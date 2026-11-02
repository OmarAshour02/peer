import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ClaudeCodeAdapter, forkPoint } from "../src/server/runtime/claude/adapter.js";
import { CodexAdapter, revertTarget } from "../src/server/runtime/codex/adapter.js";
import { Store } from "../src/server/store.js";

describe("forkPoint", () => {
  it("forks at the last kept turn's UUID", () => {
    expect(
      forkPoint(
        [
          { t: 100, u: "u1" },
          { t: 200, u: "u2" },
          { t: 300, u: "u3" },
        ],
        250,
      ),
    ).toEqual({ kind: "fork", upToMessageId: "u2" });
  });

  it("falls back when the last kept turn has no usable UUID", () => {
    // Forking at u1 would silently drop the later kept turn from the CLI session, so a
    // kept turn without a (remapped) UUID means "cannot truncate", not "truncate earlier".
    expect(
      forkPoint(
        [
          { t: 100, u: "u1" },
          { t: 200, u: null },
        ],
        250,
      ),
    ).toEqual({ kind: "unknown" });
    expect(
      forkPoint(
        [
          { t: 100, u: "f1" },
          { t: 200, u: null },
        ],
        250,
      ),
    ).toEqual({ kind: "unknown" });
  });

  it("resets when every turn is undone", () => {
    expect(forkPoint([{ t: 200, u: "u2" }], 150)).toEqual({ kind: "reset" });
  });

  it("falls back when nothing is recorded, or kept turns have no UUID", () => {
    expect(forkPoint([], 150)).toEqual({ kind: "unknown" });
    expect(forkPoint([{ t: 100, u: null }], 150)).toEqual({ kind: "unknown" });
  });
});

describe("revertTarget", () => {
  const turns = [
    { t: 100, id: "turn1" },
    { t: 200, id: "turn2" },
  ];
  it("drops the first undone turn and everything after it", () => {
    expect(revertTarget(turns, 150)).toBe("turn2");
    expect(revertTarget(turns, 100)).toBe("turn1");
    expect(revertTarget(turns, 50)).toBe("turn1");
  });

  it("finds nothing after the last recorded turn", () => {
    expect(revertTarget(turns, 250)).toBeNull();
    expect(revertTarget([], 50)).toBeNull();
  });
});

describe("Claude undo truncate", () => {
  let dir: string;
  let store: Store;
  let calls: { op: string; sessionId: string; opts: unknown }[];
  let fail: string | null;
  let sessionMessages: Record<string, { type: string; uuid: string }[]>;

  const adapter = () =>
    new ClaudeCodeAdapter({
      env: process.env,
      storage: store,
      hooks: { checkTool: async () => ({ allow: true }), checkpoint: async () => "" },
      dataDir: join(dir, "data"),
      log: () => {},
      forkSession: (async (sessionId: string, opts: unknown) => {
        if (fail === "fork") throw new Error("fork refused");
        calls.push({ op: "fork", sessionId, opts });
        return { sessionId: "forked" };
      }) as never,
      deleteSession: (async (sessionId: string, opts: unknown) => {
        if (fail === "delete") throw new Error("gone");
        calls.push({ op: "delete", sessionId, opts });
      }) as never,
      getSessionMessages: (async (sessionId: string) => sessionMessages[sessionId] ?? []) as never,
    } as unknown as ConstructorParameters<typeof ClaudeCodeAdapter>[0]);

  beforeEach(() => {
    dir = realpathSync(mkdtempSync(join(tmpdir(), "peer-truncate-")));
    store = new Store(":memory:");
    calls = [];
    fail = null;
    sessionMessages = {};
  });

  afterEach(() => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("forks the CLI session at the last kept turn", async () => {
    const a = adapter();
    store.setRuntimeState("claude", "s1", { started: true, turns: [{ t: 100, u: "u1" }, { t: 200, u: "u2" }] });
    expect(await a.forgetTurns(dir, "s1", 150)).toBe(true);
    expect(calls).toEqual([{ op: "fork", sessionId: "s1", opts: { dir, upToMessageId: "u1" } }]);
    expect(store.getRuntimeState<{ claudeSessionId: string; turns: unknown[] }>("claude", "s1")).toMatchObject({
      claudeSessionId: "forked",
      // No transcript was supplied to remap with, so the stale UUID is dropped and the
      // next undo falls back instead of truncating at an invalid ID.
      turns: [{ t: 100, u: null }],
    });
  });

  it("keeps valid UUIDs across repeated undos after a fork", async () => {
    const a = adapter();
    sessionMessages = {
      s1: [
        { type: "assistant", uuid: "u1" },
        { type: "assistant", uuid: "u2" },
        { type: "assistant", uuid: "u3" },
      ],
      forked: [
        { type: "assistant", uuid: "f1" },
        { type: "assistant", uuid: "f2" },
      ],
    };
    store.setRuntimeState("claude", "s1", {
      started: true,
      turns: [
        { t: 100, u: "u1" },
        { t: 200, u: "u2" },
        { t: 300, u: "u3" },
      ],
    });
    expect(await a.forgetTurns(dir, "s1", 250)).toBe(true);
    expect(store.getRuntimeState<{ turns: unknown[] }>("claude", "s1")!.turns).toEqual([
      { t: 100, u: "f1" },
      { t: 200, u: "f2" },
    ]);

    sessionMessages.forked = [{ type: "assistant", uuid: "g1" }];
    expect(await a.forgetTurns(dir, "s1", 150)).toBe(true);
    expect(calls[1]).toEqual({ op: "fork", sessionId: "forked", opts: { dir, upToMessageId: "f1" } });
  });

  it("deletes the CLI session when every turn is undone", async () => {
    const a = adapter();
    store.setRuntimeState("claude", "s1", { started: true, turns: [{ t: 200, u: "u2" }] });
    expect(await a.forgetTurns(dir, "s1", 150)).toBe(true);
    expect(calls).toEqual([{ op: "delete", sessionId: "s1", opts: { dir } }]);
    expect(store.getRuntimeState<{ started: boolean; turns: unknown[] }>("claude", "s1")).toMatchObject({ started: false, turns: [] });
  });

  it("tells the agent when there is nothing to truncate with", async () => {
    const a = adapter();
    store.setRuntimeState("claude", "s1", { started: true, turns: [] });
    expect(await a.forgetTurns(dir, "s1", 150)).toBe(false);
    expect(calls).toEqual([]);
  });

  it("tells the agent when the truncate fails, keeping the records", async () => {
    const a = adapter();
    fail = "fork";
    store.setRuntimeState("claude", "s1", { started: true, turns: [{ t: 100, u: "u1" }, { t: 200, u: "u2" }] });
    expect(await a.forgetTurns(dir, "s1", 150)).toBe(false);
    expect(store.getRuntimeState<{ turns: unknown[] }>("claude", "s1")!.turns).toHaveLength(2);
  });

  it("drops Peer's transcript in every path", async () => {
    const a = adapter();
    const t = (a as unknown as { transcript(id: string): { addUserMessage(id: string, text: string): void } }).transcript("s1");
    t.addUserMessage("u1", "hello");
    store.setRuntimeState("claude", "s1", { started: false });
    expect(await a.forgetTurns(dir, "s1", 0)).toBe(true);
    expect(calls).toEqual([]);
  });

  it("refuses while the agent works", async () => {
    const a = adapter();
    (a as unknown as { runs: Map<string, unknown> }).runs.set("s1", {});
    await expect(a.forgetTurns(dir, "s1", 0)).rejects.toThrow(/still working/);
  });
});

describe("Codex undo revert", () => {
  let dir: string;
  let store: Store;
  let rpcCalls: { method: string; params: Record<string, unknown> }[];
  let rpcFail: boolean;

  const adapter = () => {
    const a = new CodexAdapter({
      storage: store,
      hooks: { checkTool: async () => ({ allow: true }), checkpoint: async () => "" },
      dataDir: join(dir, "data"),
      log: () => {},
    } as unknown as ConstructorParameters<typeof CodexAdapter>[0]);
    (a as unknown as { rpc: unknown }).rpc = {
      alive: true,
      call: async (method: string, params: Record<string, unknown>) => {
        if (rpcFail) throw new Error("revert refused");
        rpcCalls.push({ method, params });
        return {};
      },
      respond: () => {},
      respondError: () => {},
    };
    return a;
  };

  beforeEach(() => {
    dir = realpathSync(mkdtempSync(join(tmpdir(), "peer-revert-")));
    store = new Store(":memory:");
    rpcCalls = [];
    rpcFail = false;
  });

  afterEach(() => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("reverts the thread before the first undone turn", async () => {
    const a = adapter();
    store.setRuntimeState("codex", "s1", { threadId: "th1", turns: [{ t: 100, id: "turn1" }, { t: 200, id: "turn2" }] });
    expect(await a.forgetTurns(dir, "s1", 150)).toBe(true);
    expect(rpcCalls).toEqual([{ method: "thread/revert", params: { threadId: "th1", beforeTurnId: "turn2" } }]);
    expect(store.getRuntimeState<{ turns: unknown[] }>("codex", "s1")!.turns).toEqual([{ t: 100, id: "turn1" }]);
  });

  it("has nothing to revert when no thread exists yet", async () => {
    const a = adapter();
    store.setRuntimeState("codex", "s1", {});
    expect(await a.forgetTurns(dir, "s1", 150)).toBe(true);
    expect(rpcCalls).toEqual([]);
  });

  it("tells the agent when the turns cannot be mapped or the revert fails", async () => {
    const a = adapter();
    store.setRuntimeState("codex", "s1", { threadId: "th1", turns: [{ t: 100, id: "turn1" }] });
    expect(await a.forgetTurns(dir, "s1", 150)).toBe(false);

    rpcFail = true;
    store.setRuntimeState("codex", "s1", { threadId: "th1", turns: [{ t: 100, id: "turn1" }, { t: 200, id: "turn2" }] });
    expect(await a.forgetTurns(dir, "s1", 150)).toBe(false);
    // A failed revert keeps the records for a later retry.
    expect(store.getRuntimeState<{ turns: unknown[] }>("codex", "s1")!.turns).toHaveLength(2);
  });

  it("refuses while the agent works", async () => {
    const a = adapter();
    (a as unknown as { runs: Map<string, unknown> }).runs.set("s1", {});
    await expect(a.forgetTurns(dir, "s1", 0)).rejects.toThrow(/still working/);
  });
});
