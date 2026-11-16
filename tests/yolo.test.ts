import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { EventHub } from "../src/server/hub.js";
import { RuntimeSet } from "../src/server/runtime/set.js";
import { PeerService } from "../src/server/service.js";
import { Store } from "../src/server/store.js";
import type { PeerEvent, PermissionReply } from "../src/shared/types.js";
import { FakeRuntime } from "./helpers.js";

let dir: string;
let store: Store;
let runtime: FakeRuntime;
let service: PeerService;
let events: PeerEvent[];
let replies: { id: string; reply: PermissionReply }[];

beforeEach(() => {
  dir = realpathSync(mkdtempSync(join(tmpdir(), "peer-yolo-")));
  store = new Store(":memory:");
  runtime = new FakeRuntime();
  replies = [];
  runtime.replyPermission = async (_d, id, reply) => {
    replies.push({ id, reply });
  };
  const hub = new EventHub();
  events = [];
  hub.subscribe((e) => events.push(e));
  service = new PeerService(store, new RuntimeSet([runtime]), hub);
});

afterEach(() => {
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

const flush = () => new Promise((r) => setImmediate(r));

async function session() {
  const ws = service.addWorkspace(dir);
  const s = await service.createSession(ws.id, {});
  await service.send(s.id, "task");
  return s;
}

const ask = (runtimeSessionId: string, id: string) =>
  runtime.emit({ type: "permission.asked", request: { id, sessionId: runtimeSessionId, permission: "bash", patterns: ["rm -rf build/"], metadata: {} } });

describe("YOLO", () => {
  it("is off by default and persists when turned on", async () => {
    const s = await session();
    expect(s.yolo).toBe(false);
    service.updateSession(s.id, { yolo: true });
    expect(store.getSession(s.id)!.yolo).toBe(true);
    expect(events.some((e) => e.type === "session.updated" && e.session.yolo)).toBe(true);
  });

  it("off: permission requests reach the developer", async () => {
    const s = await session();
    ask(s.runtimeSessionId, "perm_1");
    await flush();
    expect(replies).toEqual([]);
    expect(service.snapshot(s.id).permissions.map((p) => p.id)).toEqual(["perm_1"]);
  });

  it("on: Peer approves each request once, without showing a card", async () => {
    const s = await session();
    service.updateSession(s.id, { yolo: true });
    ask(s.runtimeSessionId, "perm_1");
    await flush();
    expect(replies).toEqual([{ id: "perm_1", reply: "once" }]);
    expect(service.snapshot(s.id).permissions).toEqual([]);
    expect(events.some((e) => e.type === "permission.asked")).toBe(false);
  });

  it("turning it on settles the requests already waiting", async () => {
    const s = await session();
    ask(s.runtimeSessionId, "perm_1");
    await flush();
    service.updateSession(s.id, { yolo: true });
    await flush();
    expect(replies).toEqual([{ id: "perm_1", reply: "once" }]);
    expect(service.snapshot(s.id).permissions).toEqual([]);
    expect(events.some((e) => e.type === "permission.replied" && e.requestId === "perm_1")).toBe(true);
  });

  it("falls back to asking the developer when the runtime refuses the reply", async () => {
    runtime.replyPermission = async () => {
      throw new Error("run ended");
    };
    const s = await session();
    service.updateSession(s.id, { yolo: true });
    ask(s.runtimeSessionId, "perm_1");
    await flush();
    expect(service.snapshot(s.id).permissions.map((p) => p.id)).toEqual(["perm_1"]);
    expect(events.some((e) => e.type === "permission.asked")).toBe(true);
  });

  it("logs the approval when the runtime reports its own reply, as Claude Code and Codex do", async () => {
    const s = await session();
    runtime.replyPermission = async (_d, id, reply) => {
      replies.push({ id, reply });
      runtime.emit({ type: "permission.replied", sessionId: s.runtimeSessionId, requestId: id });
    };
    service.updateSession(s.id, { yolo: true });
    ask(s.runtimeSessionId, "perm_1");
    await flush();
    expect(replies).toEqual([{ id: "perm_1", reply: "once" }]);
    expect(store.listEvents(s.id).some((e) => e.type === "permission.replied" && e.payload.by === "yolo")).toBe(true);
    expect(events.filter((e) => e.type === "permission.replied" && e.requestId === "perm_1")).toHaveLength(1);
    expect(events.some((e) => e.type === "permission.asked")).toBe(false);
  });

  it("turning it off restores the prompts", async () => {
    const s = await session();
    service.updateSession(s.id, { yolo: true });
    service.updateSession(s.id, { yolo: false });
    ask(s.runtimeSessionId, "perm_1");
    await flush();
    expect(replies).toEqual([]);
    expect(service.snapshot(s.id).permissions.map((p) => p.id)).toEqual(["perm_1"]);
  });
});
