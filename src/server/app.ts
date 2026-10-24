import { timingSafeEqual } from "node:crypto";
import { readFile } from "node:fs/promises";
import { extname, join, normalize, sep } from "node:path";
import { Hono, type Context } from "hono";
import { cors } from "hono/cors";
import { streamSSE } from "hono/streaming";
import {
  CHECKPOINT_ACTIONS,
  COLLABORATION_MODES,
  TURN_INTENTS,
  type CheckpointAction,
  type CollaborationModeId,
  type RuntimeKind,
  type ModelRef,
  type PeerEvent,
  type PermissionReply,
  type TurnIntent,
} from "../shared/types.js";
import { EngineError } from "./collaboration/engine.js";
import { POLICIES } from "./collaboration/policies.js";
import type { EventHub } from "./hub.js";
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
  if (err instanceof WorkspaceError) return c.json({ error: err.message }, 400);
  const message = err instanceof Error ? err.message : String(err);
  return c.json({ error: message }, 500);
}

const isMode = (m: unknown): m is CollaborationModeId => COLLABORATION_MODES.includes(m as CollaborationModeId);
const isIntent = (i: unknown): i is TurnIntent => TURN_INTENTS.includes(i as TurnIntent);

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
  api.get("/preferences", (c) => c.json(service.store.getPreferences()));
  api.patch("/preferences", async (c) => {
    const body = await c.req.json<{ defaultMode?: unknown; defaultRuntime?: unknown; lastSessionId?: unknown }>();
    if (body.defaultMode !== undefined && !isMode(body.defaultMode)) return c.json({ error: "Unknown mode" }, 400);
    if (body.defaultRuntime !== undefined && (typeof body.defaultRuntime !== "string" || !service.runtimes.has(body.defaultRuntime))) {
      return c.json({ error: "Unknown runtime" }, 400);
    }
    if (body.lastSessionId !== undefined && body.lastSessionId !== null && typeof body.lastSessionId !== "string") {
      return c.json({ error: "Invalid lastSessionId" }, 400);
    }
    return c.json(
      service.store.setPreferences({
        defaultMode: body.defaultMode as CollaborationModeId | undefined,
        defaultRuntime: body.defaultRuntime as RuntimeKind | undefined,
        lastSessionId: body.lastSessionId as string | null | undefined,
      }),
    );
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
    const kind = c.req.query("runtime") ?? service.store.getPreferences().defaultRuntime;
    if (!service.runtimes.has(kind)) return c.json({ error: `Unknown runtime ${kind}` }, 400);
    try {
      return c.json(await service.runtimes.get(kind).listModels(ws.path));
    } catch (err) {
      return fail(c, err);
    }
  });

  api.get("/sessions/:id", (c) => {
    try {
      return c.json(service.snapshot(c.req.param("id")));
    } catch (err) {
      return fail(c, err);
    }
  });
  api.patch("/sessions/:id", async (c) => {
    try {
      const body = await c.req.json<{ mode?: unknown; model?: unknown; title?: unknown }>();
      if (body.mode !== undefined && !isMode(body.mode)) return c.json({ error: "Unknown mode" }, 400);
      return c.json(
        service.updateSession(c.req.param("id"), {
          mode: body.mode as CollaborationModeId | undefined,
          model: parseModel(body.model),
          title: typeof body.title === "string" ? body.title : undefined,
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
  api.post("/sessions/:id/abort", async (c) => {
    try {
      await service.abort(c.req.param("id"));
      return c.json({ ok: true });
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
