import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { EventHub } from "../src/server/hub.js";
import { RuntimeSet } from "../src/server/runtime/set.js";
import { PeerService } from "../src/server/service.js";
import { Store } from "../src/server/store.js";
import type { PeerEvent, PeerSession } from "../src/shared/types.js";
import { CONTINUATION_TEXT, DECISION_APPROVE, DECISION_DECLINE } from "../src/server/collaboration/engine.js";
import { FakeRuntime } from "./helpers.js";

let dir: string;
let store: Store;
let runtime: FakeRuntime;
let service: PeerService;
let events: PeerEvent[];

beforeEach(() => {
  dir = realpathSync(mkdtempSync(join(tmpdir(), "peer-test-")));
  store = new Store(":memory:");
  runtime = new FakeRuntime();
  const hub = new EventHub();
  events = [];
  hub.subscribe((e) => events.push(e));
  service = new PeerService(store, new RuntimeSet([runtime]), hub);
});

afterEach(() => {
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

async function newSession(mode?: PeerSession["mode"]) {
  const ws = service.addWorkspace(dir);
  return service.createSession(ws.id, { mode });
}

const engine = () => service.engine;
const idle = (s: PeerSession) => runtime.emit({ type: "session.idle", sessionId: s.runtimeSessionId });
const write = (s: PeerSession) => engine().checkTool(s.runtimeSessionId, "write", { filePath: "x.js" });

describe("sessions and modes", () => {
  it("defaults new sessions to Collaborate, or to the user's preference", async () => {
    expect((await newSession()).mode).toBe("collaborate");
    store.setPreferences({ defaultMode: "learn" });
    expect((await newSession()).mode).toBe("learn");
  });

  it("a mode change applies to the next turn without resetting the conversation", async () => {
    const s = await newSession("focus");
    await service.send(s.id, "first task");
    idle(s);
    service.updateSession(s.id, { mode: "learn" });
    await service.send(s.id, "second task");
    expect(runtime.prompts).toHaveLength(2);
    expect(runtime.prompts[0]!.input.system).toContain("Active mode: Focus");
    expect(runtime.prompts[1]!.input.system).toContain("Active mode: Learn");
    // Same runtime conversation both times.
    expect(runtime.prompts[0]!.sessionId).toBe(runtime.prompts[1]!.sessionId);
    expect(store.listEvents(s.id).some((e) => e.type === "mode.changed")).toBe(true);
  });

  it("disables the runtime's generic question tool in favour of checkpoints", async () => {
    const s = await newSession();
    await service.send(s.id, "hello");
    expect(runtime.lastPrompt().input.tools).toEqual({ question: false });
  });

  it("refuses a new message while the agent is working", async () => {
    const s = await newSession();
    await service.send(s.id, "task");
    await expect(service.send(s.id, "another")).rejects.toThrow(/still working/);
  });
});

describe("collaboration gate", () => {
  it("Learn locks code changes until the developer engages, but allows exploration", async () => {
    const s = await newSession("learn");
    await service.send(s.id, "implement rate limiting");
    expect(engine().gateFor(s.id).locked).toBe(true);
    expect((await write(s)).allow).toBe(false);
    expect((await engine().checkTool(s.runtimeSessionId, "bash", { command: "npm install x" })).allow).toBe(false);
    expect((await engine().checkTool(s.runtimeSessionId, "read", { filePath: "a" })).allow).toBe(true);
    expect((await engine().checkTool(s.runtimeSessionId, "bash", { command: "git log -3" })).allow).toBe(true);

    const { checkpoint } = await engine().requestCheckpoint(s.runtimeSessionId, null, {
      category: "hypothesis",
      question: "What happens to in-memory counters with several instances?",
    });
    await engine().resolveCheckpoint(checkpoint!.id, { action: "answer", text: "They diverge" });
    expect(engine().gateFor(s.id).locked).toBe(false);
    expect((await write(s)).allow).toBe(true);
    expect(store.listEvents(s.id).filter((e) => e.type === "gate.blocked")).toHaveLength(2);
  });

  it("asking for a hint does not unlock the Learn gate", async () => {
    const s = await newSession("learn");
    await service.send(s.id, "task");
    const { checkpoint } = await engine().requestCheckpoint(s.runtimeSessionId, null, { category: "hypothesis", question: "Why?" });
    await engine().resolveCheckpoint(checkpoint!.id, { action: "hint" });
    expect((await write(s)).allow).toBe(false);
    const out = await engine().waitForCheckpoint(checkpoint!.id, 1000);
    expect(out).toMatch(/hint 1/);
  });

  it("the developer's reply after a gated turn counts as engagement", async () => {
    const s = await newSession("learn");
    await service.send(s.id, "task");
    idle(s); // agent ended its turn with a question in prose
    await service.send(s.id, "I think the counters diverge");
    expect(engine().gateFor(s.id).locked).toBe(false);
    idle(s);
    await service.send(s.id, "next task");
    expect(engine().gateFor(s.id).locked).toBe(true);
  });

  it("Focus and Collaborate do not gate by default; /discuss holds edits; skip releases them", async () => {
    const s = await newSession("focus");
    await service.send(s.id, "task");
    expect((await write(s)).allow).toBe(true);
    idle(s);
    service.updateSession(s.id, { mode: "collaborate" });
    await service.send(s.id, "/discuss caching strategy");
    expect(runtime.lastPrompt().input.text).toBe("caching strategy");
    expect((await write(s)).allow).toBe(false);
    const { checkpoint: a } = await engine().requestCheckpoint(s.runtimeSessionId, null, { category: "tradeoff", question: "LRU or TTL?" });
    await engine().resolveCheckpoint(a!.id, { action: "answer", text: "TTL" });
    expect((await write(s)).allow).toBe(false); // answering a question is not permission to implement
    const { checkpoint: b } = await engine().requestCheckpoint(s.runtimeSessionId, null, { category: "confirm", question: "Implement now?" });
    await engine().resolveCheckpoint(b!.id, { action: "skip" });
    expect((await write(s)).allow).toBe(true);
  });

  it("locks edits while a checkpoint is open, in every mode", async () => {
    const s = await newSession("focus");
    await service.send(s.id, "task");
    await engine().requestCheckpoint(s.runtimeSessionId, null, { category: "risk", question: "Drop the table?" });
    expect((await write(s)).allow).toBe(false);
  });

  it("gates subagent sessions through their parent", async () => {
    const s = await newSession("learn");
    await service.send(s.id, "task");
    runtime.parents.set("child_1", s.runtimeSessionId);
    expect((await engine().checkTool("child_1", "edit", {})).allow).toBe(false);
  });

  it("fails closed for runtime sessions Peer cannot map", async () => {
    expect((await engine().checkTool("unknown", "write", {})).allow).toBe(false);
    expect((await engine().checkTool("unknown", "read", {})).allow).toBe(true);
  });

  it("deleting a session stops its run, and its tool calls lose write access", async () => {
    const s = await newSession("focus");
    await service.send(s.id, "task");
    await service.deleteSession(s.id);
    expect(runtime.aborted).toContain(s.runtimeSessionId);
    expect((await write(s)).allow).toBe(false);
  });
});

describe("checkpoints", () => {
  it("declines categories the mode leaves to the agent, and records it", async () => {
    const s = await newSession("focus");
    await service.send(s.id, "task");
    const res = await engine().requestCheckpoint(s.runtimeSessionId, null, {
      category: "tradeoff",
      question: "Fixed or sliding window?",
      recommendation: "Sliding",
    });
    expect(res.checkpoint!.status).toBe("auto_resolved");
    expect(res.output).toMatch(/Focus mode leaves tradeoff decisions to you/);
    expect(res.output).toMatch(/you recommended "Sliding"/);
  });

  it("enforces the per-turn budget, but never for risk", async () => {
    const s = await newSession("focus"); // budget 1
    await service.send(s.id, "task");
    const first = await engine().requestCheckpoint(s.runtimeSessionId, null, { category: "architecture", question: "Q1" });
    expect(first.checkpoint!.status).toBe("pending");
    await engine().resolveCheckpoint(first.checkpoint!.id, { action: "delegate" });
    const second = await engine().requestCheckpoint(s.runtimeSessionId, null, { category: "requirement", question: "Q2" });
    expect(second.checkpoint!.status).toBe("auto_resolved");
    expect(second.output).toMatch(/budget/);
    const risk = await engine().requestCheckpoint(s.runtimeSessionId, null, { category: "risk", question: "Q3" });
    expect(risk.checkpoint!.status).toBe("pending");
  });

  it("'Just do it' narrows questions to risk only", async () => {
    const s = await newSession("learn");
    await service.send(s.id, "/go add a test");
    expect(engine().gateFor(s.id).locked).toBe(false);
    const res = await engine().requestCheckpoint(s.runtimeSessionId, null, { category: "concept", question: "Do you know X?" });
    expect(res.checkpoint!.status).toBe("auto_resolved");
  });

  it("blocks the waiting agent until the developer responds, then returns their answer", async () => {
    const s = await newSession();
    await service.send(s.id, "task");
    const { checkpoint } = await engine().requestCheckpoint(s.runtimeSessionId, null, {
      category: "tradeoff",
      question: "Which algorithm?",
      options: [{ label: "Token bucket" }, { label: "Sliding window" }],
    });
    expect(await engine().waitForCheckpoint(checkpoint!.id, 50)).toBeNull(); // still waiting
    const waiting = engine().waitForCheckpoint(checkpoint!.id, 5000);
    await engine().resolveCheckpoint(checkpoint!.id, { action: "choose", option: "Sliding window" });
    expect(await waiting).toMatch(/chose "Sliding window"/);
  });

  it("validates resolutions", async () => {
    const s = await newSession();
    await service.send(s.id, "task");
    const { checkpoint } = await engine().requestCheckpoint(s.runtimeSessionId, null, { category: "tradeoff", question: "Q", options: ["A", "B"] });
    await expect(engine().resolveCheckpoint(checkpoint!.id, { action: "choose", option: "C" })).rejects.toThrow(/Unknown option/);
    await expect(engine().resolveCheckpoint(checkpoint!.id, { action: "answer", text: " " })).rejects.toThrow(/needs text/);
    await engine().resolveCheckpoint(checkpoint!.id, { action: "delegate" });
    await expect(engine().resolveCheckpoint(checkpoint!.id, { action: "delegate" })).rejects.toThrow(/already resolved/);
  });

  it("a chat message while a checkpoint is open answers it instead of starting a turn", async () => {
    const s = await newSession();
    await service.send(s.id, "task");
    const { checkpoint } = await engine().requestCheckpoint(s.runtimeSessionId, null, { category: "requirement", question: "Per IP or per user?" });
    const res = await service.send(s.id, "Per user");
    expect(res.kind).toBe("checkpoint-answered");
    expect(store.getCheckpoint(checkpoint!.id)!.resolution).toMatchObject({ action: "answer", text: "Per user" });
    expect(runtime.prompts).toHaveLength(1);
  });

  it("stopping the agent cancels open checkpoints", async () => {
    const s = await newSession();
    await service.send(s.id, "task");
    const { checkpoint } = await engine().requestCheckpoint(s.runtimeSessionId, null, { category: "tradeoff", question: "Q" });
    const waiting = engine().waitForCheckpoint(checkpoint!.id, 5000);
    await engine().abort(s.id);
    await expect(waiting).rejects.toThrow(/cancelled/);
    expect(store.getCheckpoint(checkpoint!.id)!.status).toBe("cancelled");
    expect(runtime.aborted).toContain(s.runtimeSessionId);
  });

  it("survives a restart: open checkpoints become interrupted and answering resumes the work", async () => {
    const s = await newSession("learn");
    await service.send(s.id, "task");
    const { checkpoint } = await engine().requestCheckpoint(s.runtimeSessionId, null, { category: "hypothesis", question: "Why do counters diverge?" });

    // Simulate Peer restarting on the same database.
    const runtime2 = new FakeRuntime();
    const service2 = new PeerService(store, new RuntimeSet([runtime2]), new EventHub());
    expect(store.getCheckpoint(checkpoint!.id)!.status).toBe("interrupted");
    expect(service2.snapshot(s.id).session.mode).toBe("learn");

    await service2.engine.resolveCheckpoint(checkpoint!.id, { action: "answer", text: "Each instance has its own memory" });
    expect(runtime2.prompts).toHaveLength(1);
    const resumed = runtime2.lastPrompt();
    expect(resumed.sessionId).toBe(s.runtimeSessionId);
    expect(resumed.input.text).toContain("Why do counters diverge?");
    expect(resumed.input.text).toContain("Each instance has its own memory");
    // Engaging resumed the work with code changes unlocked.
    expect(service2.engine.gateFor(s.id).locked).toBe(false);
  });

  it("keeps an interrupted checkpoint answerable if the resume cannot start", async () => {
    const s = await newSession("learn");
    await service.send(s.id, "task");
    const { checkpoint } = await engine().requestCheckpoint(s.runtimeSessionId, null, { category: "hypothesis", question: "Why?" });
    const runtime2 = new FakeRuntime();
    runtime2.prompt = async () => {
      throw new Error("runtime down");
    };
    const service2 = new PeerService(store, new RuntimeSet([runtime2]), new EventHub());
    await expect(service2.engine.resolveCheckpoint(checkpoint!.id, { action: "answer", text: "x" })).rejects.toThrow(/runtime down/);
    expect(store.getCheckpoint(checkpoint!.id)!.status).toBe("interrupted");
    runtime2.prompt = FakeRuntime.prototype.prompt;
    await service2.engine.resolveCheckpoint(checkpoint!.id, { action: "answer", text: "x" });
    expect(runtime2.prompts).toHaveLength(1);
  });

  it("a runtime crash interrupts live checkpoints", async () => {
    const s = await newSession();
    await service.send(s.id, "task");
    const { checkpoint } = await engine().requestCheckpoint(s.runtimeSessionId, null, { category: "tradeoff", question: "Q" });
    runtime.emit({ type: "runtime.restarted" });
    expect(store.getCheckpoint(checkpoint!.id)!.status).toBe("interrupted");
    expect(engine().statusOf(s.id)).toBe("idle");
  });

  it("emits events so reconnecting clients and live clients stay in sync", async () => {
    const s = await newSession();
    await service.send(s.id, "task");
    await engine().requestCheckpoint(s.runtimeSessionId, null, { category: "tradeoff", question: "Q" });
    expect(events.some((e) => e.type === "checkpoint.updated")).toBe(true);
    expect(events.some((e) => e.type === "gate.updated" && e.gate.locked)).toBe(true);
    const snap = service.snapshot(s.id);
    expect(snap.checkpoints).toHaveLength(1);
    expect(snap.gate.locked).toBe(true);
  });
});

describe("permissions", () => {
  it("are mapped to the Peer session and cleared when the run stops", async () => {
    const s = await newSession();
    await service.send(s.id, "task");
    runtime.emit({ type: "permission.asked", request: { id: "perm_1", sessionId: s.runtimeSessionId, permission: "bash", patterns: ["rm -rf data/"], metadata: {} } });
    await new Promise((r) => setTimeout(r, 0));
    expect(service.snapshot(s.id).permissions.map((p) => p.id)).toEqual(["perm_1"]);
    await service.abort(s.id);
    expect(service.snapshot(s.id).permissions).toEqual([]);
    expect(events.some((e) => e.type === "permission.replied" && e.requestId === "perm_1")).toBe(true);
  });
});

describe("runtimes whose sandbox is fixed per turn (Codex)", () => {
  const flush = () => new Promise((r) => setImmediate(r));

  /** A Learn turn: gated at the start, then the developer engages through a checkpoint. */
  async function engagedLearnTurn(action: "answer" | "hint" = "answer") {
    const s = await newSession("learn");
    await service.send(s.id, "add ETag support");
    expect(runtime.lastPrompt().input.gate).toBe("engage");
    const { checkpoint } = await engine().requestCheckpoint(s.runtimeSessionId, null, { category: "hypothesis", question: "What should the ETag be based on?" });
    const resolved = await engine().resolveCheckpoint(checkpoint!.id, action === "answer" ? { action, text: "A hash of the list" } : { action });
    return { s, resolved };
  }

  it("continues engaged work in a new turn that starts with write access", async () => {
    runtime.sandboxFixedPerTurn = true;
    const { s, resolved } = await engagedLearnTurn();
    // The read-only turn is told not to attempt edits and to hand over.
    expect(engine().agentOutput(resolved)).toMatch(/sandbox stays read-only.*end your turn/);
    expect(runtime.prompts).toHaveLength(1);

    idle(s);
    await flush();
    expect(runtime.prompts).toHaveLength(2);
    expect(runtime.lastPrompt().input).toMatchObject({ text: CONTINUATION_TEXT, gate: "open" });
    expect(runtime.prompts[1]!.sessionId).toBe(runtime.prompts[0]!.sessionId);
    expect(engine().gateFor(s.id).locked).toBe(false);
    expect(store.listEvents(s.id).some((e) => e.type === "turn.continued")).toBe(true);

    // The continuation itself starts open, so it never continues again.
    idle(s);
    await flush();
    expect(runtime.prompts).toHaveLength(2);
  });

  it("reports idle before the continuation's busy, so the UI ends up busy", async () => {
    runtime.sandboxFixedPerTurn = true;
    const { s } = await engagedLearnTurn();
    events.length = 0;
    idle(s);
    await flush();
    const statuses = events.flatMap((e) => (e.type === "session.status" && e.sessionId === s.id ? [e.status] : []));
    expect(statuses.at(-2)).toBe("idle");
    expect(statuses.at(-1)).toBe("busy");
  });

  it("Stop between the end of the turn and the continuation cancels it", async () => {
    runtime.sandboxFixedPerTurn = true;
    const { s } = await engagedLearnTurn();
    idle(s);
    await engine().abort(s.id);
    await flush();
    expect(runtime.prompts).toHaveLength(1);
    expect(store.listEvents(s.id).some((e) => e.type === "turn.continued")).toBe(false);
  });

  it("lets a developer message that arrives first take over", async () => {
    runtime.sandboxFixedPerTurn = true;
    const { s } = await engagedLearnTurn();
    idle(s);
    await service.send(s.id, "actually, let's use a revision counter");
    await flush();
    expect(runtime.prompts.map((p) => p.input.text)).toEqual(["add ETag support", "actually, let's use a revision counter"]);
  });

  it("does not continue when the developer did not engage", async () => {
    runtime.sandboxFixedPerTurn = true;
    const { s } = await engagedLearnTurn("hint");
    idle(s);
    await flush();
    expect(runtime.prompts).toHaveLength(1);
    // The next developer message is still the engagement, as before.
    await service.send(s.id, "my guess: hash it");
    expect(runtime.lastPrompt().input.gate).toBe("open");
  });

  it("does not continue a turn that was stopped or failed", async () => {
    runtime.sandboxFixedPerTurn = true;
    const stopped = await engagedLearnTurn();
    await engine().abort(stopped.s.id);
    idle(stopped.s);
    await flush();
    expect(runtime.prompts).toHaveLength(1);

    const failed = await engagedLearnTurn();
    runtime.emit({ type: "session.error", sessionId: failed.s.runtimeSessionId, error: "model unavailable" });
    idle(failed.s);
    await flush();
    expect(runtime.prompts.filter((p) => p.sessionId === failed.s.runtimeSessionId)).toHaveLength(1);
  });

  it("the continuation shares the task's checkpoint budget instead of getting a fresh one", async () => {
    runtime.sandboxFixedPerTurn = true;
    const { s } = await engagedLearnTurn(); // 1 of Learn's 4 used in the read-only turn
    idle(s);
    await flush();
    expect(runtime.lastPrompt().input.system).toContain("At most 3 checkpoint(s) this turn");
    const ask = (question: string, category: "tradeoff" | "risk" = "tradeoff") => engine().requestCheckpoint(s.runtimeSessionId, null, { category, question });
    for (const q of ["A?", "B?", "C?"]) {
      const { checkpoint } = await ask(q);
      expect(checkpoint!.status, q).toBe("pending");
      await engine().resolveCheckpoint(checkpoint!.id, { action: "answer", text: "ok" });
    }
    const fifth = await ask("D?");
    expect(fifth.checkpoint!.status).toBe("auto_resolved");
    expect(fifth.output).toMatch(/budget for this turn \(4\) is used up/);
    // Risk questions stay exempt.
    expect((await ask("Drop the table?", "risk")).checkpoint!.status).toBe("pending");
  });

  it("records which turn a continuation carries on, and the next developer message starts a fresh budget", async () => {
    runtime.sandboxFixedPerTurn = true;
    const { s } = await engagedLearnTurn();
    const first = store.latestTurn(s.id)!;
    idle(s);
    await flush();
    const continuation = store.latestTurn(s.id)!;
    expect(continuation.continuedFrom).toBe(first.id);
    expect(store.getTurn(first.id)!.continuedFrom).toBeNull();
    idle(s);
    await service.send(s.id, "now add a test for 304 responses");
    expect(store.latestTurn(s.id)!.continuedFrom).toBeNull();
    expect(runtime.lastPrompt().input.system).toContain("At most 4 checkpoint(s) this turn");
  });

  it("leaves other runtimes unchanged: they unlock within the same turn", async () => {
    const { s, resolved } = await engagedLearnTurn();
    expect(engine().agentOutput(resolved)).toMatch(/Code changes are now unlocked\.$/);
    expect((await write(s)).allow).toBe(true);
    idle(s);
    await flush();
    expect(runtime.prompts).toHaveLength(1);
  });
});

describe("decisions Peer detects itself (new dependencies)", () => {
  beforeEach(() => writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "app", dependencies: { react: "^19.0.0" } })));

  const tick = () => new Promise((r) => setImmediate(r));
  /** The agent runs an install in-process (Claude Code, Codex): the call waits while Peer holds it. */
  const install = (s: PeerSession, pkg = "zod", signal?: AbortSignal) => engine().checkTool(s.runtimeSessionId, "bash", { command: `npm install ${pkg}` }, signal);
  const pending = (s: PeerSession) => store.listCheckpoints(s.id).filter((c) => c.status === "pending");
  /** Start an install and return the Peer checkpoint it is held on. */
  async function held(s: PeerSession, pkg = "zod") {
    const call = install(s, pkg);
    await tick();
    const [cp] = pending(s);
    expect(cp).toBeDefined();
    return { call, cp: cp! };
  }

  it("Collaborate holds a new dependency on a checkpoint the agent did not ask for; approving runs it", async () => {
    const s = await newSession("collaborate");
    await service.send(s.id, "validate the request body");
    const { call, cp } = await held(s);
    expect(cp).toMatchObject({ source: "peer", category: "architecture", decision: { kind: "dependency", subjects: ["zod"], style: "choice", action: "`npm install zod`" } });
    expect(cp.options.map((o) => o.label)).toEqual([DECISION_APPROVE, DECISION_DECLINE]);
    // While it is held, other changes wait too (parallel tool calls).
    expect((await write(s)).allow).toBe(false);

    await engine().resolveCheckpoint(cp.id, { action: "choose", option: DECISION_APPROVE });
    expect(await call).toEqual({ allow: true });
    // Already decided: the same dependency, again or through a manifest edit, runs without asking.
    expect(await install(s)).toEqual({ allow: true });
    const pkg = JSON.stringify({ name: "app", dependencies: { react: "^19.0.0", zod: "^4" } });
    expect(await engine().checkTool(s.runtimeSessionId, "write", { filePath: "package.json", content: pkg })).toEqual({ allow: true });
    expect(store.listCheckpoints(s.id)).toHaveLength(1);
  });

  it("a manifest that crashes its reader still leads to a question, not a silent allow (review F5)", async () => {
    writeFileSync(join(dir, "pyproject.toml"), '[project]\nname = "\\U00110000"\ndependencies = ["httpx"]\n');
    const s = await newSession("collaborate");
    await service.send(s.id, "task");
    expect(await engine().evaluateTool(s.runtimeSessionId, "bash", { command: "pip install httpx" })).toHaveProperty("wait");
  });

  it("does not interrupt mechanical work", async () => {
    const s = await newSession("collaborate");
    await service.send(s.id, "task");
    for (const command of ["npm install", "npm ci", "npm install react@latest", "npm run build"]) {
      expect(await engine().checkTool(s.runtimeSessionId, "bash", { command })).toEqual({ allow: true });
    }
    expect(await engine().checkTool(s.runtimeSessionId, "edit", { filePath: "src/a.ts", oldString: "a", newString: "b" })).toEqual({ allow: true });
    expect(store.listCheckpoints(s.id)).toHaveLength(0);
  });

  it("'Don't add it' rejects the call, and later attempts are rejected without asking again", async () => {
    const s = await newSession("collaborate");
    await service.send(s.id, "format the dates");
    const { call, cp } = await held(s, "moment");
    await engine().resolveCheckpoint(cp.id, { action: "choose", option: DECISION_DECLINE, text: "use Intl.DateTimeFormat" });
    const decision = await call;
    expect(decision).toMatchObject({ allow: false, explain: true });
    expect(decision.allow === false && decision.reason).toMatch(/decided against it and said: "use Intl.DateTimeFormat"/);
    const again = await install(s, "moment");
    expect(again.allow === false && again.reason).toMatch(/already decided not to add `moment`/);
    // A note on the decline that names the package is not an approval.
    const other = await held(s, "lodash");
    await engine().resolveCheckpoint(other.cp.id, { action: "choose", option: DECISION_DECLINE, text: "lodash is too heavy" });
    await other.call;
    expect((await install(s, "lodash")).allow).toBe(false);
    expect(pending(s)).toHaveLength(0);
    // The developer can change their mind in their own words.
    idle(s);
    await service.send(s.id, "OK, add `moment` after all.");
    expect(await install(s, "moment")).toEqual({ allow: true });
  });

  it("a free-text answer reaches the agent first; its retry runs without asking again", async () => {
    const s = await newSession("collaborate");
    await service.send(s.id, "task");
    const { call, cp } = await held(s);
    await engine().resolveCheckpoint(cp.id, { action: "answer", text: "fine, but pin it to 4.x" });
    const decision = await call;
    expect(decision.allow === false && decision.reason).toMatch(/They said: "fine, but pin it to 4.x"/);
    expect(await install(s, "zod@4")).toEqual({ allow: true });
    // Typing in the chat while a call is held answers it, like any checkpoint.
    const second = await held(s, "dayjs");
    expect((await service.send(s.id, "go ahead")).kind).toBe("checkpoint-answered");
    expect((await second.call).allow).toBe(false);
    expect(store.getCheckpoint(second.cp.id)!.resolution).toMatchObject({ action: "answer", text: "go ahead" });
  });

  it("You decide lets the agent go ahead", async () => {
    const s = await newSession("collaborate");
    await service.send(s.id, "task");
    const { call, cp } = await held(s);
    await engine().resolveCheckpoint(cp.id, { action: "delegate" });
    expect(await call).toEqual({ allow: true });
  });

  it("Learn asks for the developer's reasoning first; the agent must respond to it", async () => {
    const s = await newSession("learn");
    await service.send(s.id, "speed up the search page");
    // Learn's gate comes first: no code changes, and no decision question, before the developer engages.
    expect((await install(s, "lodash")).allow).toBe(false);
    expect(store.listCheckpoints(s.id)).toHaveLength(0);
    idle(s);
    await service.send(s.id, "I think the filter runs on every keystroke");

    const { call, cp } = await held(s, "lodash");
    expect(cp).toMatchObject({ category: "hypothesis", options: [], decision: { style: "reasoning" } });
    expect(cp.question).toMatch(/what do you think this task needs it for/);
    await engine().resolveCheckpoint(cp.id, { action: "answer", text: "debounce, but we could write it ourselves" });
    const decision = await call;
    expect(decision.allow === false && decision.reason).toMatch(/Their reasoning: "debounce, but we could write it ourselves"\. Before you continue, respond to it/);
    expect(await install(s, "lodash")).toEqual({ allow: true });
  });

  it("Learn hints are progressive: the agent gives one, and Peer asks again on the retry", async () => {
    const s = await newSession("learn");
    await service.send(s.id, "task");
    idle(s);
    await service.send(s.id, "reply");
    const first = await held(s, "lodash");
    await engine().resolveCheckpoint(first.cp.id, { action: "hint" });
    const decision = await first.call;
    expect(decision.allow === false && decision.reason).toMatch(/asked for a hint \(hint 1\).*Peer will ask them again/);
    const second = await held(s, "lodash");
    expect(second.cp.id).not.toBe(first.cp.id);
    // A hint request that names the package is not an approval either (review F1).
    await engine().resolveCheckpoint(second.cp.id, { action: "hint", text: "What does lodash provide here?" });
    await second.call;
    const third = await held(s, "lodash");
    expect(third.cp.id).not.toBe(second.cp.id);
    await engine().resolveCheckpoint(third.cp.id, { action: "delegate" });
    expect(await third.call).toEqual({ allow: true });
  });

  it("'Direct answer' in Learn asks with a pick-one instead of a reasoning question", async () => {
    const s = await newSession("learn");
    await service.send(s.id, "/answer how do I validate this");
    const { cp } = await held(s);
    expect(cp).toMatchObject({ category: "architecture", decision: { style: "choice" } });
  });

  it("Focus and 'Just do it' note the decision in the transcript without interrupting", async () => {
    const focus = await newSession("focus");
    await service.send(focus.id, "task");
    expect(await install(focus)).toEqual({ allow: true });
    expect(await install(focus)).toEqual({ allow: true });
    const noted = store.listCheckpoints(focus.id);
    expect(noted).toHaveLength(1);
    expect(noted[0]).toMatchObject({ source: "peer", status: "auto_resolved", decision: { subjects: ["zod"] }, resolution: { action: "policy", note: "Focus mode notes this without interrupting you" } });

    const collab = await newSession("collaborate");
    await service.send(collab.id, "/go task");
    expect(await install(collab)).toEqual({ allow: true });
    expect(store.listCheckpoints(collab.id)[0]!.resolution!.note).toBe('"Just do it" notes this without interrupting you');
  });

  it("does not ask about a dependency the developer asked for, or accepted in an agent checkpoint", async () => {
    const s = await newSession("collaborate");
    await service.send(s.id, "Add `zod` and validate the request body. Don't use `lodash`.");
    expect(await install(s, "zod")).toEqual({ allow: true });
    // A negation in the sentence is not an approval.
    (await held(s, "lodash")).call.catch(() => {});
    await engine().abort(s.id);

    idle(s);
    await service.send(s.id, "next task");
    const { checkpoint } = await engine().requestCheckpoint(s.runtimeSessionId, null, { category: "tradeoff", question: "Which date library?", options: ["dayjs", "date-fns"], recommendation: "dayjs" });
    await engine().resolveCheckpoint(checkpoint!.id, { action: "choose", option: "date-fns" });
    expect(await install(s, "date-fns")).toEqual({ allow: true });
    expect((await held(s, "dayjs")).cp.decision!.subjects).toEqual(["dayjs"]);
  });

  it("an approved confirm plan counts as approval of what it names", async () => {
    const s = await newSession("collaborate");
    await service.send(s.id, "task");
    const { checkpoint } = await engine().requestCheckpoint(s.runtimeSessionId, null, { category: "confirm", question: "Plan for logging.\nAdd the pino library for structured logs and replace console.log. OK?", options: ["Go ahead"] });
    await engine().resolveCheckpoint(checkpoint!.id, { action: "choose", option: "Go ahead" });
    expect(await install(s, "pino")).toEqual({ allow: true });
  });

  it("asks only about the undecided packages of a multi-package install", async () => {
    const s = await newSession("collaborate");
    await service.send(s.id, "Use `zod`.");
    const call = engine().checkTool(s.runtimeSessionId, "bash", { command: "npm install zod lodash" });
    await tick();
    expect(pending(s)[0]!.decision!.subjects).toEqual(["lodash"]);
    await engine().resolveCheckpoint(pending(s)[0]!.id, { action: "choose", option: DECISION_APPROVE });
    expect(await call).toEqual({ allow: true });
  });

  it("does not use the agent's checkpoint budget", async () => {
    const s = await newSession("collaborate");
    await service.send(s.id, "task");
    const { call, cp } = await held(s);
    await engine().resolveCheckpoint(cp.id, { action: "choose", option: DECISION_APPROVE });
    await call;
    for (let i = 0; i < 3; i++) {
      const { checkpoint } = await engine().requestCheckpoint(s.runtimeSessionId, null, { category: "tradeoff", question: `Q${i}` });
      expect(checkpoint!.status).toBe("pending");
      await engine().resolveCheckpoint(checkpoint!.id, { action: "delegate" });
    }
    const { checkpoint } = await engine().requestCheckpoint(s.runtimeSessionId, null, { category: "tradeoff", question: "Q4" });
    expect(checkpoint!.status).toBe("auto_resolved");
  });

  it("Stop cancels the held call: it does not run", async () => {
    const s = await newSession("collaborate");
    await service.send(s.id, "task");
    const { call, cp } = await held(s);
    await engine().abort(s.id);
    const decision = await call;
    expect(decision.allow === false && decision.reason).toMatch(/question was cancelled \(Stopped by the developer\)/);
    expect(store.getCheckpoint(cp.id)!.status).toBe("cancelled");
    // The run's own abort signal cancels it too.
    idle(s);
    await service.send(s.id, "again");
    const controller = new AbortController();
    const call2 = install(s, "zod", controller.signal);
    await tick();
    controller.abort();
    expect((await call2).allow).toBe(false);
  });

  it("survives a restart: answering resumes the work with the decision recorded", async () => {
    const s = await newSession("collaborate");
    await service.send(s.id, "task");
    const { cp } = await held(s);

    const runtime2 = new FakeRuntime();
    const service2 = new PeerService(store, new RuntimeSet([runtime2]), new EventHub());
    expect(store.getCheckpoint(cp.id)!.status).toBe("interrupted");
    await service2.engine.resolveCheckpoint(cp.id, { action: "choose", option: DECISION_APPROVE });
    const resumed = runtime2.lastPrompt().input.text;
    expect(resumed).toContain("Before `npm install zod` ran, Peer paused it");
    expect(resumed).toContain("they approved. Go ahead (run `npm install zod` again)");
    expect(await service2.engine.checkTool(s.runtimeSessionId, "bash", { command: "npm install zod" })).toEqual({ allow: true });
  });

  it("an interrupted question is replaced when the agent retries instead of piling up", async () => {
    const s = await newSession("collaborate");
    await service.send(s.id, "task");
    const { cp } = await held(s);
    runtime.emit({ type: "runtime.restarted" });
    expect(store.getCheckpoint(cp.id)!.status).toBe("interrupted");
    await service.send(s.id, "carry on");
    const again = await held(s);
    expect(store.getCheckpoint(cp.id)!.status).toBe("cancelled");
    expect(again.cp.id).not.toBe(cp.id);
  });

  it("over the bridge (OpenCode), the call long-polls for the decision", async () => {
    const s = await newSession("collaborate");
    await service.send(s.id, "task");
    const check = await engine().evaluateTool(s.runtimeSessionId, "bash", { command: "npm install zod" });
    expect(check).toHaveProperty("wait");
    const id = (check as { wait: string }).wait;
    expect(await engine().waitForToolDecision(id, 20)).toBeNull();
    const waiting = engine().waitForToolDecision(id, 5000);
    await engine().resolveCheckpoint(id, { action: "choose", option: DECISION_APPROVE });
    expect(await waiting).toEqual({ allow: true });
  });

  it("tells the agent about it in Collaborate and Learn, not in Focus", async () => {
    for (const mode of ["collaborate", "learn", "focus"] as const) {
      const s = await newSession(mode);
      await service.send(s.id, "task");
      const said = runtime.lastPrompt().input.system.includes("Peer itself pauses some actions before they run");
      expect(said).toBe(mode !== "focus");
    }
  });
});
