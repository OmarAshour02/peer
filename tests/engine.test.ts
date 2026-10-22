import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { EventHub } from "../src/server/hub.js";
import { RuntimeSet } from "../src/server/runtime/set.js";
import { PeerService } from "../src/server/service.js";
import { Store } from "../src/server/store.js";
import type { PeerEvent, PeerSession } from "../src/shared/types.js";
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
const write = (s: PeerSession) => engine().evaluateTool(s.runtimeSessionId, "write", { filePath: "x.js" });

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
    expect((await engine().evaluateTool(s.runtimeSessionId, "bash", { command: "npm install x" })).allow).toBe(false);
    expect((await engine().evaluateTool(s.runtimeSessionId, "read", { filePath: "a" })).allow).toBe(true);
    expect((await engine().evaluateTool(s.runtimeSessionId, "bash", { command: "git log -3" })).allow).toBe(true);

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
    expect((await engine().evaluateTool("child_1", "edit", {})).allow).toBe(false);
  });

  it("fails closed for runtime sessions Peer cannot map", async () => {
    expect((await engine().evaluateTool("unknown", "write", {})).allow).toBe(false);
    expect((await engine().evaluateTool("unknown", "read", {})).allow).toBe(true);
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
