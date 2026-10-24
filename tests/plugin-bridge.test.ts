import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createApp } from "../src/server/app.js";
import { DECISION_APPROVE, DECISION_DECLINE } from "../src/server/collaboration/engine.js";
import { EventHub } from "../src/server/hub.js";
import { RuntimeSet } from "../src/server/runtime/set.js";
import { PeerService } from "../src/server/service.js";
import { Store } from "../src/server/store.js";
import { FakeRuntime } from "./helpers.js";

// The OpenCode plugin against the real bridge, in-process: the plugin's fetch goes to the Hono app.
let dir: string;
let store: Store;
let service: PeerService;

type Before = (input: { tool: string; sessionID: string; callID: string }, output: { args: unknown }) => Promise<void>;

async function loadPlugin(): Promise<Before> {
  vi.resetModules();
  vi.stubEnv("PEER_BRIDGE_URL", "http://peer.test");
  vi.stubEnv("PEER_BRIDGE_TOKEN", "bridge-token");
  vi.stubEnv("PEER_PARENT_PID", "");
  const app = createApp({ service, hub: new EventHub(), apiToken: "api", bridgeToken: "bridge-token", allowedOrigins: [] });
  vi.stubGlobal("fetch", (url: string, init: RequestInit) => app.request(url.replace("http://peer.test", ""), init));
  const { PeerCollaboration } = await import("../src/plugin/peer-plugin.js");
  const hooks = (await PeerCollaboration({} as never)) as Record<string, unknown>;
  return hooks["tool.execute.before"] as Before;
}

beforeEach(() => {
  dir = realpathSync(mkdtempSync(join(tmpdir(), "peer-plugin-")));
  writeFileSync(join(dir, "package.json"), JSON.stringify({ dependencies: {} }));
  store = new Store(":memory:");
  service = new PeerService(store, new RuntimeSet([new FakeRuntime()]), new EventHub());
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

async function session() {
  const ws = service.addWorkspace(dir);
  const s = await service.createSession(ws.id, { mode: "collaborate" });
  await service.send(s.id, "task");
  return s;
}

/** Wait until Peer holds a call on a checkpoint. */
async function heldCheckpoint(sessionId: string) {
  for (let i = 0; i < 100; i++) {
    const cp = store.listCheckpoints(sessionId).find((c) => c.status === "pending");
    if (cp) return cp;
    await new Promise((r) => setTimeout(r, 5));
  }
  throw new Error("no checkpoint opened");
}

describe("OpenCode plugin and the bridge", () => {
  it("holds a tool call until the developer approves, then lets it run", async () => {
    const before = await loadPlugin();
    const s = await session();
    const call = before({ tool: "bash", sessionID: s.runtimeSessionId, callID: "c1" }, { args: { command: "npm install zod" } });
    const cp = await heldCheckpoint(s.id);
    await service.engine.resolveCheckpoint(cp.id, { action: "choose", option: DECISION_APPROVE });
    await expect(call).resolves.toBeUndefined();
  });

  it("rejects the call with the developer's decision", async () => {
    const before = await loadPlugin();
    const s = await session();
    const call = before({ tool: "bash", sessionID: s.runtimeSessionId, callID: "c1" }, { args: { command: "npm install moment" } });
    const cp = await heldCheckpoint(s.id);
    await service.engine.resolveCheckpoint(cp.id, { action: "choose", option: DECISION_DECLINE });
    await expect(call).rejects.toThrow(/decided against it/);
  });

  it("Stop rejects the held call", async () => {
    const before = await loadPlugin();
    const s = await session();
    const call = before({ tool: "bash", sessionID: s.runtimeSessionId, callID: "c1" }, { args: { command: "npm install zod" } });
    await heldCheckpoint(s.id);
    await service.engine.abort(s.id);
    await expect(call).rejects.toThrow(/question was cancelled/);
  });
});

describe("session API", () => {
  it("toggles auto approvals and rejects anything but a boolean", async () => {
    const app = createApp({ service, hub: new EventHub(), apiToken: "api", bridgeToken: "bridge-token", allowedOrigins: [] });
    const ws = service.addWorkspace(dir);
    const s = await service.createSession(ws.id, { mode: "collaborate" });
    const patch = (body: unknown) => app.request(`/api/sessions/${s.id}`, { method: "PATCH", headers: { authorization: "Bearer api", "content-type": "application/json" }, body: JSON.stringify(body) });
    expect((await patch({ autoApprovals: "yes" })).status).toBe(400);
    const res = await patch({ autoApprovals: true });
    expect(res.status).toBe(200);
    expect(((await res.json()) as { autoApprovals: boolean }).autoApprovals).toBe(true);
    expect(store.getSession(s.id)!.autoApprovals).toBe(true);
  });
});
