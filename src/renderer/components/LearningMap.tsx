import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { LearningMap as MapData, LearningMapTopic, TopicLevel } from "../../shared/types";
import { fitView, layoutGraph, type Point } from "../learning-map-layout";
import { usePeer } from "../store";
import { Constellation } from "./Constellation";
import { ProviderIcon } from "./ProviderIcon";

/**
 * The learning map (DESIGN.md, the Learning Space): every concept from the developer's sessions as
 * a star, brighter the further they went with it, joined to the concepts it came up with. Click a
 * star for the chats behind it. Drawn only from real sessions; an empty history is an empty sky.
 */

const LEVEL_LABEL: Record<TopicLevel, string> = {
  encountered: "Encountered",
  engaged: "Engaged",
  demonstrated: "Demonstrated",
};

const LEVEL_HINT: Record<TopicLevel, string> = {
  encountered: "It came up while you worked.",
  engaged: "You reasoned about it yourself.",
  demonstrated: "Your own reasoning about it was right, without hints.",
};

const radius = (t: LearningMapTopic) => 4.5 + Math.min(7, (Math.sqrt(t.mentions) - 1) * 2.5);

/** "just now", "5m ago", "3d ago", or a date. */
function ago(ms: number): string {
  const a = age(ms);
  return a === "now" ? "just now" : /\d$/.test(a) ? a : `${a} ago`;
}

function age(ms: number): string {
  const s = Math.max(0, (Date.now() - ms) / 1000);
  if (s < 60) return "now";
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86400) return `${Math.floor(s / 3600)}h`;
  if (s < 86400 * 30) return `${Math.floor(s / 86400)}d`;
  return new Date(ms).toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

export function LearningMapView({ sidebarOpen }: { sidebarOpen: boolean }) {
  const api = usePeer((s) => s.api);
  const version = usePeer((s) => s.learningMapVersion);
  const close = () => usePeer.getState().setLearningMapOpen(false);
  const [map, setMap] = useState<MapData | null>(null);
  const [enabled, setEnabled] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [query, setQuery] = useState("");

  // Only the newest request's answer is shown: an older one resolving late (say, from before a
  // clear) would put removed topics back.
  const mapRequest = useRef(0);
  const prefsRequest = useRef(0);
  const load = useCallback(() => {
    if (!api) return;
    const id = ++mapRequest.current;
    api
      .learningMap()
      .then((m) => {
        if (id !== mapRequest.current) return;
        setMap(m);
        setLoadError(null);
      })
      .catch((err: Error) => id === mapRequest.current && setLoadError(err.message));
  }, [api]);

  // On open, and again when topics are recorded or settings clear the map or switch tagging.
  useEffect(() => {
    load();
    const id = ++prefsRequest.current;
    api
      ?.preferences()
      .then((p) => id === prefsRequest.current && setEnabled(p.learningMap))
      .catch(() => {});
  }, [api, load, version]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape" || e.defaultPrevented) return;
      if (selected) setSelected(null);
      else close();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [selected]);

  const topic = map?.topics.find((t) => t.id === selected) ?? null;
  const q = query.trim().toLowerCase();
  const matches = useMemo(() => (q && map ? new Set(map.topics.filter((t) => t.name.toLowerCase().includes(q)).map((t) => t.id)) : null), [map, q]);

  return (
    <div className="relative flex min-h-0 flex-1 flex-col">
      <header className={`relative z-10 flex items-center gap-4 border-b border-line/70 py-3 pr-6 ${sidebarOpen ? "pl-6" : "pl-28"}`}>
        <div className="min-w-[9rem] flex-1">
          <h1 className="truncate text-[14px] font-medium">Learning map</h1>
          <div className="truncate text-[11px] text-faint">
            {map ? `${map.topics.length} topic${map.topics.length === 1 ? "" : "s"} · ${map.links.length} connection${map.links.length === 1 ? "" : "s"}` : "Loading…"}
            {!enabled && " · tagging is off"}
          </div>
        </div>
        {map && map.topics.length > 0 && (
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && matches && matches.size > 0) setSelected([...matches][0]!);
              if (e.key === "Escape" && query) {
                e.preventDefault();
                setQuery("");
              }
            }}
            placeholder="Find a topic"
            aria-label="Find a topic"
            className="w-48 rounded-md border border-line bg-bg px-2 py-1 text-[12px] outline-none placeholder:text-faint focus:border-accent"
          />
        )}
        <button onClick={close} title="Close the learning map (Esc)" className="text-[12px] text-faint hover:text-fg">
          Close
        </button>
      </header>

      {loadError && <div className="border-b border-line bg-danger/10 px-4 py-2 text-[12px] text-danger">{loadError}</div>}

      {map && map.topics.length === 0 ? (
        <EmptyMap enabled={enabled} />
      ) : map ? (
        <div className="relative min-h-0 flex-1">
          <MapCanvas map={map} selected={selected} matches={matches} onSelect={setSelected} />
          <Legend />
          {topic && <TopicPanel key={topic.id} map={map} topic={topic} onSelect={setSelected} onClose={() => setSelected(null)} />}
        </div>
      ) : (
        <div className="flex-1" />
      )}
    </div>
  );
}

function EmptyMap({ enabled }: { enabled: boolean }) {
  return (
    <div className="relative flex flex-1 items-center justify-center overflow-hidden">
      <Constellation />
      <div className="relative max-w-md text-center">
        <div className="text-[16px] font-semibold">Your map fills in as you work.</div>
        <p className="mt-2 text-[13px] leading-relaxed text-muted">
          {enabled ? (
            "Each concept a session deals with becomes a star here, brighter as you reason about it yourself, and joined to the concepts it came up with. Click a star to find the chats behind it."
          ) : (
            <>
              Tagging is off, so new sessions don't add topics.{" "}
              <button onClick={() => usePeer.getState().setSettingsOpen(true)} className="text-link underline-offset-2 hover:underline">
                Turn it on in settings
              </button>
              .
            </>
          )}
        </p>
      </div>
    </div>
  );
}

function Legend() {
  return (
    <div aria-hidden="true" className="pointer-events-none absolute bottom-4 left-5 flex flex-col gap-1.5 font-mono text-[10px] text-faint">
      {(["encountered", "engaged", "demonstrated"] as const).map((level) => (
        <div key={level} className="flex items-center gap-2">
          <svg viewBox="-8 -8 16 16" className="h-3.5 w-3.5">
            <Star level={level} r={3.5} />
          </svg>
          {LEVEL_LABEL[level].toLowerCase()}
        </div>
      ))}
    </div>
  );
}

/** One topic's dot: dim when it only came up, solid once engaged, accent with a halo once demonstrated. */
function Star({ level, r, halo = 4 }: { level: TopicLevel; r: number; halo?: number }) {
  if (level === "demonstrated") {
    return (
      <>
        <circle r={r + halo} fill="var(--color-accent)" className="constellation-halo" opacity={0.18} />
        <circle r={r} fill="var(--color-accent)" />
      </>
    );
  }
  return <circle r={r} fill="var(--color-constellation-node)" opacity={level === "engaged" ? 0.95 : 0.45} />;
}

interface View {
  x: number;
  y: number;
  k: number;
}

function MapCanvas({ map, selected, matches, onSelect }: { map: MapData; selected: string | null; matches: Set<string> | null; onSelect: (id: string | null) => void }) {
  const box = useRef<HTMLDivElement>(null);
  const svg = useRef<SVGSVGElement>(null);
  const [size, setSize] = useState({ w: 0, h: 0 });
  const [view, setView] = useState<View | null>(null);
  const [hovered, setHovered] = useState<string | null>(null);
  const positions = useRef<Map<string, Point>>(new Map());
  const [pos, setPos] = useState<Map<string, Point>>(new Map());

  useEffect(() => {
    const el = box.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setSize({ w: el.clientWidth, h: el.clientHeight }));
    ro.observe(el);
    setSize({ w: el.clientWidth, h: el.clientHeight });
    return () => ro.disconnect();
  }, []);

  // Lay the graph out again when topics or links change, keeping existing stars where they are.
  useEffect(() => {
    const next = layoutGraph(
      map.topics.map((t) => ({ id: t.id, r: radius(t) })),
      map.links,
      positions.current,
    );
    positions.current = next;
    setPos(next);
  }, [map]);

  // Fit once the size is known, and again when the canvas is resized before the developer moved it.
  const moved = useRef(false);
  useEffect(() => {
    if (size.w === 0 || pos.size === 0) return;
    if (!view || !moved.current) setView(fitView(pos.values(), size.w, size.h));
  }, [size, pos.size > 0]);

  const neighbors = useMemo(() => {
    const m = new Map<string, Set<string>>();
    for (const l of map.links) {
      if (!m.has(l.source)) m.set(l.source, new Set());
      if (!m.has(l.target)) m.set(l.target, new Set());
      m.get(l.source)!.add(l.target);
      m.get(l.target)!.add(l.source);
    }
    return m;
  }, [map]);

  // Zoom around the pointer. A non-passive listener, so the page itself never scrolls.
  useEffect(() => {
    const el = svg.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const rect = el.getBoundingClientRect();
      const px = e.clientX - rect.left;
      const py = e.clientY - rect.top;
      moved.current = true;
      setView((v) => {
        if (!v) return v;
        const k = Math.max(0.2, Math.min(4, v.k * Math.exp(-e.deltaY * 0.0015)));
        return { k, x: px - ((px - v.x) / v.k) * k, y: py - ((py - v.y) / v.k) * k };
      });
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, []);

  // Dragging: the background pans, a star moves. A press that doesn't move is a click.
  const drag = useRef<{ kind: "pan" | "node"; id?: string; startX: number; startY: number; x0: number; y0: number; travelled: number } | null>(null);
  const onPointerDown = (e: React.PointerEvent, id?: string) => {
    if (!view || e.button !== 0) return;
    e.stopPropagation();
    (e.currentTarget as Element).setPointerCapture?.(e.pointerId);
    const p = id ? pos.get(id) : null;
    drag.current = id && p ? { kind: "node", id, startX: e.clientX, startY: e.clientY, x0: p.x, y0: p.y, travelled: 0 } : { kind: "pan", startX: e.clientX, startY: e.clientY, x0: view.x, y0: view.y, travelled: 0 };
  };
  const onPointerMove = (e: React.PointerEvent) => {
    const d = drag.current;
    if (!d || !view) return;
    const dx = e.clientX - d.startX;
    const dy = e.clientY - d.startY;
    d.travelled = Math.max(d.travelled, Math.hypot(dx, dy));
    if (d.travelled < 3) return;
    moved.current = true;
    if (d.kind === "pan") setView({ ...view, x: d.x0 + dx, y: d.y0 + dy });
    else if (d.id) {
      const next = new Map(pos);
      next.set(d.id, { x: d.x0 + dx / view.k, y: d.y0 + dy / view.k });
      positions.current = next;
      setPos(next);
    }
  };
  const onPointerUp = () => {
    const d = drag.current;
    drag.current = null;
    if (!d || d.travelled >= 3) return;
    onSelect(d.kind === "node" ? (d.id ?? null) : null);
  };

  const focus = hovered ?? selected;
  const lit = (id: string) => {
    if (matches) return matches.has(id);
    if (!focus) return true;
    return id === focus || (neighbors.get(focus)?.has(id) ?? false);
  };
  const showLabels = map.topics.length <= 40 || (view?.k ?? 1) > 1.3;
  const byId = useMemo(() => new Map(map.topics.map((t) => [t.id, t])), [map]);
  // Zoomed out, stars keep their size on screen (so a big map is never dust); zoomed in, they grow.
  const grow = view ? Math.max(1, view.k) / view.k : 1;

  return (
    <div ref={box} className="absolute inset-0 overflow-hidden">
      <svg
        ref={svg}
        role="group"
        aria-label="Topics you have worked with. Tab to a topic and press Enter to see its chats."
        className="h-full w-full touch-none select-none"
        onPointerDown={(e) => onPointerDown(e)}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={() => (drag.current = null)}
        style={{ cursor: drag.current?.kind === "pan" ? "grabbing" : "default" }}
      >
        {view && (
          <g transform={`translate(${view.x} ${view.y}) scale(${view.k})`}>
            {map.links.map((l) => {
              const a = pos.get(l.source);
              const b = pos.get(l.target);
              const ta = byId.get(l.source);
              const tb = byId.get(l.target);
              if (!a || !b || !ta || !tb) return null;
              // Hairlines stop short of each star, the way printed charts join them.
              const d = Math.hypot(b.x - a.x, b.y - a.y) || 1;
              const ga = ((radius(ta) + 3) * grow) / d;
              const gb = ((radius(tb) + 3) * grow) / d;
              if (ga + gb >= 1) return null;
              const on = focus !== null && (l.source === focus || l.target === focus);
              const dim = (focus !== null || matches !== null) && !on;
              return (
                <line
                  key={`${l.source}|${l.target}`}
                  x1={a.x + (b.x - a.x) * ga}
                  y1={a.y + (b.y - a.y) * ga}
                  x2={b.x - (b.x - a.x) * gb}
                  y2={b.y - (b.y - a.y) * gb}
                  stroke={on ? "var(--color-accent)" : "var(--color-constellation-line)"}
                  strokeWidth={on ? 1.25 : 1}
                  strokeDasharray={l.related ? undefined : "3 3"}
                  vectorEffect="non-scaling-stroke"
                  opacity={dim ? 0.25 : on ? 0.9 : l.related ? 0.95 : 0.7}
                />
              );
            })}
            {map.topics.map((t) => {
              const p = pos.get(t.id);
              if (!p) return null;
              const r = radius(t) * grow;
              const isLit = lit(t.id);
              const isFocus = t.id === focus;
              const label = showLabels || isFocus || (focus !== null && isLit) || (matches?.has(t.id) ?? false) || t.mentions >= 3;
              return (
                <g
                  key={t.id}
                  transform={`translate(${p.x} ${p.y})`}
                  role="button"
                  tabIndex={0}
                  aria-label={`${t.name}: ${LEVEL_LABEL[t.level].toLowerCase()}, in ${t.sessions.length} chat${t.sessions.length === 1 ? "" : "s"}`}
                  aria-pressed={t.id === selected}
                  onPointerDown={(e) => onPointerDown(e, t.id)}
                  onPointerEnter={() => setHovered(t.id)}
                  onPointerLeave={() => setHovered((h) => (h === t.id ? null : h))}
                  onFocus={() => setHovered(t.id)}
                  onBlur={() => setHovered((h) => (h === t.id ? null : h))}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" || e.key === " ") {
                      e.preventDefault();
                      onSelect(t.id);
                    }
                  }}
                  className="map-star cursor-pointer outline-none"
                  opacity={isLit ? 1 : 0.2}
                >
                  {/* A generous, invisible hit area: small stars are still easy to click. */}
                  <circle r={Math.max(r + 6 * grow, 10 / view.k)} fill="transparent" />
                  {t.id === selected && <circle r={r + 6 * grow} fill="none" stroke="var(--color-accent)" strokeWidth={1} vectorEffect="non-scaling-stroke" />}
                  <circle className="map-star-ring" r={r + 6 * grow} fill="none" stroke="var(--color-accent)" strokeWidth={2} vectorEffect="non-scaling-stroke" />
                  <Star level={t.level} r={r} halo={4 * grow} />
                  {label && (
                    <text
                      y={r + 14 / view.k}
                      textAnchor="middle"
                      fontSize={11 / view.k}
                      className="font-mono"
                      fill={isFocus ? "var(--color-fg)" : "var(--color-muted)"}
                      style={{ paintOrder: "stroke", stroke: "var(--color-bg)", strokeWidth: 3 / view.k, strokeLinejoin: "round" }}
                    >
                      {t.name}
                    </text>
                  )}
                </g>
              );
            })}
          </g>
        )}
      </svg>
    </div>
  );
}

function TopicPanel({ map, topic, onSelect, onClose }: { map: MapData; topic: LearningMapTopic; onSelect: (id: string) => void; onClose: () => void }) {
  const connected = useMemo(() => {
    const ids = new Map<string, { weight: number; related: boolean }>();
    for (const l of map.links) {
      const other = l.source === topic.id ? l.target : l.target === topic.id ? l.source : null;
      if (other) ids.set(other, { weight: l.weight, related: l.related });
    }
    return map.topics.filter((t) => ids.has(t.id)).sort((a, b) => ids.get(b.id)!.weight - ids.get(a.id)!.weight);
  }, [map, topic.id]);

  async function open(sessionId: string) {
    const session = map.sessions[sessionId];
    if (!session) return;
    const { activeWorkspaceId, selectWorkspace, selectSession } = usePeer.getState();
    if (activeWorkspaceId !== session.workspaceId) await selectWorkspace(session.workspaceId);
    await selectSession(session.id);
  }

  return (
    <aside
      aria-label={`${topic.name}: chats`}
      className="absolute bottom-4 right-4 top-4 flex w-80 max-w-[calc(100%-2rem)] flex-col overflow-hidden rounded-xl border border-line bg-panel shadow-card"
    >
      <div className="border-b border-line/70 px-4 pb-3 pt-3.5">
        <div className="flex items-start gap-2">
          <div className="min-w-0 flex-1">
            <div className={`text-[11px] font-medium uppercase tracking-wider ${topic.level === "demonstrated" ? "text-accent" : "text-faint"}`} title={LEVEL_HINT[topic.level]}>
              Topic · {LEVEL_LABEL[topic.level]}
            </div>
            <h2 className="mt-1 text-[16px] font-semibold leading-snug">{topic.name}</h2>
          </div>
          <button onClick={onClose} aria-label="Close topic" title="Close (Esc)" className="-mr-1 px-1 text-[16px] leading-none text-faint hover:text-fg">
            ×
          </button>
        </div>
        <p className="mt-1.5 text-[12px] text-muted">
          {LEVEL_HINT[topic.level]} Came up {topic.mentions} time{topic.mentions === 1 ? "" : "s"} in {topic.sessions.length} chat{topic.sessions.length === 1 ? "" : "s"}, first {ago(topic.firstSeenAt)}.
        </p>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-2 py-2">
        <div className="px-2 pb-1 text-[11px] font-medium uppercase tracking-wider text-faint">Chats</div>
        <ul>
          {topic.sessions.map((s) => {
            const session = map.sessions[s.sessionId];
            if (!session) return null;
            return (
              <li key={s.sessionId}>
                <button onClick={() => void open(s.sessionId)} className="flex w-full items-center gap-2.5 rounded-md px-2 py-1.5 text-left text-[13px] text-muted hover:bg-raised hover:text-fg">
                  <span className="flex shrink-0 text-fg">
                    <ProviderIcon runtime={session.runtime} className="h-3 w-3" />
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block truncate">{session.title}</span>
                    <span className="block truncate text-[11px] text-faint">
                      {session.workspaceName} · {LEVEL_LABEL[s.level].toLowerCase()}
                      {s.mentions > 1 ? ` · ${s.mentions}×` : ""}
                    </span>
                  </span>
                  <span className="shrink-0 font-mono text-[11px] text-faint">{age(s.lastAt)}</span>
                </button>
              </li>
            );
          })}
        </ul>

        {connected.length > 0 && (
          <>
            <div className="px-2 pb-1 pt-3 text-[11px] font-medium uppercase tracking-wider text-faint">Connected</div>
            <div className="flex flex-wrap gap-1.5 px-2 pb-2">
              {connected.map((t) => (
                <button key={t.id} onClick={() => onSelect(t.id)} className="rounded border border-line/70 bg-raised px-1.5 py-0.5 font-mono text-[11px] text-muted hover:border-accent/60 hover:text-fg">
                  {t.name}
                </button>
              ))}
            </div>
          </>
        )}
      </div>
    </aside>
  );
}
