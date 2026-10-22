import type {
  CollaborationModeId,
  ModelRef,
  PeerSession,
  PermissionReply,
  PermissionRequest,
  RuntimeKind,
  SessionSnapshot,
} from "../shared/types.js";
import { CollaborationEngine, EngineError } from "./collaboration/engine.js";
import type { EventHub } from "./hub.js";
import type { AgentRuntimeAdapter, RuntimeEvent } from "./runtime/adapter.js";
import type { RuntimeSet } from "./runtime/set.js";
import type { Store } from "./store.js";
import { validateWorkspacePath } from "./workspaces.js";

const DEFAULT_TITLE = "New session";

/**
 * Application service: owns the mapping between Peer sessions and runtime sessions, forwards
 * runtime activity to the UI, and exposes the operations the HTTP API needs.
 */
export class PeerService {
  readonly engine: CollaborationEngine;
  /** Pending permission requests by id, mapped to the Peer session they belong to. */
  private readonly permissions = new Map<string, PermissionRequest>();
  private readonly lastErrors = new Map<string, string>();

  constructor(
    readonly store: Store,
    readonly runtimes: RuntimeSet,
    private readonly hub: EventHub,
  ) {
    this.engine = new CollaborationEngine(store, runtimes, (e) => hub.emit(e));
    this.engine.recover();
    runtimes.onEvent((e, kind) => void this.onRuntimeEvent(e, kind));
  }

  /** The runtime a session runs on (sessions never change runtime). */
  runtimeOf(session: PeerSession): AgentRuntimeAdapter {
    return this.runtimes.get(session.runtime);
  }

  /** A runtime that exists and is usable; otherwise a 400/409 the UI can show as-is. */
  requireRuntime(kind: unknown): AgentRuntimeAdapter {
    if (typeof kind !== "string" || !this.runtimes.has(kind)) throw new EngineError(`Unknown runtime ${String(kind)}`);
    const runtime = this.runtimes.get(kind);
    const status = runtime.status();
    if (status.state === "unavailable") throw new EngineError(status.error ?? `${runtime.name} is not available`, 409);
    return runtime;
  }

  // -- workspaces & sessions ---------------------------------------------------

  addWorkspace(path: unknown) {
    const valid = validateWorkspacePath(path);
    return this.store.upsertWorkspace(valid.path, valid.name);
  }

  async createSession(
    workspaceId: string,
    input: { mode?: CollaborationModeId; model?: ModelRef | null; runtime?: RuntimeKind },
  ): Promise<PeerSession> {
    const ws = this.store.getWorkspace(workspaceId);
    if (!ws) throw new EngineError("Unknown workspace", 404);
    const prefs = this.store.getPreferences();
    const runtime = this.requireRuntime(input.runtime ?? prefs.defaultRuntime);
    const runtimeSession = await runtime.createSession(ws.path, {});
    const mode = input.mode ?? prefs.defaultMode;
    if (input.runtime && input.runtime !== prefs.defaultRuntime) this.store.setPreferences({ defaultRuntime: input.runtime });
    const session = this.store.createSession({
      workspaceId,
      runtime: runtime.kind,
      runtimeSessionId: runtimeSession.id,
      title: DEFAULT_TITLE,
      mode,
      model: input.model ?? null,
    });
    this.store.logEvent(session.id, "session.created", { mode, runtime: runtime.kind });
    this.store.touchWorkspace(workspaceId);
    this.hub.emit({ type: "session.updated", session });
    return session;
  }

  updateSession(sessionId: string, patch: { mode?: CollaborationModeId; model?: ModelRef | null; title?: string }): PeerSession {
    let session = this.requireSession(sessionId);
    if (patch.mode) session = this.engine.setMode(sessionId, patch.mode);
    if (patch.model !== undefined || patch.title !== undefined) {
      session = this.store.updateSession(sessionId, { model: patch.model, title: patch.title });
      this.hub.emit({ type: "session.updated", session });
    }
    return session;
  }

  /** Stop any run before forgetting the session, so nothing keeps working unsupervised. */
  async deleteSession(sessionId: string) {
    this.requireSession(sessionId);
    if (this.engine.statusOf(sessionId) !== "idle") await this.abort(sessionId);
    this.store.deleteSession(sessionId);
  }

  snapshot(sessionId: string): SessionSnapshot {
    const session = this.requireSession(sessionId);
    return {
      session,
      status: this.engine.statusOf(sessionId),
      gate: this.engine.gateFor(sessionId),
      turn: this.store.latestTurn(sessionId),
      checkpoints: this.store.listCheckpoints(sessionId),
      permissions: [...this.permissions.values()].filter((p) => p.sessionId === sessionId),
      lastError: this.lastErrors.get(sessionId) ?? null,
    };
  }

  async messages(sessionId: string) {
    const session = this.requireSession(sessionId);
    return this.runtimeOf(session).getMessages(this.engine.directoryOf(session), session.runtimeSessionId);
  }

  async diff(sessionId: string) {
    const session = this.requireSession(sessionId);
    return this.runtimeOf(session).getDiff(this.engine.directoryOf(session), session.runtimeSessionId);
  }

  async send(sessionId: string, text: string, intent?: Parameters<CollaborationEngine["sendMessage"]>[2]) {
    this.lastErrors.delete(sessionId);
    return this.engine.sendMessage(sessionId, text, intent);
  }

  async abort(sessionId: string) {
    await this.engine.abort(sessionId);
    this.dropPermissions(sessionId);
  }

  /** The runtime discards pending permission requests when a run stops, without telling us. */
  private dropPermissions(sessionId: string) {
    for (const [id, p] of this.permissions) {
      if (p.sessionId !== sessionId) continue;
      this.permissions.delete(id);
      this.hub.emit({ type: "permission.replied", sessionId, requestId: id });
    }
  }

  async replyPermission(requestId: string, reply: PermissionReply) {
    const request = this.permissions.get(requestId);
    if (!request) throw new EngineError("Unknown or expired permission request", 404);
    const session = this.requireSession(request.sessionId);
    await this.runtimeOf(session).replyPermission(this.engine.directoryOf(session), requestId, reply);
    this.permissions.delete(requestId);
    this.store.logEvent(session.id, "permission.replied", { permission: request.permission, patterns: request.patterns, reply });
    this.hub.emit({ type: "permission.replied", sessionId: session.id, requestId });
  }

  private requireSession(id: string): PeerSession {
    const session = this.store.getSession(id);
    if (!session) throw new EngineError("Unknown session", 404);
    return session;
  }

  // -- runtime events ----------------------------------------------------------

  private async onRuntimeEvent(event: RuntimeEvent, kind: RuntimeKind) {
    this.engine.handleRuntimeEvent(event);
    switch (event.type) {
      case "runtime.status":
        this.hub.emit({ type: "runtime.status", runtime: kind, status: event.status });
        return;
      case "runtime.restarted":
        this.engine.handleRuntimeRestart(kind);
        for (const [id, p] of this.permissions) {
          if (this.store.getSession(p.sessionId)?.runtime !== kind) continue;
          this.permissions.delete(id);
          this.hub.emit({ type: "permission.replied", sessionId: p.sessionId, requestId: id });
        }
        return;
      case "permission.asked": {
        const session = await this.engine.sessionForRuntime(event.request.sessionId);
        if (!session) return;
        const request = { ...event.request, sessionId: session.id };
        this.permissions.set(request.id, request);
        this.store.logEvent(session.id, "permission.asked", { permission: request.permission, patterns: request.patterns });
        this.hub.emit({ type: "permission.asked", request });
        return;
      }
      case "permission.replied": {
        const request = this.permissions.get(event.requestId);
        if (!request) return;
        this.permissions.delete(event.requestId);
        this.hub.emit({ type: "permission.replied", sessionId: request.sessionId, requestId: event.requestId });
        return;
      }
    }

    // Everything below is scoped to one root Peer session; subagent sessions are not shown directly.
    const session = this.store.getSessionByRuntimeId(event.sessionId);
    if (!session) return;
    switch (event.type) {
      case "session.updated":
        // OpenCode titles new sessions "New session - <date>" until it generates a real title.
        if (event.title && event.title !== session.title && !event.title.startsWith(DEFAULT_TITLE)) {
          this.hub.emit({ type: "session.updated", session: this.store.updateSession(session.id, { title: event.title }) });
        }
        return;
      case "session.status":
        this.hub.emit({ type: "session.status", sessionId: session.id, status: event.status, message: event.message });
        return;
      case "session.idle":
        this.dropPermissions(session.id);
        this.hub.emit({ type: "session.status", sessionId: session.id, status: "idle" });
        return;
      case "session.error":
        this.lastErrors.set(session.id, event.error);
        this.store.logEvent(session.id, "runtime.error", { error: event.error });
        this.hub.emit({ type: "session.error", sessionId: session.id, error: event.error });
        return;
      case "session.diff":
        this.hub.emit({ type: "session.diff", sessionId: session.id, diff: event.diff });
        return;
      case "message.updated":
        this.hub.emit({ type: "message.updated", sessionId: session.id, message: event.message });
        return;
      case "part.updated":
        this.hub.emit({ type: "part.updated", sessionId: session.id, messageId: event.messageId, part: event.part });
        return;
      case "part.delta":
        this.hub.emit({ type: "part.delta", sessionId: session.id, messageId: event.messageId, partId: event.partId, field: event.field, delta: event.delta });
        return;
    }
  }
}
