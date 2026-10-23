import { useEffect, useState } from "react";
import { PeerApi, resolveConfig } from "./api";
import { ChangesPanel } from "./components/ChangesPanel";
import { Composer } from "./components/Composer";
import { ProvidersDialog } from "./components/ProvidersDialog";
import { Sidebar } from "./components/Sidebar";
import { Transcript } from "./components/Transcript";
import { MODE_UI } from "./modes";
import { RUNTIME_UI } from "./runtimes";
import { activeRuntime, runtimeInfo, usePeer } from "./store";

export function App() {
  const { ready, error, activeWorkspaceId, activeSessionId, snapshot, modelsError, workspaces, api } = usePeer();
  const kind = usePeer(activeRuntime);
  const runtimes = usePeer((s) => s.runtimes);
  const providersOpen = usePeer((s) => s.providersOpen);
  const runtime = runtimeInfo({ runtimes }, kind).status;
  const [fatal, setFatal] = useState<string | null>(null);
  const [showChanges, setShowChanges] = useState(true);

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
      <Sidebar />
      <main className="flex min-w-0 flex-1 flex-col">
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

        {snapshot ? (
          <>
            <header className="flex items-center gap-3 border-b border-line px-6 py-2.5">
              <div className="min-w-0 flex-1">
                <div className="truncate text-[14px] font-medium">{snapshot.session.title}</div>
                <div className="truncate font-mono text-[11px] text-faint">{workspace?.path}</div>
              </div>
              <span className="text-[12px] text-faint">{RUNTIME_UI[snapshot.session.runtime].label}</span>
              <span className={`text-[12px] ${MODE_UI[snapshot.session.mode].color}`}>{MODE_UI[snapshot.session.mode].label}</span>
              <button onClick={() => setShowChanges(!showChanges)} className="text-[12px] text-faint hover:text-fg">
                {showChanges ? "Hide changes" : "Show changes"}
              </button>
            </header>
            <div className="flex min-h-0 flex-1">
              <div className="flex min-w-0 flex-1 flex-col">
                <Transcript />
                <Composer />
              </div>
              {showChanges && <ChangesPanel />}
            </div>
          </>
        ) : (
          <EmptyState hasWorkspace={Boolean(activeWorkspaceId)} sessionSelected={Boolean(activeSessionId)} />
        )}
      </main>
    </div>
  );
}

function EmptyState({ hasWorkspace, sessionSelected }: { hasWorkspace: boolean; sessionSelected: boolean }) {
  if (sessionSelected) return <div className="flex-1" />;
  return (
    <div className="flex flex-1 items-center justify-center">
      <div className="max-w-md text-center">
        <div className="text-[18px] font-semibold">AI coding that makes you better, not just faster.</div>
        <p className="mt-2 text-[13px] leading-relaxed text-muted">
          {hasWorkspace
            ? "Start a new session from the sidebar. Pick a collaboration mode next to the prompt: Focus to execute, Collaborate to work as a team, Learn to build understanding."
            : "Open a project folder to begin. The agent can only work inside folders you choose."}
        </p>
      </div>
    </div>
  );
}
