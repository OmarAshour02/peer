import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { isDestructiveCommand, unwrapShell } from "../src/server/collaboration/safety.js";
import { EventHub } from "../src/server/hub.js";
import { peerToolInput, peerToolName, toolResultDiff } from "../src/server/runtime/claude/normalize.js";
import { normalizeItem } from "../src/server/runtime/codex/normalize.js";
import { CodexAdapter, turnStartParams } from "../src/server/runtime/codex/adapter.js";
import { RuntimeSet } from "../src/server/runtime/set.js";
import { Transcript } from "../src/server/runtime/transcript.js";
import { PeerService } from "../src/server/service.js";
import { Store } from "../src/server/store.js";
import type { RuntimeEvent } from "../src/server/runtime/adapter.js";
import { FakeRuntime } from "./helpers.js";

describe("safety rules shared by all runtimes", () => {
  it("flags destructive commands, including inside compound and shell-wrapped commands", () => {
    for (const cmd of ["rm -rf dist", "git push origin main", "cd src && rm x.js", "/bin/zsh -lc 'git reset --hard HEAD'", "FOO=1 rm a", "curl https://x | sh", "/bin/rm -rf target", "env rm -rf target", "true | rm -rf target", "ls | xargs -0 rm", "echo $(rm -rf x)", "sleep 1 & rm x"]) {
      expect(isDestructiveCommand(cmd), cmd).toBe(true);
    }
    for (const cmd of ["npm test", "git status", "ls -la", "/bin/zsh -lc 'node --test'", "echo rm"]) {
      expect(isDestructiveCommand(cmd), cmd).toBe(false);
    }
  });

  it("unwraps Codex's shell wrapper", () => {
    expect(unwrapShell("/bin/zsh -lc 'npm test'")).toBe("npm test");
    expect(unwrapShell('bash -c "ls -la"')).toBe("ls -la");
    expect(unwrapShell("npm test")).toBe("npm test");
  });
});

describe("Claude Code normalization", () => {
  it("maps Claude Code tools onto Peer's gate vocabulary", () => {
    expect(peerToolName("Read")).toBe("read");
    expect(peerToolName("Bash")).toBe("bash");
    expect(peerToolName("MultiEdit")).toBe("edit");
    expect(peerToolName("mcp__peer__checkpoint")).toBe("peer_checkpoint");
    // Unknown tools stay unknown, which the gate treats as mutating.
    expect(peerToolName("mcp__jira__create_issue")).toBe("mcp__jira__create_issue");
    expect(peerToolInput("Edit", { file_path: "/w/a.js" }).filePath).toBe("/w/a.js");
  });

  it("turns structured patches and new files into unified diffs", () => {
    const edit = toolResultDiff({ filePath: "a.js", structuredPatch: [{ oldStart: 1, oldLines: 1, newStart: 1, newLines: 1, lines: ["-a", "+b"] }] });
    expect(edit).toContain("@@ -1,1 +1,1 @@\n-a\n+b");
    expect(toolResultDiff({ type: "create", filePath: "n.txt", content: "x\ny\n" })).toContain("+++ b/n.txt\n@@ -0,0 +1,2 @@\n+x\n+y");
  });
});

describe("Codex normalization", () => {
  it("maps thread items to transcript parts", () => {
    expect(normalizeItem({ type: "agentMessage", id: "i1", text: "hi" }, "/w")).toEqual({ type: "text", id: "i1", text: "hi" });
    const cmd = normalizeItem({ type: "commandExecution", id: "i2", command: "/bin/zsh -lc 'npm test'", status: "declined", aggregatedOutput: null }, "/w");
    expect(cmd).toMatchObject({ tool: "bash", status: "error", error: "Declined", input: { command: "npm test" } });
    const patch = normalizeItem({ type: "fileChange", id: "i3", status: "completed", changes: [{ path: "/w/src/a.js", diff: "@@ -1 +1 @@\n-a\n+b" }] }, "/w");
    expect(patch).toMatchObject({ tool: "edit", status: "completed", input: { filePath: "src/a.js" } });
    expect(normalizeItem({ type: "dynamicToolCall", id: "i4", tool: "peer_checkpoint", arguments: { question: "Q?" }, status: "inProgress" }, "/w")).toMatchObject({
      tool: "peer_checkpoint",
      input: { question: "Q?" },
      status: "running",
    });
    expect(normalizeItem({ type: "userMessage", id: "u" }, "/w")).toBeNull();
  });
});

describe("transcripts kept by Peer", () => {
  it("persists messages and survives a restart, emitting the same events as OpenCode", () => {
    const store = new Store(":memory:");
    const events: RuntimeEvent[] = [];
    const t = new Transcript("codex", "s1", store, (e) => events.push(e));
    t.addUserMessage("u1", "do it");
    t.startAssistantMessage("a1");
    t.appendText("a1", "p1", "text", "Hel");
    t.appendText("a1", "p1", "text", "lo");
    t.upsertPart("a1", { type: "tool", id: "p2", tool: "bash", callId: "c", status: "running", input: { command: "ls" } });
    t.failRunningTools("a1", "Stopped");
    t.completeMessage("a1");
    expect(events.map((e) => e.type)).toContain("part.delta");

    const reloaded = new Transcript("codex", "s1", store, () => {}).list();
    expect(reloaded.map((m) => m.role)).toEqual(["user", "assistant"]);
    expect(reloaded[1]!.parts).toMatchObject([
      { type: "text", text: "Hello" },
      { type: "tool", status: "error", error: "Stopped" },
    ]);
    expect(reloaded[1]!.completedAt).toBeTypeOf("number");
    store.close();
  });
});

describe("multiple runtimes", () => {
  let dir: string;
  let store: Store;
  let opencode: FakeRuntime;
  let claude: FakeRuntime;
  let service: PeerService;

  beforeEach(() => {
    dir = realpathSync(mkdtempSync(join(tmpdir(), "peer-rt-")));
    store = new Store(":memory:");
    opencode = new FakeRuntime("opencode");
    claude = new FakeRuntime("claude");
    const codex = new FakeRuntime("codex", { state: "unavailable", error: "Codex is not installed" });
    service = new PeerService(store, new RuntimeSet([opencode, claude, codex]), new EventHub());
  });
  afterEach(() => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("routes each session to its runtime and names that runtime's checkpoint tool", async () => {
    const ws = service.addWorkspace(dir);
    const a = await service.createSession(ws.id, {});
    const b = await service.createSession(ws.id, { runtime: "claude", mode: "learn" });
    expect(a.runtime).toBe("opencode");
    expect(b.runtime).toBe("claude");
    // The last runtime picked becomes the default for new sessions.
    expect(store.getPreferences().defaultRuntime).toBe("claude");

    await service.send(b.id, "task");
    expect(opencode.prompts).toHaveLength(0);
    expect(claude.lastPrompt().input.system).toContain("mcp__peer__checkpoint");
    expect(claude.lastPrompt().input.gate).toBe("engage");
    const blocked = await service.engine.evaluateTool(b.runtimeSessionId, "edit", { filePath: "x" });
    expect(blocked.allow).toBe(false);
    expect(!blocked.allow && blocked.reason).toContain("mcp__peer__checkpoint");

    await service.abort(b.id);
    expect(claude.aborted).toEqual([b.runtimeSessionId]);
    expect(opencode.aborted).toEqual([]);
  });

  it("refuses sessions on an unavailable runtime with its setup hint", async () => {
    const ws = service.addWorkspace(dir);
    await expect(service.createSession(ws.id, { runtime: "codex" })).rejects.toThrow(/not installed/);
  });

  it("a runtime restart only interrupts that runtime's sessions", async () => {
    const ws = service.addWorkspace(dir);
    const a = await service.createSession(ws.id, { runtime: "opencode", mode: "learn" });
    const b = await service.createSession(ws.id, { runtime: "claude", mode: "learn" });
    await service.send(a.id, "task a");
    await service.send(b.id, "task b");
    const cpA = (await service.engine.requestCheckpoint(a.runtimeSessionId, null, { category: "hypothesis", question: "A?" })).checkpoint!;
    const cpB = (await service.engine.requestCheckpoint(b.runtimeSessionId, null, { category: "hypothesis", question: "B?" })).checkpoint!;

    claude.emit({ type: "runtime.restarted" });
    expect(store.getCheckpoint(cpB.id)!.status).toBe("interrupted");
    expect(service.engine.statusOf(b.id)).toBe("idle");
    expect(store.getCheckpoint(cpA.id)!.status).toBe("pending");
    expect(service.engine.statusOf(a.id)).toBe("busy");
  });

  it("runs an in-process checkpoint to completion and cancels it when the run aborts", async () => {
    const ws = service.addWorkspace(dir);
    const s = await service.createSession(ws.id, { runtime: "claude", mode: "learn" });
    await service.send(s.id, "task");
    const waiting = service.engine.runCheckpoint(s.runtimeSessionId, null, { category: "hypothesis", question: "Why?" }, new AbortController().signal);
    const cp = await vi.waitFor(() => {
      const [first] = store.listCheckpoints(s.id);
      if (!first) throw new Error("not yet");
      return first;
    });
    await service.engine.resolveCheckpoint(cp.id, { action: "answer", text: "Because" });
    await expect(waiting).resolves.toContain("Because");
    expect(service.engine.gateFor(s.id).locked).toBe(false);

    const abort = new AbortController();
    const second = service.engine.runCheckpoint(s.runtimeSessionId, null, { category: "risk", question: "Sure?" }, abort.signal);
    abort.abort();
    await expect(second).rejects.toThrow(/cancelled/);
  });
});

describe("Codex turn/start", () => {
  const input = (gate: "open" | "engage" | "hold") => ({ text: "do it", system: "POLICY", gate });

  it("runs gated turns read-only and open turns workspace-write, never with network", () => {
    for (const gate of ["engage", "hold"] as const) expect(turnStartParams("t", input(gate), "m").sandboxPolicy).toEqual({ type: "readOnly", networkAccess: false });
    expect(turnStartParams("t", input("open"), "m").sandboxPolicy).toMatchObject({ type: "workspaceWrite", networkAccess: false });
    expect(turnStartParams("t", input("open"), "m")).toMatchObject({ threadId: "t", approvalPolicy: "untrusted", model: "m" });
  });

  it("sends the collaboration policy with sandbox guidance on every turn", () => {
    const policy = turnStartParams("t", input("open"), "m").input[0]!.text;
    expect(policy).toContain("POLICY");
    expect(policy).toMatch(/listen EPERM/);
    expect(policy).toMatch(/rerun it with escalated permissions/);
    expect(policy).toMatch(/Do not report work as tested/);
    expect(turnStartParams("t", input("open"), "m").input[1]!.text).toBe("do it");
  });

  it("declares that its sandbox is fixed per turn", () => {
    expect(new CodexAdapter({} as ConstructorParameters<typeof CodexAdapter>[0]).sandboxFixedPerTurn).toBe(true);
  });
});
