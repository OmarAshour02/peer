import { create } from "zustand";
import type {
  Checkpoint,
  FileDiff,
  ModelsResponse,
  PeerEvent,
  PeerMessage,
  PeerPart,
  PeerSession,
  RuntimeInfo,
  RuntimeKind,
  SessionSnapshot,
  Workspace,
} from "../shared/types";
import type { PeerApi } from "./api";

interface PeerState {
  api: PeerApi | null;
  ready: boolean;
  connected: boolean;
  runtimes: RuntimeInfo[];
  /** Runtime for the next new session (remembered server-side). */
  newRuntime: RuntimeKind;
  workspaces: Workspace[];
  sessions: PeerSession[];
  activeWorkspaceId: string | null;
  activeSessionId: string | null;
  snapshot: SessionSnapshot | null;
  messages: PeerMessage[];
  diff: FileDiff[];
  /** Models of the runtime shown in the composer (the active session's, else `newRuntime`). */
  models: ModelsResponse | null;
  modelsFor: RuntimeKind | null;
  modelsError: string | null;
  error: string | null;

  init(api: PeerApi): Promise<void>;
  selectWorkspace(id: string | null): Promise<void>;
  selectSession(id: string | null): Promise<void>;
  setNewRuntime(kind: RuntimeKind): void;
  loadModels(kind: RuntimeKind): Promise<void>;
  resync(): Promise<void>;
  handleEvent(event: PeerEvent): void;
  setError(error: string | null): void;
}

function upsertPart(messages: PeerMessage[], messageId: string, part: PeerPart): PeerMessage[] {
  const idx = messages.findIndex((m) => m.id === messageId);
  if (idx === -1) {
    return [...messages, { id: messageId, role: "assistant", createdAt: Date.now(), parts: [part] }];
  }
  const msg = messages[idx]!;
  const pIdx = msg.parts.findIndex((p) => p.id === part.id);
  const parts = pIdx === -1 ? [...msg.parts, part] : msg.parts.map((p, i) => (i === pIdx ? part : p));
  return messages.map((m, i) => (i === idx ? { ...msg, parts } : m));
}

const RUNTIME_ORDER: RuntimeKind[] = ["opencode", "claude", "codex"];
const byKind = (a: RuntimeInfo, b: RuntimeInfo) => RUNTIME_ORDER.indexOf(a.kind) - RUNTIME_ORDER.indexOf(b.kind);

function upsertCheckpoint(list: Checkpoint[], cp: Checkpoint): Checkpoint[] {
  const idx = list.findIndex((c) => c.id === cp.id);
  return idx === -1 ? [...list, cp] : list.map((c, i) => (i === idx ? cp : c));
}

/** The runtime the main view is about: the open session's, or the one new sessions will use. */
export function activeRuntime(s: Pick<PeerState, "snapshot" | "newRuntime">): RuntimeKind {
  return s.snapshot?.session.runtime ?? s.newRuntime;
}

export function runtimeInfo(s: Pick<PeerState, "runtimes">, kind: RuntimeKind): RuntimeInfo {
  return s.runtimes.find((r) => r.kind === kind) ?? { kind, name: kind, status: { state: "starting" } };
}

export const usePeer = create<PeerState>((set, get) => ({
  api: null,
  ready: false,
  connected: false,
  runtimes: [],
  newRuntime: "opencode",
  workspaces: [],
  sessions: [],
  activeWorkspaceId: null,
  activeSessionId: null,
  snapshot: null,
  messages: [],
  diff: [],
  models: null,
  modelsFor: null,
  modelsError: null,
  error: null,

  async init(api) {
    set({ api });
    const [workspaces, health, prefs] = await Promise.all([api.workspaces(), api.health(), api.preferences()]);
    set({ workspaces, runtimes: health.runtimes, newRuntime: prefs.defaultRuntime, ready: true });
    // Reopen where the developer left off (workspaces are ordered by last use).
    const last = prefs.lastSessionId ? await api.snapshot(prefs.lastSessionId).catch(() => null) : null;
    const ws = workspaces.find((w) => w.id === last?.session.workspaceId) ?? workspaces[0];
    if (ws) await get().selectWorkspace(ws.id);
    if (last && get().sessions.some((s) => s.id === last.session.id)) await get().selectSession(last.session.id);
  },

  async selectWorkspace(id) {
    const { api } = get();
    if (!api) return;
    set({ activeWorkspaceId: id, sessions: [], models: null, modelsFor: null, modelsError: null });
    if (!id) return get().selectSession(null);
    const sessions = await api.sessions(id);
    set({ sessions });
    if (!sessions.some((s) => s.id === get().activeSessionId)) await get().selectSession(null);
    void get().loadModels(activeRuntime(get()));
  },

  async loadModels(kind) {
    const { api, activeWorkspaceId: ws } = get();
    if (!api || !ws) return;
    set({ models: null, modelsFor: kind, modelsError: null });
    if (runtimeInfo(get(), kind).status.state !== "ready") return;
    try {
      const models = await api.models(ws, kind);
      if (get().modelsFor !== kind || get().activeWorkspaceId !== ws) return;
      set({ models, modelsError: models.providers.length === 0 ? "No model providers are configured." : null });
    } catch (err) {
      if (get().modelsFor === kind) set({ modelsError: err instanceof Error ? err.message : String(err) });
    }
  },

  setNewRuntime(kind) {
    set({ newRuntime: kind });
    get().api?.setPreferences({ defaultRuntime: kind }).catch(() => {});
    if (!get().snapshot) void get().loadModels(kind);
  },

  async selectSession(id) {
    if (id) get().api?.setPreferences({ lastSessionId: id }).catch(() => {});
    set({ activeSessionId: id, snapshot: null, messages: [], diff: [] });
    if (id) await get().resync();
  },

  /** Reload the active session from the server (after selection or an event-stream reconnect). */
  async resync() {
    const { api, activeSessionId: id } = get();
    if (!api || !id) return;
    try {
      const [snapshot, messages] = await Promise.all([api.snapshot(id), api.messages(id)]);
      if (get().activeSessionId !== id) return;
      set({ snapshot, messages });
      if (get().modelsFor !== snapshot.session.runtime) void get().loadModels(snapshot.session.runtime);
      api.diff(id).then((diff) => get().activeSessionId === id && set({ diff })).catch(() => {});
    } catch (err) {
      set({ error: err instanceof Error ? err.message : String(err) });
    }
  },

  setError(error) {
    set({ error });
  },

  handleEvent(event) {
    const s = get();
    switch (event.type) {
      case "runtime.status": {
        const others = s.runtimes.filter((r) => r.kind !== event.runtime);
        const name = s.runtimes.find((r) => r.kind === event.runtime)?.name ?? event.runtime;
        set({ runtimes: [...others, { kind: event.runtime, name, status: event.status }].sort(byKind) });
        // A runtime that just became ready may now list its models.
        if (event.status.state === "ready" && s.modelsFor === event.runtime && !s.models) void get().loadModels(event.runtime);
        return;
      }
      case "session.updated": {
        const session = event.session;
        if (session.workspaceId === s.activeWorkspaceId) {
          const exists = s.sessions.some((x) => x.id === session.id);
          const sessions = exists ? s.sessions.map((x) => (x.id === session.id ? session : x)) : [session, ...s.sessions];
          set({ sessions: sessions.sort((a, b) => b.updatedAt - a.updatedAt) });
        }
        if (s.snapshot?.session.id === session.id) set({ snapshot: { ...s.snapshot, session } });
        return;
      }
    }

    // Session-scoped events only matter for the session on screen.
    const sessionId = "sessionId" in event ? event.sessionId : event.type === "checkpoint.updated" ? event.checkpoint.sessionId : event.type === "permission.asked" ? event.request.sessionId : null;
    if (!sessionId || sessionId !== s.activeSessionId || !s.snapshot) return;
    const snap = s.snapshot;

    switch (event.type) {
      case "session.status":
        set({ snapshot: { ...snap, status: event.status, lastError: event.status === "busy" ? null : snap.lastError } });
        if (event.status === "idle" && s.api) {
          s.api.diff(sessionId).then((diff) => get().activeSessionId === sessionId && set({ diff })).catch(() => {});
        }
        return;
      case "session.error":
        set({ snapshot: { ...snap, lastError: event.error } });
        return;
      case "session.diff":
        if (event.diff.length > 0) set({ diff: event.diff });
        return;
      case "gate.updated":
        set({ snapshot: { ...snap, gate: event.gate } });
        return;
      case "checkpoint.updated":
        set({ snapshot: { ...snap, checkpoints: upsertCheckpoint(snap.checkpoints, event.checkpoint) } });
        return;
      case "permission.asked":
        set({ snapshot: { ...snap, permissions: [...snap.permissions.filter((p) => p.id !== event.request.id), event.request] } });
        return;
      case "permission.replied":
        set({ snapshot: { ...snap, permissions: snap.permissions.filter((p) => p.id !== event.requestId) } });
        return;
      case "message.updated": {
        const idx = s.messages.findIndex((m) => m.id === event.message.id);
        const messages =
          idx === -1
            ? [...s.messages, { ...event.message, parts: [] }]
            : s.messages.map((m, i) => (i === idx ? { ...m, ...event.message, parts: m.parts } : m));
        set({ messages: messages.sort((a, b) => a.createdAt - b.createdAt) });
        return;
      }
      case "part.updated":
        set({ messages: upsertPart(s.messages, event.messageId, event.part) });
        return;
      case "part.delta": {
        const msg = s.messages.find((m) => m.id === event.messageId);
        const part = msg?.parts.find((p) => p.id === event.partId);
        if (!part || (part.type !== "text" && part.type !== "reasoning") || event.field !== "text") return;
        set({ messages: upsertPart(s.messages, event.messageId, { ...part, text: part.text + event.delta }) });
        return;
      }
    }
  },
}));
