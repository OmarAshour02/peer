import { useEffect, useRef, useState } from "react";
import type { PeerSession } from "../../shared/types";
import { usePeer } from "../store";
import { ProviderIcon } from "./ProviderIcon";

/**
 * Find a chat or session by title, across Chats and every project. Opened from the sidebar's search
 * icon or ⌘K / Ctrl+K. Arrow keys move, Enter opens, Escape closes.
 */
export function SearchDialog({ onClose }: { onClose: () => void }) {
  const api = usePeer((s) => s.api);
  const workspaces = usePeer((s) => s.workspaces);
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<PeerSession[] | null>(null);
  /** The query `results` answer; while it differs from the input, the list is stale. */
  const [resultsFor, setResultsFor] = useState<string | null>(null);
  const [active, setActive] = useState(0);
  /** Enter was pressed before the current query's results arrived: open the first one when they do. */
  const [openWhenReady, setOpenWhenReady] = useState(false);
  const fresh = resultsFor === query;
  const list = useRef<HTMLUListElement>(null);

  useEffect(() => {
    if (!api) return;
    let current = true;
    const timer = setTimeout(() => {
      api
        .searchSessions(query)
        .then((found) => {
          if (!current) return;
          setResults(found);
          setResultsFor(query);
          setActive(0);
        })
        .catch(() => {
          if (!current) return;
          setResults([]);
          setResultsFor(query);
        });
    }, 120);
    return () => {
      current = false;
      clearTimeout(timer);
    };
  }, [api, query]);

  useEffect(() => {
    if (!openWhenReady || !fresh) return;
    setOpenWhenReady(false);
    if (results?.[0]) void open(results[0]);
  }, [openWhenReady, fresh, results]);

  useEffect(() => {
    list.current?.querySelector<HTMLElement>(`[data-index="${active}"]`)?.scrollIntoView({ block: "nearest" });
  }, [active]);

  async function open(session: PeerSession) {
    onClose();
    const { activeWorkspaceId, selectWorkspace, selectSession } = usePeer.getState();
    if (activeWorkspaceId !== session.workspaceId) await selectWorkspace(session.workspaceId);
    await selectSession(session.id);
  }

  const where = (s: PeerSession) => {
    const ws = workspaces.find((w) => w.id === s.workspaceId);
    return ws?.general ? "Chats" : (ws?.name ?? "");
  };

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center bg-black/50 p-8 pt-[12vh]" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div role="dialog" aria-label="Search chats and sessions" className="w-full max-w-xl overflow-hidden rounded-xl border border-line bg-panel shadow-composer">
        <div className="flex items-center gap-2 border-b border-line/70 px-4">
          <SearchIcon className="h-4 w-4 shrink-0 text-faint" />
          <input
            autoFocus
            value={query}
            onChange={(e) => {
              setQuery(e.target.value);
              setOpenWhenReady(false);
            }}
            onKeyDown={(e) => {
              const n = results?.length ?? 0;
              if (e.key === "Escape") onClose();
              else if (e.key === "ArrowDown" && n > 0) {
                e.preventDefault();
                setActive((i) => (i + 1) % n);
              } else if (e.key === "ArrowUp" && n > 0) {
                e.preventDefault();
                setActive((i) => (i - 1 + n) % n);
              } else if (e.key === "Enter") {
                e.preventDefault();
                // Results for an earlier query are never opened: wait for this query's first match.
                if (!fresh) setOpenWhenReady(true);
                else if (results?.[active]) void open(results[active]);
              }
            }}
            placeholder="Search chats and sessions"
            aria-label="Search chats and sessions"
            aria-controls="search-results"
            aria-activedescendant={results?.[active] ? `search-result-${results[active].id}` : undefined}
            className="w-full bg-transparent py-3 text-[14px] outline-none placeholder:text-faint"
          />
          <kbd className="shrink-0 rounded border border-line/70 px-1.5 py-0.5 font-mono text-[10px] text-faint">esc</kbd>
        </div>
        <ul id="search-results" ref={list} role="listbox" aria-label="Results" aria-busy={!fresh} className={`max-h-[50vh] overflow-y-auto p-1.5 ${fresh ? "" : "opacity-60"}`}>
          {fresh && results !== null && results.length === 0 && (
            <li className="px-3 py-6 text-center text-[13px] text-faint">{query.trim() ? `Nothing titled "${query.trim()}".` : "No chats or sessions yet."}</li>
          )}
          {results?.map((s, i) => (
            <li
              key={s.id}
              id={`search-result-${s.id}`}
              data-index={i}
              role="option"
              aria-selected={i === active}
              onMouseMove={() => setActive(i)}
              onClick={() => fresh && void open(s)}
              className={`flex cursor-pointer items-center gap-2.5 rounded-md px-3 py-2 text-[13px] ${i === active ? "bg-raised text-fg" : "text-muted"}`}
            >
              <span className="flex shrink-0 text-fg">
                <ProviderIcon runtime={s.runtime} className="h-3 w-3" />
              </span>
              <span className="min-w-0 flex-1 truncate">{s.title}</span>
              <span className="shrink-0 text-[11px] text-faint">{where(s)}</span>
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}

export function SearchIcon({ className = "" }: { className?: string }) {
  return (
    <svg aria-hidden="true" viewBox="0 0 24 24" className={className} fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="11" cy="11" r="6.5" />
      <path d="m20 20-4.2-4.2" />
    </svg>
  );
}
