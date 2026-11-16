import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { composeSystemPrompt } from "../src/server/collaboration/prompt.js";
import { resolveEffectivePolicy } from "../src/server/collaboration/policies.js";
import { createApp } from "../src/server/app.js";
import { EventHub } from "../src/server/hub.js";
import { RuntimeSet } from "../src/server/runtime/set.js";
import { PeerService, plainTitle } from "../src/server/service.js";
import { Store } from "../src/server/store.js";
import { FakeRuntime } from "./helpers.js";

let dir: string;
let store: Store;
let runtime: FakeRuntime;
let service: PeerService;

beforeEach(() => {
  dir = realpathSync(mkdtempSync(join(tmpdir(), "peer-chat-")));
  mkdirSync(join(dir, "chats"));
  mkdirSync(join(dir, "project"));
  store = new Store(":memory:");
  runtime = new FakeRuntime("opencode");
  service = new PeerService(store, new RuntimeSet([runtime]), new EventHub());
});

afterEach(() => {
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

describe("general chat (not tied to a project)", () => {
  it("Peer keeps exactly one Chats workspace, listed after the developer's projects", () => {
    const project = service.addWorkspace(join(dir, "project"));
    const chats = store.ensureGeneralWorkspace(join(dir, "chats"));
    expect(chats).toMatchObject({ name: "Chats", general: true, path: join(dir, "chats") });
    expect(store.ensureGeneralWorkspace(join(dir, "chats")).id).toBe(chats.id);
    expect(store.listWorkspaces().filter((w) => w.general)).toHaveLength(1);
    expect(store.listWorkspaces()[0]!.id).toBe(project.id);
    expect(project.general).toBe(false);
  });

  it("follows Peer's data directory when it moves, keeping its chats", async () => {
    const chats = store.ensureGeneralWorkspace(join(dir, "chats"));
    const session = await service.createSession(chats.id, {});
    const moved = join(dir, "moved");
    mkdirSync(moved);
    const again = store.ensureGeneralWorkspace(moved);
    expect(again).toMatchObject({ id: chats.id, path: moved });
    expect(store.listSessions(chats.id).map((s) => s.id)).toEqual([session.id]);
  });

  it("moving onto a folder that is open as a project folds that project's sessions into Chats", async () => {
    const chats = store.ensureGeneralWorkspace(join(dir, "chats"));
    const project = service.addWorkspace(join(dir, "project"));
    const kept = await service.createSession(project.id, {});
    const again = store.ensureGeneralWorkspace(join(dir, "project"));
    expect(again).toMatchObject({ id: chats.id, general: true, path: join(dir, "project") });
    expect(store.getWorkspace(project.id)).toBeNull();
    expect(store.listSessions(chats.id).map((s) => s.id)).toEqual([kept.id]);
  });

  it("a project opened at the chats folder earlier becomes Chats", () => {
    const earlier = service.addWorkspace(join(dir, "chats"));
    const chats = store.ensureGeneralWorkspace(join(dir, "chats"));
    expect(chats).toMatchObject({ id: earlier.id, general: true, name: "Chats" });
  });

  it("cannot be removed; its chats can be deleted one by one", async () => {
    const chats = store.ensureGeneralWorkspace(join(dir, "chats"));
    const session = await service.createSession(chats.id, {});
    await expect(service.removeWorkspace(chats.id)).rejects.toThrow(/cannot be removed/);
    expect(store.getWorkspace(chats.id)).not.toBeNull();
    await service.deleteSession(session.id);
    expect(store.listSessions(chats.id)).toHaveLength(0);
  });

  it("tells the agent it is in a general chat, in every mode; project sessions are not told", async () => {
    const chats = store.ensureGeneralWorkspace(join(dir, "chats"));
    for (const mode of ["collaborate", "learn"] as const) {
      const chat = await service.createSession(chats.id, { mode });
      await service.send(chat.id, "What is a B-tree?");
      expect(runtime.lastPrompt().input.system).toMatch(/## General chat[\s\S]*not tied to a project/);
      expect(runtime.lastPrompt().directory).toBe(join(dir, "chats"));
    }
    const project = service.addWorkspace(join(dir, "project"));
    const work = await service.createSession(project.id, {});
    await service.send(work.id, "Add a test");
    expect(runtime.lastPrompt().input.system).not.toMatch(/## General chat/);
  });

  it("Peer declines quiz checkpoints in a chat and tells the agent to ask in its reply; choices still reach the developer", async () => {
    const chats = store.ensureGeneralWorkspace(join(dir, "chats"));
    const chat = await service.createSession(chats.id, { mode: "learn" });
    await service.send(chat.id, "How does a B-tree work internally?");
    for (const category of ["hypothesis", "concept"] as const) {
      const r = await service.engine.requestCheckpoint(chat.runtimeSessionId, null, { category, question: `What happens on a full leaf? (${category})` });
      expect(r.checkpoint?.status).toBe("auto_resolved");
      expect(r.output).toMatch(/ask teaching questions in your reply as plain text and end your turn/);
    }
    const choice = service.engine.requestCheckpoint(chat.runtimeSessionId, null, { category: "requirement", question: "Database indexes or search indexes?" });
    await new Promise((r) => setImmediate(r));
    expect(store.listCheckpoints(chat.id).filter((c) => c.status === "pending")).toHaveLength(1);
    void choice;
    // The same Learn questions in a project still reach the developer.
    const project = service.addWorkspace(join(dir, "project"));
    const work = await service.createSession(project.id, { mode: "learn" });
    await service.send(work.id, "Add an index");
    void service.engine.requestCheckpoint(work.runtimeSessionId, null, { category: "hypothesis", question: "Which column first?" });
    await new Promise((r) => setImmediate(r));
    expect(store.listCheckpoints(work.id).filter((c) => c.status === "pending")).toHaveLength(1);
  });

  it("in a locked Learn chat, every message to the agent says to ask in its reply, never with a teaching checkpoint", async () => {
    const chats = store.ensureGeneralWorkspace(join(dir, "chats"));
    const chat = await service.createSession(chats.id, { mode: "learn" });
    await service.send(chat.id, "Let's write a tiny B-tree in Python");
    const teachingCheckpoint = /hypothesis or concept question|with peer_checkpoint|ask your question with/;

    // A blocked edit.
    const blocked = await service.engine.checkTool(chat.runtimeSessionId, "write", { filePath: "btree.py", content: "x" });
    if (blocked.allow) throw new Error("the edit should be blocked");
    expect(blocked.reason).toMatch(/ask your question in your reply as plain text and end your turn/);
    expect(blocked.reason).not.toMatch(teachingCheckpoint);

    // A go-ahead on a plan: still locked, and the agent is told to ask inline.
    const { checkpoint: asked } = await service.engine.requestCheckpoint(chat.runtimeSessionId, null, { category: "confirm", question: "Write the insert path first?" });
    expect(asked?.status).toBe("pending");
    await service.engine.resolveCheckpoint(asked!.id, { action: "answer", text: "Yes" });
    const out = service.engine.agentOutput(store.getCheckpoint(asked!.id)!);
    expect(out).toMatch(/Code changes stay locked/);
    expect(out).toMatch(/in your reply as plain text and end your turn/);
    expect(out).not.toMatch(teachingCheckpoint);

    // A hint on a choice checkpoint: the hint, then the question again in the reply.
    const { checkpoint: choice } = await service.engine.requestCheckpoint(chat.runtimeSessionId, null, { category: "requirement", question: "Start with search or insert?" });
    await service.engine.resolveCheckpoint(choice!.id, { action: "hint" });
    const hint = service.engine.agentOutput(store.getCheckpoint(choice!.id)!);
    expect(hint).toMatch(/one short hint/);
    expect(hint).toMatch(/ask your question again in your reply as plain text and end your turn/);
    expect(hint).not.toMatch(teachingCheckpoint);
    expect(hint).not.toMatch(/category "hypothesis"/);

    // The developer says "Not routine, ask me"; a later routine claim is refused with the inline instruction.
    const chat2 = await service.createSession(chats.id, { mode: "learn" });
    await service.send(chat2.id, "Add the boilerplate for a Node class");
    const claim = await service.engine.requestCheckpoint(chat2.runtimeSessionId, null, { category: "routine", question: "Only boilerplate" });
    expect(claim.checkpoint?.resolution?.note).toMatch(/unlocked/);
    service.engine.contestRoutine(claim.checkpoint!.id);
    const refused = await service.engine.requestCheckpoint(chat2.runtimeSessionId, null, { category: "routine", question: "Just boilerplate" });
    expect(refused.output).toMatch(/not routine\. Ask them your question in your reply as plain text and end your turn/);
    expect(refused.output).not.toMatch(teachingCheckpoint);
    const blockedAfter = await service.engine.checkTool(chat2.runtimeSessionId, "write", { filePath: "btree.py", content: "x" });
    if (blockedAfter.allow) throw new Error("the edit should be blocked");
    expect(blockedAfter.reason).not.toMatch(teachingCheckpoint);

    // The same paths in a project keep pointing at the checkpoint tool.
    const project = service.addWorkspace(join(dir, "project"));
    const work = await service.createSession(project.id, { mode: "learn" });
    await service.send(work.id, "Add a B-tree");
    const projectBlocked = await service.engine.checkTool(work.runtimeSessionId, "write", { filePath: "btree.py", content: "x" });
    if (projectBlocked.allow) throw new Error("the edit should be blocked");
    expect(projectBlocked.reason).toMatch(/ask your question with the peer_checkpoint tool/);
  });

  it("the general-chat note comes before the mode's guidance", () => {
    const p = composeSystemPrompt(resolveEffectivePolicy("learn", "default", false), undefined, { generalChat: true });
    expect(p.indexOf("## General chat")).toBeLessThan(p.indexOf("## Active mode"));
    expect(p).toMatch(/ground your questions and examples in what the developer brings/);
    // Teaching questions are messages in a chat, not blocking checkpoint cards.
    expect(p).toMatch(/ask teaching questions .* in your reply as plain text and end your turn/);
    expect(p).toMatch(/not to quiz them/);
    expect(p).toContain("Code changes: locked by Peer until the developer replies. In a chat this rarely matters");
    expect(p).not.toContain("ask a hypothesis or concept question instead");
    // No instruction elsewhere in the composed prompt contradicts asking inline.
    expect(p).not.toMatch(/do not end your turn just to ask/);
    expect(p).not.toMatch(/^- (hypothesis|concept):/m);
    // Projects keep the checkpoint-driven Learn gate.
    const project = composeSystemPrompt(resolveEffectivePolicy("learn", "default", false));
    expect(project).toContain("ask a hypothesis or concept question instead");
    expect(project).not.toMatch(/ask teaching questions/);
  });

  it("session titles from a runtime drop Markdown markers", () => {
    expect(plainTitle("I'm preparing for a **Cloudflare Systems Engineering – Metrics** interview")).toBe("I'm preparing for a Cloudflare Systems Engineering – Metrics interview");
    expect(plainTitle("## Fix `rate()` in _alerts.yml_")).toBe("Fix rate() in alerts.yml");
    expect(plainTitle("See [the docs](https://x.dev) ~~now~~")).toBe("See the docs now");
    expect(plainTitle("snake_case_name and 2 * 3 * 4")).toBe("snake_case_name and 2 * 3 * 4");
    // Content survives: code spans keep their text, literal operators stay.
    expect(plainTitle("Fix `__init__` in `foo__bar`")).toBe("Fix __init__ in foo__bar");
    expect(plainTitle("Evaluate 2 ** 3")).toBe("Evaluate 2 ** 3");
    expect(plainTitle("Use __dunder__ names")).toBe("Use dunder names");
    // Syntax goes.
    expect(plainTitle("Review (*parser*)")).toBe("Review (parser)");
    expect(plainTitle("1. Fix the parser")).toBe("Fix the parser");
    expect(plainTitle("Check\n~~~yaml\nkey: value\n~~~\nnow")).toBe("Check now");
    expect(plainTitle("See [docs](https://en.wikipedia.org/wiki/Foo_(bar))")).toBe("See docs");
    expect(plainTitle("> quoted **ask**")).toBe("quoted ask");
  });

  it("search finds chats and sessions by title across Chats and projects, most recent first", async () => {
    const chats = store.ensureGeneralWorkspace(join(dir, "chats"));
    const project = service.addWorkspace(join(dir, "project"));
    const a = await service.createSession(chats.id, {});
    const b = await service.createSession(project.id, {});
    const c = await service.createSession(project.id, {});
    await service.updateSession(a.id, { title: "Indexing concepts" });
    await service.updateSession(b.id, { title: "Fix the INDEX migration" });
    await service.updateSession(c.id, { title: "100% coverage for snake_case parser" });
    // Distinct activity times: a oldest, c newest.
    for (const [id, t] of [[a.id, 1000], [b.id, 2000], [c.id, 3000]] as const) store.db.prepare("UPDATE sessions SET updated_at = ? WHERE id = ?").run(t, id);

    expect(store.searchSessions("index").map((s) => s.title)).toEqual(["Fix the INDEX migration", "Indexing concepts"]);
    // % and _ are literal characters, not wildcards.
    expect(store.searchSessions("100%").map((s) => s.id)).toEqual([c.id]);
    expect(store.searchSessions("e_c").map((s) => s.id)).toEqual([c.id]);
    expect(store.searchSessions("x%y")).toEqual([]);
    // Case folding beyond ASCII.
    await service.updateSession(a.id, { title: "ÉCOLE migration · ПРИВЕТ" });
    expect(store.searchSessions("école").map((s) => s.id)).toEqual([a.id]);
    expect(store.searchSessions("привет").map((s) => s.id)).toEqual([a.id]);
    await service.updateSession(a.id, { title: "Indexing concepts" });
    store.db.prepare("UPDATE sessions SET updated_at = 1000 WHERE id = ?").run(a.id);
    // Empty query: recent sessions everywhere.
    expect(store.searchSessions("   ").map((s) => s.id)).toEqual([c.id, b.id, a.id]);
    expect(store.searchSessions("", 2)).toHaveLength(2);

    const app = createApp({ service, hub: new EventHub(), apiToken: "api", bridgeToken: "b", allowedOrigins: [] });
    const res = await app.request(`/api/sessions?q=${encodeURIComponent("concepts")}`, { headers: { authorization: "Bearer api" } });
    expect(res.status).toBe(200);
    expect(((await res.json()) as { id: string }[]).map((s) => s.id)).toEqual([a.id]);
    expect((await app.request("/api/sessions?q=x")).status).toBe(401);
  });
});
