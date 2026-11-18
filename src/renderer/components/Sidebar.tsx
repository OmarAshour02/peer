import { useRef, useState } from "react";
import type { PeerSession, RuntimeKind, Workspace } from "../../shared/types";
import { ActivityMark } from "./ActivityMark";
import { MODE_UI } from "../modes";
import { RUNTIME_UI, statusDot } from "../runtimes";
import { ProviderIcon } from "./ProviderIcon";
import { SearchIcon } from "./SearchDialog";
import { usePeer } from "../store";
import { applyTheme, beginThemeChoice, clearPendingTheme, currentTheme, enqueueThemeWrite, isLatestThemeChoice, markPendingTheme, type Theme } from "../theme";

/** Dark is home; the light theme is the paper palette (DESIGN.md). Persisted as a server preference. */
export function ThemeToggle() {
  const api = usePeer((s) => s.api);
  const [theme, setTheme] = useState<Theme>(() => currentTheme());
  const next: Theme = theme === "dark" ? "light" : "dark";
  return (
    <button
      onClick={() => {
        const gen = beginThemeChoice();
        applyTheme(next);
        setTheme(next);
        // The choice is recorded as unsynchronized before the write starts, so a reconnect
        // landing while the write is outstanding already sees it and schedules its own retry.
        markPendingTheme(next);
        if (!api) return;
        void enqueueThemeWrite(async () => {
          if (!isLatestThemeChoice(gen)) return;
          try {
            await api.setPreferences({ theme: next });
            // Persisting the latest choice supersedes any older queued one; an older write
            // finishing late only ever clears its own marker.
            if (isLatestThemeChoice(gen)) clearPendingTheme();
            else clearPendingTheme(next);
          } catch {
            if (isLatestThemeChoice(gen)) markPendingTheme(next);
          }
        });
      }}
      role="switch"
      aria-checked={theme === "light"}
      aria-label="Light theme"
      title={theme === "dark" ? "Switch to the light (paper) theme" : "Switch to the dark theme"}
      className="-ml-1.5 flex h-7 w-7 items-center justify-center rounded-md text-muted hover:bg-raised hover:text-fg"
    >
      {/* The icon shows where a click takes you: a sun in the dark, a moon on paper. */}
      <svg aria-hidden="true" viewBox="0 0 24 24" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
        {theme === "dark" ? (
          <>
            <circle cx="12" cy="12" r="4" />
            <path d="M12 2.5v2M12 19.5v2M4.6 4.6l1.4 1.4M18 18l1.4 1.4M2.5 12h2M19.5 12h2M4.6 19.4 6 18M18 6l1.4-1.4" />
          </>
        ) : (
          <path d="M20.5 14.2A8.5 8.5 0 0 1 9.8 3.5a8.5 8.5 0 1 0 10.7 10.7Z" />
        )}
      </svg>
    </button>
  );
}

/** Open or close the sidebar. The same control sits in the sidebar (close) and in the main view (open). */
export function SidebarToggle({ open, onToggle, className = "" }: { open: boolean; onToggle: () => void; className?: string }) {
  return (
    <button
      onClick={onToggle}
      aria-label={open ? "Close sidebar" : "Open sidebar"}
      aria-expanded={open}
      title={open ? "Close sidebar" : "Open sidebar"}
      className={`flex h-7 w-7 items-center justify-center rounded-md text-faint hover:bg-raised hover:text-muted ${className}`}
    >
      <svg aria-hidden="true" viewBox="0 0 24 24" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
        <rect x="3.5" y="4.5" width="17" height="15" rx="2.5" />
        <path d="M9.5 4.5v15" />
      </svg>
    </button>
  );
}

/**
 * Opens the learning map (⌘G / Ctrl+G): the concepts from every session, as a constellation. It
 * sits with search: both are destinations across every project, not places you work.
 */
export function LearningMapButton({ className = "" }: { className?: string }) {
  const open = usePeer((s) => s.learningMapOpen);
  const mac = typeof navigator !== "undefined" && /Mac/i.test(navigator.platform);
  return (
    <button
      onClick={() => usePeer.getState().setLearningMapOpen(!open)}
      aria-label="Learning map"
      aria-pressed={open}
      aria-keyshortcuts={mac ? "Meta+G" : "Control+G"}
      title={`Learning map: the concepts you've worked through, and the chats behind each one (${mac ? "⌘G" : "Ctrl+G"})`}
      className={`flex h-7 w-7 items-center justify-center rounded-md ${open ? "bg-raised text-fg" : "text-faint hover:bg-raised hover:text-muted"} ${className}`}
    >
      {/* Drawn like its neighbours: 16px, 1.6 stroke. Three stars and the lines that join them. */}
      <svg aria-hidden="true" viewBox="0 0 24 24" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
        <circle cx="5.5" cy="7" r="2" />
        <circle cx="17.5" cy="5.5" r="2" />
        <circle cx="12" cy="17.5" r="2.5" />
        <path d="M7.4 7.7 15.6 6M6.6 8.8l3.9 6.6M16.6 7.4l-3.4 7.9" />
      </svg>
    </button>
  );
}

/** Opens search (⌘K / Ctrl+K). */
export function SearchButton({ onSearch, className = "" }: { onSearch: () => void; className?: string }) {
  const mac = typeof navigator !== "undefined" && /Mac/i.test(navigator.platform);
  return (
    <button
      onClick={onSearch}
      aria-label="Search chats and sessions"
      aria-keyshortcuts={mac ? "Meta+K" : "Control+K"}
      title={`Search chats and sessions (${mac ? "⌘K" : "Ctrl+K"})`}
      className={`flex h-7 w-7 items-center justify-center rounded-md text-faint hover:bg-raised hover:text-muted ${className}`}
    >
      <SearchIcon className="h-4 w-4" />
    </button>
  );
}

export function Sidebar({ onClose, onSearch }: { onClose: () => void; onSearch: () => void }) {
  const { api, workspaces, runtimes, connected } = usePeer();
  const selectWorkspace = usePeer((s) => s.selectWorkspace);
  const setError = usePeer((s) => s.setError);
  const general = workspaces.find((w) => w.general);
  const projects = workspaces.filter((w) => !w.general);
  const [pathInput, setPathInput] = useState<string | null>(null);

  async function addWorkspace(path: string) {
    if (!api) return;
    try {
      const ws = await api.addWorkspace(path);
      usePeer.setState({ workspaces: [ws, ...workspaces.filter((w) => w.id !== ws.id)] });
      await selectWorkspace(ws.id);
      setPathInput(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  async function openProject() {
    if (window.peerDesktop) {
      const path = await window.peerDesktop.pickDirectory();
      if (path) await addWorkspace(path);
    } else {
      setPathInput("");
    }
  }

  return (
    <aside className="flex w-64 shrink-0 flex-col border-r border-line/70 bg-nav">
      <div className="px-5 pb-3 pt-4">
        <div className="flex items-center justify-between">
          <div className="text-[16px] font-semibold tracking-[-0.01em]">
            Peer<span className="text-accent">.</span>
          </div>
          <div className="-mr-1.5 flex items-center gap-0.5">
            <SearchButton onSearch={onSearch} />
            <LearningMapButton />
            {connected && (
              <button
                onClick={() => usePeer.getState().setSettingsOpen(true)}
                title="Runtime settings (CLI paths, permission mode, effort)"
                aria-label="Runtime settings"
                className="flex h-7 w-7 items-center justify-center rounded-md text-faint hover:bg-raised hover:text-muted"
              >
                {/* Drawn like its neighbours (search, sidebar): 16px, 1.6 stroke. */}
                <svg aria-hidden="true" viewBox="0 0 24 24" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
                  <circle cx="12" cy="12" r="3" />
                  <path d="M19.4 15a1.7 1.7 0 0 0 .34 1.87l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.7 1.7 0 0 0-1.87-.34 1.7 1.7 0 0 0-1.03 1.56V21a2 2 0 1 1-4 0v-.09a1.7 1.7 0 0 0-1.11-1.56 1.7 1.7 0 0 0-1.87.34l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06A1.7 1.7 0 0 0 4.6 15a1.7 1.7 0 0 0-1.56-1.03H3a2 2 0 1 1 0-4h.09A1.7 1.7 0 0 0 4.6 8.86a1.7 1.7 0 0 0-.34-1.87l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.7 1.7 0 0 0 1.87.34H9a1.7 1.7 0 0 0 1.03-1.56V3a2 2 0 1 1 4 0v.09a1.7 1.7 0 0 0 1.03 1.56 1.7 1.7 0 0 0 1.87-.34l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.7 1.7 0 0 0-.34 1.87V9c.26.6.86 1 1.51 1.03H21a2 2 0 1 1 0 4h-.09a1.7 1.7 0 0 0-1.51 1.03Z" />
                </svg>
              </button>
            )}
            <SidebarToggle open onToggle={onClose} />
          </div>
        </div>
        <div className="mt-2 flex items-center justify-between">
          <ThemeToggle />
          {!connected ? (
            <div className="flex items-center gap-1.5 text-[11px] text-faint">
              <span className="h-1.5 w-1.5 rounded-full bg-danger" />
              offline
            </div>
          ) : (
            <button
              onClick={() => usePeer.getState().setProvidersOpen(true)}
              title={`Models & providers — ${runtimes.map((r) => `${r.name}: ${r.status.state === "ready" ? "ready" : (r.status.error ?? r.status.state)}`).join("; ")}`}
              aria-label="Models & providers"
              className="-mr-2 flex items-center gap-2 rounded-md px-2 py-1 hover:bg-raised"
            >
              {runtimes.map((r) => (
                <span
                  key={r.kind}
                  className="flex items-center"
                  title={`${r.name}: ${r.status.state === "ready" ? `ready (${[r.status.version ?? "unknown version", r.status.account].filter(Boolean).join(", ")})` : (r.status.error ?? r.status.state)}${r.status.warning ? `\n${r.status.warning}` : ""}`}
                >
                  <span className={`h-1.5 w-1.5 rounded-full ${statusDot(r.status)}`} />
                </span>
              ))}
            </button>
          )}
        </div>
      </div>

      <div className="px-3">
        <button
          onClick={openProject}
          className="w-full rounded-md border border-line/60 bg-raised px-2 py-1.5 text-left text-[13px] text-fg hover:border-accent/60"
        >
          + Open project…
        </button>
        {pathInput !== null && (
          <form
            className="mt-2"
            onSubmit={(e) => {
              e.preventDefault();
              void addWorkspace(pathInput);
            }}
          >
            <input
              autoFocus
              value={pathInput}
              onChange={(e) => setPathInput(e.target.value)}
              onKeyDown={(e) => e.key === "Escape" && setPathInput(null)}
              placeholder="/absolute/path/to/project"
              className="w-full rounded-md border border-line bg-bg px-2 py-1.5 font-mono text-[12px] outline-none focus:border-accent"
            />
          </form>
        )}
      </div>

      <div className="mt-4 min-h-0 flex-1 overflow-y-auto px-3 pb-4">
        {general && <WorkspaceGroup ws={general} />}
        <div className={`px-2 pb-1 text-[11px] font-medium uppercase tracking-wider text-faint ${general ? "mt-3" : ""}`}>Projects</div>
        {projects.length === 0 && <div className="px-2 py-1 text-[12px] text-faint">No projects yet.</div>}
        {projects.map((ws) => (
          <WorkspaceGroup key={ws.id} ws={ws} />
        ))}
      </div>
    </aside>
  );
}

/**
 * A workspace in the sidebar with its sessions when it is the active one. Chats (the general
 * workspace) reads as a chat list: "+ New chat", and it cannot be removed.
 */
function WorkspaceGroup({ ws }: { ws: Workspace }) {
  const { api, sessions, activeWorkspaceId, activeSessionId, runtimes, newRuntime } = usePeer();
  const setNewRuntime = usePeer((s) => s.setNewRuntime);
  const selectWorkspace = usePeer((s) => s.selectWorkspace);
  const setError = usePeer((s) => s.setError);
  const active = ws.id === activeWorkspaceId;

  const newSession = () => usePeer.getState().newSession(ws.id);

  async function removeProject() {
    if (!api) return;
    if (!window.confirm(`Remove "${ws.name}" from Peer? Its sessions and their history are removed from Peer. Files in the project are not changed.`)) return;
    try {
      await api.removeWorkspace(ws.id);
      const remaining = usePeer.getState().workspaces.filter((w) => w.id !== ws.id);
      usePeer.setState({ workspaces: remaining });
      if (active) await selectWorkspace(remaining.find((w) => !w.general)?.id ?? remaining[0]?.id ?? null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  return (
    <div className="mb-1">
      <div className={`group flex w-full items-center gap-1 rounded-md px-2 py-1.5 ${active ? "bg-raised" : "hover:bg-raised/60"}`}>
        <button
          onClick={() => void selectWorkspace(ws.id)}
          title={ws.general ? "General chats, not tied to a project" : ws.path}
          className={`flex min-w-0 flex-1 items-center gap-2 truncate text-left text-[13px] ${active ? "text-fg" : "text-muted"}`}
        >
          {ws.general && (
            <svg aria-hidden="true" viewBox="0 0 24 24" className="h-3.5 w-3.5 shrink-0" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
              <path d="M20 12.5a7.5 7.5 0 0 1-11.2 6.5L4 20l1.1-4.3A7.5 7.5 0 1 1 20 12.5Z" />
            </svg>
          )}
          <span className="truncate">{ws.name}</span>
          <WaitingCount workspaceId={ws.id} />
        </button>
        {!ws.general && (
          <button
            onClick={() => void removeProject()}
            title="Remove project"
            aria-label={`Remove project ${ws.name}`}
            className="hidden shrink-0 px-0.5 text-faint hover:text-danger group-hover:block group-focus-within:block"
          >
            ×
          </button>
        )}
      </div>
      {active && (
        <div className="ml-2 mt-0.5 space-y-0.5 border-l border-line/60 pl-2">
          <div className="flex items-center gap-2">
            <button onClick={() => void newSession()} className="min-w-0 flex-1 truncate rounded px-2 py-1 text-left text-[12px] text-accent hover:bg-raised/60">
              {ws.general ? "+ New chat" : "+ New session"}
            </button>
            <select
              value={newRuntime}
              onChange={(e) => setNewRuntime(e.target.value as RuntimeKind)}
              title={ws.general ? "Agent runtime for new chats" : "Agent runtime for new sessions"}
              aria-label={ws.general ? "Agent runtime for new chats" : "Agent runtime for new sessions"}
              className="max-w-[104px] shrink-0 rounded-md border border-line/60 bg-bg px-1 py-0.5 text-[11px] text-muted outline-none focus:border-accent"
            >
              {/* Only runtimes that can start a session; the current pick stays listed even if it went down. */}
              {runtimes
                .filter((r) => r.status.state !== "unavailable" || r.kind === newRuntime)
                .map((r) => (
                  <option key={r.kind} value={r.kind} title={r.status.error}>
                    {RUNTIME_UI[r.kind].label}
                  </option>
                ))}
            </select>
          </div>
          {sessions.map((s, i) => (
            <SessionRow
              key={s.id}
              session={s}
              active={s.id === activeSessionId}
              tabbable={s.id === activeSessionId || (i === 0 && !sessions.some((x) => x.id === activeSessionId))}
            />
          ))}
        </div>
      )}
    </div>
  );
}

/** How many sessions in a workspace wait on the developer, so a closed project still says so. */
function WaitingCount({ workspaceId }: { workspaceId: string }) {
  const waiting = usePeer((st) => Object.values(st.activity).filter((a) => a.workspaceId === workspaceId && a.state === "waiting").length);
  if (!waiting) return null;
  const label = `${waiting} ${waiting === 1 ? "session waits" : "sessions wait"} for you`;
  return (
    <span className="ml-auto flex shrink-0 items-center gap-1 text-[11px] tabular-nums text-accent" title={label}>
      <span aria-hidden="true" className="h-1.5 w-1.5 rounded-full bg-accent" />
      <span aria-hidden="true">{waiting}</span>
      <span className="sr-only">{label}</span>
    </span>
  );
}

/** A session in the sidebar: click to open, double-click (or the pencil) to rename, × to delete. */
export function SessionRow({ session: s, active, tabbable }: { session: PeerSession; active: boolean; tabbable: boolean }) {
  const api = usePeer((st) => st.api);
  const selectSession = usePeer((st) => st.selectSession);
  const setError = usePeer((st) => st.setError);
  const [name, setName] = useState<string | null>(null);
  // Enter submits and the input's blur follows; only the first one renames.
  const editing = useRef(false);
  const startRename = () => {
    editing.current = true;
    setName(s.title);
  };

  async function rename() {
    if (!editing.current) return;
    editing.current = false;
    const title = name?.trim();
    setName(null);
    if (!api || !title || title === s.title) return;
    try {
      await api.updateSession(s.id, { title });
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  async function remove() {
    if (!api) return;
    if (!window.confirm(`Delete "${s.title}"? Its conversation and checkpoints are removed from Peer. Files in the project are not changed.`)) return;
    try {
      await api.deleteSession(s.id);
      const { sessions, activeSessionId } = usePeer.getState();
      usePeer.setState({ sessions: sessions.filter((x) => x.id !== s.id) });
      if (activeSessionId === s.id) await selectSession(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  /** One tab stop for the whole list: arrows move between sessions, F2 renames, Delete removes. */
  function onRowKey(e: React.KeyboardEvent<HTMLButtonElement>) {
    if (e.key === "F2") {
      e.preventDefault();
      startRename();
    } else if (e.key === "Delete" || (e.key === "Backspace" && e.metaKey)) {
      e.preventDefault();
      void remove();
    } else if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      const rows = [...document.querySelectorAll<HTMLElement>("[data-session-row]")];
      const at = rows.indexOf(e.currentTarget);
      rows[Math.min(rows.length - 1, Math.max(0, at + (e.key === "ArrowDown" ? 1 : -1)))]?.focus();
    }
  }

  if (name !== null) {
    return (
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void rename();
        }}
      >
        <input
          autoFocus
          value={name}
          aria-label="Session name"
          onChange={(e) => setName(e.target.value)}
          onBlur={() => void rename()}
          onKeyDown={(e) => {
            if (e.key !== "Escape") return;
            editing.current = false;
            setName(null);
          }}
          maxLength={200}
          className="w-full rounded border border-accent bg-bg px-2 py-1 text-[12px] outline-none"
        />
      </form>
    );
  }

  return (
    <div
      className={`group flex w-full items-center gap-2 rounded px-2 py-1 text-[12px] ${active ? "bg-raised text-fg" : "text-muted hover:bg-raised/60"}`}
    >
      <button
        onClick={() => void selectSession(s.id)}
        onDoubleClick={startRename}
        onKeyDown={onRowKey}
        tabIndex={tabbable ? 0 : -1}
        data-session-row
        aria-current={active ? "page" : undefined}
        aria-keyshortcuts="F2 Delete"
        title={`${s.title}  ·  F2 renames, Delete removes, ↑↓ move between sessions`}
        className="flex min-w-0 flex-1 items-center gap-2 text-left"
      >
        {/* The runtime's own mark in its own colours; monochrome marks take the foreground. */}
        <span className="flex shrink-0 text-fg" title={`${RUNTIME_UI[s.runtime].label} · ${MODE_UI[s.mode].label}`}>
          <ProviderIcon runtime={s.runtime} className="h-3 w-3" />
        </span>
        <span className="min-w-0 flex-1 truncate">{s.title}</span>
        <ActivityMark sessionId={s.id} />
      </button>
      <span className="hidden shrink-0 items-center gap-1 group-hover:flex group-focus-within:flex">
        {/* Out of the tab order: one stop per session; F2 and Delete do these from the keyboard. */}
        <button tabIndex={-1} onClick={startRename} title="Rename (F2)" aria-label={`Rename ${s.title}`} className="px-0.5 text-faint hover:text-fg">
          ✎
        </button>
        <button tabIndex={-1} onClick={() => void remove()} title="Delete (Delete key)" aria-label={`Delete ${s.title}`} className="px-0.5 text-faint hover:text-danger">
          ×
        </button>
      </span>
    </div>
  );
}
