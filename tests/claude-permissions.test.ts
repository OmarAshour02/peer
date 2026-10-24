import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PermissionUpdate } from "@anthropic-ai/claude-agent-sdk";
import type { PermissionRequest } from "../src/shared/types.js";
import type { RuntimeEvent } from "../src/server/runtime/adapter.js";
import { Store } from "../src/server/store.js";

// Capture what Peer passes to the Agent SDK for each turn. A turn lasts until the test ends it.
const calls: { prompt: unknown; options: Record<string, unknown>; end: () => void }[] = [];
vi.mock("@anthropic-ai/claude-agent-sdk", async (original) => ({
  ...(await original<object>()),
  query: (args: { prompt: unknown; options: Record<string, unknown> }) => {
    let end = () => {};
    const done = new Promise<void>((resolve) => (end = resolve));
    calls.push({ ...args, end });
    return {
      async *[Symbol.asyncIterator]() {
        await done;
      },
      interrupt: async () => end(),
      close: () => end(),
    };
  },
}));

const { ClaudeCodeAdapter, describeSuggestions, sessionGrants } = await import("../src/server/runtime/claude/adapter.js");

// What Claude Code 2.1.310 suggested for `cat ../outside/note.txt` in a real run (Haiku, 2026-10-24).
const SUGGESTIONS: PermissionUpdate[] = [
  { type: "addRules", rules: [{ toolName: "Bash", ruleContent: "cat ../outside/note.txt" }], behavior: "allow", destination: "localSettings" },
  { type: "addRules", rules: [{ toolName: "Read", ruleContent: "//work/outside/**" }], behavior: "allow", destination: "session" },
];

describe("Claude Code 'Always allow'", () => {
  let dir: string;
  let store: Store;
  beforeEach(() => {
    dir = realpathSync(mkdtempSync(join(tmpdir(), "peer-claude-perm-")));
    store = new Store(":memory:");
    calls.length = 0;
  });
  afterEach(() => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("describes what it saves and where", () => {
    expect(describeSuggestions(SUGGESTIONS)).toEqual([
      { grant: "Bash(cat ../outside/note.txt)", scope: "this project, on this machine" },
      { grant: "Read(//work/outside/**)", scope: "this Peer session" },
    ]);
    expect(sessionGrants(SUGGESTIONS)).toEqual({ rules: ["Read(//work/outside/**)"], directories: [] });
    expect(sessionGrants([{ type: "addDirectories", directories: ["/work/other"], destination: "session" }])).toEqual({ rules: [], directories: ["/work/other"] });
  });

  it("keeps session-scoped grants for later turns of the Peer session, across a restart", async () => {
    const make = () => {
      const adapter = new ClaudeCodeAdapter({ env: {}, storage: store, hooks: { checkTool: async () => ({ allow: true }), checkpoint: async () => "" }, dataDir: join(dir, ".peer"), log: () => {} });
      Object.assign(adapter as object, { current: { state: "ready" }, binary: "/usr/bin/false" });
      return adapter;
    };
    const adapter = make();
    const events: RuntimeEvent[] = [];
    adapter.onEvent((e) => events.push(e));
    await adapter.prompt(dir, "s1", { text: "first", system: "", gate: "open" });
    expect(calls[0]!.options.allowedTools).toBeUndefined();

    // Claude Code asks; the developer chooses "Always allow".
    const canUseTool = calls[0]!.options.canUseTool as (t: string, i: unknown, o: { signal: AbortSignal; suggestions?: PermissionUpdate[] }) => Promise<unknown>;
    const decision = canUseTool("Bash", { command: "cat ../outside/note.txt" }, { signal: new AbortController().signal, suggestions: SUGGESTIONS });
    const asked = events.find((e): e is { type: "permission.asked"; request: PermissionRequest } => e.type === "permission.asked")!;
    expect(asked.request.metadata.always).toEqual(describeSuggestions(SUGGESTIONS));
    await adapter.replyPermission(dir, asked.request.id, "always");
    expect(await decision).toMatchObject({ behavior: "allow", updatedPermissions: SUGGESTIONS });

    // The next turn is a new query: the session grant comes along (also after Peer restarts).
    calls.at(-1)!.end();
    await vi.waitFor(() => expect((adapter as unknown as { runs: Map<string, unknown> }).runs.size).toBe(0));
    const restarted = make();
    await restarted.prompt(dir, "s1", { text: "second", system: "", gate: "open" });
    expect(calls[1]!.options.allowedTools).toEqual(["Read(//work/outside/**)"]);
    // Other sessions do not inherit it.
    calls.at(-1)!.end();
    await restarted.prompt(dir, "s2", { text: "other", system: "", gate: "open" });
    expect(calls[2]!.options.allowedTools).toBeUndefined();
    calls.at(-1)!.end();
  });

  it("'Allow once' keeps nothing", async () => {
    const adapter = new ClaudeCodeAdapter({ env: {}, storage: store, hooks: { checkTool: async () => ({ allow: true }), checkpoint: async () => "" }, dataDir: join(dir, ".peer"), log: () => {} });
    Object.assign(adapter as object, { current: { state: "ready" }, binary: "/usr/bin/false" });
    const events: RuntimeEvent[] = [];
    adapter.onEvent((e) => events.push(e));
    await adapter.prompt(dir, "s1", { text: "first", system: "", gate: "open" });
    const canUseTool = calls[0]!.options.canUseTool as (t: string, i: unknown, o: { signal: AbortSignal; suggestions?: PermissionUpdate[] }) => Promise<unknown>;
    const decision = canUseTool("Bash", { command: "cat ../outside/note.txt" }, { signal: new AbortController().signal, suggestions: SUGGESTIONS });
    const asked = events.find((e): e is { type: "permission.asked"; request: PermissionRequest } => e.type === "permission.asked")!;
    await adapter.replyPermission(dir, asked.request.id, "once");
    expect(await decision).toMatchObject({ behavior: "allow", updatedPermissions: undefined });
    calls.at(-1)!.end();
    await vi.waitFor(() => expect((adapter as unknown as { runs: Map<string, unknown> }).runs.size).toBe(0));
    await adapter.prompt(dir, "s1", { text: "second", system: "", gate: "open" });
    expect(calls[1]!.options.allowedTools).toBeUndefined();
    calls.at(-1)!.end();
  });
});
