import type {
  FileDiff,
  GateKind,
  LocalServerKind,
  ModelRef,
  ModelsResponse,
  OAuthStart,
  PeerMessage,
  PeerMessageInfo,
  PeerPart,
  PermissionReply,
  PermissionRequest,
  ProviderCatalog,
  RuntimeKind,
  RuntimeStatus,
  SessionRunStatus,
} from "../../shared/types.js";

/**
 * The boundary between Peer and the coding-agent runtime. The collaboration engine and the
 * HTTP API depend only on this interface, so the runtime (OpenCode today) can be replaced
 * or extended without touching collaboration logic or the UI.
 *
 * All session ids here are runtime session ids; Peer maps them to its own sessions.
 */
export interface AgentRuntimeAdapter {
  readonly kind: RuntimeKind;
  /** Display name, e.g. "Claude Code". */
  readonly name: string;
  /** Name under which the model sees Peer's checkpoint tool in this runtime. */
  readonly checkpointTool: string;
  /**
   * The runtime's OS sandbox is fixed when a turn starts (Codex). A turn that starts gated stays
   * read-only even after the developer engages, so Peer continues the work in a new turn.
   */
  readonly sandboxFixedPerTurn?: boolean;

  start(): Promise<void>;
  stop(): Promise<void>;
  restart(): Promise<void>;
  status(): RuntimeStatus;

  listModels(directory: string): Promise<ModelsResponse>;

  createSession(directory: string, input: { title?: string }): Promise<{ id: string; title: string }>;
  getMessages(directory: string, sessionId: string): Promise<PeerMessage[]>;
  getDiff(directory: string, sessionId: string): Promise<FileDiff[]>;
  /** Parent session id for subagent sessions, or null for root sessions. */
  getParentSessionId(directory: string, sessionId: string): Promise<string | null>;

  /** Start an agent turn. Resolves once the runtime accepted it; progress arrives as events. */
  prompt(directory: string, sessionId: string, input: PromptInput): Promise<void>;
  abort(directory: string, sessionId: string): Promise<void>;

  listPermissions(directory: string): Promise<PermissionRequest[]>;
  replyPermission(directory: string, requestId: string, reply: PermissionReply): Promise<void>;

  /** Ids of tools the runtime exposes for a model (used by health checks). */
  listToolIds(directory: string, model: ModelRef): Promise<string[]>;

  onEvent(listener: (event: RuntimeEvent) => void): () => void;

  /**
   * Undo: drop everything from the first user message created at or after `since` from the
   * conversation. Peer has already put the files back. Resolves true if the agent no longer sees
   * those turns, false if they stay in its context (Peer then tells it they were undone).
   */
  forgetTurns(directory: string, sessionId: string, since: number): Promise<boolean>;

  /** Present when Peer can connect this runtime's model providers itself (OpenCode). */
  readonly providers?: ProviderConnections;
}

/** A provider request the developer can fix (unknown provider, not removable here, ...). */
export class ProviderError extends Error {}

/**
 * Connecting model providers from Peer. Credentials go straight to the runtime's own store;
 * nothing here returns one.
 */
export interface ProviderConnections {
  catalog(): Promise<ProviderCatalog>;
  /** `inputs` are the answers to the method's prompts (e.g. a Cloudflare account id). */
  setKey(providerId: string, key: string, inputs: Record<string, string>): Promise<void>;
  /** `method` indexes the provider's methods. */
  startOAuth(providerId: string, method: number, inputs: Record<string, string>): Promise<OAuthStart>;
  /** "auto" logins wait here until the browser finishes; "code" logins pass the pasted code. */
  finishOAuth(providerId: string, method: number, code?: string): Promise<void>;
  /** Only providers connected in Peer ("peer" source) can be disconnected here. */
  disconnect(providerId: string): Promise<void>;
  /** Add an OpenAI-compatible local server (Ollama, LM Studio, ...); its models become a provider. */
  addLocal(input: { baseUrl: string; name?: string; kind?: LocalServerKind }): Promise<void>;
  removeLocal(id: string): Promise<void>;
}

/**
 * Collaboration hooks for runtimes Peer drives in-process (Claude Code, Codex). The OpenCode
 * plugin reaches the same engine functions over the authenticated HTTP bridge instead.
 */
export interface RuntimeHooks {
  /**
   * Decide whether a tool call may run under the session's collaboration gate. May wait for the
   * developer when Peer holds the call on a checkpoint; the signal (the run stopping) cancels that.
   * `explain`: the reason must reach the model (send it separately if the runtime only says "declined").
   */
  checkTool(
    runtimeSessionId: string,
    tool: string,
    args: unknown,
    signal?: AbortSignal,
  ): Promise<{ allow: true } | { allow: false; reason: string; explain?: boolean }>;
  /**
   * Open a checkpoint and wait for the developer's response. Resolves with the text to return to
   * the agent; rejects if the checkpoint was cancelled or the signal aborted.
   */
  checkpoint(runtimeSessionId: string, callId: string | null, request: Record<string, unknown>, signal: AbortSignal): Promise<string>;
}

export interface PromptInput {
  text: string;
  /** Collaboration policy instructions for this turn. */
  system: string;
  /** How code changes are gated at the start of this turn (runtimes may enforce it natively too). */
  gate: GateKind;
  model?: ModelRef | null;
  /** Commands may use the network inside the runtime's OS sandbox (Codex; others have no sandbox). */
  network?: boolean;
  /**
   * Let the runtime settle its own permission prompts where it can (Claude Code: auto mode).
   * Runtimes without such a mode ignore it. Peer's gate and safety approvals are unaffected.
   */
  autoApprovals?: boolean;
  /** Tools to enable/disable for this turn. */
  tools?: Record<string, boolean>;
}

/** Runtime events, already normalized into Peer shapes. */
export type RuntimeEvent =
  | { type: "runtime.status"; status: RuntimeStatus }
  /** The runtime process came back after a crash; all in-flight runs are gone. */
  | { type: "runtime.restarted" }
  | { type: "providers.updated"; reloadPending: boolean }
  | { type: "session.updated"; sessionId: string; title: string; parentId: string | null }
  | { type: "session.status"; sessionId: string; status: SessionRunStatus; message?: string }
  | { type: "session.idle"; sessionId: string }
  | { type: "session.error"; sessionId: string; error: string }
  | { type: "session.diff"; sessionId: string; diff: FileDiff[] }
  | { type: "message.updated"; sessionId: string; message: PeerMessageInfo }
  | { type: "part.updated"; sessionId: string; messageId: string; part: PeerPart }
  | { type: "part.delta"; sessionId: string; messageId: string; partId: string; field: string; delta: string }
  | { type: "permission.asked"; request: PermissionRequest }
  | { type: "permission.replied"; sessionId: string; requestId: string };
