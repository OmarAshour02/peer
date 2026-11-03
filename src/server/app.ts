import { timingSafeEqual } from "node:crypto";
import { readFile } from "node:fs/promises";
import { extname, join, normalize, sep } from "node:path";
import { Hono, type Context } from "hono";
import { cors } from "hono/cors";
import { streamSSE } from "hono/streaming";
import {
  CHECKPOINT_ACTIONS,
  CLAUDE_PERMISSION_MODES,
  COLLABORATION_MODES,
  isPrimaryMode,
  TURN_INTENTS,
  type CheckpointAction,
  type ClaudePermissionMode,
  type CollaborationModeId,
  type LocalServerKind,
  type RuntimeKind,
  type ModelRef,
  type PeerEvent,
  type PermissionReply,
  type RuntimeSettings,
  type TurnIntent,
} from "../shared/types.js";
import { EngineError } from "./collaboration/engine.js";
import { POLICIES } from "./collaboration/policies.js";
import type { EventHub } from "./hub.js";
import { ProviderError, type ProviderConnections } from "./runtime/adapter.js";
import type { PeerService } from "./service.js";
import { WorkspaceError } from "./workspaces.js";

export interface AppDeps {
  service: PeerService;
  hub: EventHub;
  apiToken: string;
  bridgeToken: string;
  /** Origins allowed to call the API cross-origin (e.g. the Vite dev server). */
  allowedOrigins: string[];
  /** Built renderer to serve at /, if any. */
  rendererDir?: string;
}

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".json": "application/json",
  ".woff2": "font/woff2",
};

function safeEqual(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

function fail(c: Context, err: unknown) {
  if (err instanceof EngineError) return c.json({ error: err.message }, err.status);
  if (err instanceof WorkspaceError || err instanceof ProviderError) return c.json({ error: err.message }, 400);
  const message = err instanceof Error ? err.message : String(err);
  return c.json({ error: message }, 500);
}

const isMode = (m: unknown): m is CollaborationModeId => COLLABORATION_MODES.includes(m as CollaborationModeId);
const isIntent = (i: unknown): i is TurnIntent => TURN_INTENTS.includes(i as TurnIntent);

/**
 * Merge validated runtime settings over the stored ones (the UI sends the whole form, but
 * unknown keys and wrong types are refused rather than stored).
 */
export function normalizeRuntimeSettings(v: unknown, previous?: RuntimeSettings): RuntimeSettings {
  if (!v || typeof v !== "object" || Array.isArray(v)) throw new Error("runtimeSettings must be an object");
  const base: RuntimeSettings = previous ?? { claudeBin: null, codexBin: null, geminiBin: null, claudePermissionMode: "acceptEdits", codexEffort: null };
  const next: RuntimeSettings = { ...base };
  const bin = (key: "claudeBin" | "codexBin" | "geminiBin") => {
    const raw = (v as Record<string, unknown>)[key];
    if (raw === undefined) return;
    if (raw !== null && typeof raw !== "string") throw new Error(`${key} must be a path string or null`);
    const trimmed = typeof raw === "string" ? raw.trim() : "";
    if (trimmed.length > 1024) throw new Error(`${key} is too long`);
    next[key] = trimmed ? trimmed : null;
  };
  bin("claudeBin");
  bin("codexBin");
  bin("geminiBin");
  const mode = (v as Record<string, unknown>).claudePermissionMode;
  if (mode !== undefined) {
    if (!CLAUDE_PERMISSION_MODES.includes(mode as ClaudePermissionMode)) throw new Error("claudePermissionMode must be acceptEdits or auto");
    next.claudePermissionMode = mode as ClaudePermissionMode;
  }
  const effort = (v as Record<string, unknown>).codexEffort;
  if (effort !== undefined) {
    if (effort !== null && typeof effort !== "string") throw new Error("codexEffort must be a string or null");
    const trimmed = typeof effort === "string" ? effort.trim() : "";
    if (trimmed.length > 64) throw new Error("codexEffort is too long");
    next.codexEffort = trimmed ? trimmed : null;
  }
  return next;
}

/** Answers to a login method's prompts: a flat string map. */
function parseInputs(v: unknown): Record<string, string> | null {
  if (v === undefined) return {};
  if (!v || typeof v !== "object" || Array.isArray(v)) return null;
  const entries = Object.entries(v);
  return entries.every(([, x]) => typeof x === "string") ? (Object.fromEntries(entries) as Record<string, string>) : null;
}

function parseModel(m: unknown): ModelRef | null | undefined {
  if (m === null) return null;
  if (m && typeof m === "object") {
    const { providerId, modelId } = m as Record<string, unknown>;
    if (typeof providerId === "string" && typeof modelId === "string") return { providerId, modelId };
  }
  return undefined;
}

export function createApp(deps: AppDeps): Hono {
  const { service, hub } = deps;
  const app = new Hono();

  // ---------------------------------------------------------------------------
  // Bridge: called by the Peer plugin inside the OpenCode runtime process. Not a browser API.
  const bridge = new Hono();
  bridge.use("*", async (c, next) => {
    if (!safeEqual(c.req.header("x-peer-bridge-token") ?? "", deps.bridgeToken)) return c.json({ error: "unauthorized" }, 401);
    await next();
  });
  bridge.post("/tool-check", async (c) => {
    const body = await c.req.json<{ sessionId: string; tool: string; args: unknown }>();
    return c.json(await service.engine.evaluateTool(body.sessionId, body.tool, body.args));
  });
  // A call Peer holds on a checkpoint: long-poll until the developer responds.
  bridge.post("/tool-check/:id/wait", async (c) => {
    const { timeoutMs } = await c.req.json<{ timeoutMs?: number }>();
    try {
      const decision = await service.engine.waitForToolDecision(c.req.param("id"), Math.min(Math.max(timeoutMs ?? 25_000, 1000), 60_000));
      return c.json(decision ?? { wait: c.req.param("id") });
    } catch (err) {
      return fail(c, err);
    }
  });
  bridge.post("/checkpoints", async (c) => {
    try {
      const body = await c.req.json<{ sessionId: string; callId: string | null; request: Record<string, unknown> }>();
      const res = await service.engine.requestCheckpoint(body.sessionId, body.callId, body.request ?? {});
      return c.json({ checkpointId: res.checkpoint?.id ?? null, output: res.output });
    } catch (err) {
      return fail(c, err);
    }
  });
  bridge.post("/checkpoints/:id/wait", async (c) => {
    const { timeoutMs } = await c.req.json<{ timeoutMs?: number }>();
    try {
      const output = await service.engine.waitForCheckpoint(c.req.param("id"), Math.min(Math.max(timeoutMs ?? 25_000, 1000), 60_000));
      return c.json(output === null ? { status: "pending" } : { status: "resolved", output });
    } catch (err) {
      if (err instanceof EngineError && err.status === 409) return c.json({ status: "cancelled" });
      return fail(c, err);
    }
  });
  bridge.post("/checkpoints/:id/cancel", (c) => {
    service.engine.cancelCheckpoint(c.req.param("id"), "The agent run was stopped");
    return c.json({ ok: true });
  });
  app.route("/bridge", bridge);

  // ---------------------------------------------------------------------------
  // API: used by the Peer UI. Token-authenticated; CORS limited to explicit origins.
  const api = new Hono();
  api.use(
    "*",
    cors({
      origin: (origin) => (deps.allowedOrigins.includes(origin) ? origin : null),
      allowHeaders: ["authorization", "content-type"],
      allowMethods: ["GET", "POST", "PATCH", "DELETE", "OPTIONS"],
    }),
  );
  api.use("*", async (c, next) => {
    if (c.req.method === "OPTIONS") return next();
    const header = c.req.header("authorization")?.replace(/^Bearer\s+/i, "");
    // EventSource cannot send headers, so the event stream alone accepts the token as a query param.
    const token = header ?? (c.req.path.endsWith("/events") ? c.req.query("token") : undefined);
    if (!token || !safeEqual(token, deps.apiToken)) return c.json({ error: "unauthorized" }, 401);
    await next();
  });

  // `runtime` is the bundled OpenCode runtime (Peer's default); `runtimes` lists every runtime.
  api.get("/health", (c) => c.json({ runtime: service.runtimes.get("opencode").status(), runtimes: service.runtimes.info() }));
  api.get("/runtimes", (c) => c.json(service.runtimes.info()));
  api.post("/runtimes/:kind/restart", async (c) => {
    const kind = c.req.param("kind");
    if (!service.runtimes.has(kind)) return c.json({ error: `Unknown runtime ${kind}` }, 404);
    try {
      const runtime = service.runtimes.get(kind);
      await runtime.restart();
      return c.json({ kind, name: runtime.name, status: runtime.status() });
    } catch (err) {
      return fail(c, err);
    }
  });

  api.get("/policies", (c) => c.json(POLICIES));
  api.get("/preferences", (c) => c.json(service.preferences()));
  api.patch("/preferences", async (c) => {
    const body = await c.req.json<{ defaultMode?: unknown; defaultRuntime?: unknown; lastSessionId?: unknown; runtimeSettings?: unknown; crossSessionMemory?: unknown; resetMemory?: unknown }>();
    if (body.defaultMode !== undefined && !isMode(body.defaultMode)) return c.json({ error: "Unknown mode" }, 400);
    if (body.defaultMode !== undefined && !isPrimaryMode(body.defaultMode)) return c.json({ error: "Focus is retired as a default; use collaborate or learn." }, 400);
    if (body.crossSessionMemory !== undefined && typeof body.crossSessionMemory !== "boolean") return c.json({ error: "crossSessionMemory must be true or false" }, 400);
    if (body.resetMemory !== undefined && typeof body.resetMemory !== "boolean") return c.json({ error: "resetMemory must be true or false" }, 400);
    if (body.defaultRuntime !== undefined && (typeof body.defaultRuntime !== "string" || !service.runtimes.has(body.defaultRuntime))) {
      return c.json({ error: "Unknown runtime" }, 400);
    }
    if (body.lastSessionId !== undefined && body.lastSessionId !== null && typeof body.lastSessionId !== "string") {
      return c.json({ error: "Invalid lastSessionId" }, 400);
    }
    let runtimeSettings: RuntimeSettings | undefined;
    if (body.runtimeSettings !== undefined) {
      try {
        runtimeSettings = normalizeRuntimeSettings(body.runtimeSettings, service.store.getPreferences().runtimeSettings);
      } catch (err) {
        return c.json({ error: err instanceof Error ? err.message : String(err) }, 400);
      }
    }
    service.store.setPreferences({
      defaultMode: body.defaultMode as CollaborationModeId | undefined,
      defaultRuntime: body.defaultRuntime as RuntimeKind | undefined,
      lastSessionId: body.lastSessionId as string | null | undefined,
      runtimeSettings,
      crossSessionMemory: body.crossSessionMemory as boolean | undefined,
      memoryResetAt: body.resetMemory === true ? Date.now() : undefined,
    });
    return c.json(service.preferences());
  });

  api.get("/workspaces", (c) => c.json(service.store.listWorkspaces()));
  api.post("/workspaces", async (c) => {
    try {
      const body = await c.req.json<{ path?: unknown }>();
      return c.json(service.addWorkspace(body.path));
    } catch (err) {
      return fail(c, err);
    }
  });
  api.patch("/workspaces/:id", async (c) => {
    try {
      const body = await c.req.json<{ sandboxNetwork?: unknown }>();
      if (body.sandboxNetwork !== undefined && typeof body.sandboxNetwork !== "boolean") return c.json({ error: "sandboxNetwork must be true or false" }, 400);
      return c.json(service.updateWorkspace(c.req.param("id"), { sandboxNetwork: body.sandboxNetwork }));
    } catch (err) {
      return fail(c, err);
    }
  });
  api.delete("/workspaces/:id", (c) => {
    service.store.removeWorkspace(c.req.param("id"));
    return c.json({ ok: true });
  });
  api.get("/workspaces/:id/sessions", (c) => c.json(service.store.listSessions(c.req.param("id"))));
  api.post("/workspaces/:id/sessions", async (c) => {
    try {
      type Body = { mode?: unknown; model?: unknown; runtime?: unknown };
      const body = await c.req.json<Body>().catch(() => ({}) as Body);
      if (body.mode !== undefined && !isMode(body.mode)) return c.json({ error: "Unknown mode" }, 400);
      if (body.runtime !== undefined && (typeof body.runtime !== "string" || !service.runtimes.has(body.runtime))) {
        return c.json({ error: "Unknown runtime" }, 400);
      }
      return c.json(
        await service.createSession(c.req.param("id"), {
          mode: body.mode as CollaborationModeId | undefined,
          model: parseModel(body.model),
          runtime: body.runtime as RuntimeKind | undefined,
        }),
      );
    } catch (err) {
      return fail(c, err);
    }
  });
  api.get("/workspaces/:id/models", async (c) => {
    const ws = service.store.getWorkspace(c.req.param("id"));
    if (!ws) return c.json({ error: "Unknown workspace" }, 404);
    const kind = c.req.query("runtime") ?? service.preferences().defaultRuntime;
    if (!service.runtimes.has(kind)) return c.json({ error: `Unknown runtime ${kind}` }, 400);
    try {
      return c.json(await service.runtimes.get(kind).listModels(ws.path));
    } catch (err) {
      return fail(c, err);
    }
  });

  // Model providers of runtimes Peer can connect itself (OpenCode). Credentials only flow in:
  // no response carries one.
  const withProviders = async (c: Context, run: (providers: ProviderConnections) => Promise<Response>) => {
    const kind = c.req.param("kind") ?? "";
    if (!service.runtimes.has(kind)) return c.json({ error: `Unknown runtime ${kind}` }, 404);
    const runtime = service.runtimes.get(kind);
    if (!runtime.providers) return c.json({ error: `${runtime.name} manages its own login.` }, 404);
    if (runtime.status().state !== "ready") return c.json({ error: `${runtime.name} is not running.` }, 409);
    try {
      return await run(runtime.providers);
    } catch (err) {
      return fail(c, err);
    }
  };
  api.get("/runtimes/:kind/providers", (c) => withProviders(c, async (p) => c.json(await p.catalog())));
  api.post("/runtimes/:kind/providers/:id/key", (c) =>
    withProviders(c, async (p) => {
      const body = await c.req.json<{ key?: unknown; inputs?: unknown }>();
      const key = typeof body.key === "string" ? body.key.trim() : "";
      const inputs = parseInputs(body.inputs);
      if (!key || key.length > 10_000) return c.json({ error: "Enter an API key." }, 400);
      if (!inputs) return c.json({ error: "Invalid inputs" }, 400);
      await p.setKey(c.req.param("id"), key, inputs);
      return c.json(await p.catalog());
    }),
  );
  api.post("/runtimes/:kind/providers/:id/oauth", (c) =>
    withProviders(c, async (p) => {
      const body = await c.req.json<{ method?: unknown; inputs?: unknown }>();
      const inputs = parseInputs(body.inputs);
      if (!Number.isInteger(body.method) || (body.method as number) < 0) return c.json({ error: "Invalid method" }, 400);
      if (!inputs) return c.json({ error: "Invalid inputs" }, 400);
      return c.json(await p.startOAuth(c.req.param("id"), body.method as number, inputs));
    }),
  );
  api.post("/runtimes/:kind/providers/:id/oauth/callback", (c) =>
    withProviders(c, async (p) => {
      const body = await c.req.json<{ method?: unknown; code?: unknown }>();
      if (!Number.isInteger(body.method) || (body.method as number) < 0) return c.json({ error: "Invalid method" }, 400);
      if (body.code !== undefined && typeof body.code !== "string") return c.json({ error: "Invalid code" }, 400);
      const code = typeof body.code === "string" ? body.code.trim() || undefined : undefined;
      await p.finishOAuth(c.req.param("id"), body.method as number, code);
      return c.json(await p.catalog());
    }),
  );
  api.delete("/runtimes/:kind/providers/:id", (c) =>
    withProviders(c, async (p) => {
      await p.disconnect(c.req.param("id"));
      return c.json(await p.catalog());
    }),
  );

  // Local model servers (Ollama, LM Studio, any OpenAI-compatible address).
  api.post("/runtimes/:kind/local-servers", (c) =>
    withProviders(c, async (p) => {
      const body = await c.req.json<{ baseUrl?: unknown; name?: unknown; kind?: unknown }>();
      if (typeof body.baseUrl !== "string" || body.baseUrl.length > 2000) return c.json({ error: "Enter the server's address." }, 400);
      if (body.name !== undefined && typeof body.name !== "string") return c.json({ error: "Invalid name" }, 400);
      if (body.kind !== undefined && !["ollama", "lmstudio", "custom"].includes(body.kind as string)) return c.json({ error: "Invalid kind" }, 400);
      await p.addLocal({ baseUrl: body.baseUrl, name: body.name as string | undefined, kind: body.kind as LocalServerKind | undefined });
      return c.json(await p.catalog());
    }),
  );
  api.delete("/runtimes/:kind/local-servers/:id", (c) =>
    withProviders(c, async (p) => {
      await p.removeLocal(c.req.param("id"));
      return c.json(await p.catalog());
    }),
  );

  api.get("/sessions/:id", (c) => {
    try {
      return c.json(service.snapshot(c.req.param("id")));
    } catch (err) {
      return fail(c, err);
    }
  });
  api.patch("/sessions/:id", async (c) => {
    try {
      const body = await c.req.json<{ mode?: unknown; model?: unknown; title?: unknown; autoApprovals?: unknown; approachGate?: unknown; discussing?: unknown }>();
      if (body.mode !== undefined && !isMode(body.mode)) return c.json({ error: "Unknown mode" }, 400);
      if (body.autoApprovals !== undefined && typeof body.autoApprovals !== "boolean") return c.json({ error: "autoApprovals must be true or false" }, 400);
      if (body.approachGate !== undefined && typeof body.approachGate !== "boolean") return c.json({ error: "approachGate must be true or false" }, 400);
      if (body.discussing !== undefined && typeof body.discussing !== "boolean") return c.json({ error: "discussing must be true or false" }, 400);
      return c.json(
        service.updateSession(c.req.param("id"), {
          mode: body.mode as CollaborationModeId | undefined,
          model: parseModel(body.model),
          title: typeof body.title === "string" ? body.title : undefined,
          autoApprovals: body.autoApprovals as boolean | undefined,
          approachGate: body.approachGate as boolean | undefined,
          discussing: body.discussing as boolean | undefined,
        }),
      );
    } catch (err) {
      return fail(c, err);
    }
  });
  api.delete("/sessions/:id", async (c) => {
    try {
      await service.deleteSession(c.req.param("id"));
      return c.json({ ok: true });
    } catch (err) {
      return fail(c, err);
    }
  });
  api.get("/sessions/:id/messages", async (c) => {
    try {
      return c.json(await service.messages(c.req.param("id")));
    } catch (err) {
      return fail(c, err);
    }
  });
  api.get("/sessions/:id/diff", async (c) => {
    try {
      return c.json(await service.diff(c.req.param("id")));
    } catch (err) {
      return fail(c, err);
    }
  });
  api.get("/sessions/:id/events", (c) => c.json(service.store.listEvents(c.req.param("id"))));
  api.post("/sessions/:id/messages", async (c) => {
    try {
      const body = await c.req.json<{ text?: unknown; intent?: unknown }>();
      if (typeof body.text !== "string") return c.json({ error: "text is required" }, 400);
      if (body.intent !== undefined && !isIntent(body.intent)) return c.json({ error: "Unknown intent" }, 400);
      return c.json(await service.send(c.req.param("id"), body.text, body.intent as TurnIntent | undefined));
    } catch (err) {
      return fail(c, err);
    }
  });
  api.post("/sessions/:id/undo", async (c) => {
    try {
      return c.json(await service.undoLastTurn(c.req.param("id")));
    } catch (err) {
      return fail(c, err);
    }
  });
  api.post("/sessions/:id/abort", async (c) => {
    try {
      await service.abort(c.req.param("id"));
      return c.json({ ok: true });
    } catch (err) {
      return fail(c, err);
    }
  });

  api.post("/checkpoints/:id/contest", (c) => {
    try {
      return c.json(service.engine.contestRoutine(c.req.param("id")));
    } catch (err) {
      return fail(c, err);
    }
  });
  api.post("/checkpoints/:id/resolve", async (c) => {
    try {
      const body = await c.req.json<{ action?: unknown; text?: unknown; option?: unknown }>();
      if (!CHECKPOINT_ACTIONS.includes(body.action as CheckpointAction)) return c.json({ error: "Unknown action" }, 400);
      return c.json(
        await service.engine.resolveCheckpoint(c.req.param("id"), {
          action: body.action as CheckpointAction,
          text: typeof body.text === "string" ? body.text : undefined,
          option: typeof body.option === "string" ? body.option : undefined,
        }),
      );
    } catch (err) {
      return fail(c, err);
    }
  });

  api.post("/permissions/:id/reply", async (c) => {
    try {
      const body = await c.req.json<{ reply?: unknown }>();
      if (!["once", "always", "reject"].includes(body.reply as string)) return c.json({ error: "Unknown reply" }, 400);
      await service.replyPermission(c.req.param("id"), body.reply as PermissionReply);
      return c.json({ ok: true });
    } catch (err) {
      return fail(c, err);
    }
  });

  api.get("/events", (c) =>
    streamSSE(c, async (stream) => {
      const queue: PeerEvent[] = [];
      let wake: (() => void) | null = null;
      const unsubscribe = hub.subscribe((event) => {
        queue.push(event);
        wake?.();
      });
      stream.onAbort(() => {
        unsubscribe();
        wake?.();
      });
      for (const r of service.runtimes.info()) {
        await stream.writeSSE({ event: "peer", data: JSON.stringify({ type: "runtime.status", runtime: r.kind, status: r.status }) });
      }
      while (!stream.aborted) {
        if (queue.length === 0) {
          await new Promise<void>((resolve) => {
            wake = resolve;
            setTimeout(resolve, 15_000); // heartbeat
          });
          wake = null;
          if (queue.length === 0 && !stream.aborted) await stream.writeSSE({ event: "ping", data: "" });
          continue;
        }
        const event = queue.shift()!;
        await stream.writeSSE({ event: "peer", data: JSON.stringify(event) });
      }
      unsubscribe();
    }),
  );

  app.route("/api", api);

  // ---------------------------------------------------------------------------
  // Renderer (production builds). Single-page app: unknown paths fall back to index.html.
  if (deps.rendererDir) {
    const root = normalize(deps.rendererDir);
    app.get("*", async (c) => {
      const rel = normalize(decodeURIComponent(new URL(c.req.url).pathname)).replace(/^([/\\])+/, "");
      const file = join(root, rel || "index.html");
      if (!file.startsWith(root + sep) && file !== root) return c.text("Not found", 404);
      const target = extname(file) ? file : join(root, "index.html");
      try {
        const body = await readFile(target);
        return c.body(body, 200, {
          "content-type": MIME[extname(target)] ?? "application/octet-stream",
          "content-security-policy":
            "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'",
        });
      } catch {
        return c.text("Not found", 404);
      }
    });
  }

  return app;
}
