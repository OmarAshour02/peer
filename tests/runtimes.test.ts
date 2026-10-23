import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { isDestructiveCommand, unwrapShell } from "../src/server/collaboration/safety.js";
import { EventHub } from "../src/server/hub.js";
import { peerToolInput, peerToolName, toolResultDiff } from "../src/server/runtime/claude/normalize.js";
import { isSandboxNetworkBlock, isTestCommand, normalizeItem, TestEvidence } from "../src/server/runtime/codex/normalize.js";
import { CodexAdapter, turnStartParams } from "../src/server/runtime/codex/adapter.js";
import { RuntimeSet } from "../src/server/runtime/set.js";
import { Transcript } from "../src/server/runtime/transcript.js";
import { PeerService } from "../src/server/service.js";
import { Store } from "../src/server/store.js";
import type { RuntimeEvent } from "../src/server/runtime/adapter.js";
import { pickDefaultRuntime } from "../src/shared/types.js";
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
    t.completeMessage("a1", undefined, "Not verified: tests did not run");
    expect(events.map((e) => e.type)).toContain("part.delta");

    const reloaded = new Transcript("codex", "s1", store, () => {}).list();
    expect(reloaded.map((m) => m.role)).toEqual(["user", "assistant"]);
    expect(reloaded[1]!.parts).toMatchObject([
      { type: "text", text: "Hello" },
      { type: "tool", status: "error", error: "Stopped" },
    ]);
    expect(reloaded[1]!.completedAt).toBeTypeOf("number");
    expect(reloaded[1]!.warning).toBe("Not verified: tests did not run");
    expect(reloaded[1]!.error).toBeUndefined();
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
    const a = await service.createSession(ws.id, { runtime: "opencode" });
    const b = await service.createSession(ws.id, { runtime: "claude", mode: "learn" });
    expect(a.runtime).toBe("opencode");
    expect(b.runtime).toBe("claude");
    // The last runtime picked becomes the default for new sessions.
    expect(store.getPreferences().runtimeChosen).toBe("claude");

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

  it("defaults new sessions to an agent the developer is signed in to, until they pick one", async () => {
    const ws = service.addWorkspace(dir);
    // Claude Code is ready (Codex is not installed here): it wins over the bundled runtime.
    expect(service.preferences()).toMatchObject({ defaultRuntime: "claude", runtimeChosen: null });
    const auto = await service.createSession(ws.id, { runtime: "claude" });
    expect(auto.runtime).toBe("claude");
    // Using the default is not a choice; asking for another runtime is.
    expect(store.getPreferences().runtimeChosen).toBeNull();
    await service.createSession(ws.id, { runtime: "opencode" });
    expect(service.preferences()).toMatchObject({ defaultRuntime: "opencode", runtimeChosen: "opencode" });
  });

  it("picks the runtime for new sessions from the developer's choice and what is ready", () => {
    const rt = (claude: string, codex: string, opencode = "ready") => [
      { kind: "opencode" as const, status: { state: opencode } },
      { kind: "claude" as const, status: { state: claude } },
      { kind: "codex" as const, status: { state: codex } },
    ];
    expect(pickDefaultRuntime(null, rt("ready", "ready"))).toBe("claude");
    expect(pickDefaultRuntime(null, rt("unavailable", "ready"))).toBe("codex");
    expect(pickDefaultRuntime(null, rt("unavailable", "unavailable"))).toBe("opencode");
    // Claude Code still starting: use what is ready now (the UI switches once Claude is ready).
    expect(pickDefaultRuntime(null, rt("starting", "unavailable"))).toBe("opencode");
    // The developer's pick sticks, unless that runtime is unavailable (then it comes back once it is).
    expect(pickDefaultRuntime("opencode", rt("ready", "ready"))).toBe("opencode");
    expect(pickDefaultRuntime("codex", rt("ready", "unavailable"))).toBe("claude");
    expect(pickDefaultRuntime("codex", rt("ready", "starting"))).toBe("codex");
    // Crashed or stopped: new sessions would fail there, so they go elsewhere until it is back.
    expect(pickDefaultRuntime("claude", rt("error", "unavailable"))).toBe("opencode");
    expect(pickDefaultRuntime("claude", rt("stopped", "ready"))).toBe("codex");
    expect(pickDefaultRuntime(null, rt("error", "error", "error"))).toBe("opencode");
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

describe("Codex turns whose work was not tested", () => {
  const cmd = (command: string, status: string, exitCode: number | null, aggregatedOutput = "") => ({ type: "commandExecution", id: `c${Math.random()}`, command, status, exitCode, aggregatedOutput });
  const EPERM = "Error: listen EPERM: operation not permitted 127.0.0.1\n    at Server.setupListenHandle";

  it("recognizes socket errors from the sandbox and nothing else", () => {
    for (const out of [EPERM, "Error: connect EPERM 127.0.0.1:5432", "listen tcp 127.0.0.1:0: bind: operation not permitted"]) expect(isSandboxNetworkBlock(out), out).toBe(true);
    for (const out of ["AssertionError: expected 200, got 404", "EPERM: operation not permitted, open '/etc/hosts'", "listen EADDRINUSE: address already in use :::3000", ""]) expect(isSandboxNetworkBlock(out), out).toBe(false);
  });

  it("warns about a blocked command that was never rerun successfully", () => {
    const blocks = new TestEvidence();
    blocks.observe(cmd("/bin/zsh -lc 'npm test'", "failed", 1, EPERM));
    expect(blocks.warning()).toMatch(/Not verified.*`npm test`.*Tests may not have run/);
    // A declined or failing rerun leaves it flagged.
    blocks.observe(cmd("/bin/zsh -lc 'npm test'", "declined", null));
    blocks.observe(cmd("/bin/zsh -lc 'npm test'", "failed", 1, "AssertionError"));
    expect(blocks.warning()).toBeDefined();
  });

  it("clears it when the same command later succeeds (an approved escalated rerun)", () => {
    const blocks = new TestEvidence();
    blocks.observe(cmd("/bin/zsh -lc 'npm test'", "failed", 1, EPERM));
    blocks.observe(cmd("npm test", "completed", 0, "pass 12"));
    expect(blocks.warning()).toBeUndefined();
  });

  it("only a rerun in the same directory clears it", () => {
    const blocks = new TestEvidence();
    blocks.observe({ ...cmd("npm test", "failed", 1, EPERM), cwd: "/w/backend" });
    blocks.observe({ ...cmd("npm test", "completed", 0, "pass"), cwd: "/w/frontend" });
    expect(blocks.warning()).toMatch(/`npm test`/);
    blocks.observe({ ...cmd("npm test", "completed", 0, "pass"), cwd: "/w/backend" });
    expect(blocks.warning()).toBeUndefined();
  });

  it("does not flag ordinary failures or other item types", () => {
    const blocks = new TestEvidence();
    blocks.observe(cmd("npm test", "failed", 1, "AssertionError: expected 200, got 404"));
    blocks.observe({ type: "agentMessage", id: "m", text: EPERM });
    expect(blocks.warning()).toBeUndefined();
  });

  it("shows the warning on the turn's message when the turn ends", () => {
    const store = new Store(":memory:");
    const adapter = new CodexAdapter({ storage: store, log: () => {} } as unknown as ConstructorParameters<typeof CodexAdapter>[0]);
    const internals = adapter as unknown as { runs: Map<string, unknown>; byThread: Map<string, string>; onNotification(n: { method: string; params: Record<string, unknown> }): void };
    internals.byThread.set("th", "s1");
    internals.runs.set("s1", { sessionId: "s1", threadId: "th", directory: "/w", turnId: "t1", messageId: "a1", abort: new AbortController(), approvals: new Map(), filePaths: new Map(), declined: new Map(), testEvidence: new TestEvidence(), snapshots: Promise.resolve(), startTree: null, preTestTrees: new Map() });
    (adapter as unknown as { transcript(id: string): Transcript }).transcript("s1").startAssistantMessage("a1");
    internals.onNotification({ method: "item/completed", params: { threadId: "th", turnId: "t1", item: cmd("npm test", "failed", 1, EPERM) } });
    internals.onNotification({ method: "turn/completed", params: { threadId: "th", turnId: "t1", turn: { status: "completed" } } });
    const [message] = new Transcript("codex", "s1", store, () => {}).list();
    expect(message!.warning).toMatch(/`npm test` failed and was not rerun successfully/);
    expect(message!.error).toBeUndefined();
    store.close();
  });
});

describe("Codex code changes with no test run after them", () => {
  const edit = (path: string, status = "completed") => ({ type: "fileChange", id: `f${Math.random()}`, status, changes: [{ path, kind: "update", diff: "" }] });
  const run = (command: string, exitCode: number | null, aggregatedOutput = "", status = exitCode === 0 ? "completed" : "failed") => ({ type: "commandExecution", id: `c${Math.random()}`, command, status, exitCode, aggregatedOutput });

  it("recognizes common test runners, and not other commands", () => {
    for (const c of ["npm test", "npm run test:unit", "npm t", "/bin/zsh -lc 'node --test'", "node --experimental-strip-types --test", "npx vitest run", "pnpm exec jest", "yarn test", "bun test", "pytest -q", "python -m pytest", "python3 -m unittest", "go test ./...", "cargo test", "cd api && npm test", "make test", "./gradlew test", "bundle exec rspec"]) expect(isTestCommand(c), c).toBe(true);
    for (const c of ["npm install", "npm run build", "node server.js", "cat test/notes.test.js", "ls test", "git status", "npm run testdata-gen", "rg test src"]) expect(isTestCommand(c), c).toBe(false);
  });

  it("warns when code changed and no tests ran afterwards", () => {
    const e = new TestEvidence();
    e.observe(edit("/w/src/notes.js"));
    expect(e.warning()).toBe("Not verified: Codex changed code in this turn and ran no tests after its last change.");
  });

  it("a test run after the last change clears it, passing or failing", () => {
    for (const exit of [0, 1]) {
      const e = new TestEvidence();
      e.observe(edit("/w/src/notes.js"));
      e.observe(run("npm test", exit, exit ? "not ok 2 - paginates\n# fail 1" : "ok 1 - lists\n# pass 1\n# fail 0"));
      expect(e.warning(), `exit ${exit}`).toBeUndefined();
    }
  });

  it("a test command that failed before its tests started does not count", () => {
    for (const [command, exit, output] of [
      ["cd /nonexistent-package && npm test", 1, "zsh:cd:1: no such file or directory: /nonexistent-package"],
      ["npm test", 127, "sh: npm: command not found"],
      ["npm test", 1, 'npm ERR! Missing script: "test"'],
      ["npx vitest run", 1, "Error: Cannot find module 'vitest'"],
    ] as const) {
      const e = new TestEvidence();
      e.observe(edit("/w/src/a.js"));
      e.observe(run(command, exit, output));
      expect(e.warning(), command).toMatch(/ran no tests/);
    }
  });

  it("failing runs with real test output count, across runners", () => {
    for (const output of ["not ok 2 - paginates\n# pass 1\n# fail 1", " FAIL  tests/a.test.ts > x", "Tests:       1 failed, 3 passed", "=== 1 failed, 4 passed in 0.12s ===", "--- FAIL: TestPaginate (0.00s)", "test result: FAILED. 3 passed; 1 failed"]) {
      const e = new TestEvidence();
      e.observe(edit("/w/src/a.js"));
      e.observe(run("npm test", 1, output));
      expect(e.warning(), output).toBeUndefined();
    }
  });

  it("a change after the last test run warns again", () => {
    const e = new TestEvidence();
    e.observe(edit("/w/src/a.js"));
    e.observe(run("npm test", 0));
    e.observe(edit("/w/src/b.js"));
    expect(e.warning()).toMatch(/ran no tests after its last change/);
  });

  it("declined or sandbox-blocked test runs do not count", () => {
    const declined = new TestEvidence();
    declined.observe(edit("/w/src/a.js"));
    declined.observe(run("npm test", null, "", "declined"));
    expect(declined.warning()).toMatch(/ran no tests/);

    const blocked = new TestEvidence();
    blocked.observe(edit("/w/src/a.js"));
    blocked.observe(run("npm test", 1, "Error: listen EPERM: operation not permitted 127.0.0.1"));
    // The more specific sandbox warning wins.
    expect(blocked.warning()).toMatch(/sandbox blocks network access.*`npm test`/);
  });

  it("ignores docs-only changes, changes that were not applied, and turns without changes", () => {
    const e = new TestEvidence();
    e.observe(edit("/w/README.md"));
    e.observe(edit("/w/docs/notes.txt"));
    e.observe(edit("/w/src/a.js", "declined"));
    e.observe(run("npm run build", 0));
    expect(e.warning()).toBeUndefined();
  });
});

describe("what counts as a test run", () => {
  const edit = () => ({ type: "fileChange", id: `f${Math.random()}`, status: "completed", changes: [{ path: "/w/src/a.js" }] });
  const run = (command: string, exitCode: number, aggregatedOutput: string) => ({ type: "commandExecution", id: `c${Math.random()}`, command, status: exitCode === 0 ? "completed" : "failed", exitCode, aggregatedOutput });

  it("only where a command starts, not inside an argument", () => {
    for (const c of ['echo "Run npm test before committing"', "git commit -m 'npm test passes'", "grep -r 'node --test' ."]) expect(isTestCommand(c), c).toBe(false);
    for (const c of ["CI=1 npm test", "timeout 60 npm test", "(cd api && npm test)", "npm test 2>&1 | tee out.log", "env NODE_ENV=test npx vitest run"]) expect(isTestCommand(c), c).toBe(true);
  });

  it("a mention or a skipped branch does not clear the warning", () => {
    for (const [c, out] of [['echo "Run npm test before committing"', "Run npm test before committing"], ["true || npm test", ""]] as const) {
      const e = new TestEvidence();
      e.observe(edit());
      expect(e.observe(run(c, 0, out)), c).toBe(false);
      expect(e.warning(), c).toMatch(/ran no tests/);
    }
  });

  it("passing runs of common runners count", () => {
    for (const out of ["# tests 3\n# pass 3\n# fail 0", " Test Files  1 passed (1)\n      Tests  3 passed (3)", "Tests:       3 passed, 3 total", "===== 3 passed in 0.05s =====", "ok  \texample.com/notes\t0.012s", "test result: ok. 3 passed; 0 failed", "Ran 3 tests in 0.001s\n\nOK", "  3 passing (12ms)"]) {
      const e = new TestEvidence();
      e.observe(edit());
      expect(e.observe(run("npm test", 0, out)), out).toBe(true);
      expect(e.warning(), out).toBeUndefined();
    }
  });

  it("sandbox errors win over a pipeline's exit 0", () => {
    const e = new TestEvidence();
    e.observe(edit());
    expect(e.observe(run("npm test 2>&1 | tee /tmp/test-output.log", 0, "Error: listen EPERM: operation not permitted 127.0.0.1\n# fail 1"))).toBe(false);
    expect(e.warning()).toMatch(/sandbox blocks network access.*`npm test 2>&1 \| tee/);
  });
});

describe("Codex code changes made through the shell", () => {
  let repo: string;
  let store: Store;

  beforeEach(() => {
    repo = realpathSync(mkdtempSync(join(tmpdir(), "peer-codex-shell-")));
    const git = (...args: string[]) => execFileSync("git", args, { cwd: repo, stdio: "pipe" });
    git("init", "-q");
    mkdirSync(join(repo, "src"));
    writeFileSync(join(repo, "src", "a.js"), "export const a = 1;\n");
    writeFileSync(join(repo, ".git", "info", "exclude"), ".peer-data/\n");
    git("add", "-A");
    git("-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "init");
    store = new Store(":memory:");
  });
  afterEach(() => {
    store.close();
    rmSync(repo, { recursive: true, force: true });
  });

  /** A Codex adapter with one turn in progress for session s1 in the temp repo, set up as prompt() does. */
  async function startedRun() {
    const hooks = { checkTool: async () => ({ allow: true }) };
    const adapter = new CodexAdapter({ storage: store, hooks, log: () => {}, dataDir: join(repo, ".peer-data") } as unknown as ConstructorParameters<typeof CodexAdapter>[0]);
    type Internals = {
      rpc: unknown;
      runs: Map<string, Record<string, unknown>>;
      byThread: Map<string, string>;
      onNotification(n: { method: string; params: Record<string, unknown> }): void;
      onRequest(r: { id: number; method: string; params: Record<string, unknown> }): Promise<void>;
      snapshot(run: unknown): Promise<string | null>;
      transcript(id: string): Transcript;
    };
    const internals = adapter as unknown as Internals;
    const responses: unknown[] = [];
    internals.rpc = { alive: true, respond: (_id: number, result: unknown) => responses.push(result), respondError: () => {} };
    const run: Record<string, unknown> = { sessionId: "s1", threadId: "th", directory: repo, turnId: "t1", messageId: "a1", abort: new AbortController(), approvals: new Map(), filePaths: new Map(), declined: new Map(), testEvidence: new TestEvidence(), snapshots: Promise.resolve(), preTestTrees: new Map() };
    run.startTree = await internals.snapshot(run);
    internals.byThread.set("th", "s1");
    internals.runs.set("s1", run);
    internals.transcript("s1").startAssistantMessage("a1");
    const notify = (method: string, params: Record<string, unknown>) => internals.onNotification({ method, params: { threadId: "th", turnId: "t1", ...params } });
    let n = 0;
    /** A command as Codex runs it: Codex asks Peer, Peer accepts, `during` runs, the item completes. */
    const command = async (cmd: string, exitCode: number, output: string, during = () => {}) => {
      const itemId = `c${++n}`;
      await internals.onRequest({ id: n, method: "item/commandExecution/requestApproval", params: { threadId: "th", turnId: "t1", itemId, command: cmd, cwd: repo } });
      expect(responses.at(-1)).toEqual({ decision: "accept" });
      during();
      notify("item/completed", { item: { type: "commandExecution", id: itemId, command: cmd, cwd: repo, status: exitCode === 0 ? "completed" : "failed", exitCode, aggregatedOutput: output } });
    };
    const end = async (status = "completed") => {
      const idle = new Promise<void>((resolve) => {
        const off = adapter.onEvent((e) => {
          if (e.type === "session.idle") {
            off();
            resolve();
          }
        });
      });
      notify("turn/completed", { turn: { status } });
      await idle;
      return new Transcript("codex", "s1", store, () => {}).list()[0]!;
    };
    return { command, end };
  }
  const edit = (file: string, text = "export const changed = true;\n") => () => writeFileSync(join(repo, file), text);
  const PASS = "# pass 1\n# fail 0";

  it("warns about code written by a shell command with no test run after it", async () => {
    const { command, end } = await startedRun();
    await command("printf 'export const a = 2;' > src/a.js", 0, "", edit("src/a.js"));
    expect((await end()).warning).toBe("Not verified: Codex changed code in this turn and ran no tests after its last change.");
  });

  it("does not warn when tests ran after the shell change", async () => {
    const { command, end } = await startedRun();
    await command("printf 'export const a = 2;' > src/a.js", 0, "", edit("src/a.js"));
    await command("node --test", 0, PASS);
    expect((await end()).warning).toBeUndefined();
  });

  it("does not warn when only docs changed", async () => {
    const { command, end } = await startedRun();
    await command("printf '# notes' > NOTES.md", 0, "", edit("NOTES.md", "# notes\n"));
    await command("printf '# 说明' > 说明.md", 0, "", edit("说明.md", "# 说明\n"));
    expect((await end()).warning).toBeUndefined();
  });

  it("warns about a change right after the last test run, with no delay", async () => {
    const { command, end } = await startedRun();
    await command("node --test", 0, PASS);
    await command("printf 'x' > src/b.js", 0, "", edit("src/b.js"));
    expect((await end()).warning).toMatch(/ran no tests after its last change/);
  });

  it("counts an edit inside the same compound command, after its tests, as untested", async () => {
    const { command, end } = await startedRun();
    await command("node --test && printf changed > src/a.js", 0, PASS, edit("src/a.js"));
    expect((await end()).warning).toMatch(/ran no tests after its last change/);
  });

  it("checks stopped and failed turns too", async () => {
    for (const status of ["interrupted", "failed"]) {
      const { command, end } = await startedRun();
      await command("printf x > src/a.js", 0, "", edit("src/a.js", `export const s = "${status}";\n`));
      expect((await end(status)).warning, status).toMatch(/ran no tests after its last change/);
      store.close();
      store = new Store(":memory:");
    }
  });
});
