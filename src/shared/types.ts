// Domain types shared by the Peer backend and the renderer.
// Nothing in here depends on OpenCode: the runtime adapter maps runtime data into these shapes.

export const COLLABORATION_MODES = ["focus", "collaborate", "learn"] as const;
export type CollaborationModeId = (typeof COLLABORATION_MODES)[number];
export const DEFAULT_MODE: CollaborationModeId = "collaborate";

/**
 * What the developer explicitly asked for on this turn, on top of the session mode.
 * Set from composer controls or a leading slash command (/go, /discuss, /hint, /answer).
 */
export const TURN_INTENTS = ["default", "delegate", "discuss", "hint", "answer"] as const;
export type TurnIntent = (typeof TURN_INTENTS)[number];

/** Kinds of decision the agent may bring to the developer through a checkpoint. */
export const CHECKPOINT_CATEGORIES = [
  "architecture", // structural decision with lasting consequences (data model, dependency, public API)
  "tradeoff", // choosing between viable alternatives where the developer's preference matters
  "requirement", // ambiguity in what is wanted that materially changes the result
  "risk", // risky or irreversible step, or significant uncertainty
  "hypothesis", // ask the developer to predict / diagnose before being told
  "concept", // check understanding of a concept the task depends on
  "confirm", // go-ahead on a concrete plan
] as const;
export type CheckpointCategory = (typeof CHECKPOINT_CATEGORIES)[number];

/**
 * How code changes are gated during a turn.
 * - open: the agent may change code.
 * - engage: code changes are locked until the developer engages (answers a checkpoint, delegates, skips).
 * - hold: code changes are locked for the whole turn unless the developer explicitly delegates or skips.
 */
export type GateKind = "open" | "engage" | "hold";

export interface GateState {
  kind: GateKind;
  locked: boolean;
  reason: string | null;
}

export type CheckpointStatus = "pending" | "resolved" | "auto_resolved" | "interrupted" | "cancelled";

/** Developer responses to a checkpoint. */
export const CHECKPOINT_ACTIONS = ["answer", "choose", "delegate", "skip", "hint"] as const;
export type CheckpointAction = (typeof CHECKPOINT_ACTIONS)[number];

export interface CheckpointOption {
  label: string;
  description?: string;
}

export interface CheckpointResolution {
  action: CheckpointAction | "policy" | "cancelled";
  by: "human" | "policy" | "system";
  text?: string;
  option?: string;
  /** Human-readable explanation, e.g. why the policy declined to ask. */
  note?: string;
}

export interface Checkpoint {
  id: string;
  sessionId: string;
  turnId: string | null;
  category: CheckpointCategory;
  question: string;
  context: string | null;
  options: CheckpointOption[];
  recommendation: string | null;
  status: CheckpointStatus;
  resolution: CheckpointResolution | null;
  createdAt: number;
  resolvedAt: number | null;
}

export interface Workspace {
  id: string;
  path: string;
  name: string;
  /** Commands in Codex's sandbox may use the network (off by default: tests that open a port fail). */
  sandboxNetwork: boolean;
  createdAt: number;
  lastOpenedAt: number;
}

/**
 * The coding-agent runtime a session runs on. OpenCode is bundled with Peer; Claude Code and
 * Codex use the CLI (and login) the developer already has installed.
 */
export const RUNTIME_KINDS = ["opencode", "claude", "codex"] as const;
export type RuntimeKind = (typeof RUNTIME_KINDS)[number];
export const DEFAULT_RUNTIME: RuntimeKind = "opencode";

/**
 * Until the developer picks a runtime, new sessions use the first of these that is ready: the
 * agents they are already signed in to first, the bundled runtime (any other model) last.
 */
export const RUNTIME_PREFERENCE: readonly RuntimeKind[] = ["claude", "codex", "opencode"];

/** The runtime for new sessions: the developer's own pick while it is usable, else the best one that is ready. */
export function pickDefaultRuntime(chosen: RuntimeKind | null, runtimes: readonly { kind: RuntimeKind; status: { state: string } }[]): RuntimeKind {
  const state = (kind: RuntimeKind) => runtimes.find((r) => r.kind === kind)?.status.state;
  // A pick that is down (not installed, crashed, stopped) gives way, but stays stored for when it is back.
  if (chosen && (state(chosen) === "ready" || state(chosen) === "starting")) return chosen;
  return RUNTIME_PREFERENCE.find((k) => state(k) === "ready") ?? RUNTIME_PREFERENCE.find((k) => state(k) === "starting") ?? chosen ?? DEFAULT_RUNTIME;
}

export interface ModelRef {
  providerId: string;
  modelId: string;
}

export type SessionRunStatus = "idle" | "busy" | "retry";

export interface PeerSession {
  id: string;
  workspaceId: string;
  runtime: RuntimeKind;
  runtimeSessionId: string;
  title: string;
  mode: CollaborationModeId;
  model: ModelRef | null;
  createdAt: number;
  updatedAt: number;
}

export interface Turn {
  id: string;
  sessionId: string;
  mode: CollaborationModeId;
  intent: TurnIntent;
  gate: GateKind;
  /** For a continuation: the turn whose work it carries on (same task, same checkpoint budget). */
  continuedFrom: string | null;
  engagedAt: number | null;
  startedAt: number;
  endedAt: number | null;
  /** The developer undid this turn (its file changes were reverted). */
  undoneAt: number | null;
}

// ---------------------------------------------------------------------------
// Transcript (normalized from the agent runtime)

export type ToolStatus = "pending" | "running" | "completed" | "error";

export type PeerPart =
  | { type: "text"; id: string; text: string; synthetic?: boolean }
  | { type: "reasoning"; id: string; text: string }
  | {
      type: "tool";
      id: string;
      tool: string;
      callId: string;
      status: ToolStatus;
      title?: string;
      input: Record<string, unknown>;
      output?: string;
      error?: string;
      /** Unified diff produced by file-editing tools, when available. */
      diff?: string;
    }
  | { type: "patch"; id: string; files: string[] }
  | { type: "step-finish"; id: string; tokens?: { input: number; output: number }; cost?: number }
  | { type: "file"; id: string; filename: string; mime: string };

export interface PeerMessageInfo {
  id: string;
  role: "user" | "assistant";
  createdAt: number;
  completedAt?: number;
  error?: string;
  /** Something the developer should know about the turn that isn't an error (e.g. tests that could not run). */
  warning?: string;
  providerId?: string;
  modelId?: string;
}

export interface PeerMessage extends PeerMessageInfo {
  parts: PeerPart[];
}

export interface PermissionRequest {
  id: string;
  sessionId: string;
  permission: string;
  patterns: string[];
  metadata: Record<string, unknown>;
}

export type PermissionReply = "once" | "always" | "reject";

export interface FileDiff {
  file: string;
  additions: number;
  deletions: number;
  status?: "added" | "deleted" | "modified";
  patch?: string;
}

export interface ProviderInfo {
  id: string;
  name: string;
  models: { id: string; name: string }[];
}

export interface ModelsResponse {
  providers: ProviderInfo[];
  default: ModelRef | null;
}

export interface RuntimeStatus {
  /** "unavailable": the runtime's CLI is not installed or not logged in (see `error` for what to do). */
  state: "starting" | "ready" | "error" | "stopped" | "unavailable";
  version?: string;
  error?: string;
  /** How the runtime's own CLI is signed in, e.g. "Claude Pro" or "ChatGPT". Never an email or a secret. */
  account?: string;
  /** Something to know that does not stop the runtime, e.g. a CLI version Peer was not tested with. */
  warning?: string;
}

/**
 * Where a connected OpenCode provider's credentials come from:
 * - "peer": connected in Peer (stored in Peer's own OpenCode data, can be disconnected there)
 * - "opencode-login": the developer's own `opencode auth login` (Peer re-imports it on every start)
 * - "environment": an API key variable such as OPENAI_API_KEY
 * - "config": the developer's OpenCode config file
 * - "built-in": needs no credentials (OpenCode's free models)
 */
export type ProviderSource = "peer" | "opencode-login" | "environment" | "config" | "built-in";

/** One question a login method asks before it can run (e.g. an enterprise URL). */
export interface ProviderAuthPrompt {
  type: "text" | "select";
  key: string;
  message: string;
  placeholder?: string;
  options?: { label: string; value: string; hint?: string }[];
  /** Ask only when another answer matches. */
  when?: { key: string; op: "eq" | "neq"; value: string };
}

export interface ProviderAuthMethodInfo {
  type: "api" | "oauth";
  label: string;
  prompts: ProviderAuthPrompt[];
}

/** A model provider the bundled OpenCode runtime can use. Never carries a credential. */
export interface ProviderEntry {
  id: string;
  name: string;
  connected: boolean;
  source?: ProviderSource;
  modelCount: number;
  /** Ways to connect it, in OpenCode's order (the index is the OAuth method number). */
  methods: ProviderAuthMethodInfo[];
  /** Environment variables OpenCode reads a key from, e.g. ["OPENAI_API_KEY"]. */
  env: string[];
}

export type LocalServerKind = "ollama" | "lmstudio" | "custom";

/** A local model server (OpenAI-compatible), added in Peer or detected at its default address. */
export interface LocalServerInfo {
  /** The OpenCode provider id once added; null for a detected server that is not added. */
  id: string | null;
  name: string;
  kind: LocalServerKind;
  baseUrl: string;
  added: boolean;
  /** It answered just now. */
  running: boolean;
  /** Model ids (for a server that is down: the ones it served last). */
  models: string[];
}

export interface ProviderCatalog {
  providers: ProviderEntry[];
  /** Local model servers; their providers are not in `providers`. */
  local: LocalServerInfo[];
  /** A connection changed while an OpenCode session was running; models refresh once it is idle. */
  reloadPending: boolean;
}

/** The first step of a browser login: open `url`; "code" logins then need the code the page shows. */
export interface OAuthStart {
  url: string;
  mode: "auto" | "code";
  instructions: string;
}

export interface RuntimeInfo {
  kind: RuntimeKind;
  name: string;
  status: RuntimeStatus;
}

/** Everything the UI needs to render a session after a (re)connect. */
export interface SessionSnapshot {
  session: PeerSession;
  status: SessionRunStatus;
  gate: GateState;
  turn: Turn | null;
  checkpoints: Checkpoint[];
  permissions: PermissionRequest[];
  lastError: string | null;
  /** Whether "Undo last turn" can run now, and why not. */
  undo: UndoAvailability;
}

/** The undo reason when the session has no turn left to undo (the UI then hides the button). */
export const NOTHING_TO_UNDO = "Nothing to undo yet.";

export interface UndoAvailability {
  available: boolean;
  reason: string | null;
}

/** What "Undo last turn" did. */
export interface UndoResult {
  /** Files restored to how they were before the turn (repository-relative). */
  files: string[];
  /** Turns undone (a task and the continuation that carried it on count as one undo). */
  turns: number;
  /** The runtime dropped the turn from the conversation; otherwise the agent is told on its next turn. */
  forgotten: boolean;
}

export interface Preferences {
  defaultMode: CollaborationModeId;
  /** Runtime for new sessions (see `pickDefaultRuntime`). */
  defaultRuntime: RuntimeKind;
  /** The runtime the developer last picked, or null if they never did (then Peer picks). */
  runtimeChosen: RuntimeKind | null;
  /** Session to reopen on launch. Kept server-side: the UI origin (port) changes between launches. */
  lastSessionId: string | null;
}

// ---------------------------------------------------------------------------
// Events pushed to the renderer over SSE

export type PeerEvent =
  | { type: "runtime.status"; runtime: RuntimeKind; status: RuntimeStatus }
  /** The runtime's connected providers (and so its models) changed. */
  | { type: "providers.updated"; runtime: RuntimeKind; reloadPending: boolean }
  | { type: "session.updated"; session: PeerSession }
  | { type: "session.status"; sessionId: string; status: SessionRunStatus; message?: string }
  | { type: "session.error"; sessionId: string; error: string }
  /** The session's last turn was undone: its messages, diff and undo state changed. */
  | { type: "session.undone"; sessionId: string; result: UndoResult }
  | { type: "session.diff"; sessionId: string; diff: FileDiff[] }
  | { type: "message.updated"; sessionId: string; message: PeerMessageInfo }
  | { type: "part.updated"; sessionId: string; messageId: string; part: PeerPart }
  | { type: "part.delta"; sessionId: string; messageId: string; partId: string; field: string; delta: string }
  | { type: "checkpoint.updated"; checkpoint: Checkpoint }
  | { type: "gate.updated"; sessionId: string; gate: GateState }
  | { type: "permission.asked"; request: PermissionRequest }
  | { type: "permission.replied"; sessionId: string; requestId: string };
