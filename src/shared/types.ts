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
  engagedAt: number | null;
  startedAt: number;
  endedAt: number | null;
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
}

export interface Preferences {
  defaultMode: CollaborationModeId;
  /** Runtime for new sessions; the last one the developer picked. */
  defaultRuntime: RuntimeKind;
  /** Session to reopen on launch. Kept server-side: the UI origin (port) changes between launches. */
  lastSessionId: string | null;
}

// ---------------------------------------------------------------------------
// Events pushed to the renderer over SSE

export type PeerEvent =
  | { type: "runtime.status"; runtime: RuntimeKind; status: RuntimeStatus }
  | { type: "session.updated"; session: PeerSession }
  | { type: "session.status"; sessionId: string; status: SessionRunStatus; message?: string }
  | { type: "session.error"; sessionId: string; error: string }
  | { type: "session.diff"; sessionId: string; diff: FileDiff[] }
  | { type: "message.updated"; sessionId: string; message: PeerMessageInfo }
  | { type: "part.updated"; sessionId: string; messageId: string; part: PeerPart }
  | { type: "part.delta"; sessionId: string; messageId: string; partId: string; field: string; delta: string }
  | { type: "checkpoint.updated"; checkpoint: Checkpoint }
  | { type: "gate.updated"; sessionId: string; gate: GateState }
  | { type: "permission.asked"; request: PermissionRequest }
  | { type: "permission.replied"; sessionId: string; requestId: string };
