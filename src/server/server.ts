import { randomBytes } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { serve, type ServerType } from "@hono/node-server";
import { createApp } from "./app.js";
import { EventHub } from "./hub.js";
import { mergePath, providerVariables, resolveLoginShellEnv } from "./platform.js";
import type { RuntimeHooks } from "./runtime/adapter.js";
import { ClaudeCodeAdapter } from "./runtime/claude/adapter.js";
import { CodexAdapter } from "./runtime/codex/adapter.js";
import { resolveOpenCodeBinary } from "./runtime/opencode/binary.js";
import { OpenCodeAdapter } from "./runtime/opencode/adapter.js";
import { RuntimeSet } from "./runtime/set.js";
import { PeerService } from "./service.js";
import { Store } from "./store.js";

export interface PeerServerOptions {
  dataDir: string;
  /** Root of the app (repo root in dev, app.asar in packaged builds). */
  appRoot: string;
  /** Electron's process.resourcesPath in packaged builds (where the runtime binary lives). */
  resourcesPath?: string;
  /** 0 picks a free port. */
  port?: number;
  rendererDir?: string;
  /** Extra origins allowed to call the API (e.g. the Vite dev server). */
  devOrigins?: string[];
  /** Reuse a persisted API token so browser tabs survive server restarts. */
  persistToken?: boolean;
  log?: (line: string) => void;
}

export interface PeerServer {
  url: string;
  token: string;
  service: PeerService;
  stop(): Promise<void>;
}

const HOST = "127.0.0.1";

function loadOrCreateToken(dataDir: string, persist: boolean): string {
  const file = join(dataDir, "api-token");
  if (persist && existsSync(file)) {
    const token = readFileSync(file, "utf8").trim();
    if (token.length >= 32) return token;
  }
  const token = randomBytes(32).toString("base64url");
  if (persist) {
    writeFileSync(file, token, { mode: 0o600 });
    chmodSync(file, 0o600);
  }
  return token;
}

function peerVersion(appRoot: string): string {
  try {
    return String(JSON.parse(readFileSync(join(appRoot, "package.json"), "utf8")).version ?? "0.0.0");
  } catch {
    return "0.0.0";
  }
}

export async function startPeerServer(opts: PeerServerOptions): Promise<PeerServer> {
  const log = opts.log ?? ((line: string) => console.log(line));
  mkdirSync(opts.dataDir, { recursive: true });
  const store = new Store(join(opts.dataDir, "peer.db"));
  const hub = new EventHub();
  const apiToken = loadOrCreateToken(opts.dataDir, opts.persistToken ?? false);
  const bridgeToken = randomBytes(32).toString("base64url");

  // The service needs the bridge URL (our own port) before the runtime can start, so listen first
  // and attach the service once the port is known. Requests before then get 503.
  let service: PeerService | null = null;
  let app: ReturnType<typeof createApp> | null = null;
  const server: ServerType = await new Promise((resolve) => {
    const s = serve(
      {
        hostname: HOST,
        port: opts.port ?? 0,
        fetch: (req) => (app ? app.fetch(req) : new Response("Peer is starting", { status: 503 })),
      },
      () => resolve(s),
    );
  });
  const { port } = server.address() as AddressInfo;
  const url = `http://${HOST}:${port}`;

  const shell = await resolveLoginShellEnv();
  const env = { ...process.env, PATH: mergePath(shell.path, process.env.PATH) };
  const shellKeys = providerVariables(shell.vars, process.env);
  if (Object.keys(shellKeys).length > 0) log(`[peer] model provider variables from the login shell (OpenCode only): ${Object.keys(shellKeys).sort().join(", ")}`);
  // In-process runtimes reach the collaboration engine directly; the service exists by the time
  // any agent runs, so these are bound late.
  const hooks: RuntimeHooks = {
    checkTool: (sessionId, tool, args) => service!.engine.evaluateTool(sessionId, tool, args),
    checkpoint: (sessionId, callId, request, signal) => service!.engine.runCheckpoint(sessionId, callId, request, signal),
  };
  const runtimes = new RuntimeSet([
    new OpenCodeAdapter({
      binary: resolveOpenCodeBinary({ resourcesPath: opts.resourcesPath, appRoot: opts.appRoot }),
      rootDir: join(opts.dataDir, "opencode"),
      pluginFile: join(opts.appRoot, "dist", "plugin", "peer.js"),
      env: { ...shellKeys, ...env },
      bridgeUrl: url,
      bridgeToken,
      log: (line) => log(`[opencode] ${line}`),
    }),
    new ClaudeCodeAdapter({ env, storage: store, hooks, dataDir: opts.dataDir, binary: process.env.PEER_CLAUDE_BIN, log }),
    new CodexAdapter({ env, storage: store, hooks, dataDir: opts.dataDir, binary: process.env.PEER_CODEX_BIN, version: peerVersion(opts.appRoot), log }),
  ]);
  service = new PeerService(store, runtimes, hub, { snapshotDir: join(opts.dataDir, "snapshots", "turns") });
  app = createApp({
    service,
    hub,
    apiToken,
    bridgeToken,
    allowedOrigins: [url, ...(opts.devOrigins ?? [])],
    rendererDir: opts.rendererDir,
  });

  // A runtime that fails to start (missing CLI, not logged in, crash) is reported to the UI rather
  // than taking Peer down; the developer can retry with "Restart runtime".
  await runtimes.startAll(log);

  return {
    url,
    token: apiToken,
    service,
    async stop() {
      await runtimes.stopAll();
      // Long-lived SSE streams would keep close() waiting forever.
      const closing = new Promise<void>((resolve) => server.close(() => resolve()));
      (server as import("node:http").Server).closeAllConnections?.();
      await closing;
      store.close();
    },
  };
}
