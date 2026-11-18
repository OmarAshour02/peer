import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { PeerEvent, PeerSession } from "../src/shared/types.js";
import { createApp } from "../src/server/app.js";
import { EventHub } from "../src/server/hub.js";
import { RuntimeSet } from "../src/server/runtime/set.js";
import { PeerService } from "../src/server/service.js";
import { Store } from "../src/server/store.js";
import { queuedAsDraft, queuedControlLabel, withReturnedDraft } from "../src/renderer/queue.js";
import { FakeRuntime } from "./helpers.js";

let dir: string;
let store: Store;
let runtime: FakeRuntime;
let hub: EventHub;
let service: PeerService;
let events: PeerEvent[];
let session: PeerSession;

const settle = () => new Promise((r) => setTimeout(r, 20));
const idle = () => runtime.emit({ type: "session.idle", sessionId: session.runtimeSessionId });
const prompts = () => runtime.prompts.map((p) => p.input.text);
const queuedEvents = () => events.flatMap((e) => (e.type === "session.queued" ? [e] : []));

beforeEach(async () => {
  dir = realpathSync(mkdtempSync(join(tmpdir(), "peer-queue-")));
  store = new Store(":memory:");
  runtime = new FakeRuntime("opencode");
  hub = new EventHub();
  events = [];
  hub.subscribe((e) => events.push(e));
  service = new PeerService(store, new RuntimeSet([runtime]), hub);
  const ws = service.addWorkspace(dir);
  session = await service.createSession(ws.id, { mode: "collaborate" });
});

afterEach(() => {
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

describe("queuing the next message while the agent works", () => {
  it("holds the message while a turn runs and sends it once the turn ends", async () => {
    await service.send(session.id, "Add a cache");
    const result = await service.queueMessage(session.id, "Also add a test");
    expect(result.sent).toBe(false);
    expect(service.snapshot(session.id).queued).toMatchObject({ text: "Also add a test", intent: "default" });
    expect(prompts()).toEqual(["Add a cache"]);

    idle();
    await settle();
    expect(prompts()).toEqual(["Add a cache", "Also add a test"]);
    expect(service.snapshot(session.id).queued).toBeNull();
    expect(service.engine.statusOf(session.id)).toBe("busy");
    expect(queuedEvents().map((e) => e.queued?.text ?? null)).toEqual(["Also add a test", null]);
  });

  it("sends at once when nothing is running", async () => {
    const result = await service.queueMessage(session.id, "Start here");
    expect(result).toEqual({ queued: null, sent: true });
    expect(prompts()).toEqual(["Start here"]);
  });

  it("keeps one message per session: queuing again replaces it", async () => {
    await service.send(session.id, "First");
    await service.queueMessage(session.id, "Second");
    await service.queueMessage(session.id, "Third", "delegate");
    expect(service.snapshot(session.id).queued).toMatchObject({ text: "Third", intent: "delegate" });
    idle();
    await settle();
    expect(prompts()).toEqual(["First", "Third"]);
    // The control goes with it: a delegated task.
    expect(store.latestTurn(session.id)!.intent).toBe("delegate");
  });

  it("can be taken back before it is sent", async () => {
    await service.send(session.id, "First");
    await service.queueMessage(session.id, "Never mind");
    expect(service.unqueueMessage(session.id)).toMatchObject({ text: "Never mind" });
    expect(service.snapshot(session.id).queued).toBeNull();
    idle();
    await settle();
    expect(prompts()).toEqual(["First"]);
  });

  it("Stop does not send it: it comes back to the developer", async () => {
    await service.send(session.id, "First");
    await service.queueMessage(session.id, "/discuss the schema");
    await service.abort(session.id);
    idle();
    await settle();
    expect(prompts()).toEqual(["First"]);
    expect(service.snapshot(session.id).queued).toBeNull();
    expect(queuedEvents().at(-1)).toMatchObject({ queued: null, returned: { text: "/discuss the schema" } });
  });

  it("never answers an open question; it waits for the turn to end", async () => {
    await service.send(session.id, "Pick a store");
    const { checkpoint } = await service.engine.requestCheckpoint(session.runtimeSessionId, null, {
      category: "architecture",
      question: "Redis or SQLite?",
      options: [{ label: "Redis" }, { label: "SQLite" }],
    });
    const cp = checkpoint!;
    expect(cp.status).toBe("pending");
    await service.queueMessage(session.id, "Then document it");
    expect(store.getCheckpoint(cp.id)!.status).toBe("pending");
    expect(service.snapshot(session.id).queued).toMatchObject({ text: "Then document it" });
    await service.engine.resolveCheckpoint(cp.id, { action: "choose", option: "SQLite" });
    idle();
    await settle();
    expect(prompts().at(-1)).toBe("Then document it");
  });

  it("a queued message that cannot start goes back with the reason", async () => {
    await service.send(session.id, "First");
    await service.queueMessage(session.id, "Second");
    runtime.prompt = async () => {
      throw new Error("The model provider is out of credits");
    };
    idle();
    await settle();
    expect(queuedEvents().at(-1)).toMatchObject({ queued: null, returned: { text: "Second" }, error: "The model provider is out of credits" });
    expect(service.snapshot(session.id).queued).toBeNull();
  });

  it("needs text unless it carries a control", async () => {
    await service.send(session.id, "First");
    await expect(service.queueMessage(session.id, "  ")).rejects.toThrow(/needs text/);
    await expect(service.queueMessage(session.id, "", "delegate")).resolves.toMatchObject({ sent: false });
  });

  it("is dropped with its session", async () => {
    await service.send(session.id, "First");
    await service.queueMessage(session.id, "Second");
    await service.deleteSession(session.id);
    idle();
    await settle();
    expect(prompts()).toEqual(["First"]);
  });

  it("has an HTTP API: POST and DELETE /sessions/:id/queue", async () => {
    const app = createApp({ service, hub, apiToken: "api", bridgeToken: "b", allowedOrigins: [] });
    const call = (method: string, body?: unknown) =>
      app.request(`/api/sessions/${session.id}/queue`, {
        method,
        headers: { authorization: "Bearer api", "content-type": "application/json" },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
    await service.send(session.id, "First");
    expect(await (await call("POST", { text: "Second", intent: "discuss" })).json()).toMatchObject({ sent: false, queued: { text: "Second", intent: "discuss" } });
    expect((await call("POST", { text: "x", intent: "nope" })).status).toBe(400);
    expect(await (await call("DELETE")).json()).toMatchObject({ returned: { text: "Second" } });
    expect(await (await call("DELETE")).json()).toEqual({ returned: null });
  });
});

describe("the composer's queued message", () => {
  it("comes back as text, its control as the slash command that means it", () => {
    expect(queuedAsDraft({ text: "add a test", intent: "default" })).toBe("add a test");
    expect(queuedAsDraft({ text: "add a test", intent: "delegate" })).toBe("/go add a test");
    expect(queuedAsDraft({ text: "", intent: "discuss" })).toBe("/discuss");
    expect(queuedControlLabel("hint")).toBe("Give me a hint");
    expect(queuedControlLabel("default")).toBeNull();
  });

  it("never replaces what the developer is writing", () => {
    expect(withReturnedDraft("", { text: "queued", intent: "default" })).toBe("queued");
    expect(withReturnedDraft("typing", { text: "queued", intent: "default" })).toBe("queued\n\ntyping");
    expect(withReturnedDraft("typing", { text: " ", intent: "default" })).toBe("typing");
  });
});

describe("session activity (sidebar marks)", () => {
  it("is empty when nothing runs, working during a turn, waiting on an open question", async () => {
    expect(service.activity()).toEqual([]);
    await service.send(session.id, "Pick a store");
    expect(service.activity()).toEqual([{ sessionId: session.id, workspaceId: session.workspaceId, state: "working" }]);
    const { checkpoint } = await service.engine.requestCheckpoint(session.runtimeSessionId, null, { category: "architecture", question: "Redis or SQLite?", options: [{ label: "Redis" }, { label: "SQLite" }] });
    expect(service.activity()).toEqual([{ sessionId: session.id, workspaceId: session.workspaceId, state: "waiting" }]);
    await service.engine.resolveCheckpoint(checkpoint!.id, { action: "choose", option: "SQLite" });
    idle();
    await settle();
    expect(service.activity()).toEqual([]);
  });

  it("shows a question a restart interrupted until the developer moves on", async () => {
    await service.send(session.id, "Pick a store");
    await service.engine.requestCheckpoint(session.runtimeSessionId, null, { category: "architecture", question: "Redis or SQLite?", options: [{ label: "Redis" }, { label: "SQLite" }] });
    runtime.emit({ type: "runtime.restarted" });
    await settle();
    expect(service.activity()).toEqual([{ sessionId: session.id, workspaceId: session.workspaceId, state: "interrupted" }]);
    await service.send(session.id, "Never mind, use SQLite");
    idle();
    await settle();
    expect(service.activity()).toEqual([]);
  });

  it("is served at GET /api/activity", async () => {
    const app = createApp({ service, hub, apiToken: "api", bridgeToken: "b", allowedOrigins: [] });
    await service.send(session.id, "Go");
    const res = await app.request("/api/activity", { headers: { authorization: "Bearer api" } });
    expect(await res.json()).toEqual([{ sessionId: session.id, workspaceId: session.workspaceId, state: "working" }]);
  });
});

describe("discarding a session the developer never used", () => {
  it("deletes a new session nothing was sent in, and keeps any session that was used or renamed", async () => {
    const ws = store.getSession(session.id)!.workspaceId;
    expect(await service.discardIfUnused(session.id)).toBe(true);
    expect(store.getSession(session.id)).toBeNull();

    const used = await service.createSession(ws, { mode: "collaborate" });
    await service.send(used.id, "Hello");
    expect(await service.discardIfUnused(used.id)).toBe(false);
    expect(store.getSession(used.id)).not.toBeNull();

    const renamed = await service.createSession(ws, { mode: "collaborate" });
    service.updateSession(renamed.id, { title: "Plan the migration" });
    expect(await service.discardIfUnused(renamed.id)).toBe(false);
  });

  it("is served as DELETE /sessions/:id?ifUnused=1, which never deletes a used session", async () => {
    const app = createApp({ service, hub, apiToken: "api", bridgeToken: "b", allowedOrigins: [] });
    const del = (id: string) => app.request(`/api/sessions/${id}?ifUnused=1`, { method: "DELETE", headers: { authorization: "Bearer api" } });
    await service.send(session.id, "Hello");
    expect(await (await del(session.id)).json()).toEqual({ deleted: false });
    const fresh = await service.createSession(session.workspaceId, { mode: "collaborate" });
    expect(await (await del(fresh.id)).json()).toEqual({ deleted: true });
  });
});
