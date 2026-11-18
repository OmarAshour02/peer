import { useEffect, useMemo, useRef, useState } from "react";
import type { PeerSession, Workspace } from "../shared/types";
import { PeerApi, resolveConfig } from "./api";
import { ChangesPanel } from "./components/ChangesPanel";
import { Constellation } from "./components/Constellation";
import { LearningMapView } from "./components/LearningMap";
import { Composer } from "./components/Composer";
import { ProvidersDialog } from "./components/ProvidersDialog";
import { RuntimeSettingsDialog } from "./components/RuntimeSettingsDialog";
import { SearchDialog } from "./components/SearchDialog";
import { LearningMapButton, SearchButton, Sidebar, SidebarToggle } from "./components/Sidebar";
import { ThreadBackdrop, Transcript } from "./components/Transcript";
import { MODE_UI } from "./modes";
import { RUNTIME_UI } from "./runtimes";
import { useGlobalShortcuts } from "./shortcuts";
import { formatTokens, sessionUsage, usageDetail } from "./usage";
import { activeRuntime, runtimeInfo, usePeer } from "./store";


const SIDEBAR_KEY = "peer-sidebar";
export function App() {
  const { ready, error, notice, activeWorkspaceId, activeSessionId, snapshot, modelsError, workspaces, api } = usePeer();
  const kind = usePeer(activeRuntime);
  const runtimes = usePeer((s) => s.runtimes);
  const providersOpen = usePeer((s) => s.providersOpen);
  const settingsOpen = usePeer((s) => s.settingsOpen);
  const learningMapOpen = usePeer((s) => s.learningMapOpen);
  const runtime = runtimeInfo({ runtimes }, kind).status;
  const [fatal, setFatal] = useState<string | null>(null);
  // Closed until the developer opens it from the header: the panel never opens on its own.
  const [showChanges, setShowChanges] = useState(false);
  // Each session starts with the panel closed, even if it was open in the previous one.
  useEffect(() => setShowChanges(false), [activeSessionId]);
  const [searchOpen, setSearchOpen] = useState(false);
  // ⌘K search, ⌘G learning map, ⌘N new session, ⌘L message box, ⌘\ sidebar, ⌘⇧M mode: from anywhere.
  useGlobalShortcuts({ toggleSearch: () => setSearchOpen((open) => !open), toggleSidebar: () => setSidebarOpen(!sidebarOpenRef.current) });
  // The sidebar stays as the developer last left it (a per-window convenience; open if unknown).
  const [sidebarOpen, setSidebarOpenState] = useState(() => {
    try {
      return window.localStorage.getItem(SIDEBAR_KEY) !== "closed";
    } catch {
      return true;
    }
  });
  const sidebarOpenRef = useRef(sidebarOpen);
  sidebarOpenRef.current = sidebarOpen;
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
      {/* First stop for the keyboard: straight to the message box, past the sidebar. */}
      {snapshot && !learningMapOpen && (
        <button
          onClick={() => usePeer.getState().focusComposer()}
          className="sr-only z-50 rounded-md bg-accent px-3 py-1.5 text-[12px] font-medium text-bg focus:not-sr-only focus:fixed focus:left-3 focus:top-3"
        >
          Skip to the message box (⌘L)
        </button>
      )}
      {providersOpen && <ProvidersDialog />}
      {settingsOpen && <RuntimeSettingsDialog />}
      {searchOpen && <SearchDialog onClose={() => setSearchOpen(false)} />}
      {sidebarOpen && <Sidebar onClose={() => setSidebarOpen(false)} onSearch={() => setSearchOpen(true)} />}
      <main className="relative flex min-w-0 flex-1 flex-col">
        {!sidebarOpen && (
          <div className="absolute left-3 top-3 z-20 flex items-center gap-0.5">
            <SidebarToggle open={false} onToggle={() => setSidebarOpen(true)} />
            <SearchButton onSearch={() => setSearchOpen(true)} />
            <LearningMapButton />
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

        {learningMapOpen ? (
          <LearningMapView sidebarOpen={sidebarOpen} />
        ) : snapshot ? (
          <div className="relative flex min-h-0 flex-1 flex-col">
            <ThreadBackdrop />
            <header className={`relative flex items-center gap-4 border-b border-line/70 py-3 pr-6 ${sidebarOpen ? "pl-6" : "pl-28"}`}>
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
                <SessionUsage />
                <SessionControls session={snapshot.session} workspace={workspace} />
                <ChangesButton open={showChanges} onToggle={() => setShowChanges(!showChanges)} />
              </div>
            </header>
            <div className="relative flex min-h-0 flex-1">
              <div className="flex min-w-0 flex-1 flex-col">
                <Transcript />
                <Composer />
              </div>
              {showChanges && !workspace?.general && <ChangesPanel onClose={() => setShowChanges(false)} />}
            </div>
          </div>
        ) : (
          <EmptyState hasWorkspace={Boolean(activeWorkspaceId)} general={workspace?.general === true} sessionSelected={Boolean(activeSessionId)} />
        )}
      </main>
    </div>
  );
}

/** The header's Changes toggle, with how many files the session has changed so far (projects only). */
export function ChangesButton({ open, onToggle }: { open: boolean; onToggle: () => void }) {
  const files = usePeer((s) => s.diff.length);
  // A general chat has no project: no files to show.
  const general = usePeer((s) => s.workspaces.find((w) => w.id === s.activeWorkspaceId)?.general === true);
  if (general) return null;
  return (
    <button
      onClick={onToggle}
      aria-pressed={open}
      title={open ? "Hide the changes panel" : "Files changed in this session"}
      className={`rounded-md border px-2 py-0.5 text-[12px] ${open ? "border-accent/60 bg-raised text-fg" : "border-line bg-raised text-muted hover:text-fg"}`}
    >
      Changes{files > 0 && <span className="ml-1 tabular-nums text-muted">{files}</span>}
    </button>
  );
}

type SessionSwitch = {
  key: string;
  label: string;
  on: boolean;
  /** What on and off mean, shown in the menu (not only in a tooltip). */
  describe: (on: boolean) => string;
  /** On relaxes a safeguard: the header says so while it is on. */
  relaxes: boolean;
  toggle: () => Promise<unknown>;
};

/**
 * The session's switches (Network, Auto approvals, YOLO, Approach gate) behind one header button.
 * The button says what is relaxed right now, so the posture reads at a glance; the menu explains
 * each switch in words.
 */
export function SessionControls({ session, workspace }: { session: PeerSession; workspace: Workspace | undefined }) {
  const api = usePeer((s) => s.api);
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!open) return;
    root.current?.querySelector<HTMLElement>("[role=menu] button")?.focus();
    const onDown = (e: MouseEvent) => !root.current?.contains(e.target as Node) && setOpen(false);
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.preventDefault();
      setOpen(false);
      trigger.current?.focus();
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const fail = (err: unknown) => usePeer.getState().setError(err instanceof Error ? err.message : String(err));
  const update = (patch: Parameters<NonNullable<typeof api>["updateSession"]>[1]) => (api ? api.updateSession(session.id, patch) : Promise.resolve());
  const switches: SessionSwitch[] = [];
  if (session.runtime === "codex" && workspace)
    switches.push({
      key: "network",
      label: "Network",
      on: workspace.sandboxNetwork,
      relaxes: true,
      describe: (on) =>
        on
          ? "Codex commands in this project may use the network, local ports included. From the next turn."
          : "Codex runs commands without network, so tests that start a server fail. Applies to this project, from the next turn.",
      toggle: async () => {
        if (!api) return;
        const ws = await api.updateWorkspace(workspace.id, { sandboxNetwork: !workspace.sandboxNetwork });
        usePeer.setState((s) => ({ workspaces: s.workspaces.map((w) => (w.id === ws.id ? ws : w)) }));
      },
    });
  if (session.runtime === "claude")
    switches.push({
      key: "auto",
      label: "Auto approvals",
      on: session.autoApprovals,
      relaxes: true,
      describe: (on) =>
        on
          ? "Claude Code's classifier settles permission prompts, access outside the project included, and asks you only when unsure. Destructive commands still ask. From the next turn."
          : "Permission prompts in this session come to you. On lets Claude Code's classifier settle them, from the next turn.",
      toggle: () => update({ autoApprovals: !session.autoApprovals }),
    });
  if (session.runtime !== "gemini")
    switches.push({
      key: "yolo",
      label: "YOLO",
      on: session.yolo,
      relaxes: true,
      describe: (on) =>
        on
          ? "Peer approves every permission request in this session without asking, destructive commands included. Checkpoints, Learn and Discuss first still apply."
          : "Permission requests come to you. On approves all of them, destructive commands included; collaboration is unchanged.",
      toggle: () => update({ yolo: !session.yolo }),
    });
  if (session.mode === "collaborate")
    switches.push({
      key: "gate",
      label: "Approach gate",
      on: session.approachGate,
      relaxes: false,
      describe: (on) =>
        on ? "Peer pauses a task's edits before they grow past five files and asks you to agree." : "Large tasks run without asking. On asks before a task's edits grow past five files.",
      toggle: () => update({ approachGate: !session.approachGate }),
    });
  if (switches.length === 0) return null;

  const relaxed = switches.filter((s) => s.relaxes && s.on);
  const yolo = session.yolo;
  return (
    <div ref={root} className="relative">
      <button
        ref={trigger}
        onClick={() => setOpen((o) => !o)}
        aria-haspopup="menu"
        aria-expanded={open}
        title="Network, approvals, YOLO and the approach gate for this session"
        className={
          yolo
            ? "yolo-on rounded-md px-2 py-0.5 text-[12px] font-semibold tracking-wide"
            : `rounded-md border border-line bg-raised px-2 py-0.5 text-[12px] hover:text-fg ${relaxed.length ? "text-warn" : "text-muted"}`
        }
      >
        {yolo ? "YOLO on" : relaxed.length ? `${relaxed.map((s) => s.label).join(" · ")} on` : "Permissions: ask"}
        <span aria-hidden="true" className="ml-1 text-[10px]">▾</span>
      </button>
      {open && (
        <div
          role="menu"
          aria-label="Session permissions"
          onKeyDown={(e) => {
            if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
            e.preventDefault();
            const items = [...e.currentTarget.querySelectorAll<HTMLElement>("[role=menuitemcheckbox]")];
            const at = items.indexOf(document.activeElement as HTMLElement);
            items[(at + (e.key === "ArrowDown" ? 1 : -1) + items.length) % items.length]?.focus();
          }}
          className="absolute right-0 top-full z-30 mt-1.5 w-80 whitespace-normal rounded-xl border border-line bg-panel p-1.5 shadow-card">
          {switches.map((s) => (
            <button
              key={s.key}
              role="menuitemcheckbox"
              aria-checked={s.on}
              onClick={() => void s.toggle().catch(fail)}
              className="flex w-full flex-col gap-0.5 rounded-lg px-2.5 py-2 text-left hover:bg-raised focus-visible:bg-raised"
            >
              <span className="flex w-full items-center gap-2 text-[12px]">
                <span className="flex-1 text-fg">{s.label}</span>
                <span className={s.on ? (s.key === "yolo" ? "text-danger" : s.relaxes ? "text-warn" : "text-accent") : "text-muted"}>{s.on ? "On" : "Off"}</span>
              </span>
              <span className="text-[12px] leading-snug text-muted">{s.describe(s.on)}</span>
            </button>
          ))}
        </div>
      )}
    </div>
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

/** What the session has used so far, from the runtime's own token reports. */
function SessionUsage() {
  const messages = usePeer((st) => st.messages);
  const usage = useMemo(() => sessionUsage(messages), [messages]);
  if (!usage) return null;
  return (
    <span className="text-[12px] tabular-nums text-faint" title={`This session so far\n${usageDetail(usage)}`}>
      {formatTokens(usage.input + usage.output)} tokens
    </span>
  );
}
