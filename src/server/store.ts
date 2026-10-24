import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
  DEFAULT_MODE,
  type Checkpoint,
  type CheckpointResolution,
  type CheckpointStatus,
  type CollaborationModeId,
  type GateKind,
  DEFAULT_RUNTIME,
  RUNTIME_KINDS,
  type ModelRef,
  type PeerMessage,
  type PeerSession,
  type Preferences,
  type RuntimeKind,
  type Turn,
  type TurnIntent,
  type Workspace,
} from "../shared/types.js";

// Peer owns collaboration state. OpenCode keeps conversation messages in its own storage; for
// Claude Code and Codex, Peer keeps a normalized transcript so history renders after a restart.

const MIGRATIONS: string[] = [
  `
  CREATE TABLE workspaces (
    id TEXT PRIMARY KEY,
    path TEXT NOT NULL UNIQUE,
    name TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    last_opened_at INTEGER NOT NULL
  );
  CREATE TABLE sessions (
    id TEXT PRIMARY KEY,
    workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
    runtime_session_id TEXT NOT NULL UNIQUE,
    title TEXT NOT NULL,
    mode TEXT NOT NULL,
    model_provider TEXT,
    model_id TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );
  CREATE INDEX sessions_workspace ON sessions(workspace_id, updated_at DESC);
  CREATE TABLE turns (
    id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
    mode TEXT NOT NULL,
    intent TEXT NOT NULL,
    gate TEXT NOT NULL,
    engaged_at INTEGER,
    started_at INTEGER NOT NULL,
    ended_at INTEGER
  );
  CREATE INDEX turns_session ON turns(session_id, started_at DESC);
  CREATE TABLE checkpoints (
    id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
    turn_id TEXT,
    runtime_call_id TEXT,
    category TEXT NOT NULL,
    question TEXT NOT NULL,
    context TEXT,
    options TEXT NOT NULL,
    recommendation TEXT,
    status TEXT NOT NULL,
    resolution TEXT,
    created_at INTEGER NOT NULL,
    resolved_at INTEGER
  );
  CREATE INDEX checkpoints_session ON checkpoints(session_id, created_at);
  -- Append-only log of collaboration events (mode changes, turn plans, checkpoints, gate blocks).
  -- This is the capture point for the future Learning Space; see docs/roadmap.md.
  CREATE TABLE collaboration_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id TEXT NOT NULL,
    type TEXT NOT NULL,
    payload TEXT NOT NULL,
    created_at INTEGER NOT NULL
  );
  CREATE INDEX collaboration_events_session ON collaboration_events(session_id, id);
  CREATE TABLE preferences (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );
  `,
  `
  ALTER TABLE sessions ADD COLUMN runtime TEXT NOT NULL DEFAULT 'opencode';
  -- Per-session state owned by a runtime adapter (e.g. the Codex thread id).
  CREATE TABLE runtime_state (
    runtime TEXT NOT NULL,
    session_id TEXT NOT NULL,
    state TEXT NOT NULL,
    PRIMARY KEY (runtime, session_id)
  );
  -- Normalized transcripts for runtimes whose history Peer keeps itself (Claude Code, Codex).
  CREATE TABLE transcript_messages (
    runtime TEXT NOT NULL,
    session_id TEXT NOT NULL,
    message_id TEXT NOT NULL,
    seq INTEGER NOT NULL,
    data TEXT NOT NULL,
    PRIMARY KEY (runtime, session_id, message_id)
  );
  `,
  `
  -- The turn a continuation carries on (runtimes whose sandbox is fixed per turn).
  ALTER TABLE turns ADD COLUMN continued_from TEXT;
  `,
  `
  -- Commands in Codex's sandbox may use the network in this workspace.
  ALTER TABLE workspaces ADD COLUMN sandbox_network INTEGER NOT NULL DEFAULT 0;
  -- The workspace (a git tree) when the turn started and ended, and when the developer undid it.
  ALTER TABLE turns ADD COLUMN start_tree TEXT;
  ALTER TABLE turns ADD COLUMN end_tree TEXT;
  ALTER TABLE turns ADD COLUMN undone_at INTEGER;
  -- Turns undone that the agent still has in its context and has not been told about.
  ALTER TABLE sessions ADD COLUMN undone_untold INTEGER NOT NULL DEFAULT 0;
  -- The developer named the session; runtime-generated titles no longer replace it.
  ALTER TABLE sessions ADD COLUMN titled_by_developer INTEGER NOT NULL DEFAULT 0;
  `,
  `
  -- Checkpoints Peer opened itself for a decision it detected in a tool call (model-independent).
  ALTER TABLE checkpoints ADD COLUMN source TEXT NOT NULL DEFAULT 'agent';
  ALTER TABLE checkpoints ADD COLUMN decision TEXT;
  `,
  `
  -- The runtime settles its own permission prompts where it can (Claude Code's auto mode).
  ALTER TABLE sessions ADD COLUMN auto_approvals INTEGER NOT NULL DEFAULT 0;
  `,
];

type Row = Record<string, unknown>;

export function newId(prefix: string): string {
  return `${prefix}_${randomUUID().replace(/-/g, "").slice(0, 20)}`;
}

export class Store {
  readonly db: DatabaseSync;

  constructor(file: string) {
    if (file !== ":memory:") mkdirSync(dirname(file), { recursive: true });
    this.db = new DatabaseSync(file);
    this.db.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 3000;");
    this.migrate();
  }

  private migrate() {
    const { user_version: version } = this.db.prepare("PRAGMA user_version").get() as { user_version: number };
    for (let v = version; v < MIGRATIONS.length; v++) {
      this.db.exec("BEGIN");
      try {
        this.db.exec(MIGRATIONS[v]!);
        this.db.exec(`PRAGMA user_version = ${v + 1}`);
        this.db.exec("COMMIT");
      } catch (err) {
        this.db.exec("ROLLBACK");
        throw err;
      }
    }
  }

  close() {
    this.db.close();
  }

  // -- workspaces ------------------------------------------------------------

  listWorkspaces(): Workspace[] {
    return this.db.prepare("SELECT * FROM workspaces ORDER BY last_opened_at DESC").all().map(toWorkspace);
  }

  getWorkspace(id: string): Workspace | null {
    const row = this.db.prepare("SELECT * FROM workspaces WHERE id = ?").get(id);
    return row ? toWorkspace(row) : null;
  }

  upsertWorkspace(path: string, name: string): Workspace {
    const now = Date.now();
    const existing = this.db.prepare("SELECT * FROM workspaces WHERE path = ?").get(path);
    if (existing) {
      this.db.prepare("UPDATE workspaces SET last_opened_at = ? WHERE path = ?").run(now, path);
      return { ...toWorkspace(existing), lastOpenedAt: now };
    }
    const ws: Workspace = { id: newId("ws"), path, name, sandboxNetwork: false, createdAt: now, lastOpenedAt: now };
    this.db
      .prepare("INSERT INTO workspaces (id, path, name, created_at, last_opened_at) VALUES (?, ?, ?, ?, ?)")
      .run(ws.id, ws.path, ws.name, ws.createdAt, ws.lastOpenedAt);
    return ws;
  }

  updateWorkspace(id: string, patch: { sandboxNetwork?: boolean }): Workspace | null {
    if (patch.sandboxNetwork !== undefined) this.db.prepare("UPDATE workspaces SET sandbox_network = ? WHERE id = ?").run(patch.sandboxNetwork ? 1 : 0, id);
    return this.getWorkspace(id);
  }

  touchWorkspace(id: string) {
    this.db.prepare("UPDATE workspaces SET last_opened_at = ? WHERE id = ?").run(Date.now(), id);
  }

  removeWorkspace(id: string) {
    this.db.prepare("DELETE FROM workspaces WHERE id = ?").run(id);
  }

  // -- sessions --------------------------------------------------------------

  listSessions(workspaceId: string): PeerSession[] {
    return this.db
      .prepare("SELECT * FROM sessions WHERE workspace_id = ? ORDER BY updated_at DESC")
      .all(workspaceId)
      .map(toSession);
  }

  getSession(id: string): PeerSession | null {
    const row = this.db.prepare("SELECT * FROM sessions WHERE id = ?").get(id);
    return row ? toSession(row) : null;
  }

  getSessionByRuntimeId(runtimeSessionId: string): PeerSession | null {
    const row = this.db.prepare("SELECT * FROM sessions WHERE runtime_session_id = ?").get(runtimeSessionId);
    return row ? toSession(row) : null;
  }

  createSession(input: {
    workspaceId: string;
    runtime: RuntimeKind;
    runtimeSessionId: string;
    title: string;
    mode: CollaborationModeId;
    model: ModelRef | null;
  }): PeerSession {
    const now = Date.now();
    // Auto approvals start off; the developer turns them on per session.
    const session: PeerSession = { id: newId("ps"), ...input, autoApprovals: false, createdAt: now, updatedAt: now };
    this.db
      .prepare(
        `INSERT INTO sessions (id, workspace_id, runtime, runtime_session_id, title, mode, model_provider, model_id, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        session.id,
        session.workspaceId,
        session.runtime,
        session.runtimeSessionId,
        session.title,
        session.mode,
        session.model?.providerId ?? null,
        session.model?.modelId ?? null,
        now,
        now,
      );
    return session;
  }

  updateSession(id: string, patch: { title?: string; mode?: CollaborationModeId; model?: ModelRef | null; autoApprovals?: boolean }): PeerSession {
    const current = this.getSession(id);
    if (!current) throw new Error(`Unknown session ${id}`);
    const next: PeerSession = {
      ...current,
      title: patch.title ?? current.title,
      mode: patch.mode ?? current.mode,
      model: patch.model === undefined ? current.model : patch.model,
      autoApprovals: patch.autoApprovals ?? current.autoApprovals,
      updatedAt: Date.now(),
    };
    this.db
      .prepare("UPDATE sessions SET title = ?, mode = ?, model_provider = ?, model_id = ?, auto_approvals = ?, updated_at = ? WHERE id = ?")
      .run(next.title, next.mode, next.model?.providerId ?? null, next.model?.modelId ?? null, next.autoApprovals ? 1 : 0, next.updatedAt, id);
    return next;
  }

  /** A name the developer gave the session; it stays even when the runtime generates a title later. */
  renameSession(id: string, title: string): PeerSession {
    this.db.prepare("UPDATE sessions SET titled_by_developer = 1 WHERE id = ?").run(id);
    return this.updateSession(id, { title });
  }

  titledByDeveloper(id: string): boolean {
    const row = this.db.prepare("SELECT titled_by_developer FROM sessions WHERE id = ?").get(id);
    return Number(row?.titled_by_developer ?? 0) === 1;
  }

  deleteSession(id: string) {
    const session = this.getSession(id);
    this.db.prepare("DELETE FROM sessions WHERE id = ?").run(id);
    if (session) {
      this.db.prepare("DELETE FROM runtime_state WHERE runtime = ? AND session_id = ?").run(session.runtime, session.runtimeSessionId);
      this.db.prepare("DELETE FROM transcript_messages WHERE runtime = ? AND session_id = ?").run(session.runtime, session.runtimeSessionId);
    }
  }

  // -- runtime-owned state and transcripts (keyed by runtime session id) -------

  getRuntimeState<T>(runtime: RuntimeKind, sessionId: string): T | null {
    const row = this.db.prepare("SELECT state FROM runtime_state WHERE runtime = ? AND session_id = ?").get(runtime, sessionId);
    return row ? (JSON.parse(String(row.state)) as T) : null;
  }

  setRuntimeState(runtime: RuntimeKind, sessionId: string, state: unknown) {
    this.db
      .prepare("INSERT INTO runtime_state (runtime, session_id, state) VALUES (?, ?, ?) ON CONFLICT(runtime, session_id) DO UPDATE SET state = excluded.state")
      .run(runtime, sessionId, JSON.stringify(state));
  }

  listTranscript(runtime: RuntimeKind, sessionId: string): PeerMessage[] {
    return this.db
      .prepare("SELECT data FROM transcript_messages WHERE runtime = ? AND session_id = ? ORDER BY seq")
      .all(runtime, sessionId)
      .map((r) => JSON.parse(String(r.data)) as PeerMessage);
  }

  /** Insert or replace one message; new messages are appended after the existing ones. */
  saveTranscriptMessage(runtime: RuntimeKind, sessionId: string, message: PeerMessage) {
    this.db
      .prepare(
        `INSERT INTO transcript_messages (runtime, session_id, message_id, seq, data)
         VALUES (?, ?, ?, (SELECT COALESCE(MAX(seq), 0) + 1 FROM transcript_messages WHERE runtime = ? AND session_id = ?), ?)
         ON CONFLICT(runtime, session_id, message_id) DO UPDATE SET data = excluded.data`,
      )
      .run(runtime, sessionId, message.id, runtime, sessionId, JSON.stringify(message));
  }

  /** Forget messages of an undone turn. */
  deleteTranscriptMessages(runtime: RuntimeKind, sessionId: string, messageIds: string[]) {
    const del = this.db.prepare("DELETE FROM transcript_messages WHERE runtime = ? AND session_id = ? AND message_id = ?");
    for (const id of messageIds) del.run(runtime, sessionId, id);
  }

  // -- turns -----------------------------------------------------------------

  createTurn(input: { sessionId: string; mode: CollaborationModeId; intent: TurnIntent; gate: GateKind; continuedFrom?: string | null }): Turn {
    const turn: Turn = {
      id: newId("turn"),
      ...input,
      continuedFrom: input.continuedFrom ?? null,
      engagedAt: null,
      startedAt: Date.now(),
      endedAt: null,
      undoneAt: null,
    };
    this.db
      .prepare("INSERT INTO turns (id, session_id, mode, intent, gate, continued_from, engaged_at, started_at, ended_at) VALUES (?, ?, ?, ?, ?, ?, NULL, ?, NULL)")
      .run(turn.id, turn.sessionId, turn.mode, turn.intent, turn.gate, turn.continuedFrom, turn.startedAt);
    return turn;
  }

  latestTurn(sessionId: string): Turn | null {
    const row = this.db
      .prepare("SELECT * FROM turns WHERE session_id = ? ORDER BY started_at DESC, rowid DESC LIMIT 1")
      .get(sessionId);
    return row ? toTurn(row) : null;
  }

  getTurn(id: string): Turn | null {
    const row = this.db.prepare("SELECT * FROM turns WHERE id = ?").get(id);
    return row ? toTurn(row) : null;
  }

  markTurnEngaged(id: string) {
    this.db.prepare("UPDATE turns SET engaged_at = COALESCE(engaged_at, ?) WHERE id = ?").run(Date.now(), id);
  }

  setTurnTree(id: string, which: "start" | "end", tree: string | null) {
    this.db.prepare(`UPDATE turns SET ${which === "start" ? "start_tree" : "end_tree"} = ? WHERE id = ?`).run(tree, id);
  }

  /** The workspace trees recorded for a turn (null: not recorded, or not a git workspace). */
  turnTrees(id: string): { start: string | null; end: string | null } {
    const row = this.db.prepare("SELECT start_tree, end_tree FROM turns WHERE id = ?").get(id);
    return { start: row?.start_tree == null ? null : String(row.start_tree), end: row?.end_tree == null ? null : String(row.end_tree) };
  }

  /** The most recent turn that has not been undone. */
  latestKeptTurn(sessionId: string): Turn | null {
    const row = this.db
      .prepare("SELECT * FROM turns WHERE session_id = ? AND undone_at IS NULL ORDER BY started_at DESC, rowid DESC LIMIT 1")
      .get(sessionId);
    return row ? toTurn(row) : null;
  }

  markTurnsUndone(ids: string[]) {
    const now = Date.now();
    const mark = this.db.prepare("UPDATE turns SET undone_at = COALESCE(undone_at, ?) WHERE id = ?");
    for (const id of ids) mark.run(now, id);
  }

  addUndoneUntold(sessionId: string, turns: number) {
    this.db.prepare("UPDATE sessions SET undone_untold = undone_untold + ? WHERE id = ?").run(turns, sessionId);
  }

  /** How many undone turns the agent has not been told about; resets the count. */
  takeUndoneUntold(sessionId: string): number {
    const row = this.db.prepare("SELECT undone_untold FROM sessions WHERE id = ?").get(sessionId);
    this.db.prepare("UPDATE sessions SET undone_untold = 0 WHERE id = ?").run(sessionId);
    return Number(row?.undone_untold ?? 0);
  }

  endTurn(id: string) {
    this.db.prepare("UPDATE turns SET ended_at = COALESCE(ended_at, ?) WHERE id = ?").run(Date.now(), id);
  }

  // -- checkpoints -----------------------------------------------------------

  createCheckpoint(input: Omit<Checkpoint, "id" | "createdAt" | "resolvedAt"> & { runtimeCallId: string | null }): Checkpoint {
    const now = Date.now();
    const cp: Checkpoint = {
      id: newId("cp"),
      sessionId: input.sessionId,
      turnId: input.turnId,
      source: input.source,
      decision: input.decision,
      category: input.category,
      question: input.question,
      context: input.context,
      options: input.options,
      recommendation: input.recommendation,
      status: input.status,
      resolution: input.resolution,
      createdAt: now,
      resolvedAt: input.status === "pending" ? null : now,
    };
    this.db
      .prepare(
        `INSERT INTO checkpoints (id, session_id, turn_id, runtime_call_id, source, decision, category, question, context, options, recommendation, status, resolution, created_at, resolved_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        cp.id,
        cp.sessionId,
        cp.turnId,
        input.runtimeCallId,
        cp.source,
        cp.decision ? JSON.stringify(cp.decision) : null,
        cp.category,
        cp.question,
        cp.context,
        JSON.stringify(cp.options),
        cp.recommendation,
        cp.status,
        cp.resolution ? JSON.stringify(cp.resolution) : null,
        cp.createdAt,
        cp.resolvedAt,
      );
    return cp;
  }

  getCheckpoint(id: string): Checkpoint | null {
    const row = this.db.prepare("SELECT * FROM checkpoints WHERE id = ?").get(id);
    return row ? toCheckpoint(row) : null;
  }

  listCheckpoints(sessionId: string): Checkpoint[] {
    return this.db
      .prepare("SELECT * FROM checkpoints WHERE session_id = ? ORDER BY created_at, rowid")
      .all(sessionId)
      .map(toCheckpoint);
  }

  listCheckpointsForTurn(turnId: string): Checkpoint[] {
    return this.db.prepare("SELECT * FROM checkpoints WHERE turn_id = ? ORDER BY created_at, rowid").all(turnId).map(toCheckpoint);
  }

  listCheckpointsByStatus(status: CheckpointStatus): Checkpoint[] {
    return this.db.prepare("SELECT * FROM checkpoints WHERE status = ?").all(status).map(toCheckpoint);
  }

  updateCheckpoint(id: string, status: CheckpointStatus, resolution: CheckpointResolution | null): Checkpoint {
    this.db
      .prepare("UPDATE checkpoints SET status = ?, resolution = ?, resolved_at = ? WHERE id = ?")
      .run(status, resolution ? JSON.stringify(resolution) : null, status === "pending" ? null : Date.now(), id);
    const cp = this.getCheckpoint(id);
    if (!cp) throw new Error(`Unknown checkpoint ${id}`);
    return cp;
  }

  // -- collaboration events --------------------------------------------------

  logEvent(sessionId: string, type: string, payload: Record<string, unknown>) {
    this.db
      .prepare("INSERT INTO collaboration_events (session_id, type, payload, created_at) VALUES (?, ?, ?, ?)")
      .run(sessionId, type, JSON.stringify(payload), Date.now());
  }

  listEvents(sessionId: string): { type: string; payload: Record<string, unknown>; createdAt: number }[] {
    return this.db
      .prepare("SELECT type, payload, created_at FROM collaboration_events WHERE session_id = ? ORDER BY id")
      .all(sessionId)
      .map((r) => ({ type: String(r.type), payload: JSON.parse(String(r.payload)), createdAt: Number(r.created_at) }));
  }

  // -- preferences -----------------------------------------------------------

  getPreferences(): Preferences {
    const get = (key: string) => {
      const row = this.db.prepare("SELECT value FROM preferences WHERE key = ?").get(key);
      return row ? JSON.parse(String(row.value)) : undefined;
    };
    const lastSessionId = (get("lastSessionId") as string | null | undefined) ?? null;
    const runtime = get("defaultRuntime") as RuntimeKind | undefined;
    return {
      defaultMode: (get("defaultMode") as CollaborationModeId | undefined) ?? DEFAULT_MODE,
      // Resolved against runtime availability by PeerService.preferences().
      defaultRuntime: runtime && RUNTIME_KINDS.includes(runtime) ? runtime : DEFAULT_RUNTIME,
      runtimeChosen: runtime && RUNTIME_KINDS.includes(runtime) ? runtime : null,
      lastSessionId: lastSessionId && this.getSession(lastSessionId) ? lastSessionId : null,
    };
  }

  setPreferences(prefs: Partial<Preferences>): Preferences {
    const put = this.db.prepare("INSERT INTO preferences (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value");
    if (prefs.defaultMode) put.run("defaultMode", JSON.stringify(prefs.defaultMode));
    if (prefs.defaultRuntime) put.run("defaultRuntime", JSON.stringify(prefs.defaultRuntime));
    if (prefs.lastSessionId !== undefined) put.run("lastSessionId", JSON.stringify(prefs.lastSessionId));
    return this.getPreferences();
  }
}

function toWorkspace(r: Row): Workspace {
  return {
    id: String(r.id),
    path: String(r.path),
    name: String(r.name),
    sandboxNetwork: Number(r.sandbox_network ?? 0) === 1,
    createdAt: Number(r.created_at),
    lastOpenedAt: Number(r.last_opened_at),
  };
}

function toSession(r: Row): PeerSession {
  return {
    id: String(r.id),
    workspaceId: String(r.workspace_id),
    runtime: (r.runtime ?? DEFAULT_RUNTIME) as RuntimeKind,
    runtimeSessionId: String(r.runtime_session_id),
    title: String(r.title),
    mode: r.mode as CollaborationModeId,
    model: r.model_provider && r.model_id ? { providerId: String(r.model_provider), modelId: String(r.model_id) } : null,
    autoApprovals: Number(r.auto_approvals ?? 0) === 1,
    createdAt: Number(r.created_at),
    updatedAt: Number(r.updated_at),
  };
}

function toTurn(r: Row): Turn {
  return {
    id: String(r.id),
    sessionId: String(r.session_id),
    mode: r.mode as CollaborationModeId,
    intent: r.intent as TurnIntent,
    gate: r.gate as GateKind,
    continuedFrom: r.continued_from == null ? null : String(r.continued_from),
    engagedAt: r.engaged_at == null ? null : Number(r.engaged_at),
    startedAt: Number(r.started_at),
    endedAt: r.ended_at == null ? null : Number(r.ended_at),
    undoneAt: r.undone_at == null ? null : Number(r.undone_at),
  };
}

function toCheckpoint(r: Row): Checkpoint {
  return {
    id: String(r.id),
    sessionId: String(r.session_id),
    turnId: r.turn_id == null ? null : String(r.turn_id),
    source: r.source === "peer" ? "peer" : "agent",
    decision: r.decision == null ? null : JSON.parse(String(r.decision)),
    category: r.category as Checkpoint["category"],
    question: String(r.question),
    context: r.context == null ? null : String(r.context),
    options: JSON.parse(String(r.options)),
    recommendation: r.recommendation == null ? null : String(r.recommendation),
    status: r.status as CheckpointStatus,
    resolution: r.resolution == null ? null : JSON.parse(String(r.resolution)),
    createdAt: Number(r.created_at),
    resolvedAt: r.resolved_at == null ? null : Number(r.resolved_at),
  };
}
