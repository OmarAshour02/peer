import { randomUUID } from "node:crypto";
import { isAbsolute, join, relative, resolve } from "node:path";
import type { ModelsResponse, PeerMessage, PermissionReply, PermissionRequest, RuntimeStatus } from "../../../shared/types.js";
import { CHECKPOINT_CATEGORIES } from "../../../shared/types.js";
import { CHECKPOINT_TOOL } from "../../collaboration/prompt.js";
import { isDestructiveCommand, unwrapShell } from "../../collaboration/safety.js";
import type { AgentRuntimeAdapter, PromptInput, RuntimeEvent, RuntimeHooks, RuntimeSettingsProvider } from "../adapter.js";
import { findExecutable, runCli } from "../cli.js";
import { changedFiles, diffSinceSnapshot, snapshotWorkspace } from "../git-snapshot.js";
import { Transcript, titleFromPrompt, type RuntimeStorage } from "../transcript.js";
import { TESTED_VERSIONS, versionWarning } from "../versions.js";
import { isDocFile, isTestCommand, normalizeItem, TestEvidence, UNTESTED_CHANGE_WARNING, type CodexItem } from "./normalize.js";
import { CodexRpc, type RpcNotification, type RpcRequest } from "./rpc.js";


// Codex's sandbox has no network by default, which also blocks tests that open a local port.
// Rerunning with escalated permissions turns that into an approval request, which Peer sends to
// the developer. A workspace can allow network access instead (Workspace.sandboxNetwork).
const SANDBOX_NOTE =
  "Sandbox: your commands run without network access, which also blocks opening local ports (tests that start a server fail with errors like `listen EPERM`). " +
  "When a command fails only because of the sandbox, rerun it with escalated permissions and a one-line justification; Peer asks the developer. Do not report work as tested if its tests could not run.";
const SANDBOX_NOTE_NETWORK =
  "Sandbox: your commands may use the network, including opening local ports. If a command still fails only because of the sandbox, rerun it with escalated permissions and a one-line justification; Peer asks the developer. Do not report work as tested if its tests could not run.";
/**
 * Gated turns cannot change code, and MCP tools are not gated per call by the protocol, so the
 * model is told up front not to start any: Peer stops a turn whose MCP call starts while locked.
 * (When Codex asks first with `item/mcpToolCall/requestApproval`, that goes through the gate
 * and the developer instead.)
 */
export const MCP_LOCKED_NOTE =
  `MCP tools are locked too: do not call any MCP tool while code changes are locked. Peer stops a turn that starts one. If an MCP tool is the right next step, ask the developer with the ${CHECKPOINT_TOOL} tool first.`;

/**
 * `turn/start` parameters. Codex fixes the sandbox for the whole turn: read-only when the turn
 * starts gated, workspace-write otherwise. Network access only for writable turns in workspaces
 * that allow it; read-only turns never get it.
 */
export function turnStartParams(threadId: string, input: PromptInput, model: string | undefined) {
  const writable = input.gate === "open";
  const network = writable && input.network === true;
  const policy = writable ? input.system : `${input.system}\n\n${MCP_LOCKED_NOTE}`;
  return {
    threadId,
    // developerInstructions are fixed per thread, so the per-turn policy travels with the input.
    input: [
      { type: "text", text: `<peer_collaboration_policy>\n${policy}\n\n${network ? SANDBOX_NOTE_NETWORK : SANDBOX_NOTE}\n</peer_collaboration_policy>`, text_elements: [] },
      { type: "text", text: input.text, text_elements: [] },
    ],
    approvalPolicy: "untrusted",
    sandboxPolicy: writable
      ? { type: "workspaceWrite", writableRoots: [], networkAccess: network, excludeTmpdirEnvVar: false, excludeSlashTmp: false }
      : { type: "readOnly", networkAccess: false },
    model,
    // The protocol takes any non-empty effort string; omit it for the account default.
    ...(input.effort ? { effort: input.effort } : {}),
  };
}

const MAX_RESTARTS = 5;
const RESTART_WINDOW_MS = 2 * 60_000;

/** Notifications Peer has no use for; Codex stops sending them to this connection. */
const OPTED_OUT_NOTIFICATIONS = [
  "turn/diff/updated",
  "turn/moderationMetadata",
  "rawResponseItem/completed",
  "rawResponse/completed",
  "account/rateLimits/updated",
  "mcpServer/startupStatus/updated",
  "thread/readState/changed",
];

/** Peer's checkpoint tool, declared to Codex as a client-side ("dynamic") tool. */
const CHECKPOINT_SPEC = {
  type: "function",
  name: CHECKPOINT_TOOL,
  description:
    "Bring a decision or question to the developer and wait for their response. Use it instead of ending your turn to ask. Returns the developer's answer and instructions for how to continue.",
  inputSchema: {
    type: "object",
    properties: {
      category: { type: "string", enum: [...CHECKPOINT_CATEGORIES], description: "What kind of decision this is." },
      question: { type: "string", description: "One focused question for the developer." },
      context: { type: "string", description: "Why this matters, in a few sentences (markdown)." },
      options: {
        type: "array",
        description: "2-4 short options when there are discrete choices.",
        items: { type: "object", properties: { label: { type: "string" }, description: { type: "string" } }, required: ["label"] },
      },
      recommendation: { type: "string", description: "The option label you recommend, if any." },
    },
    required: ["category", "question"],
  },
};

export interface CodexAdapterOptions {
  env: NodeJS.ProcessEnv;
  storage: RuntimeStorage;
  hooks: RuntimeHooks;
  dataDir: string;
  /** Explicit path to the `codex` executable (PEER_CODEX_BIN); otherwise found on PATH. */
  binary?: string;
  version: string;
  log: (line: string) => void;
  /** Live runtime settings; `codexBin` there overrides `binary` (a restart picks it up). */
  settings?: RuntimeSettingsProvider;
}

/**
 * One Peer turn's Codex turn, for undo: when Peer prompted (adapter clock, so it compares with
 * the engine's `since`) and the Codex turn id (`thread/revert beforeTurnId` drops it and every
 * later turn from the thread's durable history).
 */
export interface CodexTurnRecord {
  t: number;
  id: string;
}

/** The Codex turn undo drops first, or null when the thread holds nothing Peer started after `since`. */
export function revertTarget(turns: CodexTurnRecord[], since: number): string | null {
  return turns.find((r) => r.t >= since)?.id ?? null;
}

/** Turn records Peer keeps per session (capped; each undo prunes the undone ones). */
const MAX_TURN_RECORDS = 200;

interface SessionState {
  /** Codex thread, created on the first prompt (a thread without turns cannot be resumed later). */
  threadId?: string;
  baseline?: string | null;
  titled?: boolean;
  /** Codex turn ids of past turns, oldest first. */
  turns?: CodexTurnRecord[];
}

interface PendingApproval {
  request: PermissionRequest;
  rpcId: number | string;
  method: string;
  params: Record<string, unknown>;
}

/** Token counts in Codex's thread/tokenUsage/updated (running totals, or the last request). */
interface TokenCounts {
  inputTokens?: number;
  outputTokens?: number;
}

interface Run {
  sessionId: string;
  threadId: string;
  directory: string;
  /** Adapter clock when Peer prompted, for undo mapping. */
  promptedAt: number;
  turnId: string | null;
  /** Assistant message for this turn (one per Codex turn). */
  messageId: string;
  abort: AbortController;
  approvals: Map<string, PendingApproval>;
  /** The changes (path, kind, diff) of each in-flight fileChange item, for approval checks. */
  fileChanges: Map<string, Record<string, unknown>[]>;
  /** Items Peer declined, with the reason (Codex itself only reports "declined"). */
  declined: Map<string, string>;
  /** Sandbox-blocked commands and untested changes, for the turn's "Not verified" warning. */
  testEvidence: TestEvidence;
  /** Workspace snapshots, taken one at a time (they share the session's index file). */
  snapshots: Promise<unknown>;
  /** The workspace when the turn started. */
  startTree: string | null;
  /** Test command item -> the workspace just before Peer let it run. */
  preTestTrees: Map<string, string | null>;
  /** The workspace the last test run that reached its tests ran against; undefined before one. */
  testedTree?: string | null;
  /** The thread's token totals before this turn (Codex reports running totals for the thread). */
  usageBase?: { input: number; output: number };
}

/**
 * Codex through `codex app-server` (JSON-RPC over stdio), using the developer's installed `codex`
 * CLI and its login. One app-server process serves all Codex sessions.
 *
 * Enforcement: threads run with approval policy "untrusted", so every command and file change
 * that Codex doesn't consider safe/read-only comes to Peer for approval. Peer declines it while
 * the collaboration gate is locked, routes destructive or sandbox-escaping requests to the
 * developer, and accepts the rest. Turns that start gated also run in Codex's read-only sandbox,
 * so the OS blocks writes even if an approval were missed. That sandbox is fixed for the turn, so
 * when the developer engages mid-turn the engine continues in a new, writable turn
 * (sandboxFixedPerTurn). Checkpoints are a dynamic tool.
 */
/**
 * How Codex is signed in, from `codex login status` ("Logged in using ChatGPT"). Only the method:
 * an API-key login also prints part of the key.
 */
export function codexAccount(output: string): string | undefined {
  if (/ChatGPT/i.test(output)) return "ChatGPT";
  if (/API key/i.test(output)) return "OpenAI API key";
  return undefined;
}

export class CodexAdapter implements AgentRuntimeAdapter {
  readonly kind = "codex" as const;
  readonly name = "Codex";
  readonly checkpointTool = CHECKPOINT_TOOL;
  readonly sandboxFixedPerTurn = true;

  private binary: string | null = null;
  private rpc: CodexRpc | null = null;
  private current: RuntimeStatus = { state: "stopped" };
  private version: string | undefined;
  private account: string | undefined;
  /** The installed CLI is outside the tested version range. */
  private warning: string | undefined;
  private readonly listeners = new Set<(event: RuntimeEvent) => void>();
  /** Threads loaded in the current app-server process. */
  private loaded = new Set<string>();
  private readonly runs = new Map<string, Run>();
  private readonly byThread = new Map<string, string>();
  private readonly transcripts = new Map<string, Transcript>();
  private restarts: number[] = [];
  private stopped = false;

  constructor(private readonly opts: CodexAdapterOptions) {}

  status(): RuntimeStatus {
    return this.current;
  }

  onEvent(listener: (event: RuntimeEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private emit(event: RuntimeEvent) {
    for (const listener of this.listeners) {
      try {
        listener(event);
      } catch (err) {
        this.opts.log(`[codex] listener failed: ${String(err)}`);
      }
    }
  }

  private setStatus(status: RuntimeStatus) {
    this.current = status;
    this.emit({ type: "runtime.status", status });
  }

  // -- process lifecycle --------------------------------------------------------

  async start(): Promise<void> {
    this.stopped = false;
    this.setStatus({ state: "starting" });
    this.binary = findExecutable("codex", this.opts.env, this.opts.settings?.().codexBin ?? this.opts.binary ?? undefined);
    if (!this.binary) {
      this.setStatus({ state: "unavailable", error: "Codex is not installed (no `codex` on PATH). Install the Codex CLI, run `codex login`, then restart this runtime." });
      return;
    }
    const version = await runCli(this.binary, ["--version"], this.opts.env);
    const match = /codex-cli (\S+)/.exec(version.stdout);
    if (version.code !== 0 || !match) {
      this.setStatus({ state: "unavailable", error: `\`codex --version\` failed: ${(version.stderr || version.stdout).trim().slice(0, 300)}` });
      return;
    }
    this.version = match[1];
    this.warning = versionWarning("Codex", this.version, TESTED_VERSIONS.codex, "`npm install -g @openai/codex` or your package manager");
    const login = await runCli(this.binary, ["login", "status"], this.opts.env);
    if (login.code !== 0) {
      this.setStatus({ state: "unavailable", error: "Codex is not logged in. Run `codex login` in a terminal, then restart this runtime." });
      return;
    }
    this.account = codexAccount(login.stdout + login.stderr);
    try {
      await this.spawn();
      this.setStatus({ state: "ready", version: this.version, account: this.account, warning: this.warning });
    } catch (err) {
      this.setStatus({ state: "error", error: `Codex app-server failed to start: ${err instanceof Error ? err.message : String(err)}` });
      throw err;
    }
  }

  private async spawn() {
    const rpc = new CodexRpc(this.binary!, this.opts.env, {
      onNotification: (n) => this.onNotification(n),
      onRequest: (r) => void this.onRequest(r),
      onExit: (code, signal) => void this.onExit(rpc, code, signal),
      log: (line) => this.opts.log(`[codex] ${line}`),
    });
    this.rpc = rpc;
    this.loaded = new Set();
    await rpc.call("initialize", {
      clientInfo: { name: "peer", title: "Peer", version: this.opts.version },
      // Dynamic (client-side) tools are part of Codex's experimental API.
      capabilities: { experimentalApi: true, requestAttestation: false, optOutNotificationMethods: OPTED_OUT_NOTIFICATIONS },
    });
    rpc.notify("initialized");
  }

  async stop(): Promise<void> {
    this.stopped = true;
    for (const run of this.runs.values()) this.endRun(run, "Peer is shutting down", false, false);
    this.rpc?.kill();
    this.rpc = null;
    this.setStatus({ state: "stopped" });
  }

  async restart(): Promise<void> {
    await this.stop();
    await this.start();
    this.emit({ type: "runtime.restarted" });
  }

  private async onExit(rpc: CodexRpc, code: number | null, signal: NodeJS.Signals | null) {
    if (rpc !== this.rpc || this.stopped) return;
    this.rpc = null;
    for (const run of this.runs.values()) this.endRun(run, "Codex exited unexpectedly", false, false);
    const message = `Codex app-server exited unexpectedly (code ${code}, signal ${signal}).`;
    this.opts.log(`[codex] ${message}`);
    const now = Date.now();
    this.restarts = this.restarts.filter((t) => now - t < RESTART_WINDOW_MS);
    if (this.restarts.length >= MAX_RESTARTS) {
      this.setStatus({ state: "error", error: `${message} Gave up after ${MAX_RESTARTS} restarts; use "Restart runtime".` });
      return;
    }
    this.restarts.push(now);
    this.setStatus({ state: "error", error: `${message} Restarting…` });
    await new Promise((r) => setTimeout(r, 500 * 2 ** (this.restarts.length - 1)));
    // Peer stopped, or a manual restart already started a new app-server, during the delay.
    if (this.stopped || this.rpc) return;
    try {
      await this.spawn();
      this.setStatus({ state: "ready", version: this.version, account: this.account, warning: this.warning });
      this.emit({ type: "runtime.restarted" });
    } catch (err) {
      this.setStatus({ state: "error", error: `Codex app-server failed to restart: ${err instanceof Error ? err.message : String(err)}` });
    }
  }

  private client(): CodexRpc {
    if (!this.rpc?.alive) throw new Error(this.current.error ?? "Codex is not running.");
    return this.rpc;
  }

  // -- storage helpers ----------------------------------------------------------

  private transcript(sessionId: string): Transcript {
    let t = this.transcripts.get(sessionId);
    if (!t) {
      t = new Transcript(this.kind, sessionId, this.opts.storage, (e) => this.emit(e));
      this.transcripts.set(sessionId, t);
    }
    return t;
  }

  private state(sessionId: string): SessionState {
    return this.opts.storage.getRuntimeState<SessionState>(this.kind, sessionId) ?? {};
  }

  private saveState(sessionId: string, patch: SessionState) {
    this.opts.storage.setRuntimeState(this.kind, sessionId, { ...this.state(sessionId), ...patch });
  }

  private indexFile(sessionId: string) {
    return join(this.opts.dataDir, "snapshots", this.kind, `${sessionId}.index`);
  }

  // -- adapter API --------------------------------------------------------------

  async listModels(): Promise<ModelsResponse> {
    const res = await this.client().call<{ data: { id: string; displayName: string; hidden: boolean; isDefault: boolean }[] }>("model/list", {});
    const models = res.data.filter((m) => !m.hidden);
    const def = models.find((m) => m.isDefault) ?? models[0];
    return {
      providers: [{ id: "codex", name: "Codex", models: models.map((m) => ({ id: m.id, name: m.displayName || m.id })) }],
      default: def ? { providerId: "codex", modelId: def.id } : null,
    };
  }

  async createSession(_directory: string, _input: { title?: string }) {
    const id = randomUUID();
    this.opts.storage.setRuntimeState(this.kind, id, {});
    return { id, title: "New session" };
  }

  async getMessages(_directory: string, sessionId: string): Promise<PeerMessage[]> {
    return this.transcript(sessionId).list();
  }

  async getDiff(directory: string, sessionId: string) {
    const base = this.state(sessionId).baseline;
    return base ? diffSinceSnapshot(directory, base, this.indexFile(sessionId)) : [];
  }

  /**
   * Undo reverts the thread too (`thread/revert` drops the first undone turn and every later
   * one from its durable history; Peer's files are already back). When the turns cannot be
   * mapped or the revert fails, they stay in the thread and the agent is told on its next turn
   * instead.
   */
  async forgetTurns(_directory: string, sessionId: string, since: number): Promise<boolean> {
    if (this.runs.has(sessionId)) throw new Error("The agent is still working on this session.");
    this.transcript(sessionId).dropSince(since);
    const { threadId, turns = [] } = this.state(sessionId);
    if (!threadId) return true;
    const beforeTurnId = revertTarget(turns, since);
    if (!beforeTurnId) return false;
    try {
      await this.client().call("thread/revert", { threadId, beforeTurnId });
      this.saveState(sessionId, { turns: turns.filter((r) => r.t < since) });
      return true;
    } catch (err) {
      this.opts.log(`[codex] thread/revert for undo failed: ${err instanceof Error ? err.message : String(err)}`);
      return false;
    }
  }

  async getParentSessionId(): Promise<string | null> {
    return null;
  }

  async listPermissions(directory: string) {
    return [...this.runs.values()].filter((r) => r.directory === directory).flatMap((r) => [...r.approvals.values()].map((a) => a.request));
  }

  async listToolIds(): Promise<string[]> {
    return [CHECKPOINT_TOOL];
  }

  private threadSettings(directory: string) {
    return { cwd: directory, approvalPolicy: "untrusted", sandbox: "workspace-write" };
  }

  /** Make sure the session's Codex thread exists and is loaded in the current app-server. */
  private async ensureThread(directory: string, sessionId: string, model: string | undefined): Promise<string> {
    const rpc = this.client();
    const { threadId } = this.state(sessionId);
    if (!threadId) {
      const res = await rpc.call<{ thread: { id: string } }>("thread/start", {
        ...this.threadSettings(directory),
        model,
        dynamicTools: [CHECKPOINT_SPEC],
        serviceName: "peer",
      });
      this.saveState(sessionId, { threadId: res.thread.id });
      this.loaded.add(res.thread.id);
      this.byThread.set(res.thread.id, sessionId);
      return res.thread.id;
    }
    if (!this.loaded.has(threadId)) {
      await rpc.call("thread/resume", { threadId, ...this.threadSettings(directory), excludeTurns: true });
      this.loaded.add(threadId);
    }
    this.byThread.set(threadId, sessionId);
    return threadId;
  }

  /** Remember a Codex turn id for undo, once per turn. */
  private recordTurnId(sessionId: string, t: number, id: string | null | undefined) {
    if (!id) return;
    const turns = (this.state(sessionId).turns ?? []).filter((r) => r.id !== id);
    this.saveState(sessionId, { turns: [...turns, { t, id }].slice(-MAX_TURN_RECORDS) });
  }

  async prompt(directory: string, sessionId: string, input: PromptInput): Promise<void> {
    if (this.runs.has(sessionId)) throw new Error("Codex is still working on this session.");
    const promptedAt = Date.now();
    const model = input.model?.modelId || undefined;
    const threadId = await this.ensureThread(directory, sessionId, model);
    const state = this.state(sessionId);
    if (state.baseline === undefined) this.saveState(sessionId, { baseline: await snapshotWorkspace(directory, this.indexFile(sessionId)) });
    if (!state.titled) {
      this.emit({ type: "session.updated", sessionId, title: titleFromPrompt(input.text), parentId: null });
      this.saveState(sessionId, { titled: true });
    }

    const transcript = this.transcript(sessionId);
    transcript.addUserMessage(`user_${randomUUID()}`, input.text);
    const run: Run = {
      sessionId,
      threadId,
      directory,
      promptedAt,
      turnId: null,
      messageId: `turn_${randomUUID()}`,
      abort: new AbortController(),
      approvals: new Map(),
      fileChanges: new Map(),
      declined: new Map(),
      testEvidence: new TestEvidence(),
      snapshots: Promise.resolve(),
      startTree: null,
      preTestTrees: new Map(),
    };
    // Taken before the turn starts, so every change Codex makes comes after it.
    run.startTree = await this.snapshot(run);
    this.runs.set(sessionId, run);
    transcript.startAssistantMessage(run.messageId, { providerId: "codex", modelId: model });
    this.emit({ type: "session.status", sessionId, status: "busy" });
    try {
      const res = await this.client().call<{ turn: { id: string } }>("turn/start", turnStartParams(threadId, input, model));
      run.turnId ??= res.turn.id;
      this.recordTurnId(sessionId, promptedAt, res.turn.id);
    } catch (err) {
      this.endRun(run, err instanceof Error ? err.message : String(err), true);
      throw err;
    }
  }

  async abort(_directory: string, sessionId: string): Promise<void> {
    const run = this.runs.get(sessionId);
    if (!run) return;
    run.abort.abort();
    this.cancelApprovals(run);
    if (run.turnId && this.rpc?.alive) {
      try {
        await this.rpc.call("turn/interrupt", { threadId: run.threadId, turnId: run.turnId }, 10_000);
        return; // turn/completed (interrupted) ends the run
      } catch (err) {
        this.opts.log(`[codex] interrupt failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    this.endRun(run, "Stopped");
  }

  async replyPermission(_directory: string, requestId: string, reply: PermissionReply): Promise<void> {
    for (const run of this.runs.values()) {
      const pending = run.approvals.get(requestId);
      if (!pending) continue;
      run.approvals.delete(requestId);
      if (reply !== "reject") await this.beforeTestCommand(run, pending.method, pending.params);
      this.client().respond(pending.rpcId, approvalResponse(pending.method, pending.params, reply));
      this.emit({ type: "permission.replied", sessionId: run.sessionId, requestId });
      return;
    }
    throw new Error("Unknown or expired permission request");
  }

  // -- run bookkeeping ----------------------------------------------------------

  private cancelApprovals(run: Run) {
    for (const [id, pending] of run.approvals) {
      this.rpc?.respond(pending.rpcId, approvalResponse(pending.method, pending.params, "reject", true));
      this.emit({ type: "permission.replied", sessionId: run.sessionId, requestId: id });
    }
    run.approvals.clear();
  }

  /**
   * End a run. The turn is first checked for code changes made after its last test run, including
   * changes made through shell commands, which Codex doesn't report as file changes; it reports
   * idle once that check is done. Shutdown and crashes skip the check.
   */
  private endRun(run: Run, reason: string, isError = false, checkChanges = true) {
    if (this.runs.get(run.sessionId) !== run) return;
    this.runs.delete(run.sessionId);
    run.abort.abort();
    this.cancelApprovals(run);
    const finish = (warning: string | undefined) => {
      const transcript = this.transcript(run.sessionId);
      transcript.failRunningTools(run.messageId, reason);
      transcript.completeMessage(run.messageId, isError ? reason : undefined, warning);
      if (isError) this.emit({ type: "session.error", sessionId: run.sessionId, error: reason });
      this.emit({ type: "session.idle", sessionId: run.sessionId });
    };
    const warning = run.testEvidence.warning();
    if (warning || !checkChanges) return finish(warning);
    this.changedSinceLastTest(run).then(
      (changed) => finish(changed ? UNTESTED_CHANGE_WARNING : undefined),
      (err) => {
        this.opts.log(`[codex] change check failed: ${err instanceof Error ? err.message : String(err)}`);
        finish(undefined);
      },
    );
  }

  private snapshot(run: Run): Promise<string | null> {
    const next = run.snapshots.then(() => snapshotWorkspace(run.directory, this.indexFile(run.sessionId)));
    run.snapshots = next.catch(() => null);
    return next;
  }

  /**
   * Before Peer lets a test command run, record the workspace it will test. Anything that changes
   * from then on, including edits later in the same compound command, counts as untested.
   */
  private async beforeTestCommand(run: Run, method: string, params: Record<string, unknown>) {
    if (method !== "item/commandExecution/requestApproval" || typeof params.itemId !== "string") return;
    if (!isTestCommand(String(params.command ?? ""))) return;
    run.preTestTrees.set(params.itemId, await this.snapshot(run));
  }

  /**
   * Whether code (not docs) in the workspace changed after the last test run, or since the turn
   * started. A test run counts only with a snapshot from before Peer let it run; Codex asks Peer
   * before running test runners, so one is normally there, and without one the turn warns.
   */
  private async changedSinceLastTest(run: Run): Promise<boolean> {
    const base = run.testedTree !== undefined ? run.testedTree : run.startTree;
    const end = await this.snapshot(run);
    if (!base || !end || base === end) return false;
    return (await changedFiles(run.directory, base, end)).some((f) => !isDocFile(f));
  }

  private runForThread(threadId: unknown): Run | undefined {
    const sessionId = typeof threadId === "string" ? this.byThread.get(threadId) : undefined;
    return sessionId ? this.runs.get(sessionId) : undefined;
  }

  // -- notifications ------------------------------------------------------------

  private onNotification({ method, params }: RpcNotification) {
    if (method === "thread/name/updated") {
      const sessionId = this.byThread.get(String(params.threadId));
      if (sessionId && typeof params.threadName === "string" && params.threadName) {
        this.emit({ type: "session.updated", sessionId, title: params.threadName, parentId: null });
      }
      return;
    }
    const run = this.runForThread(params.threadId);
    if (!run) return;
    // Notifications from a previous turn of this thread (e.g. after an interrupt) are ignored.
    if (typeof params.turnId === "string" && run.turnId && params.turnId !== run.turnId) return;
    const transcript = this.transcript(run.sessionId);
    switch (method) {
      case "turn/started": {
        const startedId = (params.turn as { id?: string } | undefined)?.id ?? null;
        run.turnId ??= startedId;
        this.recordTurnId(run.sessionId, run.promptedAt, startedId);
        return;
      }
      case "item/started":
      case "item/completed": {
        const item = params.item as CodexItem | undefined;
        if (!item) return;
        if (item.type === "fileChange" && Array.isArray(item.changes)) run.fileChanges.set(item.id, item.changes as Record<string, unknown>[]);
        if (method === "item/started" && item.type === "mcpToolCall" && item.readOnlyHint !== true) void this.checkMcpCall(run, item);
        if (method === "item/completed" && run.testEvidence.observe(item) && run.preTestTrees.has(item.id)) run.testedTree = run.preTestTrees.get(item.id);
        let part = normalizeItem(item, run.directory);
        const declined = run.declined.get(item.id);
        if (part?.type === "tool" && declined && item.status === "declined") part = { ...part, error: declined };
        // Streamed text already holds the content of an in-progress message.
        if (part && !(method === "item/started" && part.type === "text" && !part.text)) transcript.upsertPart(run.messageId, part);
        return;
      }
      case "item/agentMessage/delta":
        transcript.appendText(run.messageId, String(params.itemId), "text", String(params.delta ?? ""));
        return;
      case "item/reasoning/summaryTextDelta":
        transcript.appendText(run.messageId, String(params.itemId), "reasoning", String(params.delta ?? ""));
        return;
      case "thread/tokenUsage/updated": {
        // The turn's tokens, as OpenCode reports them: totals now minus totals before the turn.
        const usage = params.tokenUsage as { total?: TokenCounts; last?: TokenCounts } | undefined;
        const total = usage?.total;
        if (!total || typeof total.inputTokens !== "number" || typeof total.outputTokens !== "number") return;
        run.usageBase ??= { input: total.inputTokens - (usage.last?.inputTokens ?? 0), output: total.outputTokens - (usage.last?.outputTokens ?? 0) };
        const tokens = { input: Math.max(0, total.inputTokens - run.usageBase.input), output: Math.max(0, total.outputTokens - run.usageBase.output) };
        transcript.upsertPart(run.messageId, { type: "step-finish", id: `${run.messageId}:usage`, tokens });
        return;
      }
      case "error": {
        const error = params.error as { message?: string } | undefined;
        if (params.willRetry) this.emit({ type: "session.status", sessionId: run.sessionId, status: "retry", message: error?.message });
        return;
      }
      case "turn/completed": {
        const turn = params.turn as { status?: string; error?: { message?: string } | null } | undefined;
        if (turn?.status === "failed") this.endRun(run, turn.error?.message ?? "The Codex turn failed", true);
        else this.endRun(run, turn?.status === "interrupted" ? "Stopped" : "The turn ended before this finished");
        return;
      }
    }
  }

  // -- server requests (approvals, dynamic tools) -------------------------------

  private async onRequest(req: RpcRequest) {
    const rpc = this.rpc;
    if (!rpc) return;
    const run = this.runForThread(req.params.threadId);
    try {
      switch (req.method) {
        case "item/tool/call":
          return rpc.respond(req.id, await this.callTool(run, req.params));
        case "item/commandExecution/requestApproval":
        case "item/fileChange/requestApproval":
        case "item/permissions/requestApproval":
          return await this.approve(rpc, run, req);
        case "item/mcpToolCall/requestApproval":
          // If Codex ever asks before running an MCP tool, that is the pre-execution gate.
          // Codex 0.166.0 has no such method in its protocol schema, so in practice MCP
          // calls just start (item/started), which stays on the fail-closed abort below.
          return await this.approveMcp(rpc, run, req);
        case "item/tool/requestUserInput":
          return rpc.respondError(req.id, `Ask the developer with the ${CHECKPOINT_TOOL} tool instead.`);
        case "mcpServer/elicitation/request":
          // MCP servers asking the developer for input are not supported in Peer yet.
          return rpc.respond(req.id, { action: "decline", content: null, _meta: null });
        case "execCommandApproval":
        case "applyPatchApproval":
          return rpc.respond(req.id, { decision: { denied: { rejection: "Peer only supports the v2 approval protocol." } } });
        default:
          return rpc.respondError(req.id, `Peer does not handle ${req.method}`, -32601);
      }
    } catch (err) {
      this.opts.log(`[codex] ${req.method} failed: ${err instanceof Error ? err.message : String(err)}`);
      rpc.respondError(req.id, err instanceof Error ? err.message : String(err));
    }
  }

  private async callTool(run: Run | undefined, params: Record<string, unknown>) {
    const text = (t: string) => [{ type: "inputText", text: t }];
    if (params.tool !== CHECKPOINT_TOOL || !run) return { contentItems: text(`Unknown tool ${String(params.tool)}`), success: false };
    const args = params.arguments && typeof params.arguments === "object" ? (params.arguments as Record<string, unknown>) : {};
    try {
      const output = await this.opts.hooks.checkpoint(run.sessionId, String(params.callId ?? "") || null, args, run.abort.signal);
      return { contentItems: text(output), success: true };
    } catch (err) {
      return { contentItems: text(`The checkpoint was cancelled: ${err instanceof Error ? err.message : String(err)}`), success: false };
    }
  }

  /**
   * Peer is the approver for Codex. Locked gate -> decline. Destructive, networked, escalated, or
   * outside-the-workspace requests -> the developer decides. Anything else -> accept.
   */
  private async approve(rpc: CodexRpc, run: Run | undefined, req: RpcRequest) {
    const p = req.params;
    if (!run) return rpc.respond(req.id, approvalResponse(req.method, p, "reject", true));

    let needsDeveloper: string | null = null;
    let permission = "bash";
    let pattern = "";
    if (req.method === "item/commandExecution/requestApproval") {
      const command = unwrapShell(String(p.command ?? ""));
      pattern = command;
      const gate = await this.opts.hooks.checkTool(run.sessionId, "bash", { command, cwd: typeof p.cwd === "string" ? p.cwd : undefined }, run.abort.signal);
      if (!gate.allow) return this.decline(rpc, run, req, gate.reason, gate.explain);
      if (isDestructiveCommand(command)) needsDeveloper = "Destructive command";
      else if (p.networkApprovalContext || (Array.isArray(p.proposedNetworkPolicyAmendments) && p.proposedNetworkPolicyAmendments.length)) needsDeveloper = "Network access";
      else if (p.reason) needsDeveloper = String(p.reason);
      else if (p.kind && p.kind !== "command") needsDeveloper = "Input to a running command";
      else if (typeof p.cwd === "string" && !inside(run.directory, p.cwd)) needsDeveloper = "Runs outside the workspace";
    } else if (req.method === "item/fileChange/requestApproval") {
      permission = "edit";
      const changes = run.fileChanges.get(String(p.itemId)) ?? [];
      const paths = changes.map((c) => String(c.path ?? ""));
      pattern = paths.map((f) => relative(run.directory, f) || f).join(", ") || "file changes";
      const gate = await this.opts.hooks.checkTool(run.sessionId, "apply_patch", { files: paths, changes }, run.abort.signal);
      if (!gate.allow) return this.decline(rpc, run, req, gate.reason, gate.explain);
      if (p.grantRoot) needsDeveloper = `Write access to ${String(p.grantRoot)}`;
      else if (p.reason) needsDeveloper = String(p.reason);
      else if (paths.length === 0 || paths.some((f) => !inside(run.directory, f))) needsDeveloper = "Changes outside the workspace";
    } else {
      permission = "permissions";
      pattern = JSON.stringify(p.permissions ?? {});
      const gate = await this.opts.hooks.checkTool(run.sessionId, "permissions", {}, run.abort.signal);
      if (!gate.allow) return this.decline(rpc, run, req, gate.reason, gate.explain);
      needsDeveloper = String(p.reason ?? "Additional permissions");
    }

    if (!needsDeveloper) {
      await this.beforeTestCommand(run, req.method, p);
      return rpc.respond(req.id, approvalResponse(req.method, p, "once"));
    }
    const request: PermissionRequest = {
      id: `perm_${randomUUID()}`,
      sessionId: run.sessionId,
      permission,
      patterns: [pattern],
      metadata: { reason: needsDeveloper, method: req.method },
    };
    run.approvals.set(request.id, { request, rpcId: req.id, method: req.method, params: p });
    this.emit({ type: "permission.asked", request });
  }

  /** The MCP tool an approval request or item names, and the arguments it would run with. */
  private mcpCall(params: Record<string, unknown>): { server: string; tool: string; args: unknown } {
    const item = params.item && typeof params.item === "object" ? (params.item as Record<string, unknown>) : params;
    const server = String(item.server ?? params.server ?? "");
    const tool = String(item.tool ?? params.tool ?? "");
    const args = (item.arguments ?? params.arguments ?? {}) as unknown;
    return { server, tool, args };
  }

  /**
   * Pre-execution gate for MCP tools, when Codex asks first. The gate decides whether the call
   * may run at all; the developer decides the rest, like any other approval.
   */
  private async approveMcp(rpc: CodexRpc, run: Run | undefined, req: RpcRequest) {
    const p = req.params;
    if (!run) return rpc.respond(req.id, approvalResponse(req.method, p, "reject", true));
    const { server, tool, args } = this.mcpCall(p);
    const name = `${server}_${tool}`;
    const gate = await this.opts.hooks.checkTool(run.sessionId, name, args, run.abort.signal);
    if (!gate.allow) return this.decline(rpc, run, req, gate.reason, gate.explain);
    const request: PermissionRequest = {
      id: `perm_${randomUUID()}`,
      sessionId: run.sessionId,
      permission: "mcp",
      patterns: [`${server}: ${tool}`],
      metadata: { reason: "MCP tool call", method: req.method, server, tool, arguments: args },
    };
    run.approvals.set(request.id, { request, rpcId: req.id, method: req.method, params: p });
    this.emit({ type: "permission.asked", request });
  }

  /**
   * Codex 0.166.0 runs MCP tools without asking its client (no
   * `item/mcpToolCall/requestApproval` in its protocol schema), so Peer cannot stop one
   * beforehand. If one starts while the gate is locked, Peer stops the turn and says so (fail
   * closed, after the fact). Gated turns are also told up front not to start any
   * (MCP_LOCKED_NOTE).
   */
  private async checkMcpCall(run: Run, item: CodexItem) {
    const tool = `${String(item.server)}_${String(item.tool)}`;
    const gate = await this.opts.hooks.checkTool(run.sessionId, tool, item.arguments ?? {}, run.abort.signal);
    if (gate.allow || this.runs.get(run.sessionId) !== run) return;
    const reason = `${gate.reason} Codex runs MCP tools without asking Peer first, so Peer stopped this turn.`;
    run.declined.set(item.id, reason);
    this.emit({ type: "session.error", sessionId: run.sessionId, error: `Stopped: Codex called the MCP tool "${tool}" while code changes were locked.` });
    await this.abort(run.directory, run.sessionId);
  }

  private decline(rpc: CodexRpc, run: Run, req: RpcRequest, reason: string, explain = false) {
    // Codex only tells the model "declined"; keep the reason for the transcript.
    if (typeof req.params.itemId === "string") run.declined.set(req.params.itemId, reason);
    rpc.respond(req.id, approvalResponse(req.method, req.params, "reject"));
    // When the reason is the developer's decision, the model needs it: add it to the running turn.
    if (explain) void this.steer(rpc, run, typeof req.params.turnId === "string" ? req.params.turnId : run.turnId, reason);
  }

  /** Add input to the turn in progress (turn/steer). Best effort: the turn may have ended meanwhile. */
  private async steer(rpc: CodexRpc, run: Run, turnId: string | null, text: string) {
    if (!turnId || this.runs.get(run.sessionId) !== run) return;
    try {
      await rpc.call("turn/steer", { threadId: run.threadId, expectedTurnId: turnId, input: [{ type: "text", text, text_elements: [] }] }, 10_000);
    } catch (err) {
      this.opts.log(`[codex] turn/steer failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
}

function inside(root: string, path: string): boolean {
  const rel = relative(root, resolve(root, path));
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

/** The JSON-RPC result for an approval request, per method. */
function approvalResponse(method: string, params: Record<string, unknown>, reply: PermissionReply, cancel = false): Record<string, unknown> {
  if (method === "item/permissions/requestApproval") {
    return reply === "reject" ? { permissions: {}, scope: "turn" } : { permissions: params.permissions ?? {}, scope: reply === "always" ? "session" : "turn" };
  }
  if (method === "execCommandApproval" || method === "applyPatchApproval") {
    return { decision: reply === "reject" ? (cancel ? "abort" : { denied: { rejection: "Declined by the developer" } }) : "approved" };
  }
  return { decision: reply === "reject" ? (cancel ? "cancel" : "decline") : reply === "always" ? "acceptForSession" : "accept" };
}

