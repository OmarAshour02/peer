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
  SessionActivity,
  SessionSnapshot,
  Workspace,
} from "../shared/types";
import { pickDefaultRuntime } from "../shared/types";
import type { PeerApi } from "./api";
import { queuedAsDraft } from "./queue";
import { applyTheme, clearPendingTheme, currentTheme, pendingTheme, syncPendingTheme } from "./theme";

interface PeerState {
  api: PeerApi | null;
  ready: boolean;
  connected: boolean;
  runtimes: RuntimeInfo[];
  /** Runtime for the next new session (remembered server-side). */
  newRuntime: RuntimeKind;
  /** The developer's own pick; while null, `newRuntime` follows the best runtime that is ready. */
  runtimeChosen: RuntimeKind | null;
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
  /** Something to tell the developer that is not an error (e.g. what an undo did). */
  notice: string | null;
  /** The "Models & providers" dialog. */
  providersOpen: boolean;
  /** Bumped when a runtime's providers change, so an open dialog reloads them. */
  providersVersion: number;
  /** The "Runtime settings" dialog (CLI paths, permission mode, effort). */
  settingsOpen: boolean;
  /** The learning map fills the main view; opening a session closes it. */
  learningMapOpen: boolean;
  /**
   * Bumped when topics are recorded, a question is resolved, or settings clear the map or switch
   * tagging: an open map reloads.
   */
  learningMapVersion: number;
  /**
   * Queued messages that left the queue unsent (Stop, or they failed to send), by session, for
   * that session's composer to take back when it is on screen. Several returns to one session
   * are kept together; nothing returned is dropped while another session is open.
   */
  returnedDrafts: Record<string, string>;
  /** Ask the composer to take focus (⌘L). Bumped, never reset. */
  composerFocus: number;
  /**
   * Each session's unsent composer text, kept here rather than in the composer so it survives
   * switching sessions and opening the learning map, and so leaving a session can tell it was used.
   */
  drafts: Record<string, string>;
  /** Sessions with a send or queue request on its way. */
  sendingIn: Record<string, boolean>;
  /** Bumped when Runtime settings are saved, so what depends on them (the default effort) reloads. */
  settingsVersion: number;
  /** Sessions that need the developer or are running, across every workspace, by session id. */
  activity: Record<string, SessionActivity>;

  init(api: PeerApi): Promise<void>;
  selectWorkspace(id: string | null): Promise<void>;
  selectSession(id: string | null): Promise<void>;
  setNewRuntime(kind: RuntimeKind): void;
  loadModels(kind: RuntimeKind): Promise<void>;
  resync(): Promise<void>;
  /** The event stream came back: reload everything an event may have changed meanwhile. */
  reconnected(): Promise<void>;
  handleEvent(event: PeerEvent): void;
  setError(error: string | null): void;
  setNotice(notice: string | null): void;
  setProvidersOpen(open: boolean): void;
  setSettingsOpen(open: boolean): void;
  setLearningMapOpen(open: boolean): void;
  focusComposer(): void;
  /** Reload which sessions are waiting, working or interrupted. */
  loadActivity(): Promise<void>;
  /** A new session in the given workspace (default: the active one, else Chats), opened at once. */
  newSession(workspaceId?: string): Promise<void>;
}

/**
 * Parts that first appeared through a live event while this window was open. Only these reveal
 * from their first character; text loaded with a session (history, a turn still waiting on a
 * checkpoint) shows at once, and only what arrives after that animates in.
 */
const freshParts = new Set<string>();
export const isFreshPart = (partId: string) => freshParts.has(partId);

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

/** Whether the developer has started something in a session's composer (text, or a send on its way). */
export function sessionHasDraft(s: Pick<PeerState, "drafts" | "sendingIn">, sessionId: string): boolean {
  return (s.drafts[sessionId] ?? "").trim() !== "" || Boolean(s.sendingIn[sessionId]);
}

/** Change one session's draft (a value, or a function of the current one). */
export function updateDraft(sessionId: string, next: string | ((current: string) => string)) {
  usePeer.setState((s) => {
    const current = s.drafts[sessionId] ?? "";
    const value = typeof next === "function" ? next(current) : next;
    if (value === current) return {};
    const drafts = { ...s.drafts };
    if (value) drafts[sessionId] = value;
    else delete drafts[sessionId];
    return { drafts };
  });
}

let activityTimer: ReturnType<typeof setTimeout> | null = null;
let activityRequest = 0;
/** Events come in bursts (a turn ending emits several); one reload per burst. */
function scheduleActivityReload(reload: () => void) {
  if (activityTimer) clearTimeout(activityTimer);
  activityTimer = setTimeout(() => {
    activityTimer = null;
    reload();
  }, 150);
}

const RUNTIME_ORDER: RuntimeKind[] = ["opencode", "claude", "codex", "gemini"];
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
  runtimeChosen: null,
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
  notice: null,
  providersOpen: false,
  providersVersion: 0,
  settingsOpen: false,
  learningMapOpen: false,
  learningMapVersion: 0,
  returnedDrafts: {},
  activity: {},
  settingsVersion: 0,
  drafts: {},
  sendingIn: {},
  composerFocus: 0,

  async init(api) {
    set({ api });
    const themeAtStart = currentTheme();
    const pendingAtStart = pendingTheme();
    const [workspaces, health, prefs] = await Promise.all([api.workspaces(), api.health(), api.preferences()]);
    // A theme chosen while offline wins over the stored one and is written back now.
    const pending = pendingTheme();
    if (pending && pending !== prefs.theme) {
      applyTheme(pending);
      void syncPendingTheme(async (theme) => { await api.setPreferences({ theme }); });
    } else {
      if (pending) clearPendingTheme();
      // The captured preferences are stale if the theme moved while init was in flight:
      // a toggle, or a reconnect that synced the queued choice and cleared its marker.
      // In that case the displayed theme (already saved server-side) wins.
      const movedInFlight = currentTheme() !== themeAtStart || (pendingAtStart !== null && pending === null);
      applyTheme(movedInFlight ? currentTheme() : prefs.theme);
    }
    set({ workspaces, runtimes: health.runtimes, newRuntime: prefs.defaultRuntime, runtimeChosen: prefs.runtimeChosen, ready: true });
    void get().loadActivity();
    // Reopen where the developer left off (workspaces are ordered by last use).
    const last = prefs.lastSessionId ? await api.snapshot(prefs.lastSessionId).catch(() => null) : null;
    const ws = workspaces.find((w) => w.id === last?.session.workspaceId) ?? workspaces.find((w) => !w.general) ?? workspaces[0];
    if (ws) await get().selectWorkspace(ws.id);
    if (last && get().sessions.some((s) => s.id === last.session.id)) await get().selectSession(last.session.id);
  },

  async selectWorkspace(id) {
    const { api } = get();
    if (!api) return;
    set({ activeWorkspaceId: id, sessions: [], models: null, modelsFor: null, modelsError: null, learningMapOpen: false });
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
    set({ newRuntime: kind, runtimeChosen: kind });
    get().api?.setPreferences({ defaultRuntime: kind }).catch(() => {});
    if (!get().snapshot) void get().loadModels(kind);
  },

  async selectSession(id) {
    // Leaving a session that was never used (nothing sent, nothing typed) discards it, so new
    // sessions opened and abandoned don't pile up. The server makes the final call.
    // It may still be loading (no snapshot yet): then the server's check alone decides.
    const left = get();
    const leaving = left.activeSessionId;
    const looksUnused = left.snapshot?.session.id === leaving ? left.messages.length === 0 && left.snapshot.turn === null : true;
    if (left.api && leaving && leaving !== id && looksUnused && !sessionHasDraft(left, leaving)) {
      const gone = leaving;
      void left.api
        .discardIfUnused(gone)
        .then(({ deleted }) => deleted && usePeer.setState((s) => ({ sessions: s.sessions.filter((x) => x.id !== gone) })))
        .catch(() => {});
    }
    if (id) get().api?.setPreferences({ lastSessionId: id }).catch(() => {});
    // Freshness belongs to one viewing of a session: coming back to it (even mid-turn) shows the
    // text it already has at once.
    freshParts.clear();
    set({ activeSessionId: id, snapshot: null, messages: [], diff: [], notice: null, learningMapOpen: false });
    // The composer (or an open question's card) takes focus as it mounts with the session.
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

  async reconnected() {
    const { api } = get();
    if (!api) return;
    // Write back a theme chosen while disconnected.
    if (pendingTheme()) void syncPendingTheme(async (theme) => { await api.setPreferences({ theme }); });
    // Providers may have changed while events were missed: refresh an open dialog and the model list.
    set((s) => ({ providersVersion: s.providersVersion + 1 }));
    // Topic updates sent while disconnected are not replayed: an open learning map reloads.
    set((s) => ({ learningMapVersion: s.learningMapVersion + 1 }));
    await api
      .health()
      .then((h) => set({ runtimes: h.runtimes, newRuntime: pickDefaultRuntime(get().runtimeChosen, h.runtimes) }))
      .catch(() => {});
    const kind = get().modelsFor ?? activeRuntime(get());
    await Promise.all([get().loadModels(kind), get().resync(), get().loadActivity()]);
  },

  setError(error) {
    set({ error });
  },

  setNotice(notice) {
    set({ notice });
  },

  setProvidersOpen(open) {
    set({ providersOpen: open });
  },

  setSettingsOpen(open) {
    set({ settingsOpen: open });
  },

  setLearningMapOpen(open) {
    set({ learningMapOpen: open });
  },

  focusComposer() {
    set((s) => ({ composerFocus: s.composerFocus + 1 }));
  },

  async loadActivity() {
    const { api } = get();
    if (!api) return;
    // Requests can overlap (an event burst during a slow reload): only the latest one's answer counts.
    const request = ++activityRequest;
    try {
      const list = await api.activity();
      if (request !== activityRequest) return;
      set({ activity: Object.fromEntries(list.map((a) => [a.sessionId, a])) });
    } catch {
      // Kept as it was; the next event reloads it.
    }
  },

  async newSession(workspaceId) {
    const { api, workspaces, activeWorkspaceId, newRuntime } = get();
    const ws = workspaces.find((w) => w.id === (workspaceId ?? activeWorkspaceId)) ?? workspaces.find((w) => w.general);
    if (!api || !ws) return;
    try {
      if (ws.id !== get().activeWorkspaceId) await get().selectWorkspace(ws.id);
      const session = await api.createSession(ws.id, { runtime: newRuntime });
      await get().selectSession(session.id);
    } catch (err) {
      set({ error: err instanceof Error ? err.message : String(err) });
    }
  },

  handleEvent(event) {
    const s = get();
    // Any session's run starting or ending, or a question or permission opening or closing, can
    // change what the sidebar shows for it: reload once the burst settles.
    if (event.type === "session.status" || event.type === "checkpoint.updated" || event.type === "permission.asked" || event.type === "permission.replied") {
      scheduleActivityReload(() => void get().loadActivity());
    }
    // The open learning map reloads when topics are recorded, or a tagged question is answered.
    if (event.type === "learningMap.updated" || (event.type === "checkpoint.updated" && event.checkpoint.status !== "pending")) {
      set({ learningMapVersion: s.learningMapVersion + 1 });
    }
    if (event.type === "learningMap.updated") return;
    // A queued message that comes back goes to its session's composer even if another session is on
    // screen; the error is shown wherever the developer is.
    if (event.type === "session.queued" && event.returned) {
      const text = queuedAsDraft(event.returned);
      if (text) {
        const earlier = get().returnedDrafts[event.sessionId];
        set({ returnedDrafts: { ...get().returnedDrafts, [event.sessionId]: earlier ? `${earlier}\n\n${text}` : text } });
      }
      if (event.error) set({ error: `Your queued message wasn't sent: ${event.error.trim().replace(/[.!]?$/, ".")} It is back in the message box.` });
    }
    switch (event.type) {
      case "runtime.status": {
        const others = s.runtimes.filter((r) => r.kind !== event.runtime);
        const name = s.runtimes.find((r) => r.kind === event.runtime)?.name ?? event.runtime;
        const runtimes = [...others, { kind: event.runtime, name, status: event.status }].sort(byKind);
        set({ runtimes });
        // New sessions follow the best runtime that is ready, unless the developer picked one that still works.
        const next = pickDefaultRuntime(s.runtimeChosen, runtimes);
        if (next !== s.newRuntime) {
          set({ newRuntime: next });
          if (!s.snapshot) void get().loadModels(next);
        }
        // A runtime that just became ready may now list its models; after a restart they can differ
        // (OpenCode re-reads credentials on start).
        const wasReady = s.runtimes.find((r) => r.kind === event.runtime)?.status.state === "ready";
        if (event.status.state === "ready" && s.modelsFor === event.runtime && (!s.models || !wasReady)) void get().loadModels(event.runtime);
        if (event.status.state === "ready" && !wasReady) set({ providersVersion: get().providersVersion + 1 });
        return;
      }
      case "providers.updated":
        set({ providersVersion: s.providersVersion + 1 });
        // The model list changes once the runtime has reloaded its providers.
        if (!event.reloadPending && s.modelsFor === event.runtime) void get().loadModels(event.runtime);
        return;
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
      case "session.status": {
        const busy = event.status !== "idle";
        set({
          snapshot: {
            ...snap,
            status: event.status,
            lastError: event.status === "busy" ? null : snap.lastError,
            undo: busy ? { available: false, reason: "Wait for the agent to finish this turn." } : snap.undo,
          },
        });
        if (!busy && s.api) {
          s.api.diff(sessionId).then((diff) => get().activeSessionId === sessionId && set({ diff })).catch(() => {});
          // Whether the turn that just ended can be undone.
          s.api
            .snapshot(sessionId)
            .then((fresh) => {
              const current = get().snapshot;
              if (current?.session.id === sessionId) set({ snapshot: { ...current, undo: fresh.undo } });
            })
            .catch(() => {});
        }
        return;
      }
      case "session.undone": {
        const { files, forgotten } = event.result;
        const what = files.length === 0 ? "No files had changed." : `Restored ${files.length} file${files.length === 1 ? "" : "s"}: ${files.slice(0, 3).join(", ")}${files.length > 3 ? ", …" : ""}.`;
        set({ notice: `Undid the last turn. ${what}${forgotten ? "" : " The agent will be told on its next turn."}`, diff: [] });
        void get().resync();
        return;
      }
      case "session.error":
        set({ snapshot: { ...snap, lastError: event.error } });
        return;
      case "session.diff":
        if (event.diff.length > 0) set({ diff: event.diff });
        return;
      case "session.queued":
        set({ snapshot: { ...snap, queued: event.queued } });
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
        if (!s.messages.some((m) => m.id === event.messageId && m.parts.some((p) => p.id === event.part.id))) freshParts.add(event.part.id);
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
