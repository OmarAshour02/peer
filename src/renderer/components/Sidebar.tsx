import { useRef, useState } from "react";
import type { PeerSession, RuntimeKind } from "../../shared/types";
import { MODE_UI } from "../modes";
import { RUNTIME_UI, statusDot } from "../runtimes";
import { usePeer } from "../store";

export function Sidebar() {
  const { api, workspaces, sessions, activeWorkspaceId, activeSessionId, runtimes, newRuntime, connected } = usePeer();
  const setNewRuntime = usePeer((s) => s.setNewRuntime);
  const selectWorkspace = usePeer((s) => s.selectWorkspace);
  const selectSession = usePeer((s) => s.selectSession);
  const setError = usePeer((s) => s.setError);
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

  async function newSession() {
    if (!api || !activeWorkspaceId) return;
    try {
      const session = await api.createSession(activeWorkspaceId, { runtime: newRuntime });
      await selectSession(session.id);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  return (
    <aside className="flex w-64 shrink-0 flex-col border-r border-line bg-panel">
      <div className="flex items-center justify-between px-4 pb-3 pt-4">
        <div className="text-[15px] font-semibold tracking-tight">Peer</div>
        {!connected ? (
          <div className="flex items-center gap-1.5 text-[11px] text-faint">
            <span className="h-1.5 w-1.5 rounded-full bg-danger" />
            offline
          </div>
        ) : (
          <button
            onClick={() => usePeer.getState().setProvidersOpen(true)}
            title="Models & providers"
            className="flex items-center gap-2 rounded px-1 text-[11px] text-faint hover:bg-raised hover:text-muted"
          >
            {runtimes.map((r) => (
              <span
                key={r.kind}
                className="flex items-center gap-1"
                title={`${r.name}: ${r.status.state === "ready" ? `ready (${[r.status.version ?? "unknown version", r.status.account].filter(Boolean).join(", ")})` : (r.status.error ?? r.status.state)}${r.status.warning ? `\n${r.status.warning}` : ""}`}
              >
                <span className={`h-1.5 w-1.5 rounded-full ${statusDot(r.status)}`} />
                {RUNTIME_UI[r.kind].short}
              </span>
            ))}
          </button>
        )}
      </div>

      <div className="px-3">
        <button
          onClick={openProject}
          className="w-full rounded-md border border-line bg-raised px-3 py-1.5 text-left text-[13px] text-fg hover:border-accent/60"
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

      <div className="mt-4 min-h-0 flex-1 overflow-y-auto px-2 pb-4">
        <div className="px-2 pb-1 text-[11px] font-medium uppercase tracking-wider text-faint">Projects</div>
        {workspaces.length === 0 && <div className="px-2 py-1 text-[12px] text-faint">No projects yet.</div>}
        {workspaces.map((ws) => {
          const active = ws.id === activeWorkspaceId;
          return (
            <div key={ws.id} className="mb-1">
              <button
                onClick={() => void selectWorkspace(ws.id)}
                title={ws.path}
                className={`w-full truncate rounded-md px-2 py-1.5 text-left text-[13px] ${active ? "bg-raised text-fg" : "text-muted hover:bg-raised/60"}`}
              >
                {ws.name}
              </button>
              {active && (
                <div className="ml-2 mt-0.5 border-l border-line pl-2">
                  <div className="flex items-center gap-1">
                    <button onClick={newSession} className="flex-1 rounded px-2 py-1 text-left text-[12px] text-accent hover:bg-raised/60">
                      + New session
                    </button>
                    <select
                      value={newRuntime}
                      onChange={(e) => setNewRuntime(e.target.value as RuntimeKind)}
                      title="Agent runtime for new sessions"
                      aria-label="Agent runtime for new sessions"
                      className="max-w-[96px] rounded border border-line bg-bg px-1 py-0.5 text-[11px] text-muted outline-none focus:border-accent"
                    >
                      {runtimes.map((r) => (
                        <option key={r.kind} value={r.kind} disabled={r.status.state === "unavailable"} title={r.status.error}>
                          {RUNTIME_UI[r.kind].label}
                          {r.status.state === "unavailable" ? " (unavailable)" : ""}
                        </option>
                      ))}
                    </select>
                  </div>
                  {sessions.map((s) => (
                    <SessionRow key={s.id} session={s} active={s.id === activeSessionId} />
                  ))}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </aside>
  );
}

/** A session in the sidebar: click to open, double-click (or the pencil) to rename, × to delete. */
function SessionRow({ session: s, active }: { session: PeerSession; active: boolean }) {
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
      <button onClick={() => void selectSession(s.id)} onDoubleClick={startRename} className="flex min-w-0 flex-1 items-center gap-2 text-left">
        <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${MODE_UI[s.mode].dot}`} title={MODE_UI[s.mode].label} />
        <span className="min-w-0 flex-1 truncate">{s.title}</span>
        {s.runtime !== "opencode" && <span className="shrink-0 text-[10px] text-faint group-hover:hidden">{RUNTIME_UI[s.runtime].short}</span>}
      </button>
      <span className="hidden shrink-0 items-center gap-1 group-hover:flex group-focus-within:flex">
        <button onClick={startRename} title="Rename" aria-label={`Rename ${s.title}`} className="px-0.5 text-faint hover:text-fg">
          ✎
        </button>
        <button onClick={() => void remove()} title="Delete" aria-label={`Delete ${s.title}`} className="px-0.5 text-faint hover:text-danger">
          ×
        </button>
      </span>
    </div>
  );
}
