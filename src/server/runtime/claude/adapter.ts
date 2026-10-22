import { randomUUID } from "node:crypto";
import { join } from "node:path";
import {
  createSdkMcpServer,
  getSessionInfo,
  query,
  tool,
  type CanUseTool,
  type HookCallback,
  type PermissionResult,
  type PermissionUpdate,
  type Query,
  type SDKMessage,
} from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import {
  CHECKPOINT_CATEGORIES,
  type ModelsResponse,
  type PeerMessage,
  type PermissionReply,
  type PermissionRequest,
  type RuntimeStatus,
} from "../../../shared/types.js";
import { isDestructiveCommand } from "../../collaboration/safety.js";
import type { AgentRuntimeAdapter, PromptInput, RuntimeEvent, RuntimeHooks } from "../adapter.js";
import { findExecutable, runCli } from "../cli.js";
import { diffSinceSnapshot, snapshotWorkspace } from "../git-snapshot.js";
import { Transcript, titleFromPrompt, type RuntimeStorage } from "../transcript.js";
import { CLAUDE_CHECKPOINT_TOOL, peerToolInput, peerToolName, toolResultDiff, toolResultText } from "./normalize.js";

/** The SDK version Peer is built against; it tracks Claude Code CLI 2.1.x. */
export const CLAUDE_AGENT_SDK_VERSION = "0.3.308";

export interface ClaudeAdapterOptions {
  env: NodeJS.ProcessEnv;
  storage: RuntimeStorage;
  hooks: RuntimeHooks;
  /** Where per-session git snapshot indexes live. */
  dataDir: string;
  /** Explicit path to the `claude` executable (PEER_CLAUDE_BIN); otherwise found on PATH. */
  binary?: string;
  log: (line: string) => void;
}

interface SessionState {
  /** Claude Code has created the session on disk, so later turns resume it. */
  started?: boolean;
  /** Workspace git tree when the session first ran, for the Changes panel. */
  baseline?: string | null;
  titled?: boolean;
}

interface PendingPermission {
  request: PermissionRequest;
  input: Record<string, unknown>;
  suggestions?: PermissionUpdate[];
  resolve: (result: PermissionResult) => void;
}

interface Run {
  abort: AbortController;
  query: Query | null;
  directory: string;
  permissions: Map<string, PendingPermission>;
  /** Claude API message id -> number of content blocks seen (block index of the next one). */
  blockCount: Map<string, number>;
  /** tool_use id -> where its tool part lives. */
  tools: Map<string, { messageId: string; partId: string; claudeTool: string }>;
}

const FALLBACK_MODELS = [
  { id: "default", name: "Default (your Claude Code setting)" },
  { id: "sonnet", name: "Sonnet" },
  { id: "opus", name: "Opus" },
  { id: "haiku", name: "Haiku" },
];

/**
 * Claude Code through the Claude Agent SDK, using the developer's installed `claude` CLI and its
 * login. Each Peer turn is one `query()` that resumes the same Claude Code session, so the
 * per-turn collaboration policy is appended to Claude Code's own system prompt.
 *
 * Enforcement: a PreToolUse hook consults Peer's gate before every tool call (subagents
 * included) and forces an approval for destructive shell commands; approvals Claude Code asks
 * for reach the developer as Peer permission cards; checkpoints are an in-process MCP tool.
 */
export class ClaudeCodeAdapter implements AgentRuntimeAdapter {
  readonly kind = "claude" as const;
  readonly name = "Claude Code";
  readonly checkpointTool = CLAUDE_CHECKPOINT_TOOL;

  private binary: string | null = null;
  private current: RuntimeStatus = { state: "stopped" };
  private readonly listeners = new Set<(event: RuntimeEvent) => void>();
  private readonly runs = new Map<string, Run>();
  private readonly transcripts = new Map<string, Transcript>();
  private models: ModelsResponse | null = null;

  constructor(private readonly opts: ClaudeAdapterOptions) {}

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
        this.opts.log(`[claude] listener failed: ${String(err)}`);
      }
    }
  }

  private setStatus(status: RuntimeStatus) {
    this.current = status;
    this.emit({ type: "runtime.status", status });
  }

  /** Detect the CLI and its login. Never logs in or changes anything (status probes only). */
  async start(): Promise<void> {
    this.setStatus({ state: "starting" });
    this.binary = findExecutable("claude", this.opts.env, this.opts.binary);
    if (!this.binary) {
      this.setStatus({ state: "unavailable", error: "Claude Code is not installed (no `claude` on PATH). Install it, run `claude auth login`, then restart this runtime." });
      return;
    }
    const version = await runCli(this.binary, ["--version"], this.opts.env);
    if (version.code !== 0) {
      this.setStatus({ state: "unavailable", error: `\`claude --version\` failed: ${(version.stderr || version.stdout).trim().slice(0, 300)}` });
      return;
    }
    const auth = await runCli(this.binary, ["auth", "status", "--json"], this.opts.env);
    let loggedIn = false;
    try {
      const info = JSON.parse(auth.stdout) as { loggedIn?: boolean; apiProvider?: string };
      loggedIn = Boolean(info.loggedIn) || (info.apiProvider !== undefined && info.apiProvider !== "firstParty");
    } catch {
      loggedIn = false;
    }
    if (!loggedIn && !this.opts.env.ANTHROPIC_API_KEY) {
      this.setStatus({ state: "unavailable", error: "Claude Code is not logged in. Run `claude auth login` in a terminal, then restart this runtime." });
      return;
    }
    this.setStatus({ state: "ready", version: version.stdout.trim().split(/\s/)[0] });
  }

  async stop(): Promise<void> {
    for (const [sessionId, run] of this.runs) this.cancelRun(sessionId, run, "Peer is shutting down");
    this.setStatus({ state: "stopped" });
  }

  async restart(): Promise<void> {
    await this.stop();
    this.models = null;
    await this.start();
    this.emit({ type: "runtime.restarted" });
  }

  private bin(): string {
    if (this.current.state !== "ready" || !this.binary) throw new Error(this.current.error ?? "Claude Code is not available.");
    return this.binary;
  }

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

  // -- models -------------------------------------------------------------------

  async listModels(directory: string): Promise<ModelsResponse> {
    if (this.models) return this.models;
    let models = FALLBACK_MODELS;
    try {
      models = (await this.probeModels(directory)).map((m) => ({ id: m.value, name: m.displayName || m.value }));
    } catch (err) {
      this.opts.log(`[claude] model list unavailable, using aliases: ${err instanceof Error ? err.message : String(err)}`);
    }
    this.models = { providers: [{ id: "claude", name: "Claude Code", models }], default: { providerId: "claude", modelId: models[0]?.id ?? "default" } };
    return this.models;
  }

  /** Ask Claude Code which models this account can use, without sending a prompt. */
  private async probeModels(directory: string) {
    const abort = new AbortController();
    // A prompt stream that never yields: no message is ever sent to the model.
    const idle: AsyncIterable<never> = { [Symbol.asyncIterator]: () => ({ next: () => new Promise<never>(() => {}) }) };
    const q = query({
      prompt: idle,
      options: { pathToClaudeCodeExecutable: this.bin(), cwd: directory, env: this.opts.env, abortController: abort, persistSession: false, settingSources: [] },
    });
    try {
      return await Promise.race([
        q.supportedModels(),
        new Promise<never>((_, reject) => setTimeout(() => reject(new Error("timed out")), 20_000)),
      ]);
    } finally {
      abort.abort();
    }
  }

  // -- sessions -----------------------------------------------------------------

  async createSession(_directory: string, _input: { title?: string }) {
    // Claude Code creates the session on the first query, under this id.
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
    return [...this.runs.values()].filter((r) => r.directory === directory).flatMap((r) => [...r.permissions.values()].map((p) => p.request));
  }

  async replyPermission(_directory: string, requestId: string, reply: PermissionReply): Promise<void> {
    for (const run of this.runs.values()) {
      const pending = run.permissions.get(requestId);
      if (!pending) continue;
      run.permissions.delete(requestId);
      pending.resolve(
        reply === "reject"
          ? { behavior: "deny", message: "The developer rejected this action." }
          : { behavior: "allow", updatedInput: pending.input, updatedPermissions: reply === "always" ? pending.suggestions : undefined },
      );
      this.emit({ type: "permission.replied", sessionId: pending.request.sessionId, requestId });
      return;
    }
    throw new Error("Unknown or expired permission request");
  }

  async listToolIds(): Promise<string[]> {
    return [CLAUDE_CHECKPOINT_TOOL];
  }

  // -- turns --------------------------------------------------------------------

  async prompt(directory: string, sessionId: string, input: PromptInput): Promise<void> {
    const binary = this.bin();
    if (this.runs.has(sessionId)) throw new Error("Claude Code is still working on this session.");
    const state = this.state(sessionId);
    if (state.baseline === undefined) {
      state.baseline = await snapshotWorkspace(directory, this.indexFile(sessionId));
      this.saveState(sessionId, { baseline: state.baseline });
    }
    if (!state.titled) {
      this.emit({ type: "session.updated", sessionId, title: titleFromPrompt(input.text), parentId: null });
      this.saveState(sessionId, { titled: true });
    }

    const transcript = this.transcript(sessionId);
    transcript.addUserMessage(`user_${randomUUID()}`, input.text);
    const run: Run = { abort: new AbortController(), query: null, directory, permissions: new Map(), blockCount: new Map(), tools: new Map() };
    this.runs.set(sessionId, run);
    this.emit({ type: "session.status", sessionId, status: "busy" });

    const model = input.model?.modelId && input.model.modelId !== "default" ? input.model.modelId : undefined;
    try {
      run.query = query({
        prompt: input.text,
        options: {
          pathToClaudeCodeExecutable: binary,
          cwd: directory,
          env: this.opts.env,
          abortController: run.abort,
          ...(state.started ? { resume: sessionId } : { sessionId }),
          model,
          systemPrompt: { type: "preset", preset: "claude_code", append: input.system },
          // The developer's own Claude Code settings, CLAUDE.md files, MCP servers and permission rules apply.
          settingSources: ["user", "project", "local"],
          // File edits inside the workspace don't prompt (as in Peer's other runtimes); Peer's gate
          // still decides whether they may happen, and other approvals reach the developer.
          permissionMode: "acceptEdits",
          includePartialMessages: true,
          mcpServers: { peer: this.checkpointServer(sessionId, run) },
          // Peer checkpoints replace Claude Code's own question tool.
          disallowedTools: ["AskUserQuestion"],
          hooks: { PreToolUse: [{ hooks: [this.gateHook(sessionId)] }] },
          canUseTool: this.permissionPrompt(sessionId, run),
          stderr: (data) => this.opts.log(`[claude] ${data.trimEnd()}`),
        },
      });
    } catch (err) {
      this.runs.delete(sessionId);
      this.emit({ type: "session.idle", sessionId });
      throw err;
    }
    void this.consume(sessionId, run);
  }

  async abort(_directory: string, sessionId: string): Promise<void> {
    const run = this.runs.get(sessionId);
    if (run) this.cancelRun(sessionId, run, "Stopped by the developer");
  }

  private cancelRun(sessionId: string, run: Run, reason: string) {
    for (const [id, pending] of run.permissions) {
      pending.resolve({ behavior: "deny", message: reason, interrupt: true });
      this.emit({ type: "permission.replied", sessionId, requestId: id });
    }
    run.permissions.clear();
    run.abort.abort();
  }

  /** In-process MCP server exposing Peer's checkpoint tool to this run. */
  private checkpointServer(sessionId: string, run: Run) {
    return createSdkMcpServer({
      name: "peer",
      version: "1.0.0",
      alwaysLoad: true,
      tools: [
        tool(
          "checkpoint",
          "Bring a decision or question to the developer and wait for their response. Use it instead of ending your turn to ask. Returns the developer's answer and instructions for how to continue.",
          {
            category: z.enum(CHECKPOINT_CATEGORIES).describe("What kind of decision this is."),
            question: z.string().describe("One focused question for the developer."),
            context: z.string().optional().describe("Why this matters, in a few sentences (markdown)."),
            options: z
              .array(z.object({ label: z.string(), description: z.string().optional() }))
              .optional()
              .describe("2-4 short options when there are discrete choices."),
            recommendation: z.string().optional().describe("The option label you recommend, if any."),
          },
          async (args, extra) => {
            const callId = (extra as { _meta?: { "claudecode/toolUseId"?: string } } | undefined)?._meta?.["claudecode/toolUseId"] ?? null;
            try {
              const text = await this.opts.hooks.checkpoint(sessionId, callId, args, run.abort.signal);
              return { content: [{ type: "text", text }] };
            } catch (err) {
              return { content: [{ type: "text", text: `The checkpoint was cancelled: ${err instanceof Error ? err.message : String(err)}` }], isError: true };
            }
          },
          { alwaysLoad: true },
        ),
      ],
    });
  }

  /** Peer's collaboration gate and safety rules, consulted before every tool call. */
  private gateHook(sessionId: string): HookCallback {
    return async (input) => {
      if (input.hook_event_name !== "PreToolUse") return {};
      const name = input.tool_name;
      // Peer's own checkpoint tool never needs an approval prompt.
      if (name === CLAUDE_CHECKPOINT_TOOL) return { hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "allow" } };
      const args = peerToolInput(name, input.tool_input);
      const decision = await this.opts.hooks.checkTool(sessionId, peerToolName(name), args);
      if (!decision.allow) {
        return { hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: decision.reason } };
      }
      if (name === "Bash" && typeof args.command === "string" && isDestructiveCommand(args.command)) {
        return {
          hookSpecificOutput: {
            hookEventName: "PreToolUse",
            permissionDecision: "ask",
            permissionDecisionReason: "Peer safety rule: destructive commands need the developer's approval.",
          },
        };
      }
      return {};
    };
  }

  /** Approvals Claude Code would ask for in its terminal become Peer permission cards. */
  private permissionPrompt(sessionId: string, run: Run): CanUseTool {
    return (toolName, input, { signal, suggestions }) =>
      new Promise<PermissionResult>((resolve) => {
        const args = peerToolInput(toolName, input);
        const pattern = typeof args.command === "string" ? args.command : typeof args.filePath === "string" ? args.filePath : toolName;
        const request: PermissionRequest = {
          id: `perm_${randomUUID()}`,
          sessionId,
          permission: peerToolName(toolName),
          patterns: [pattern],
          metadata: { tool: toolName, input: args },
        };
        run.permissions.set(request.id, { request, input, suggestions, resolve });
        signal.addEventListener("abort", () => {
          if (!run.permissions.delete(request.id)) return;
          resolve({ behavior: "deny", message: "Cancelled" });
          this.emit({ type: "permission.replied", sessionId, requestId: request.id });
        });
        this.emit({ type: "permission.asked", request });
      });
  }

  // -- streaming ----------------------------------------------------------------

  private async consume(sessionId: string, run: Run) {
    const transcript = this.transcript(sessionId);
    const messageIds = new Set<string>();
    let error: string | undefined;
    try {
      for await (const message of run.query!) {
        const failure = this.handleMessage(sessionId, run, transcript, message, messageIds);
        if (failure) error = failure;
      }
    } catch (err) {
      if (!run.abort.signal.aborted) error = err instanceof Error ? err.message : String(err);
    } finally {
      this.runs.delete(sessionId);
      for (const id of messageIds) {
        transcript.failRunningTools(id, run.abort.signal.aborted ? "Stopped" : "The run ended before this finished");
        transcript.completeMessage(id, error);
      }
      if (error) this.emit({ type: "session.error", sessionId, error });
      this.emit({ type: "session.idle", sessionId });
      void this.refreshTitle(run.directory, sessionId);
    }
  }

  /** Returns an error message if this message reports a failed turn. */
  private handleMessage(sessionId: string, run: Run, transcript: Transcript, message: SDKMessage, messageIds: Set<string>): string | undefined {
    // Subagent internals are not shown; their tool calls are still gated by the hook.
    if ("parent_tool_use_id" in message && message.parent_tool_use_id) return undefined;
    switch (message.type) {
      case "system":
        if (message.subtype === "init" && !this.state(sessionId).started) this.saveState(sessionId, { started: true });
        return undefined;
      case "stream_event": {
        const event = message.event;
        if (event.type === "message_start") {
          messageIds.add(event.message.id);
          transcript.startAssistantMessage(event.message.id, { providerId: "claude", modelId: event.message.model });
          run.blockCount.set(event.message.id, 0);
          this.currentMessage.set(sessionId, event.message.id);
        } else if (event.type === "content_block_delta") {
          const messageId = this.currentMessage.get(sessionId);
          if (!messageId) return undefined;
          const partId = `${messageId}:${event.index}`;
          if (event.delta.type === "text_delta") transcript.appendText(messageId, partId, "text", event.delta.text);
          else if (event.delta.type === "thinking_delta") transcript.appendText(messageId, partId, "reasoning", event.delta.thinking);
        }
        return undefined;
      }
      case "assistant": {
        const api = message.message;
        messageIds.add(api.id);
        transcript.startAssistantMessage(api.id, { providerId: "claude", modelId: api.model });
        // Claude Code emits one assistant message per completed content block, in block order.
        let index = run.blockCount.get(api.id) ?? 0;
        for (const block of api.content) {
          const partId = `${api.id}:${index++}`;
          if (block.type === "text") transcript.upsertPart(api.id, { type: "text", id: partId, text: block.text });
          else if (block.type === "thinking") transcript.upsertPart(api.id, { type: "reasoning", id: partId, text: block.thinking });
          else if (block.type === "tool_use") {
            run.tools.set(block.id, { messageId: api.id, partId, claudeTool: block.name });
            transcript.upsertPart(api.id, {
              type: "tool",
              id: partId,
              tool: peerToolName(block.name),
              callId: block.id,
              status: "running",
              input: peerToolInput(block.name, block.input),
            });
          }
        }
        run.blockCount.set(api.id, index);
        return message.error ? `Claude Code: ${message.error.replace(/_/g, " ")}` : undefined;
      }
      case "user": {
        const content = message.message.content;
        if (!Array.isArray(content)) return undefined;
        for (const block of content) {
          if (block.type !== "tool_result") continue;
          const ref = run.tools.get(block.tool_use_id);
          const part = ref && transcript.part(ref.messageId, ref.partId);
          if (!ref || !part || part.type !== "tool") continue;
          const text = toolResultText(block.content).slice(0, 20_000);
          transcript.upsertPart(ref.messageId, {
            ...part,
            status: block.is_error ? "error" : "completed",
            output: block.is_error ? undefined : text,
            error: block.is_error ? text.replace(/^<tool_use_error>|<\/tool_use_error>$/g, "").replace(/^PreToolUse:\w+ hook error: /, "") : undefined,
            diff: block.is_error ? undefined : toolResultDiff(message.tool_use_result),
          });
        }
        return undefined;
      }
      case "result":
        if (message.subtype === "success" && !message.is_error) return undefined;
        return "result" in message && typeof message.result === "string" && message.result
          ? message.result
          : "errors" in message && Array.isArray(message.errors) && message.errors.length
            ? message.errors.join("\n")
            : `Claude Code stopped (${message.subtype}).`;
      default:
        return undefined;
    }
  }

  private readonly currentMessage = new Map<string, string>();

  /** Claude Code summarizes sessions itself; prefer that title once it exists. */
  private async refreshTitle(directory: string, sessionId: string) {
    try {
      const info = await getSessionInfo(sessionId, { dir: directory });
      const title = info?.customTitle || info?.summary;
      if (title) this.emit({ type: "session.updated", sessionId, title, parentId: null });
    } catch {
      // keep the prompt-derived title
    }
  }
}
