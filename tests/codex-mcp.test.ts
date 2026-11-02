import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CodexAdapter, MCP_LOCKED_NOTE, turnStartParams } from "../src/server/runtime/codex/adapter.js";
import type { RuntimeEvent } from "../src/server/runtime/adapter.js";
import { Transcript } from "../src/server/runtime/transcript.js";
import { TestEvidence } from "../src/server/runtime/codex/normalize.js";
import { Store } from "../src/server/store.js";

describe("Codex MCP prevention", () => {
  const input = (gate: "open" | "engage" | "hold") => ({ text: "do it", system: "POLICY", gate });

  it("tells gated turns not to start MCP tools, and leaves open turns alone", () => {
    for (const gate of ["engage", "hold"] as const) {
      const policy = turnStartParams("t", input(gate), "m").input[0]!.text;
      expect(policy).toContain("POLICY");
      expect(policy).toContain(MCP_LOCKED_NOTE);
      expect(policy).toMatch(/peer_checkpoint/);
    }
    const open = turnStartParams("t", input("open"), "m").input[0]!.text;
    expect(open).not.toContain(MCP_LOCKED_NOTE);
  });
});

describe("Codex MCP pre-execution approval", () => {
  let dir: string;
  let store: Store;
  let gate: { allow: boolean; reason?: string };
  let events: RuntimeEvent[];
  let responses: { id: number | string; result: unknown }[];
  let adapter: CodexAdapter;

  type Internals = {
    rpc: unknown;
    runs: Map<string, Record<string, unknown>>;
    byThread: Map<string, string>;
    onRequest(r: { id: number; method: string; params: Record<string, unknown> }): Promise<void>;
    onNotification(n: { method: string; params: Record<string, unknown> }): void;
    transcript(id: string): Transcript;
  };
  const internals = () => adapter as unknown as Internals;

  beforeEach(() => {
    dir = realpathSync(mkdtempSync(join(tmpdir(), "peer-codex-mcp-")));
    store = new Store(":memory:");
    gate = { allow: true };
    events = [];
    responses = [];
    adapter = new CodexAdapter({
      storage: store,
      hooks: {
        checkTool: async () => (gate.allow ? { allow: true } : { allow: false as const, reason: gate.reason ?? "locked" }),
        checkpoint: async () => "",
      },
      log: () => {},
      dataDir: join(dir, "data"),
    } as unknown as ConstructorParameters<typeof CodexAdapter>[0]);
    adapter.onEvent((e) => events.push(e));
    internals().rpc = {
      alive: true,
      respond: (id: number | string, result: unknown) => responses.push({ id, result }),
      respondError: () => {},
    };
  });

  afterEach(() => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });

  /** A turn in progress, as prompt() would leave it. */
  function startedRun() {
    const run: Record<string, unknown> = {
      sessionId: "s1",
      threadId: "th",
      directory: dir,
      turnId: "t1",
      messageId: "a1",
      abort: new AbortController(),
      approvals: new Map(),
      fileChanges: new Map(),
      declined: new Map(),
      testEvidence: new TestEvidence(),
      snapshots: Promise.resolve(),
      startTree: null,
      preTestTrees: new Map(),
    };
    internals().byThread.set("th", "s1");
    internals().runs.set("s1", run);
    internals().transcript("s1").startAssistantMessage("a1");
  }

  const mcpRequest = (id: number, params: Record<string, unknown> = {}) => ({
    id,
    method: "item/mcpToolCall/requestApproval",
    params: { threadId: "th", turnId: "t1", server: "jira", tool: "create_issue", arguments: { summary: "x" }, ...params },
  });

  it("asks the developer before the call runs, and honors the reply", async () => {
    startedRun();
    await internals().onRequest(mcpRequest(1));
    const asked = events.find((e) => e.type === "permission.asked");
    expect(asked).toMatchObject({ type: "permission.asked", request: { permission: "mcp", sessionId: "s1" } });
    expect((asked as { request: { patterns: string[] } }).request.patterns).toEqual(["jira: create_issue"]);

    // Nothing answered yet: the MCP call is held, not accepted.
    expect(responses).toHaveLength(0);
    await adapter.replyPermission(dir, (asked as { request: { id: string } }).request.id, "once");
    expect(responses).toEqual([{ id: 1, result: { decision: "accept" } }]);
    expect(events.some((e) => e.type === "permission.replied")).toBe(true);
  });

  it("a rejection declines the call before it runs", async () => {
    startedRun();
    await internals().onRequest(mcpRequest(2));
    const asked = events.find((e) => e.type === "permission.asked") as { request: { id: string } };
    await adapter.replyPermission(dir, asked.request.id, "reject");
    expect(responses).toEqual([{ id: 2, result: { decision: "decline" } }]);
  });

  it("a locked gate declines without asking the developer", async () => {
    gate = { allow: false, reason: "Code changes are locked" };
    startedRun();
    await internals().onRequest(mcpRequest(3));
    expect(responses).toEqual([{ id: 3, result: { decision: "decline" } }]);
    expect(events.some((e) => e.type === "permission.asked")).toBe(false);
  });

  it("rejects calls for unknown runs", async () => {
    await internals().onRequest(mcpRequest(4));
    expect(responses).toEqual([{ id: 4, result: { decision: "cancel" } }]);
  });

  it("still stops the turn when older Codex starts an MCP call without asking", async () => {
    gate = { allow: false, reason: "Code changes are locked" };
    startedRun();
    internals().onNotification({
      method: "item/started",
      params: { threadId: "th", turnId: "t1", item: { type: "mcpToolCall", id: "m1", server: "jira", tool: "create_issue", readOnlyHint: false } },
    });
    // endRun finishes asynchronously (change check, then idle); wait for that signal
    // instead of a fixed delay so teardown cannot close the Store mid-bookkeeping.
    const deadline = Date.now() + 5000;
    while (!events.some((e) => e.type === "session.idle")) {
      if (Date.now() > deadline) throw new Error("timed out waiting for session.idle");
      await new Promise((r) => setTimeout(r, 5));
    }
    expect(events.some((e) => e.type === "session.error" && e.error.includes("jira_create_issue"))).toBe(true);
    expect(internals().runs.has("s1")).toBe(false);
  });

  it("lets read-only MCP calls and open gates through without stopping", async () => {
    startedRun();
    internals().onNotification({
      method: "item/started",
      params: { threadId: "th", turnId: "t1", item: { type: "mcpToolCall", id: "m2", server: "jira", tool: "get_issue", readOnlyHint: true } },
    });
    await new Promise((r) => setTimeout(r, 50));
    expect(events.some((e) => e.type === "session.error")).toBe(false);
    expect(internals().runs.has("s1")).toBe(true);
  });
});
