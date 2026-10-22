import { randomUUID } from "node:crypto";
import { isAbsolute, join, relative, resolve } from "node:path";
import type { ModelsResponse, PeerMessage, PermissionReply, PermissionRequest, RuntimeStatus } from "../../../shared/types.js";
import { CHECKPOINT_CATEGORIES } from "../../../shared/types.js";
import { CHECKPOINT_TOOL } from "../../collaboration/prompt.js";
import { isDestructiveCommand, unwrapShell } from "../../collaboration/safety.js";
import type { AgentRuntimeAdapter, PromptInput, RuntimeEvent, RuntimeHooks } from "../adapter.js";
import { findExecutable, runCli } from "../cli.js";
import { diffSinceSnapshot, snapshotWorkspace } from "../git-snapshot.js";
import { Transcript, titleFromPrompt, type RuntimeStorage } from "../transcript.js";
import { normalizeItem, type CodexItem } from "./normalize.js";
import { CodexRpc, type RpcNotification, type RpcRequest } from "./rpc.js";

/** The Codex CLI version this integration was built and tested against. */
export const CODEX_TESTED_VERSION = "0.163.0";

const MAX_RESTARTS = 5;
const RESTART_WINDOW_MS = 2 * 60_000;

/** Notifications Peer has no use for; Codex stops sending them to this connection. */
const OPTED_OUT_NOTIFICATIONS = [
  "turn/diff/updated",
  "turn/moderationMetadata",
  "rawResponseItem/completed",
  "rawResponse/completed",
  "thread/tokenUsage/updated",
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
}

interface SessionState {
  /** Codex thread, created on the first prompt (a thread without turns cannot be resumed later). */
  threadId?: string;
  baseline?: string | null;
  titled?: boolean;
}

interface PendingApproval {
  request: PermissionRequest;
  rpcId: number | string;
  method: string;
  params: Record<string, unknown>;
}

interface Run {
  sessionId: string;
  threadId: string;
  directory: string;
  turnId: string | null;
  /** Assistant message for this turn (one per Codex turn). */
  messageId: string;
  abort: AbortController;
  approvals: Map<string, PendingApproval>;
  /** Paths each in-flight fileChange item touches, for approval checks. */
  filePaths: Map<string, string[]>;
  /** Items Peer declined, with the reason (Codex itself only reports "declined"). */
  declined: Map<string, string>;
}

/**
 * Codex through `codex app-server` (JSON-RPC over stdio), using the developer's installed `codex`
 * CLI and its login. One app-server process serves all Codex sessions.
 *
 * Enforcement: threads run with approval policy "untrusted", so every command and file change
 * that Codex doesn't consider safe/read-only comes to Peer for approval. Peer declines it while
 * the collaboration gate is locked, routes destructive or sandbox-escaping requests to the
 * developer, and accepts the rest. Turns that start gated also run in Codex's read-only sandbox,
 * so the OS blocks writes even if an approval were missed. Checkpoints are a dynamic tool.
 */
export class CodexAdapter implements AgentRuntimeAdapter {
  readonly kind = "codex" as const;
  readonly name = "Codex";
  readonly checkpointTool = CHECKPOINT_TOOL;

  private binary: string | null = null;
  private rpc: CodexRpc | null = null;
  private current: RuntimeStatus = { state: "stopped" };
  private version: string | undefined;
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
    this.binary = findExecutable("codex", this.opts.env, this.opts.binary);
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
    const login = await runCli(this.binary, ["login", "status"], this.opts.env);
    if (login.code !== 0) {
      this.setStatus({ state: "unavailable", error: "Codex is not logged in. Run `codex login` in a terminal, then restart this runtime." });
      return;
    }
    try {
      await this.spawn();
      this.setStatus({ state: "ready", version: this.version });
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
    for (const run of this.runs.values()) this.endRun(run, "Peer is shutting down");
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
    for (const run of this.runs.values()) this.endRun(run, "Codex exited unexpectedly");
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
      this.setStatus({ state: "ready", version: this.version });
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

  async prompt(directory: string, sessionId: string, input: PromptInput): Promise<void> {
    if (this.runs.has(sessionId)) throw new Error("Codex is still working on this session.");
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
      turnId: null,
      messageId: `turn_${randomUUID()}`,
      abort: new AbortController(),
      approvals: new Map(),
      filePaths: new Map(),
      declined: new Map(),
    };
    this.runs.set(sessionId, run);
    transcript.startAssistantMessage(run.messageId, { providerId: "codex", modelId: model });
    this.emit({ type: "session.status", sessionId, status: "busy" });
    try {
      const res = await this.client().call<{ turn: { id: string } }>("turn/start", {
        threadId,
        // developerInstructions are fixed per thread, so the per-turn policy travels with the input.
        input: [
          { type: "text", text: `<peer_collaboration_policy>\n${input.system}\n</peer_collaboration_policy>`, text_elements: [] },
          { type: "text", text: input.text, text_elements: [] },
        ],
        approvalPolicy: "untrusted",
        sandboxPolicy:
          input.gate === "open"
            ? { type: "workspaceWrite", writableRoots: [], networkAccess: false, excludeTmpdirEnvVar: false, excludeSlashTmp: false }
            : { type: "readOnly", networkAccess: false },
        model,
      });
      run.turnId ??= res.turn.id;
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

  private endRun(run: Run, reason: string, isError = false) {
    if (this.runs.get(run.sessionId) !== run) return;
    this.runs.delete(run.sessionId);
    run.abort.abort();
    this.cancelApprovals(run);
    const transcript = this.transcript(run.sessionId);
    transcript.failRunningTools(run.messageId, reason);
    transcript.completeMessage(run.messageId, isError ? reason : undefined);
    if (isError) this.emit({ type: "session.error", sessionId: run.sessionId, error: reason });
    this.emit({ type: "session.idle", sessionId: run.sessionId });
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
      case "turn/started":
        run.turnId ??= (params.turn as { id?: string } | undefined)?.id ?? null;
        return;
      case "item/started":
      case "item/completed": {
        const item = params.item as CodexItem | undefined;
        if (!item) return;
        if (item.type === "fileChange" && Array.isArray(item.changes)) {
          run.filePaths.set(item.id, (item.changes as { path?: unknown }[]).map((c) => String(c.path ?? "")));
        }
        if (method === "item/started" && item.type === "mcpToolCall" && item.readOnlyHint !== true) void this.checkMcpCall(run, item);
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
      const gate = await this.opts.hooks.checkTool(run.sessionId, "bash", { command });
      if (!gate.allow) return this.decline(rpc, run, req, gate.reason);
      if (isDestructiveCommand(command)) needsDeveloper = "Destructive command";
      else if (p.networkApprovalContext || (Array.isArray(p.proposedNetworkPolicyAmendments) && p.proposedNetworkPolicyAmendments.length)) needsDeveloper = "Network access";
      else if (p.reason) needsDeveloper = String(p.reason);
      else if (p.kind && p.kind !== "command") needsDeveloper = "Input to a running command";
      else if (typeof p.cwd === "string" && !inside(run.directory, p.cwd)) needsDeveloper = "Runs outside the workspace";
    } else if (req.method === "item/fileChange/requestApproval") {
      permission = "edit";
      const paths = run.filePaths.get(String(p.itemId)) ?? [];
      pattern = paths.map((f) => relative(run.directory, f) || f).join(", ") || "file changes";
      const gate = await this.opts.hooks.checkTool(run.sessionId, "apply_patch", { files: paths });
      if (!gate.allow) return this.decline(rpc, run, req, gate.reason);
      if (p.grantRoot) needsDeveloper = `Write access to ${String(p.grantRoot)}`;
      else if (p.reason) needsDeveloper = String(p.reason);
      else if (paths.length === 0 || paths.some((f) => !inside(run.directory, f))) needsDeveloper = "Changes outside the workspace";
    } else {
      permission = "permissions";
      pattern = JSON.stringify(p.permissions ?? {});
      const gate = await this.opts.hooks.checkTool(run.sessionId, "permissions", {});
      if (!gate.allow) return this.decline(rpc, run, req, gate.reason);
      needsDeveloper = String(p.reason ?? "Additional permissions");
    }

    if (!needsDeveloper) return rpc.respond(req.id, approvalResponse(req.method, p, "once"));
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

  /**
   * Codex runs MCP tools without asking its client, so Peer cannot stop one beforehand. If one
   * starts while the gate is locked, Peer stops the turn and says so (fail closed, after the fact).
   */
  private async checkMcpCall(run: Run, item: CodexItem) {
    const tool = `${String(item.server)}_${String(item.tool)}`;
    const gate = await this.opts.hooks.checkTool(run.sessionId, tool, item.arguments ?? {});
    if (gate.allow || this.runs.get(run.sessionId) !== run) return;
    const reason = `${gate.reason} Codex runs MCP tools without asking Peer first, so Peer stopped this turn.`;
    run.declined.set(item.id, reason);
    this.emit({ type: "session.error", sessionId: run.sessionId, error: `Stopped: Codex called the MCP tool "${tool}" while code changes were locked.` });
    await this.abort(run.directory, run.sessionId);
  }

  private decline(rpc: CodexRpc, run: Run, req: RpcRequest, reason: string) {
    // Codex only tells the model "declined"; keep the reason for the transcript.
    if (typeof req.params.itemId === "string") run.declined.set(req.params.itemId, reason);
    rpc.respond(req.id, approvalResponse(req.method, req.params, "reject"));
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

