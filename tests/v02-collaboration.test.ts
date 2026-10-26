// Peer v0.2, the collaboration experience: two modes, contextual controls that are temporary
// overrides, and adaptive (not quota-based) involvement of the developer. Deterministic: the
// engine is driven through the same entry points the runtimes and the UI use, with a fake runtime.
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../src/server/app.js";
import { CONTINUATION_TEXT, DECISION_DECLINE } from "../src/server/collaboration/engine.js";
import { isGoAhead, parseIntent } from "../src/server/collaboration/intent.js";
import { EventHub } from "../src/server/hub.js";
import { ClaudeCodeAdapter } from "../src/server/runtime/claude/adapter.js";
import { CodexAdapter } from "../src/server/runtime/codex/adapter.js";
import { TestEvidence } from "../src/server/runtime/codex/normalize.js";
import { RuntimeSet } from "../src/server/runtime/set.js";
import type { Transcript } from "../src/server/runtime/transcript.js";
import { PeerService } from "../src/server/service.js";
import { Store } from "../src/server/store.js";
import { MODE_CONTROLS } from "../src/renderer/modes.js";
import { PRIMARY_MODES, type CheckpointAction, type CheckpointCategory, type PeerSession, type RuntimeKind, type TurnIntent } from "../src/shared/types.js";
import { FakeRuntime } from "./helpers.js";

let dir: string;
let store: Store;
let runtime: FakeRuntime;
let service: PeerService;

function setup(kind: RuntimeKind = "opencode", file = ":memory:") {
  store = new Store(file);
  runtime = new FakeRuntime(kind);
  service = new PeerService(store, new RuntimeSet([runtime]), new EventHub());
}

beforeEach(() => {
  dir = realpathSync(mkdtempSync(join(tmpdir(), "peer-v02-")));
  writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "app", dependencies: {} }));
  setup();
});

afterEach(() => {
  try {
    store.close();
  } catch {
    // already closed by a persistence test
  }
  rmSync(dir, { recursive: true, force: true });
});

const engine = () => service.engine;
const tick = () => new Promise((r) => setImmediate(r));

async function newSession(mode?: PeerSession["mode"]) {
  const ws = service.addWorkspace(dir);
  return service.createSession(ws.id, { mode });
}

const idle = (s: PeerSession) => runtime.emit({ type: "session.idle", sessionId: s.runtimeSessionId });
const system = () => runtime.lastPrompt().input.system ?? "";
const write = (s: PeerSession) => engine().checkTool(s.runtimeSessionId, "write", { filePath: "x.js", content: "x" });
const ask = (s: PeerSession, category: CheckpointCategory, question: string, extra: Record<string, unknown> = {}) =>
  engine().requestCheckpoint(s.runtimeSessionId, null, { category, question, ...extra });
const resolve = (id: string, action: CheckpointAction, extra: { text?: string; option?: string } = {}) => engine().resolveCheckpoint(id, { action, ...extra });
const install = (s: PeerSession, pkg = "zod") => engine().checkTool(s.runtimeSessionId, "bash", { command: `npm install ${pkg}` });
const pending = (s: PeerSession) => store.listCheckpoints(s.id).filter((c) => c.status === "pending");
const turn = (s: PeerSession) => store.latestTurn(s.id)!;

/** An install the agent runs in-process: it waits while Peer holds it on a checkpoint. */
async function held(s: PeerSession, pkg = "zod") {
  const call = install(s, pkg);
  await tick();
  const cp = pending(s).find((c) => c.source === "peer");
  expect(cp).toBeDefined();
  return { call, cp: cp! };
}

/** A Learn task whose lock the developer opened by answering a question. */
async function engagedLearnTask(s: PeerSession, text = "add ETag support") {
  await service.send(s.id, text);
  const { checkpoint } = await ask(s, "hypothesis", "What should the ETag be based on?");
  await resolve(checkpoint!.id, "answer", { text: "A hash of the list" });
  expect((await write(s)).allow).toBe(true);
}

// ---------------------------------------------------------------------------

describe("two modes: Collaborate (default) and Learn", () => {
  it("offers Collaborate and Learn; Focus is retired but existing Focus sessions still work", async () => {
    expect(PRIMARY_MODES).toEqual(["collaborate", "learn"]);
    expect((await newSession()).mode).toBe("collaborate");
    // A Focus default stored by an older version is not used for new sessions.
    store.setPreferences({ defaultMode: "focus" });
    expect((await newSession()).mode).toBe("collaborate");
    store.setPreferences({ defaultMode: "learn" });
    expect((await newSession()).mode).toBe("learn");
    // Asked for explicitly (API compatibility), Focus still runs, and can be switched away from.
    const focus = await newSession("focus");
    await service.send(focus.id, "task");
    expect(system()).toContain("Active mode: Focus");
    idle(focus);
    expect(service.updateSession(focus.id, { mode: "collaborate" }).mode).toBe("collaborate");
  });

  it("the preferences API refuses Focus as a default", async () => {
    const app = createApp({ service, hub: new EventHub(), apiToken: "api", bridgeToken: "b", allowedOrigins: [] });
    const patch = (body: unknown) => app.request("/api/preferences", { method: "PATCH", headers: { authorization: "Bearer api", "content-type": "application/json" }, body: JSON.stringify(body) });
    expect((await patch({ defaultMode: "focus" })).status).toBe(400);
    expect((await patch({ defaultMode: "learn" })).status).toBe(200);
  });

  it("Collaborate is a teammate: decides what matters together, challenges with evidence, executes mechanical work", async () => {
    const s = await newSession("collaborate");
    await service.send(s.id, "task");
    const p = system();
    expect(p).toContain("Active mode: Collaborate");
    expect(p).toMatch(/Collaborate on the decisions that matter: architecture/);
    expect(p).toMatch(/Challenge assumptions when you have a concrete reason/);
    expect(p).toMatch(/If their hypothesis about a bug is wrong, say so plainly and show why/);
    expect(p).toMatch(/Execute mechanical work independently/);
    expect(p).toMatch(/Avoid unnecessary questions/);
    expect(p).toContain("Code changes: allowed.");
  });

  it("Learn builds understanding while completing the task, and is not a quiz", async () => {
    const s = await newSession("learn");
    await service.send(s.id, "task");
    const p = system();
    expect(p).toContain("Active mode: Learn");
    expect(p).toMatch(/you complete the task/);
    expect(p).toMatch(/invite the developer to reason first/);
    expect(p).toMatch(/Name a misconception plainly.*Do not praise by default/);
    expect(p).toMatch(/Guide progressively/);
    expect(p).toMatch(/Do not become a quiz/);
    expect(p).toMatch(/Do boilerplate, mechanical edits and routine follow-ups normally/);
  });

  it("the same task behaves differently in each mode", async () => {
    const task = "Clients re-download the whole note list. Add ETag support.";
    const collab = await newSession("collaborate");
    const learn = await newSession("learn");
    await service.send(collab.id, task);
    const collabPrompt = system();
    await service.send(learn.id, task);
    const learnPrompt = system();
    expect(collabPrompt).not.toBe(learnPrompt);

    // Collaborate: code changes allowed; the developer is not quizzed.
    expect((await write(collab)).allow).toBe(true);
    const quiz = await ask(collab, "hypothesis", "What do you think an ETag is based on?");
    expect(quiz.checkpoint!.status).toBe("auto_resolved");
    expect(quiz.output).toMatch(/Collaborate mode leaves hypothesis decisions to you/);
    expect((await ask(collab, "tradeoff", "Weak or strong ETags?")).checkpoint!.status).toBe("pending");

    // Learn: locked until the developer reasons about it.
    expect((await write(learn)).allow).toBe(false);
    const { checkpoint } = await ask(learn, "hypothesis", "What do you think an ETag is based on?");
    expect(checkpoint!.status).toBe("pending");
    await resolve(checkpoint!.id, "answer", { text: "The server start time" });
    expect((await write(learn)).allow).toBe(true);

    // A new dependency: pick-one in Collaborate, the developer's reasoning in Learn.
    await resolve(pending(collab)[0]!.id, "answer", { text: "Strong" });
    const a = await held(collab, "etag");
    expect(a.cp.decision!.style).toBe("choice");
    const b = await held(learn, "etag");
    expect(b.cp.decision!.style).toBe("reasoning");
  });
});

describe("adaptive involvement, not question quotas", () => {
  it("tells the agent to weigh each decision, with a ceiling that is not a target", async () => {
    const s = await newSession("collaborate");
    await service.send(s.id, "task");
    const p = system();
    expect(p).toContain("Decide for each decision, not by quota.");
    expect(p).toMatch(/has not already decided it/);
    expect(p).toMatch(/mechanical or routine work needs no question/);
    expect(p).toMatch(/when they delegate or answer with a short go-ahead, ask less/);
    expect(p).toMatch(/That is a ceiling, not a target/);
    expect(p).not.toMatch(/At most \d+ checkpoint/);
  });

  it("Learn does not interrupt routine work: the agent declares it and code changes unlock without a question", async () => {
    const s = await newSession("learn");
    await service.send(s.id, "Rename createNote to addNote everywhere.");
    expect(system()).toMatch(/category "routine"/);
    expect(await write(s)).toMatchObject({ allow: false, reason: expect.stringMatching(/If the work is routine.*category "routine" instead of asking/) });
    const { checkpoint, output } = await ask(s, "routine", "Mechanical rename of createNote to addNote across src and tests.");
    expect(checkpoint!.status).toBe("auto_resolved");
    expect(output).toMatch(/routine work without asking the developer\. Code changes are now unlocked/);
    expect(pending(s)).toHaveLength(0);
    expect((await write(s)).allow).toBe(true);
    expect(store.listEvents(s.id).find((e) => e.type === "checkpoint.routine")?.payload.unlocked).toBe(true);
    // It is not a question: the ceiling is untouched.
    for (const q of ["A?", "B?", "C?"]) {
      const { checkpoint: c } = await ask(s, "tradeoff", q);
      expect(c!.status, q).toBe("pending");
      await resolve(c!.id, "answer", { text: "ok" });
    }
  });

  it("the developer can say it is not routine: the lock closes again and the agent must ask", async () => {
    const s = await newSession("learn");
    await service.send(s.id, "Add ETag support");
    const { checkpoint } = await ask(s, "routine", "Add ETag support");
    expect((await write(s)).allow).toBe(true);
    const contested = engine().contestRoutine(checkpoint!.id);
    expect(contested.resolution!.note).toMatch(/not routine; code changes locked again/);
    const denied = await write(s);
    expect(denied).toMatchObject({ allow: false, explain: true, reason: expect.stringMatching(/The developer said this task is not routine work: ask them your question/) });
    // A second routine declaration in this task is refused.
    const again = await ask(s, "routine", "It really is routine");
    expect(again.output).toMatch(/did not accept this: the developer said this task is not routine/);
    expect((await write(s)).allow).toBe(false);
    expect(() => engine().contestRoutine(checkpoint!.id)).toThrow(/Only routine work that unlocked/);
    // Engaging opens it, as usual.
    const q = await ask(s, "hypothesis", "What should the ETag be based on?");
    await resolve(q.checkpoint!.id, "answer", { text: "A hash of the list" });
    expect((await write(s)).allow).toBe(true);
    // Once the task has ended there is nothing to contest.
    const t2 = await newSession("learn");
    await service.send(t2.id, "rename x");
    const r = await ask(t2, "routine", "rename");
    idle(t2);
    expect(() => engine().contestRoutine(r.checkpoint!.id)).toThrow(/no longer running/);
  });

  it("on Codex, contested routine work does not continue in a writable turn", async () => {
    runtime.sandboxFixedPerTurn = true;
    const s = await newSession("learn");
    await service.send(s.id, "Add ETag support");
    const { checkpoint } = await ask(s, "routine", "Add ETag support");
    engine().contestRoutine(checkpoint!.id);
    idle(s);
    await tick();
    expect(runtime.prompts).toHaveLength(1);
  });

  it("routine work cannot open Give me a hint or Discuss first, and is a no-op where nothing is locked", async () => {
    const learn = await newSession("learn");
    await service.send(learn.id, "Why is this slow?", "hint");
    const r1 = await ask(learn, "routine", "Formatting");
    expect(r1.output).toMatch(/stay locked/);
    expect((await write(learn)).allow).toBe(false);

    const collab = await newSession("collaborate");
    await service.send(collab.id, "caching", "discuss");
    expect((await ask(collab, "routine", "Formatting")).output).toMatch(/stay locked/);
    expect((await write(collab)).allow).toBe(false);

    const open = await newSession("collaborate");
    await service.send(open.id, "task");
    expect((await ask(open, "routine", "Formatting")).output).toMatch(/Continue\.$/);
  });

  it("on Codex, routine work in Learn continues in a writable turn", async () => {
    runtime.sandboxFixedPerTurn = true;
    const s = await newSession("learn");
    await service.send(s.id, "rename a helper");
    expect((await ask(s, "routine", "Rename")).output).toMatch(/sandbox stays read-only.*end your turn/);
    idle(s);
    await tick();
    expect(runtime.prompts).toHaveLength(2);
    expect(runtime.lastPrompt().input).toMatchObject({ text: CONTINUATION_TEXT, gate: "open" });
  });

  it("after consecutive hands-off responses fewer kinds of questions reach the developer; engaging restores them", async () => {
    const s = await newSession("collaborate");
    await service.send(s.id, "add caching", "delegate");
    idle(s);
    await service.send(s.id, "add metrics", "delegate");
    idle(s);
    await service.send(s.id, "add pagination");
    expect(system()).toMatch(/Adapted for this session: The developer's last responses handed decisions back/);
    const tradeoff = await ask(s, "tradeoff", "Offset or cursor?");
    expect(tradeoff.checkpoint!.status).toBe("auto_resolved");
    expect(tradeoff.output).toMatch(/handed their last decisions back/);
    // Consequential decisions still reach them.
    const arch = await ask(s, "architecture", "Change the list response shape?");
    expect(arch.checkpoint!.status).toBe("pending");
    await resolve(arch.checkpoint!.id, "answer", { text: "Yes, wrap it in { items, next }" });
    // They engaged: trade-offs reach them again.
    expect((await ask(s, "tradeoff", "Page size 20 or 50?")).checkpoint!.status).toBe("pending");
  });

  it("proceeding on a question after a discussion counts as engaging", async () => {
    const s = await newSession("collaborate");
    await service.send(s.id, "add caching", "delegate");
    idle(s);
    await service.send(s.id, "add metrics", "delegate");
    idle(s);
    await service.send(s.id, "add pagination");
    const arch = await ask(s, "architecture", "Change the response shape?");
    await resolve(arch.checkpoint!.id, "discuss");
    const req = await ask(s, "requirement", "Keep the old endpoint?");
    await resolve(req.checkpoint!.id, "skip", { text: "Yes, keep it compatible, and proceed." });
    // The last two responses are Discuss first and Proceed: trade-offs reach them again.
    expect((await ask(s, "tradeoff", "Offset or cursor?")).checkpoint!.status).toBe("pending");
  });

  it("Proceed alone resets hands-off adaptation", async () => {
    const s = await newSession("collaborate");
    await service.send(s.id, "add caching", "delegate");
    idle(s);
    await service.send(s.id, "add metrics", "delegate");
    idle(s);
    await service.send(s.id, "add pagination");
    const arch = await ask(s, "architecture", "Change the response shape?");
    await resolve(arch.checkpoint!.id, "skip", { text: "Yes, wrap the response in items and next, and proceed." });
    expect((await ask(s, "tradeoff", "Offset or cursor?")).checkpoint!.status).toBe("pending");
  });

  it("in Learn, repeated Direct answers narrow it to the key question", async () => {
    const s = await newSession("learn");
    await service.send(s.id, "what does this regex do?", "answer");
    idle(s);
    await service.send(s.id, "and this one?", "answer");
    idle(s);
    await service.send(s.id, "add input validation");
    expect(system()).toMatch(/asked for direct answers or handed questions back/);
    expect((await ask(s, "concept", "Do you know what a regex anchor is?")).checkpoint!.status).toBe("auto_resolved");
    expect((await ask(s, "hypothesis", "Where should validation live?")).checkpoint!.status).toBe("pending");
  });

  it("Peer's own dependency questions are not hands-off signals", async () => {
    const s = await newSession("collaborate");
    await service.send(s.id, "task");
    for (const pkg of ["zod", "pino"]) {
      const { call, cp } = await held(s, pkg);
      await resolve(cp.id, "delegate");
      await call;
    }
    expect((await ask(s, "tradeoff", "Sync or async logging?")).checkpoint!.status).toBe("pending");
  });

  it("gives the agent the decisions the developer already made in this session", async () => {
    const s = await newSession("collaborate");
    await service.send(s.id, "make notes persist");
    const a = await ask(s, "tradeoff", "LRU or TTL eviction?", { options: [{ label: "LRU" }, { label: "TTL" }] });
    await resolve(a.checkpoint!.id, "choose", { option: "TTL" });
    const b = await ask(s, "architecture", "Where should notes persist?");
    await resolve(b.checkpoint!.id, "answer", { text: "A SQLite file next to the server" });
    const h = await ask(s, "tradeoff", "Which index do you think we need?");
    await resolve(h.checkpoint!.id, "hint");
    // A hint now holds this turn; finish it before testing a separate dependency decision.
    idle(s);
    await service.send(s.id, "now consider a date library");
    const { call, cp } = await held(s, "moment");
    await resolve(cp.id, "choose", { option: DECISION_DECLINE });
    await call;
    idle(s);
    await service.send(s.id, "now add a test");
    const p = system();
    expect(p).toContain("## Already decided in this session");
    expect(p).toContain('"LRU or TTL eviction?": they chose "TTL".');
    expect(p).toContain('"Where should notes persist?": they answered "A SQLite file next to the server".');
    expect(p).toContain("Adding `moment`: declined (do not add it).");
    // A hint is not a decision.
    expect(p).not.toContain("Which index");
  });

  it("decisions from an undone turn no longer count", async () => {
    const s = await newSession("collaborate");
    await service.send(s.id, "task");
    const a = await ask(s, "tradeoff", "LRU or TTL eviction?");
    await resolve(a.checkpoint!.id, "answer", { text: "TTL" });
    const undone = turn(s).id;
    idle(s);
    store.markTurnsUndone([undone]);
    await service.send(s.id, "again");
    expect(system()).not.toContain("Already decided");
    // And the question may be asked again.
    expect((await ask(s, "tradeoff", "LRU or TTL eviction?")).checkpoint!.status).toBe("pending");
  });
});

describe("Collaborate controls", () => {
  describe("Just do it", () => {
    it("as a message: no optional questions for this task; risk still asked; dependencies noted, not asked", async () => {
      const s = await newSession("collaborate");
      await service.send(s.id, "add caching", "delegate");
      expect(turn(s).intent).toBe("delegate");
      expect(system()).toMatch(/"Just do it": they delegated this task.*permission prompts and safety rules apply/);
      expect((await write(s)).allow).toBe(true);
      const t = await ask(s, "tradeoff", "LRU or TTL?");
      expect(t.checkpoint!.status).toBe("auto_resolved");
      expect(t.output).toMatch(/"Just do it" leaves tradeoff decisions to you/);
      expect((await ask(s, "risk", "Drop the cache table?")).checkpoint!.status).toBe("pending");
      await resolve(pending(s)[0]!.id, "answer", { text: "No" });
      expect(await install(s, "lru-cache")).toEqual({ allow: true });
      expect(store.listCheckpoints(s.id).find((c) => c.decision)?.status).toBe("auto_resolved");
      // Temporary: the mode is unchanged and the next task asks again.
      idle(s);
      expect(store.getSession(s.id)!.mode).toBe("collaborate");
      await service.send(s.id, "add metrics");
      expect(turn(s).intent).toBe("default");
      expect((await ask(s, "tradeoff", "Counter or histogram?")).checkpoint!.status).toBe("pending");
    });

    it("on an open question: the rest of the task runs without optional questions", async () => {
      const s = await newSession("collaborate");
      await service.send(s.id, "add caching");
      const q = await ask(s, "tradeoff", "LRU or TTL?", { recommendation: "TTL" });
      const resolved = await resolve(q.checkpoint!.id, "go");
      expect(await engine().waitForCheckpoint(resolved.id, 100)).toMatch(/"Just do it": proceed with the rest of this task without further optional questions.*you recommended "TTL"/);
      expect(turn(s).intent).toBe("delegate");
      expect((await ask(s, "architecture", "New module?")).checkpoint!.status).toBe("auto_resolved");
      expect(await install(s, "lru-cache")).toEqual({ allow: true });
      expect((await ask(s, "risk", "Delete old cache files?")).checkpoint!.status).toBe("pending");
    });

    it("on Peer's dependency question: the held call runs once, and later ones are noted", async () => {
      const s = await newSession("collaborate");
      await service.send(s.id, "validate input");
      const { call, cp } = await held(s);
      await resolve(cp.id, "go");
      expect(await call).toEqual({ allow: true });
      expect(await install(s, "pino")).toEqual({ allow: true });
      expect(pending(s)).toHaveLength(0);
    });

    it("lasts across a Codex continuation", async () => {
      runtime.sandboxFixedPerTurn = true;
      const s = await newSession("learn");
      await service.send(s.id, "add ETag support");
      const q = await ask(s, "hypothesis", "What should the ETag be based on?");
      await resolve(q.checkpoint!.id, "go");
      idle(s);
      await tick();
      expect(runtime.prompts).toHaveLength(2);
      expect(runtime.lastPrompt().input).toMatchObject({ text: CONTINUATION_TEXT, gate: "open" });
      expect(system()).toMatch(/"Just do it"/);
      expect(turn(s).intent).toBe("delegate");
      expect((await ask(s, "tradeoff", "Weak or strong?")).checkpoint!.status).toBe("auto_resolved");
    });

    it("does not bypass destructive-command approvals or permission prompts", async () => {
      const s = await newSession("collaborate");
      await service.send(s.id, "clean up", "delegate");
      // Claude Code's gate hook, on Peer's engine: the gate allows, the safety rule still asks.
      const adapter = new ClaudeCodeAdapter({ hooks: { checkTool: (id: string, t: string, a: unknown, sig?: AbortSignal) => engine().checkTool(id, t, a, sig) }, log: () => {} } as unknown as ConstructorParameters<typeof ClaudeCodeAdapter>[0]);
      const hook = (adapter as unknown as { gateHook(s: string, r: unknown): (i: unknown, id: string | undefined, o: { signal: AbortSignal }) => Promise<unknown> }).gateHook(s.runtimeSessionId, { abort: new AbortController() });
      const out = await hook({ hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command: "rm -rf build" } }, "tu1", { signal: new AbortController().signal });
      expect(out).toMatchObject({ hookSpecificOutput: { permissionDecision: "ask" } });
      // The runtime's own permission requests still reach the developer.
      runtime.emit({ type: "permission.asked", request: { id: "perm_1", sessionId: s.runtimeSessionId, permission: "bash", patterns: ["git push"], metadata: {} } });
      await new Promise((r) => setTimeout(r, 0));
      expect(service.snapshot(s.id).permissions.map((p) => p.id)).toEqual(["perm_1"]);
    });
  });

  describe("Discuss first", () => {
    it("lasts across follow-up messages until the developer chooses to proceed", async () => {
      const s = await newSession("collaborate");
      await service.send(s.id, "How should we cache notes?", "discuss");
      expect(turn(s)).toMatchObject({ intent: "discuss", gate: "hold" });
      expect(store.getSession(s.id)!.discussing).toBe(true);
      expect(system()).toMatch(/"Discuss first".*Peer keeps code changes locked until the developer chooses to proceed/);
      expect(await write(s)).toMatchObject({ allow: false, reason: expect.stringMatching(/no code changes until they choose to proceed; continue the discussion/) });
      expect(engine().gateFor(s.id).reason).toMatch(/Discussing: no code changes until you choose to proceed/);
      idle(s);

      await service.send(s.id, "What about Redis instead?");
      expect(turn(s).intent).toBe("discuss");
      expect(system()).toMatch(/You are still discussing the approach/);
      expect((await write(s)).allow).toBe(false);
      idle(s);

      // A go-ahead with more to it keeps discussing.
      await service.send(s.id, "go ahead and compare both");
      expect(turn(s).intent).toBe("discuss");
      idle(s);

      await service.send(s.id, "OK, go ahead.");
      expect(turn(s)).toMatchObject({ intent: "proceed", gate: "open" });
      expect(system()).toMatch(/chose to proceed with the approach you discussed/);
      expect(runtime.lastPrompt().input.text).toBe("OK, go ahead.");
      expect((await write(s)).allow).toBe(true);
      expect(store.getSession(s.id)!.discussing).toBe(false);
      expect(store.getSession(s.id)!.mode).toBe("collaborate");
    });

    it("ends with Proceed, Just do it, a mode switch, or ending it; a hint keeps it", async () => {
      const s = await newSession("collaborate");
      const discuss = async () => {
        await service.send(s.id, "caching?", "discuss");
        idle(s);
      };
      await discuss();
      await service.send(s.id, "", "proceed");
      expect(runtime.lastPrompt().input.text).toBe("Go ahead with the approach we discussed.");
      expect(store.getSession(s.id)!.discussing).toBe(false);
      idle(s);

      await discuss();
      await service.send(s.id, "/go");
      expect(turn(s).intent).toBe("delegate");
      expect(store.getSession(s.id)!.discussing).toBe(false);
      idle(s);

      await discuss();
      await service.send(s.id, "any hint?", "hint");
      expect(store.getSession(s.id)!.discussing).toBe(true);
      idle(s);
      service.updateSession(s.id, { discussing: false });
      expect(store.getSession(s.id)!.discussing).toBe(false);
      await service.send(s.id, "next");
      expect(turn(s).intent).toBe("default");
      idle(s);

      await discuss();
      service.updateSession(s.id, { mode: "learn" });
      expect(store.getSession(s.id)!.discussing).toBe(false);
      expect(store.listEvents(s.id).some((e) => e.type === "discussion.ended" && e.payload.by === "mode.changed")).toBe(true);
    });

    it("on an open question mid-turn: code changes lock again until the developer proceeds", async () => {
      const s = await newSession("collaborate");
      await service.send(s.id, "add caching");
      expect((await write(s)).allow).toBe(true);
      const q = await ask(s, "tradeoff", "LRU or TTL?");
      const resolved = await resolve(q.checkpoint!.id, "discuss", { text: "Not sure we need a cache at all" });
      expect(await engine().waitForCheckpoint(resolved.id, 100)).toMatch(/wants to discuss this before any further code changes: "Not sure we need a cache at all".*Code changes are locked/);
      expect(turn(s).intent).toBe("discuss");
      expect(store.getSession(s.id)!.discussing).toBe(true);
      expect((await write(s)).allow).toBe(false);
      expect(engine().gateFor(s.id)).toMatchObject({ kind: "hold", locked: true });
      // The agent doesn't ask for a go-ahead while discussing: the developer proceeds themselves.
      const goAhead = await ask(s, "confirm", "Implement the cache now?");
      expect(goAhead.checkpoint!.status).toBe("auto_resolved");
      expect(goAhead.output).toMatch(/did not ask the developer for a go-ahead: while discussing, they choose when to proceed/);
      // Answering a question is not proceeding.
      const c1 = await ask(s, "tradeoff", "Measure first, or cache now?");
      await resolve(c1.checkpoint!.id, "answer", { text: "Measure first" });
      expect((await write(s)).allow).toBe(false);
      // Proceed releases it, without a duplicate turn.
      const c2 = await ask(s, "requirement", "Which endpoints need caching?");
      const out = await resolve(c2.checkpoint!.id, "skip");
      expect(engine().agentOutput(out)).toMatch(/Code changes are now unlocked\.$/);
      expect((await write(s)).allow).toBe(true);
      expect(store.getSession(s.id)!.discussing).toBe(false);
    });

    it("on Codex, discussing and proceeding inside a writable turn does not start a continuation", async () => {
      runtime.sandboxFixedPerTurn = true;
      const s = await newSession("collaborate");
      await service.send(s.id, "add caching");
      const q = await ask(s, "tradeoff", "LRU or TTL?");
      await resolve(q.checkpoint!.id, "discuss");
      const c = await ask(s, "requirement", "Which endpoints?");
      const out = await resolve(c.checkpoint!.id, "skip");
      // The turn's sandbox was writable all along: no "end your turn" and no second turn.
      expect(engine().agentOutput(out)).not.toMatch(/read-only/);
      idle(s);
      await tick();
      expect(runtime.prompts).toHaveLength(1);
    });

    it("Proceed on a question retires the discussion policy for the rest of the turn", async () => {
      const s = await newSession("collaborate");
      await service.send(s.id, "Implement a cache", "discuss");
      const q = await ask(s, "tradeoff", "TTL or LRU?");
      await resolve(q.checkpoint!.id, "skip", { text: "Use TTL; proceed with the approach we discussed." });
      expect(turn(s).intent).toBe("proceed");
      expect((await write(s)).allow).toBe(true);
      // A later go-ahead question is an ordinary question again, not a "do not modify files" decline.
      const confirm = await ask(s, "confirm", "Also update the public response contract?");
      expect(confirm.checkpoint!.status).toBe("pending");
      expect(confirm.output ?? "").not.toMatch(/Do not modify files/);
    });

    it("on Codex, Proceed after a locked discussion continues as Proceed", async () => {
      runtime.sandboxFixedPerTurn = true;
      const s = await newSession("collaborate");
      await service.send(s.id, "Implement a cache", "discuss");
      const q = await ask(s, "tradeoff", "TTL or LRU?");
      await resolve(q.checkpoint!.id, "skip");
      idle(s);
      await tick();
      expect(runtime.prompts).toHaveLength(2);
      expect(runtime.lastPrompt().input).toMatchObject({ text: CONTINUATION_TEXT, gate: "open" });
      expect(turn(s).intent).toBe("proceed");
      expect(system()).toMatch(/chose to proceed with the approach you discussed/);
    });

    it("a typed reply that only says go ahead is the choice to proceed", async () => {
      const s = await newSession("collaborate");
      await service.send(s.id, "caching?", "discuss");
      const q = await ask(s, "tradeoff", "TTL or LRU?");
      await service.send(s.id, "Sounds good, go ahead");
      expect(store.getCheckpoint(q.checkpoint!.id)!.resolution).toMatchObject({ action: "skip" });
      expect((await write(s)).allow).toBe(true);
    });

    it("on Peer's dependency question: not run, discussed, and asked again once the developer proceeds", async () => {
      const s = await newSession("collaborate");
      await service.send(s.id, "validate input");
      const { call, cp } = await held(s);
      await resolve(cp.id, "discuss", { text: "Could we hand-roll it?" });
      expect(await call).toMatchObject({ allow: false, reason: expect.stringMatching(/wants to discuss it before any code changes \("Could we hand-roll it\?"\)/) });
      // A retry while discussing is stopped by the lock, without a second question.
      expect((await install(s)).allow).toBe(false);
      expect(pending(s)).toHaveLength(0);
      idle(s);
      await service.send(s.id, "proceed");
      expect(turn(s).intent).toBe("proceed");
      await held(s);
    });

    it("Stop cancels the open question and keeps the discussion for the next message", async () => {
      const s = await newSession("collaborate");
      await service.send(s.id, "caching?", "discuss");
      const q = await ask(s, "tradeoff", "LRU or TTL?");
      await service.abort(s.id);
      expect(store.getCheckpoint(q.checkpoint!.id)!.status).toBe("cancelled");
      expect(runtime.aborted).toContain(s.runtimeSessionId);
      expect(store.getSession(s.id)!.discussing).toBe(true);
      idle(s);
      await service.send(s.id, "what about Redis?");
      expect(turn(s).intent).toBe("discuss");
    });
  });

  it("go-ahead phrases are recognized only when that is all the message says", () => {
    for (const yes of ["go ahead", "Go ahead.", "OK, proceed", "lgtm, ship it", "Sounds good, go ahead!", "yes please go ahead", "let's do it", "Proceed now"]) expect(isGoAhead(yes), yes).toBe(true);
    for (const no of ["go ahead and compare both", "don't go ahead", "not yet", "should we go ahead?", "go", "yes", "proceed with Redis instead", "ok"]) expect(isGoAhead(no), no).toBe(false);
    expect(parseIntent("/proceed with the plan")).toEqual({ intent: "proceed", text: "with the plan" });
  });
});

describe("Learn controls", () => {
  describe("Give me a hint", () => {
    it("a checkpoint hint holds a fixed-sandbox turn without starting a writable continuation", async () => {
      runtime.sandboxFixedPerTurn = true;
      const s = await newSession("learn");
      await engagedLearnTask(s);
      const q = await ask(s, "tradeoff", "Which cache invalidation rule?");
      await resolve(q.checkpoint!.id, "hint");
      expect(turn(s)).toMatchObject({ intent: "hint", engagedAt: null });
      expect(engine().gateFor(s.id)).toMatchObject({ kind: "hold", locked: true });
      const followup = await ask(s, "hypothesis", "What changes invalidate the list?");
      await resolve(followup.checkpoint!.id, "answer", { text: "Creating a note" });
      expect((await write(s)).allow).toBe(false);
      idle(s);
      await tick();
      expect(runtime.prompts).toHaveLength(1);
    });

    it("Direct answer explicitly releases a checkpoint hint hold", async () => {
      const s = await newSession("learn");
      await engagedLearnTask(s);
      const q = await ask(s, "tradeoff", "Which cache invalidation rule?");
      await resolve(q.checkpoint!.id, "hint");
      await ask(s, "routine", "Wire the helper");
      expect((await write(s)).allow).toBe(false);
      const followup = await ask(s, "hypothesis", "What changes invalidate the list?");
      await resolve(followup.checkpoint!.id, "direct");
      expect((await write(s)).allow).toBe(true);
      expect(turn(s).intent).toBe("answer");
    });

    it("one hint, no code changes in that turn, and each further hint goes one step further", async () => {
      const s = await newSession("learn");
      await service.send(s.id, "Why does /api/notes/ return 404?", "hint");
      expect(turn(s)).toMatchObject({ intent: "hint", gate: "hold" });
      expect(system()).toMatch(/Give the next useful hint.*without revealing the full solution/);
      expect(system()).not.toMatch(/hint 2/);
      expect((await write(s)).allow).toBe(false);
      idle(s);
      await service.send(s.id, "", "hint");
      expect(runtime.lastPrompt().input.text).toBe("Can I have a hint?");
      expect(system()).toMatch(/This is hint 2 on this problem: go one step beyond your earlier hints/);
      idle(s);
      await service.send(s.id, "still stuck", "hint");
      expect(system()).toMatch(/hint 3 on this problem.*several hints: you may point at the exact place/);
      idle(s);
      // Another message ends the run of hints.
      await service.send(s.id, "I think it is the trailing slash");
      idle(s);
      await service.send(s.id, "and the query string?", "hint");
      expect(system()).not.toMatch(/hint \d on this problem/);
      expect(store.getSession(s.id)!.mode).toBe("learn");
    });

    it("on an open question: one hint, then the agent asks again, and the lock stays", async () => {
      const s = await newSession("learn");
      await service.send(s.id, "fix the 404");
      const q = await ask(s, "hypothesis", "Why does the router miss /api/notes/?");
      await service.send(s.id, "", "hint");
      const cp = store.getCheckpoint(q.checkpoint!.id)!;
      expect(cp.resolution).toMatchObject({ action: "hint" });
      expect(await engine().waitForCheckpoint(cp.id, 100)).toMatch(/hint 1.*then ask again/);
      expect((await write(s)).allow).toBe(false);
      // Asking the same question again after a hint is the hint loop, not a repeat.
      expect((await ask(s, "hypothesis", "Why does the router miss /api/notes/?")).checkpoint!.status).toBe("pending");
    });
  });

  it("after hint turns, a Direct answer turn says plainly that code changes are allowed again", async () => {
    const s = await newSession("learn");
    await service.send(s.id, "Why does /api/notes/ 404?", "hint");
    expect(system()).not.toMatch(/That no longer applies/);
    idle(s);
    await service.send(s.id, "Just tell me and fix it", "answer");
    expect(system()).toMatch(/Code changes: allowed\.\n- Earlier turns in this conversation said not to change code\. That no longer applies/);
    expect((await write(s)).allow).toBe(true);
    idle(s);
    // Only right after a locked turn.
    await service.send(s.id, "Also handle the query string", "answer");
    expect(system()).not.toMatch(/That no longer applies/);
  });

  describe("Direct answer", () => {
    it("as a message: the answer directly, no Socratic questions, code changes allowed", async () => {
      const s = await newSession("learn");
      await service.send(s.id, "Why does /api/notes/ return 404?", "answer");
      expect(turn(s)).toMatchObject({ intent: "answer", gate: "open" });
      expect(system()).toMatch(/Answer the current question directly and completely.*without Socratic questions/);
      expect((await write(s)).allow).toBe(true);
      const q = await ask(s, "hypothesis", "What do you think the router compares?");
      expect(q.checkpoint!.status).toBe("auto_resolved");
      expect(q.output).toMatch(/They want the direct answer, not a question: answer it yourself/);
      const req = await ask(s, "requirement", "Should /api/notes/ redirect or answer directly?");
      expect(req.checkpoint!.status).toBe("pending");
      await resolve(req.checkpoint!.id, "answer", { text: "Answer directly" });
      // Temporary: the next task is gated again.
      idle(s);
      await service.send(s.id, "now add pagination");
      expect(turn(s)).toMatchObject({ intent: "default", gate: "engage" });
      expect((await write(s)).allow).toBe(false);
    });

    it("on an open question: the agent answers it, asks no more Socratic questions, and the lock opens", async () => {
      const s = await newSession("learn");
      await service.send(s.id, "fix the 404");
      const q = await ask(s, "hypothesis", "Why does the router miss /api/notes/?");
      await service.send(s.id, "", "answer");
      const cp = store.getCheckpoint(q.checkpoint!.id)!;
      expect(cp.resolution).toMatchObject({ action: "direct" });
      expect(await engine().waitForCheckpoint(cp.id, 100)).toMatch(/asked for the direct answer\. Answer your question yourself.*do not ask it again or quiz them.*Code changes are now unlocked/);
      expect(turn(s).intent).toBe("answer");
      expect((await write(s)).allow).toBe(true);
      expect((await ask(s, "concept", "Do you know what req.url contains?")).checkpoint!.status).toBe("auto_resolved");
    });

    it("on Peer's reasoning question about a dependency: the agent explains it, and the retry runs without asking", async () => {
      const s = await newSession("learn");
      await engagedLearnTask(s, "validate input");
      const { call, cp } = await held(s);
      expect(cp.decision!.style).toBe("reasoning");
      await resolve(cp.id, "direct");
      expect(await call).toMatchObject({ allow: false, reason: expect.stringMatching(/asked for the direct answer.*explain why this task needs `zod`/) });
      expect(await install(s)).toEqual({ allow: true });
      expect(pending(s)).toHaveLength(0);
    });
  });
});

describe("controls on an open question, from the composer", () => {
  const cases: [TurnIntent, CheckpointAction][] = [
    ["default", "answer"],
    ["delegate", "go"],
    ["discuss", "discuss"],
    ["hint", "hint"],
    ["answer", "direct"],
    ["proceed", "skip"],
  ];
  for (const [intent, action] of cases) {
    it(`${intent} answers with "${action}"`, async () => {
      const s = await newSession("collaborate");
      await service.send(s.id, "task");
      const q = await ask(s, "tradeoff", "A or B?");
      const result = await service.send(s.id, intent === "default" ? "A" : "", intent);
      expect(result.kind).toBe("checkpoint-answered");
      expect(store.getCheckpoint(q.checkpoint!.id)!.resolution!.action).toBe(action);
      // It answered the question; no new turn started.
      expect(runtime.prompts).toHaveLength(1);
    });
  }

  it("a plain answer still needs words; slash commands work as controls too", async () => {
    const s = await newSession("collaborate");
    await service.send(s.id, "task");
    const q = await ask(s, "tradeoff", "A or B?");
    await expect(service.send(s.id, "   ")).rejects.toThrow(/cannot be empty/);
    await service.send(s.id, "/go");
    expect(store.getCheckpoint(q.checkpoint!.id)!.resolution!.action).toBe("go");
  });
});

describe("no duplicate tool calls or repeated questions", () => {
  it("a question is resolved once; a second response is refused", async () => {
    const s = await newSession("collaborate");
    await service.send(s.id, "task");
    const q = await ask(s, "tradeoff", "A or B?");
    await resolve(q.checkpoint!.id, "go");
    await expect(resolve(q.checkpoint!.id, "go")).rejects.toThrow(/already resolved/);
    await expect(resolve(q.checkpoint!.id, "answer", { text: "A" })).rejects.toThrow(/already resolved/);
  });

  it("a question the developer already answered in this task is not asked again; the agent gets the earlier answer", async () => {
    const s = await newSession("collaborate");
    await service.send(s.id, "add caching");
    const q = await ask(s, "tradeoff", "Should notes be cached in memory?");
    await resolve(q.checkpoint!.id, "answer", { text: "No, keep it simple" });
    const again = await ask(s, "tradeoff", "  should notes be cached in memory  ");
    expect(again.checkpoint!).toMatchObject({ status: "auto_resolved", resolution: { repeatOf: q.checkpoint!.id } });
    expect(again.output).toMatch(/did not ask again.*in this task.*they answered "No, keep it simple".*Build on that answer/);
    expect(pending(s)).toHaveLength(0);
    // It doesn't count toward the ceiling, and a different question still reaches the developer.
    expect((await ask(s, "tradeoff", "Should notes be cached on disk?")).checkpoint!.status).toBe("pending");
    await resolve(pending(s)[0]!.id, "answer", { text: "no" });
    // Risk questions are always asked.
    const risk = await ask(s, "risk", "Delete the cache directory?");
    await resolve(risk.checkpoint!.id, "answer", { text: "yes" });
    expect((await ask(s, "risk", "Delete the cache directory?")).checkpoint!.status).toBe("pending");
  });

  it("a new task may ask the same words again (they may be about a different decision)", async () => {
    const s = await newSession("learn");
    await engagedLearnTask(s, "fix the 404");
    idle(s);
    await service.send(s.id, "now fix the 500 on POST");
    // Generic wording, a different problem: it reaches the developer, and answering opens Learn's lock.
    const again = await ask(s, "hypothesis", "What should the ETag be based on?");
    expect(again.checkpoint!.status).toBe("pending");
    await resolve(again.checkpoint!.id, "answer", { text: "different answer" });
    expect((await write(s)).allow).toBe(true);
  });

  it("a Codex continuation is the same task: it does not re-ask what was answered before it", async () => {
    runtime.sandboxFixedPerTurn = true;
    const s = await newSession("learn");
    await service.send(s.id, "add ETag support");
    const q = await ask(s, "hypothesis", "What should the ETag be based on?");
    await resolve(q.checkpoint!.id, "answer", { text: "A hash of the list" });
    idle(s);
    await tick();
    expect(runtime.lastPrompt().input.text).toBe(CONTINUATION_TEXT);
    const again = await ask(s, "hypothesis", "What should the ETag be based on?");
    expect(again.checkpoint!.status).toBe("auto_resolved");
    expect(again.output).toMatch(/they answered "A hash of the list"/);
  });
});

describe("mode switching", () => {
  it("applies from the next message, with that mode's behavior and controls", async () => {
    expect(MODE_CONTROLS.collaborate).toEqual(["discuss", "delegate"]);
    expect(MODE_CONTROLS.learn).toEqual(["hint", "answer"]);
    const s = await newSession("collaborate");
    await service.send(s.id, "task one");
    expect((await write(s)).allow).toBe(true);
    service.updateSession(s.id, { mode: "learn" });
    // The running turn keeps its rules.
    expect((await write(s)).allow).toBe(true);
    idle(s);
    await service.send(s.id, "task two");
    expect(system()).toContain("Active mode: Learn");
    expect((await write(s)).allow).toBe(false);
    idle(s);
    service.updateSession(s.id, { mode: "collaborate" });
    await service.send(s.id, "task three");
    expect(system()).toContain("Active mode: Collaborate");
    expect((await write(s)).allow).toBe(true);
    expect(store.listEvents(s.id).filter((e) => e.type === "mode.changed")).toHaveLength(2);
  });
});

describe("session persistence", () => {
  function fileSetup() {
    store.close();
    const file = join(dir, "data", "peer.db");
    setup("opencode", file);
    return () => {
      store.close();
      setup("opencode", file);
      engine().recover();
    };
  }

  it("discussion state, turn intents and locks survive a restart", async () => {
    const reopen = fileSetup();
    const s = await newSession("collaborate");
    await service.send(s.id, "add caching");
    const q = await ask(s, "tradeoff", "LRU or TTL?");
    await resolve(q.checkpoint!.id, "discuss");
    const t = turn(s);
    reopen();
    expect(store.getSession(s.id)!.discussing).toBe(true);
    expect(store.getTurn(t.id)).toMatchObject({ intent: "discuss", relockedAt: expect.any(Number), engagedAt: null });
    await service.send(s.id, "what about Redis?");
    expect(turn(s).intent).toBe("discuss");
  });

  for (const [action, intent, discussing] of [
    ["go", "delegate", false],
    ["direct", "answer", false],
    ["discuss", "discuss", true],
    ["skip", "proceed", false],
  ] as const) {
    it(`answering an interrupted question with "${action}" resumes the work as "${intent}"`, async () => {
      const reopen = fileSetup();
      const s = await newSession("learn");
      await service.send(s.id, "task");
      const q = await ask(s, "hypothesis", "Why?");
      reopen();
      expect(store.getCheckpoint(q.checkpoint!.id)!.status).toBe("interrupted");
      await resolve(q.checkpoint!.id, action);
      expect(runtime.lastPrompt().input.text).toMatch(/^Resuming after an interruption/);
      expect(turn(s).intent).toBe(intent);
      expect(store.getSession(s.id)!.discussing).toBe(discussing);
    });
  }

  for (const intent of ["discuss", "hint", "delegate", "answer"] as const) {
    for (const action of ["answer", "choose"] as const) {
      it(`restart preserves ${intent} when an interrupted question receives ${action}`, async () => {
        const reopen = fileSetup();
        const s = await newSession("learn");
        await service.send(s.id, "caching", intent);
        const q = await ask(s, "risk", "Delete the old cache?", { options: [{ label: "Keep it" }] });
        const original = turn(s).id;
        reopen();
        await resolve(q.checkpoint!.id, action, action === "answer" ? { text: "Keep it" } : { option: "Keep it" });
        expect(turn(s)).toMatchObject({ intent, continuedFrom: original });
        expect((await write(s)).allow).toBe(intent === "delegate" || intent === "answer");
        if (intent === "discuss" || intent === "hint") {
          await ask(s, "routine", "Formatting");
          expect((await write(s)).allow).toBe(false);
        }
      });
    }
  }

  it("repeated recovery keeps earlier answers in the same task", async () => {
    const reopen = fileSetup();
    const s = await newSession("collaborate");
    await service.send(s.id, "caching");
    const q = await ask(s, "tradeoff", "TTL or LRU?");
    await resolve(q.checkpoint!.id, "answer", { text: "TTL" });
    for (let i = 0; i < 2; i++) {
      const risk = await ask(s, "risk", `Delete cache generation ${i}?`);
      reopen();
      await resolve(risk.checkpoint!.id, "answer", { text: "Keep it" });
    }
    expect((await ask(s, "tradeoff", "TTL or LRU?")).checkpoint).toMatchObject({ status: "auto_resolved", resolution: { repeatOf: q.checkpoint!.id } });
  });

  it("a mode switch ends the old override before an interrupted question resumes", async () => {
    const reopen = fileSetup();
    const s = await newSession("learn");
    await service.send(s.id, "caching", "discuss");
    const q = await ask(s, "risk", "Delete cache?");
    reopen();
    service.updateSession(s.id, { mode: "collaborate" });
    await resolve(q.checkpoint!.id, "answer", { text: "Keep it" });
    expect(turn(s).intent).toBe("default");
    expect((await write(s)).allow).toBe(true);
    expect(store.getSession(s.id)!.discussing).toBe(false);
  });

  for (const intent of ["hint", "delegate", "answer", "discuss"] as const) {
    it(`switching away and back retires an interrupted ${intent} control`, async () => {
      const reopen = fileSetup();
      const s = await newSession("learn");
      await service.send(s.id, "caching", intent);
      const q = await ask(s, "risk", "Delete cache?", { options: [{ label: "Keep it" }] });
      reopen();
      service.updateSession(s.id, { mode: "collaborate" });
      service.updateSession(s.id, { mode: "learn" });
      await resolve(q.checkpoint!.id, "choose", { option: "Keep it" });
      expect(turn(s).intent).toBe("default");
      expect((await write(s)).allow).toBe(true);
      expect((await ask(s, "hypothesis", "What invalidates the cache?")).checkpoint!.status).toBe("pending");
    });
  }

  it("hands-off adaptation is derived from stored history, so it survives a restart", async () => {
    const reopen = fileSetup();
    const s = await newSession("collaborate");
    for (const text of ["a", "b"]) {
      await service.send(s.id, text, "delegate");
      idle(s);
    }
    reopen();
    await service.send(s.id, "c");
    expect(system()).toMatch(/Adapted for this session/);
  });
});

describe("agent compatibility", () => {
  for (const kind of ["opencode", "claude", "codex"] as const) {
    it(`the same controls behave the same on ${kind}`, async () => {
      store.close();
      setup(kind);
      const s = await newSession("collaborate");
      await service.send(s.id, "add caching");
      expect(system()).toContain(`call the \`${runtime.checkpointTool}\` tool`);
      const q = await ask(s, "tradeoff", "LRU or TTL?");
      await resolve(q.checkpoint!.id, "go");
      expect((await ask(s, "tradeoff", "Size limit?")).checkpoint!.status).toBe("auto_resolved");
      idle(s);
      await service.send(s.id, "How should we paginate?", "discuss");
      expect((await write(s)).allow).toBe(false);
      idle(s);
      await service.send(s.id, "go ahead");
      expect((await write(s)).allow).toBe(true);
    });
  }

  it("Claude Code reports a turn's tokens as OpenCode does", () => {
    const adapter = new ClaudeCodeAdapter({ storage: store, hooks: {}, log: () => {} } as unknown as ConstructorParameters<typeof ClaudeCodeAdapter>[0]);
    type Internals = { transcript(id: string): Transcript; handleMessage(s: string, run: unknown, t: Transcript, m: unknown, ids: Set<string>): string | undefined };
    const internals = adapter as unknown as Internals;
    const transcript = internals.transcript("c1");
    const run = { blockCount: new Map(), tools: new Map() };
    internals.handleMessage("c1", run, transcript, { type: "stream_event", event: { type: "message_start", message: { id: "m1", model: "claude-haiku" } } }, new Set());
    internals.handleMessage("c1", run, transcript, { type: "result", subtype: "success", is_error: false, usage: { input_tokens: 10, cache_read_input_tokens: 90, cache_creation_input_tokens: 5, output_tokens: 7 } }, new Set());
    expect(transcript.part("m1", "m1:usage")).toEqual({ type: "step-finish", id: "m1:usage", tokens: { input: 105, output: 7 } });
  });

  it("Codex reports a turn's tokens as OpenCode does (its totals are for the whole thread)", () => {
    const adapter = new CodexAdapter({ storage: store, hooks: {}, log: () => {}, dataDir: "/tmp/unused" } as unknown as ConstructorParameters<typeof CodexAdapter>[0]);
    type Internals = { runs: Map<string, unknown>; byThread: Map<string, string>; onNotification(n: { method: string; params: Record<string, unknown> }): void; transcript(id: string): Transcript };
    const internals = adapter as unknown as Internals;
    const run = { sessionId: "s1", threadId: "th", directory: "/ws", turnId: "t2", messageId: "a2", abort: new AbortController(), approvals: new Map(), fileChanges: new Map(), declined: new Map(), testEvidence: new TestEvidence(), snapshots: Promise.resolve(), preTestTrees: new Map(), startTree: null };
    internals.byThread.set("th", "s1");
    internals.runs.set("s1", run);
    internals.transcript("s1").startAssistantMessage("a2");
    const usage = (turnId: string, total: [number, number], last: [number, number]) =>
      internals.onNotification({
        method: "thread/tokenUsage/updated",
        params: { threadId: "th", turnId, tokenUsage: { total: { inputTokens: total[0], outputTokens: total[1] }, last: { inputTokens: last[0], outputTokens: last[1] } } },
      });
    // The thread already used 700/50 in earlier turns.
    usage("t2", [1000, 100], [300, 50]);
    expect(internals.transcript("s1").part("a2", "a2:usage")).toEqual({ type: "step-finish", id: "a2:usage", tokens: { input: 300, output: 50 } });
    usage("t2", [1600, 180], [600, 80]);
    expect(internals.transcript("s1").part("a2", "a2:usage")).toMatchObject({ tokens: { input: 900, output: 130 } });
    // Another turn's report is ignored.
    usage("t1", [99_999, 9_999], [1, 1]);
    expect(internals.transcript("s1").part("a2", "a2:usage")).toMatchObject({ tokens: { input: 900, output: 130 } });
  });
});
