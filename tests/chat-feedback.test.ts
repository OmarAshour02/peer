import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PeerMessage, PeerPart } from "../src/shared/types.js";
import { DEFAULT_RUNTIME_SETTINGS } from "../src/shared/types.js";
import type { RuntimeEvent } from "../src/server/runtime/adapter.js";
import { Store } from "../src/server/store.js";

// Each query replays a script of SDK messages, then ends or throws as the SDK does on a failed result.
const calls: { prompt: unknown; options: Record<string, unknown> }[] = [];
let script: { messages: unknown[]; fail?: string } = { messages: [] };
vi.mock("@anthropic-ai/claude-agent-sdk", async (original) => ({
  ...(await original<object>()),
  query: (args: { prompt: unknown; options: Record<string, unknown> }) => {
    calls.push(args);
    const { messages, fail } = script;
    return {
      async *[Symbol.asyncIterator]() {
        for (const m of messages) yield m;
        if (fail) throw new Error(fail);
      },
      interrupt: async () => {},
      close: () => {},
    };
  },
  getSessionInfo: async () => null,
}));

const { ClaudeCodeAdapter, claudeEffort, cleanClaudeError } = await import("../src/server/runtime/claude/adapter.js");
const { runtimeEffort } = await import("../src/server/collaboration/engine.js");
const { composeSystemPrompt, learningMapInstructions } = await import("../src/server/collaboration/prompt.js");
const { resolveEffectivePolicy } = await import("../src/server/collaboration/policies.js");
const { normalizePart } = await import("../src/server/runtime/opencode/normalize.js");
const usage = await import("../src/renderer/usage.js");
const layout = await import("../src/renderer/turn-layout.js");

describe("Claude Code turns", () => {
  let dir: string;
  let store: Store;
  beforeEach(() => {
    dir = realpathSync(mkdtempSync(join(tmpdir(), "peer-chat-feedback-")));
    store = new Store(":memory:");
    calls.length = 0;
    script = { messages: [] };
  });
  afterEach(() => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });

  const make = () => {
    const adapter = new ClaudeCodeAdapter({ env: {}, storage: store, hooks: { checkTool: async () => ({ allow: true }), checkpoint: async () => "" }, dataDir: join(dir, ".peer"), log: () => {} });
    Object.assign(adapter as object, { current: { state: "ready" }, binary: "/usr/bin/false" });
    const events: RuntimeEvent[] = [];
    adapter.onEvent((e) => events.push(e));
    const idle = () => vi.waitFor(() => expect(events.some((e) => e.type === "session.idle")).toBe(true));
    return { adapter, events, idle };
  };

  it("sends the effort from Runtime settings, and only a valid one", async () => {
    expect(claudeEffort("low")).toBe("low");
    expect(claudeEffort("xhigh")).toBe("xhigh");
    expect(claudeEffort("turbo")).toBeUndefined();
    expect(claudeEffort(null)).toBeUndefined();
    const { adapter, idle } = make();
    await adapter.prompt(dir, "s1", { text: "hi", system: "", gate: "open", effort: "medium" });
    await idle();
    expect(calls[0]!.options.effort).toBe("medium");
    const other = make();
    await other.adapter.prompt(dir, "s2", { text: "hi", system: "", gate: "open" });
    await other.idle();
    expect(calls[1]!.options).not.toHaveProperty("effort");
  });

  it("the engine passes each runtime its own effort setting", () => {
    const settings = { ...DEFAULT_RUNTIME_SETTINGS, codexEffort: "high", claudeEffort: "low" as const };
    expect(runtimeEffort("claude", settings)).toBe("low");
    expect(runtimeEffort("codex", settings)).toBe("high");
    expect(runtimeEffort("opencode", settings)).toBeUndefined();
    expect(runtimeEffort("claude", DEFAULT_RUNTIME_SETTINGS)).toBeUndefined();
  });

  it("shows a usage limit once: as the turn's error, without the SDK's wrapper or the repeated reply", async () => {
    const limit = "You've hit your 5-hour limit · resets 4pm (Africa/Cairo)";
    script = {
      messages: [
        { type: "stream_event", event: { type: "message_start", message: { id: "m1", model: "<synthetic>" } } },
        { type: "assistant", uuid: "u1", parent_tool_use_id: null, message: { id: "m1", model: "<synthetic>", content: [{ type: "text", text: limit }] } },
      ],
      fail: `Claude Code returned an error result: ${limit}`,
    };
    const { adapter, events, idle } = make();
    await adapter.prompt(dir, "s1", { text: "Explain Trie", system: "", gate: "open" });
    await idle();
    const [, reply] = await adapter.getMessages(dir, "s1");
    expect(reply!.error).toBe(limit);
    expect(reply!.parts).toEqual([{ type: "text", id: "m1:0", text: limit, synthetic: true }]);
    // The engine still learns the turn failed.
    expect(events).toContainEqual({ type: "session.error", sessionId: "s1", error: limit });
    expect(cleanClaudeError("Claude Code returned an error result: x")).toBe("x");
    expect(cleanClaudeError("Something else")).toBe("Something else");
  });

  it("a turn that fails without streaming keeps the previous turn's usage intact", async () => {
    const { adapter, idle, events } = make();
    script = {
      messages: [
        { type: "stream_event", event: { type: "message_start", message: { id: "m1", model: "claude" } } },
        { type: "assistant", uuid: "u1", parent_tool_use_id: null, message: { id: "m1", model: "claude", content: [{ type: "text", text: "Hi." }] } },
        { type: "result", subtype: "success", is_error: false, usage: { input_tokens: 100, output_tokens: 10 } },
      ],
    };
    await adapter.prompt(dir, "s1", { text: "first", system: "", gate: "open" });
    await idle();
    events.length = 0;
    // The usage limit: one synthetic message, no stream events, and a zero-usage error result.
    script = {
      messages: [
        { type: "assistant", uuid: "u2", parent_tool_use_id: null, message: { id: "m2", model: "<synthetic>", content: [{ type: "text", text: "You've hit your limit" }] } },
        { type: "result", subtype: "error_during_execution", is_error: true, usage: { input_tokens: 0, output_tokens: 0 }, errors: ["You've hit your limit"] },
      ],
    };
    await adapter.prompt(dir, "s1", { text: "second", system: "", gate: "open" });
    await idle();
    const messages = await adapter.getMessages(dir, "s1");
    expect(messages.find((m) => m.id === "m1")!.parts).toContainEqual(expect.objectContaining({ type: "step-finish", tokens: expect.objectContaining({ input: 100, output: 10 }) }));
    expect(usage.sessionUsage(messages)).toMatchObject({ input: 100, output: 10 });
    // The failed turn's own (zero) usage sits on its own message.
    expect(messages.find((m) => m.id === "m2")!.error).toBe("You've hit your limit");
  });

  it("hides a reply that repeats the error even when it arrived in several text parts", async () => {
    script = {
      messages: [
        { type: "stream_event", event: { type: "message_start", message: { id: "m1", model: "<synthetic>" } } },
        { type: "stream_event", event: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "You've hit your " } } },
        { type: "stream_event", event: { type: "content_block_delta", index: 1, delta: { type: "text_delta", text: "5-hour limit" } } },
      ],
      fail: "Claude Code returned an error result: You've hit your 5-hour limit",
    };
    const { adapter, idle } = make();
    await adapter.prompt(dir, "s1", { text: "go", system: "", gate: "open" });
    await idle();
    const reply = (await adapter.getMessages(dir, "s1")).find((m) => m.id === "m1")!;
    expect(reply.parts.every((p) => p.type !== "text" || p.synthetic)).toBe(true);
    expect(reply.error).toBe("You've hit your 5-hour limit");
  });

  it("puts a turn's error on its last message only", async () => {
    script = {
      messages: [
        { type: "stream_event", event: { type: "message_start", message: { id: "m1", model: "claude" } } },
        { type: "assistant", uuid: "u1", parent_tool_use_id: null, message: { id: "m1", model: "claude", content: [{ type: "text", text: "Looking." }] } },
        { type: "stream_event", event: { type: "message_start", message: { id: "m2", model: "claude" } } },
        { type: "assistant", uuid: "u2", parent_tool_use_id: null, message: { id: "m2", model: "claude", content: [{ type: "text", text: "Still looking." }] } },
      ],
      fail: "Claude Code returned an error result: Overloaded",
    };
    const { adapter, idle } = make();
    await adapter.prompt(dir, "s1", { text: "go", system: "", gate: "open" });
    await idle();
    const replies = (await adapter.getMessages(dir, "s1")).filter((m) => m.role === "assistant");
    expect(replies.map((m) => m.error ?? null)).toEqual([null, "Overloaded"]);
  });

  it("records the turn's cache use and duration with its tokens", async () => {
    script = {
      messages: [
        { type: "stream_event", event: { type: "message_start", message: { id: "m1", model: "claude" } } },
        { type: "result", subtype: "success", is_error: false, duration_ms: 12_300, usage: { input_tokens: 4, cache_read_input_tokens: 31_802, cache_creation_input_tokens: 4_506, output_tokens: 865 } },
      ],
    };
    const { adapter, idle } = make();
    await adapter.prompt(dir, "s1", { text: "go", system: "", gate: "open" });
    await idle();
    const reply = (await adapter.getMessages(dir, "s1")).find((m) => m.id === "m1")!;
    expect(reply.parts).toContainEqual({ type: "step-finish", id: "m1:usage", tokens: { input: 36_312, output: 865, cacheRead: 31_802, cacheWrite: 4_506 }, durationMs: 12_300 });
  });
});

describe("Codex thinking", () => {
  it("asks for reasoning summaries on every turn, leaving effort to the settings", async () => {
    const { turnStartParams } = await import("../src/server/runtime/codex/adapter.js");
    const params = turnStartParams("t", { text: "hi", system: "", gate: "open" }, "m");
    expect(params.summary).toBe("auto");
    expect(params).not.toHaveProperty("effort");
    expect(turnStartParams("t", { text: "hi", system: "", gate: "hold", effort: "medium" }, "m")).toMatchObject({ summary: "auto", effort: "medium" });
  });

  it("streams Codex's reasoning summary into the reply before its answer, as one part", async () => {
    const { CodexAdapter } = await import("../src/server/runtime/codex/adapter.js");
    const { TestEvidence } = await import("../src/server/runtime/codex/normalize.js");
    const { Transcript } = await import("../src/server/runtime/transcript.js");
    const store = new Store(":memory:");
    const adapter = new CodexAdapter({ storage: store, hooks: {}, log: () => {}, dataDir: "/tmp/unused" } as unknown as ConstructorParameters<typeof CodexAdapter>[0]);
    type Internals = { runs: Map<string, unknown>; byThread: Map<string, string>; onNotification(n: { method: string; params: Record<string, unknown> }): void; transcript(id: string): InstanceType<typeof Transcript> };
    const internals = adapter as unknown as Internals;
    const run = { sessionId: "s1", threadId: "th", directory: "/ws", turnId: "t1", messageId: "a1", abort: new AbortController(), approvals: new Map(), fileChanges: new Map(), declined: new Map(), testEvidence: new TestEvidence(), snapshots: Promise.resolve(), preTestTrees: new Map(), startTree: null };
    internals.byThread.set("th", "s1");
    internals.runs.set("s1", run);
    internals.transcript("s1").startAssistantMessage("a1");
    const notify = (method: string, params: Record<string, unknown>) => internals.onNotification({ method, params: { threadId: "th", turnId: "t1", ...params } });
    const parts = () => internals.transcript("s1").list().find((m) => m.id === "a1")!.parts;

    // What Codex sends with summary "auto": the reasoning item starts empty, its summary streams.
    notify("item/started", { item: { type: "reasoning", id: "r1", summary: [], content: [] } });
    expect(parts()).toEqual([]);
    notify("item/reasoning/summaryTextDelta", { itemId: "r1", delta: "**Recalling tries**\n\nPrefix sharing" });
    notify("item/reasoning/summaryTextDelta", { itemId: "r1", delta: " and end markers." });
    // Before any answer text, the developer already has something to read.
    expect(parts()).toEqual([{ type: "reasoning", id: "r1", text: "**Recalling tries**\n\nPrefix sharing and end markers." }]);
    expect(layout.thinkingHeadline((parts()[0] as { text: string }).text)).toBe("Recalling tries");
    // The completed item restates the summary under the same id: still one part.
    notify("item/completed", { item: { type: "reasoning", id: "r1", summary: ["**Recalling tries**\n\nPrefix sharing and end markers."], content: [] } });
    notify("item/agentMessage/delta", { itemId: "m1", delta: "A trie stores strings by prefix." });
    expect(parts().map((p) => `${p.type}:${p.id}`)).toEqual(["reasoning:r1", "text:m1"]);
    store.close();
  });

  it("shows what the reasoning is on: its last heading, else its last line", () => {
    expect(layout.thinkingHeadline("**Recalling tries**\nA trie...\n\n**Choosing an example**\nUse car/cat")).toBe("Choosing an example");
    expect(layout.thinkingHeadline("Looking at the question.\nComparing hash maps")).toBe("Comparing hash maps");
    expect(layout.thinkingHeadline("")).toBe("");
    expect(layout.thinkingHeadline("x".repeat(200), 20)).toHaveLength(20);
  });
});

describe("token usage from other runtimes", () => {
  it("Codex reports how much of a turn's input came from its cache", async () => {
    const { CodexAdapter } = await import("../src/server/runtime/codex/adapter.js");
    const { TestEvidence } = await import("../src/server/runtime/codex/normalize.js");
    const { Transcript } = await import("../src/server/runtime/transcript.js");
    const store = new Store(":memory:");
    const adapter = new CodexAdapter({ storage: store, hooks: {}, log: () => {}, dataDir: "/tmp/unused" } as unknown as ConstructorParameters<typeof CodexAdapter>[0]);
    type Internals = { runs: Map<string, unknown>; byThread: Map<string, string>; onNotification(n: { method: string; params: Record<string, unknown> }): void; transcript(id: string): InstanceType<typeof Transcript> };
    const internals = adapter as unknown as Internals;
    const run = { sessionId: "s1", threadId: "th", directory: "/ws", turnId: "t2", messageId: "a2", abort: new AbortController(), approvals: new Map(), fileChanges: new Map(), declined: new Map(), testEvidence: new TestEvidence(), snapshots: Promise.resolve(), preTestTrees: new Map(), startTree: null };
    internals.byThread.set("th", "s1");
    internals.runs.set("s1", run);
    internals.transcript("s1").startAssistantMessage("a2");
    const report = (total: [number, number, number], last: [number, number, number]) =>
      internals.onNotification({
        method: "thread/tokenUsage/updated",
        params: {
          threadId: "th",
          turnId: "t2",
          tokenUsage: { total: { inputTokens: total[0], cachedInputTokens: total[1], outputTokens: total[2] }, last: { inputTokens: last[0], cachedInputTokens: last[1], outputTokens: last[2] } },
        },
      });
    // Earlier turns read 700 tokens, 400 of them cached.
    report([1000, 600, 100], [300, 200, 50]);
    expect(internals.transcript("s1").part("a2", "a2:usage")).toEqual({ type: "step-finish", id: "a2:usage", tokens: { input: 300, output: 50, cacheRead: 200 } });
    report([1600, 1100, 180], [600, 500, 80]);
    expect(internals.transcript("s1").part("a2", "a2:usage")).toMatchObject({ tokens: { input: 900, output: 130, cacheRead: 700 } });
    store.close();
  });

  it("OpenCode's input counts its cached tokens too", () => {
    const part = normalizePart({ type: "step-finish", id: "p", sessionID: "s", messageID: "m", reason: "stop", cost: 0.01, tokens: { input: 100, output: 20, reasoning: 5, cache: { read: 900, write: 50 } } } as never);
    expect(part).toEqual({ type: "step-finish", id: "p", tokens: { input: 1050, output: 20, cacheRead: 900, cacheWrite: 50 }, cost: 0.01 });
  });
});

const msg = (id: string, role: "user" | "assistant", parts: PeerPart[], extra: Partial<PeerMessage> = {}): PeerMessage => ({ id, role, createdAt: 0, parts, ...extra });
const tool = (id: string, toolName: string, status: "completed" | "error" | "running", input: Record<string, unknown> = {}, error?: string): PeerPart => ({
  type: "tool",
  id,
  tool: toolName,
  callId: id,
  status,
  input,
  error,
});

describe("usage display", () => {
  const steps = (id: string, input: number, output: number, cacheRead?: number): PeerPart => ({ type: "step-finish", id, tokens: { input, output, ...(cacheRead === undefined ? {} : { cacheRead, cacheWrite: 0 }) } });

  it("sums a turn's steps across its messages and shows it on the last one", () => {
    const messages = [
      msg("u1", "user", [{ type: "text", id: "t", text: "hi" }]),
      msg("a1", "assistant", [steps("s1", 1000, 10, 800)]),
      msg("a2", "assistant", [steps("s2", 2000, 20, 1800)]),
      msg("u2", "user", [{ type: "text", id: "t2", text: "next" }]),
      msg("a3", "assistant", [{ type: "text", id: "x", text: "no usage reported" }]),
    ];
    const turns = usage.turnUsages(messages);
    expect([...turns.keys()]).toEqual(["a2"]);
    expect(turns.get("a2")).toMatchObject({ input: 3000, output: 30, cacheRead: 2600, cacheKnown: true });
    expect(usage.sessionUsage(messages)).toMatchObject({ input: 3000, output: 30 });
    expect(usage.sessionUsage([messages[4]!])).toBeNull();
  });

  it("formats compactly and says what it can't know", () => {
    expect(usage.formatTokens(950)).toBe("950");
    expect(usage.formatTokens(12_345)).toBe("12.3k");
    expect(usage.formatTokens(31_000)).toBe("31k");
    expect(usage.formatTokens(250_400)).toBe("250k");
    expect(usage.formatTokens(1_230_000)).toBe("1.23M");
    const known = { input: 36_312, output: 865, cacheRead: 31_802, cacheWrite: 4_506, durationMs: 12_300, cacheKnown: true };
    expect(usage.usageLine(known)).toBe("36.3k in (31.8k cached) · 865 out · 12s");
    expect(usage.usageDetail(known)).toContain("uncached: 4");
    // Codex without cache figures: no cached part, no made-up breakdown.
    const unknown = { ...known, cacheRead: 0, cacheWrite: 0, durationMs: 0, cacheKnown: false };
    expect(usage.usageLine(unknown)).toBe("36.3k in · 865 out");
    expect(usage.usageDetail(unknown)).not.toContain("cache");
  });
});

describe("transcript layout", () => {
  it("groups a turn's consecutive tool calls across messages, through parts that render nothing", () => {
    const items: PeerPart[] = [
      { type: "text", id: "t1", text: "Checking your past chats." },
      tool("b1", "bash", "error", { command: "ls" }),
      { type: "reasoning", id: "r", text: "" },
      tool("b2", "bash", "error", { command: "cd x" }, "Peer collaboration gate: locked"),
      { type: "step-finish", id: "sf" },
      tool("g1", "grep", "completed", { pattern: "x" }),
      { type: "text", id: "t2", text: "Your history records four concepts." },
      tool("e1", "edit", "completed", { filePath: "a.ts" }),
    ];
    // Edits with a diff stay their own card; this one has none, so it groups too.
    const segs = layout.segmentTurn(
      items,
      (p) => (layout.groupable(p) ? p : null),
      (p) => (p.type === "text" ? p.text.trim() !== "" : p.type === "reasoning" ? p.text.trim() !== "" : p.type !== "step-finish"),
    );
    expect(segs.map((s) => (s.kind === "tools" ? s.parts.map((p) => p.id) : s.item.id))).toEqual(["t1", ["b1", "b2", "g1"], "t2", ["e1"]]);
    const group = segs[1]!;
    expect(group.kind === "tools" && layout.toolGroupSummary(group.parts)).toBe("Ran 2 commands, ran 1 search · 1 blocked · 1 failed");
    expect(layout.groupable({ ...(tool("e2", "edit", "completed") as Extract<PeerPart, { type: "tool" }>), diff: "+x" })).toBe(false);
    expect(layout.groupable(tool("c", "peer_checkpoint", "completed"))).toBe(false);
  });

  it("shows each error of a turn once, including transcripts stored with it on every message", () => {
    const wrapped = "Claude Code returned an error result: You've hit your 5-hour limit";
    const errors = layout.turnErrors([
      msg("a1", "assistant", [], { error: wrapped }),
      msg("a2", "assistant", [], { error: wrapped }),
      msg("a3", "assistant", []),
    ]);
    expect([...errors]).toEqual([
      ["a3", null],
      ["a2", "You've hit your 5-hour limit"],
      ["a1", null],
    ]);
    // Different errors in one turn both show.
    const two = layout.turnErrors([msg("b1", "assistant", [], { error: "Overloaded" }), msg("b2", "assistant", [], { error: "Stopped." })]);
    expect(two.get("b1")).toBe("Overloaded");
    expect(two.get("b2")).toBe("Stopped.");
  });

  it("splits the transcript into developer messages and agent turns", () => {
    const blocks = layout.transcriptBlocks([msg("u1", "user", []), msg("a1", "assistant", []), msg("a2", "assistant", []), msg("u2", "user", [])]);
    expect(blocks.map((b) => (b.kind === "user" ? b.message.id : b.messages.map((m) => m.id)))).toEqual(["u1", ["a1", "a2"], "u2"]);
    expect(layout.cleanError("Claude Code returned an error result: You've hit your limit")).toBe("You've hit your limit");
  });
});

describe("prompt guidance", () => {
  it("asks for one topic per concept, not its parts", () => {
    const text = learningMapInstructions("peer_checkpoint", []).join("\n");
    expect(text).toContain("One concept is one topic");
    expect(text).toContain('tags "Tries"');
    expect(text).toContain("at most 3");
  });

  it("tells a chat agent it can't see other chats or the map, and where the developer finds them", () => {
    const plan = resolveEffectivePolicy("learn", "default", false);
    const chat = composeSystemPrompt(plan, "peer_checkpoint", { generalChat: true });
    expect(chat).toContain("You can't see the developer's other chats or their learning map");
    expect(chat).toContain("Cmd/Ctrl+G");
    expect(composeSystemPrompt(plan, "peer_checkpoint", {})).not.toContain("other chats");
  });
});
