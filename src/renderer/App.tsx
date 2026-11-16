import { useEffect, useState } from "react";
import { NOTHING_TO_UNDO } from "../shared/types";
import { PeerApi, resolveConfig } from "./api";
import { ChangesPanel } from "./components/ChangesPanel";
import { Constellation } from "./components/Constellation";
import { Composer } from "./components/Composer";
import { ProvidersDialog } from "./components/ProvidersDialog";
import { RuntimeSettingsDialog } from "./components/RuntimeSettingsDialog";
import { SearchDialog } from "./components/SearchDialog";
import { SearchButton, Sidebar, SidebarToggle } from "./components/Sidebar";
import { ThreadBackdrop, Transcript } from "./components/Transcript";
import { MODE_UI } from "./modes";
import { RUNTIME_UI } from "./runtimes";
import { activeRuntime, runtimeInfo, usePeer } from "./store";


const SIDEBAR_KEY = "peer-sidebar";
export function App() {
  const { ready, error, notice, activeWorkspaceId, activeSessionId, snapshot, modelsError, workspaces, api } = usePeer();
  const kind = usePeer(activeRuntime);
  const runtimes = usePeer((s) => s.runtimes);
  const providersOpen = usePeer((s) => s.providersOpen);
  const settingsOpen = usePeer((s) => s.settingsOpen);
  const runtime = runtimeInfo({ runtimes }, kind).status;
  const [fatal, setFatal] = useState<string | null>(null);
  // Closed until the developer opens it from the header: the panel never opens on its own.
  const [showChanges, setShowChanges] = useState(false);
  // Each session starts with the panel closed, even if it was open in the previous one.
  useEffect(() => setShowChanges(false), [activeSessionId]);
  const [searchOpen, setSearchOpen] = useState(false);
  // ⌘K / Ctrl+K opens search from anywhere (and closes it again).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && !e.altKey && !e.shiftKey && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setSearchOpen((open) => !open);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);
  // The sidebar stays as the developer last left it (a per-window convenience; open if unknown).
  const [sidebarOpen, setSidebarOpenState] = useState(() => {
    try {
      return window.localStorage.getItem(SIDEBAR_KEY) !== "closed";
    } catch {
      return true;
    }
  });
  const setSidebarOpen = (open: boolean) => {
    setSidebarOpenState(open);
    try {
      window.localStorage.setItem(SIDEBAR_KEY, open ? "open" : "closed");
    } catch {
      // Remembered for this run only.
    }
  };

  useEffect(() => {
    let unsubscribe: (() => void) | undefined;
    (async () => {
      const config = await resolveConfig();
      if (!config) {
        setFatal("Open Peer from the link printed by `npm run server` (it contains the access token), or use the desktop app.");
        return;
      }
      const api = new PeerApi(config);
      const { handleEvent } = usePeer.getState();
      let wasDisconnected = false;
      unsubscribe = api.events(
        handleEvent,
        () => {
          usePeer.setState({ connected: true });
          // After a reconnect, state on the server may have moved on: reload what's on screen.
          if (wasDisconnected) void usePeer.getState().reconnected();
          wasDisconnected = false;
        },
        () => {
          wasDisconnected = true;
          usePeer.setState({ connected: false });
        },
      );
      try {
        await usePeer.getState().init(api);
      } catch (err) {
        setFatal(err instanceof Error ? err.message : String(err));
      }
    })();
    return () => unsubscribe?.();
  }, []);

  if (fatal) {
    return <div className="flex h-full items-center justify-center p-8 text-center text-[13px] text-muted">{fatal}</div>;
  }
  if (!ready) return <div className="flex h-full items-center justify-center text-[13px] text-faint">Starting Peer…</div>;

  const workspace = workspaces.find((w) => w.id === activeWorkspaceId);

  return (
    <div className="flex h-full" data-peer-ready="true">
      {providersOpen && <ProvidersDialog />}
      {settingsOpen && <RuntimeSettingsDialog />}
      {searchOpen && <SearchDialog onClose={() => setSearchOpen(false)} />}
      {sidebarOpen && <Sidebar onClose={() => setSidebarOpen(false)} onSearch={() => setSearchOpen(true)} />}
      <main className="relative flex min-w-0 flex-1 flex-col">
        {!sidebarOpen && (
          <div className="absolute left-3 top-3 z-20 flex items-center gap-0.5">
            <SidebarToggle open={false} onToggle={() => setSidebarOpen(true)} />
            <SearchButton onSearch={() => setSearchOpen(true)} />
          </div>
        )}
        {runtime.state !== "ready" && (
          <div className="flex items-center gap-3 border-b border-line bg-warn/10 px-4 py-2 text-[12px] text-warn">
            <span className="min-w-0 flex-1 truncate">
              {runtime.state === "starting"
                ? `Starting ${RUNTIME_UI[kind].label}…`
                : `${RUNTIME_UI[kind].label} is unavailable: ${runtime.error ?? runtime.state}`}
            </span>
            {runtime.state !== "starting" && (
              <button onClick={() => api && void api.restartRuntime(kind).catch(() => {})} className="rounded border border-warn/60 px-2 py-0.5">
                Restart runtime
              </button>
            )}
          </div>
        )}
        {runtime.state === "ready" && modelsError && activeWorkspaceId && (
          <div className="flex items-center gap-3 border-b border-line bg-warn/10 px-4 py-2 text-[12px] text-warn">
            <span className="min-w-0 flex-1">
              {modelsError} {RUNTIME_UI[kind].setup}
            </span>
            {kind === "opencode" && (
              <button onClick={() => usePeer.getState().setProvidersOpen(true)} className="rounded border border-warn/60 px-2 py-0.5">
                Connect a provider
              </button>
            )}
          </div>
        )}
        {error && (
          <div className="flex items-center gap-3 border-b border-line bg-danger/10 px-4 py-2 text-[12px] text-danger">
            <span className="min-w-0 flex-1">{error}</span>
            <button onClick={() => usePeer.getState().setError(null)} className="text-muted hover:text-fg">
              Dismiss
            </button>
          </div>
        )}

        {notice && (
          <div className="flex items-center gap-3 border-b border-line bg-raised px-4 py-2 text-[12px] text-muted">
            <span className="min-w-0 flex-1">{notice}</span>
            <button onClick={() => usePeer.getState().setNotice(null)} className="text-faint hover:text-fg">
              Dismiss
            </button>
          </div>
        )}

        {snapshot ? (
          <div className="relative flex min-h-0 flex-1 flex-col">
            <ThreadBackdrop />
            <header className={`relative flex items-center gap-4 border-b border-line/70 py-3 pr-6 ${sidebarOpen ? "pl-6" : "pl-20"}`}>
              <div className="min-w-[9rem] flex-1">
                <div className="truncate text-[14px] font-medium">{snapshot.session.title}</div>
                {workspace?.general ? (
                  <div className="truncate text-[11px] text-faint">General chat · not tied to a project</div>
                ) : (
                  <div className="truncate font-mono text-[11px] text-faint">{workspace?.path}</div>
                )}
              </div>
              <div className="flex min-w-0 flex-wrap items-center justify-end gap-x-4 gap-y-1 whitespace-nowrap">
                <span className="text-[12px] text-faint">
                  {RUNTIME_UI[snapshot.session.runtime].label} · <span className={MODE_UI[snapshot.session.mode].color}>{MODE_UI[snapshot.session.mode].label}</span>
                </span>
                {snapshot.session.runtime === "codex" && workspace && <SandboxNetworkToggle workspaceId={workspace.id} on={workspace.sandboxNetwork} />}
                {snapshot.session.runtime === "claude" && <AutoApprovalsToggle sessionId={snapshot.session.id} on={snapshot.session.autoApprovals} />}
                {snapshot.session.runtime !== "gemini" && <YoloToggle sessionId={snapshot.session.id} on={snapshot.session.yolo} />}
                {snapshot.session.mode === "collaborate" && <ApproachGateToggle sessionId={snapshot.session.id} on={snapshot.session.approachGate} />}
                <UndoButton />
                <button
                  onClick={() => setShowChanges(!showChanges)}
                  aria-pressed={showChanges}
                  title={showChanges ? "Hide the changes panel" : "Show the changes panel"}
                  className={`text-[12px] ${showChanges ? "text-fg" : "text-faint hover:text-fg"}`}
                >
                  Changes
                </button>
              </div>
            </header>
            <div className="relative flex min-h-0 flex-1">
              <div className="flex min-w-0 flex-1 flex-col">
                <Transcript />
                <Composer />
              </div>
              {showChanges && <ChangesPanel onClose={() => setShowChanges(false)} />}
            </div>
          </div>
        ) : (
          <EmptyState hasWorkspace={Boolean(activeWorkspaceId)} general={workspace?.general === true} sessionSelected={Boolean(activeSessionId)} />
        )}
      </main>
    </div>
  );
}

/** Codex runs commands in an OS sandbox without network unless the workspace allows it. */
function SandboxNetworkToggle({ workspaceId, on }: { workspaceId: string; on: boolean }) {
  const api = usePeer((s) => s.api);
  async function toggle() {
    if (!api) return;
    try {
      const ws = await api.updateWorkspace(workspaceId, { sandboxNetwork: !on });
      usePeer.setState((s) => ({ workspaces: s.workspaces.map((w) => (w.id === ws.id ? ws : w)) }));
    } catch (err) {
      usePeer.getState().setError(err instanceof Error ? err.message : String(err));
    }
  }
  return (
    <button
      onClick={() => void toggle()}
      role="switch"
      aria-checked={on}
      title={
        on
          ? "Codex commands in this project may use the network (including local ports). Applies from the next turn."
          : "Codex runs commands without network, so tests that start a server fail. Turn on to allow network in this project, from the next turn."
      }
      className={`text-[12px] ${on ? "text-warn" : "text-faint hover:text-fg"}`}
    >
      Network: {on ? "on" : "off"}
    </button>
  );
}

/** Claude Code's auto mode: its classifier settles permission prompts and asks only when unsure. */
function AutoApprovalsToggle({ sessionId, on }: { sessionId: string; on: boolean }) {
  const api = usePeer((s) => s.api);
  async function toggle() {
    if (!api) return;
    try {
      // The server emits session.updated, which refreshes the header.
      await api.updateSession(sessionId, { autoApprovals: !on });
    } catch (err) {
      usePeer.getState().setError(err instanceof Error ? err.message : String(err));
    }
  }
  return (
    <button
      onClick={() => void toggle()}
      role="switch"
      aria-checked={on}
      title={
        on
          ? "Claude Code's classifier approves or denies permission prompts in this session (including access outside the project) and asks you only when unsure. Destructive commands and Peer's collaboration rules still come to you. Applies from the next turn."
          : "Permission prompts in this session come to you. Turn on to let Claude Code's classifier settle them, including access outside the project; destructive commands still ask. Applies from the next turn."
      }
      className={`text-[12px] ${on ? "text-warn" : "text-faint hover:text-fg"}`}
    >
      Auto approvals: {on ? "on" : "off"}
    </button>
  );
}

/** YOLO: Peer approves every permission request in this session without asking. */
function YoloToggle({ sessionId, on }: { sessionId: string; on: boolean }) {
  const api = usePeer((s) => s.api);
  async function toggle() {
    if (!api) return;
    try {
      await api.updateSession(sessionId, { yolo: !on });
    } catch (err) {
      usePeer.getState().setError(err instanceof Error ? err.message : String(err));
    }
  }
  return (
    <button
      onClick={() => void toggle()}
      role="switch"
      aria-checked={on}
      title={
        on
          ? "YOLO is on: Peer approves every permission request in this session without asking, including destructive commands (rm, git push, sudo…) and escalations. Peer's collaboration rules still apply. Click to turn off."
          : "Turn on YOLO to have Peer approve every permission request in this session without asking, including destructive commands. Collaboration (checkpoints, Learn, Discuss first) is unchanged; use Just do it for that."
      }
      className={on ? "yolo-on rounded-full px-2 py-0.5 text-[11px] font-semibold tracking-wide" : "text-[12px] text-faint hover:text-fg"}
    >
      {on ? "YOLO" : "YOLO: off"}
    </button>
  );
}

/** Collaborate approach gate: Peer asks before a task's edits grow past five files. */
function ApproachGateToggle({ sessionId, on }: { sessionId: string; on: boolean }) {
  const api = usePeer((s) => s.api);
  async function toggle() {
    if (!api) return;
    try {
      await api.updateSession(sessionId, { approachGate: !on });
    } catch (err) {
      usePeer.getState().setError(err instanceof Error ? err.message : String(err));
    }
  }
  return (
    <button
      onClick={() => void toggle()}
      role="switch"
      aria-checked={on}
      title={
        on
          ? "When a task's edits grow past five files, Peer pauses the next edit and asks you to agree before it runs. Turn off to let large tasks run without asking."
          : "Let large tasks run without asking. Turn on to agree before a task's edits grow past five files."
      }
      className={`text-[12px] ${on ? "text-warn" : "text-faint hover:text-fg"}`}
    >
      Approach gate: {on ? "on" : "off"}
    </button>
  );
}

/** Undo the last turn: its file changes are reverted and it leaves the conversation. */
function UndoButton() {
  const api = usePeer((s) => s.api);
  const snapshot = usePeer((s) => s.snapshot);
  const [busy, setBusy] = useState(false);
  if (!snapshot || (!snapshot.undo.available && snapshot.undo.reason === NOTHING_TO_UNDO)) return null;
  const { session, undo } = snapshot;

  async function run() {
    if (!api || !window.confirm("Undo the last turn? Every file it changed goes back to how it was before the turn, and the turn leaves the conversation.")) return;
    setBusy(true);
    try {
      await api.undoTurn(session.id);
    } catch (err) {
      usePeer.getState().setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }
  return (
    <button
      onClick={() => void run()}
      disabled={!undo.available || busy}
      title={undo.available ? "Revert the files the last turn changed and remove it from the conversation" : (undo.reason ?? undefined)}
      className="text-[12px] text-faint hover:text-fg disabled:opacity-40 disabled:hover:text-faint"
    >
      {busy ? "Undoing…" : "Undo"}
    </button>
  );
}

function EmptyState({ hasWorkspace, general, sessionSelected }: { hasWorkspace: boolean; general: boolean; sessionSelected: boolean }) {
  if (sessionSelected) return <div className="flex-1" />;
  return (
    <div className="relative flex flex-1 items-center justify-center overflow-hidden">
      <Constellation />
      <div className="relative max-w-md text-center">
        <div className="text-[18px] font-semibold">AI coding that makes you better, not just faster.</div>
        <p className="mt-2 text-[13px] leading-relaxed text-muted">
          {general
            ? "Start a new chat from the sidebar to ask anything that isn't about a project: a concept, a design question, a snippet to try. Collaborate and Learn work here too."
            : hasWorkspace
            ? "Start a new session from the sidebar. Pick a mode next to the prompt: Collaborate to engineer it together with a teammate, Learn to build your understanding while the work gets done."
            : "Open a project folder to begin, or start a general chat. The agent can only work inside folders you choose."}
        </p>
      </div>
    </div>
  );
}
