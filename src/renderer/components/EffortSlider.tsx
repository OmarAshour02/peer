import { useEffect, useRef, useState } from "react";
import { effortAbove, effortLabel, stepEffort, stopAt } from "../effort";

/**
 * Reasoning effort as a slider, in a popover opened from a pill in the composer toolbar.
 * Stops are the model's own levels, left (fastest) to right (thinks longest). "Default" is not a
 * point on the scale (it follows Runtime settings, else the CLI's config), so it is its own toggle.
 */
export function EffortSlider({
  levels,
  value,
  defaultLevel = null,
  capLevel = null,
  capHint,
  defaultHint,
  onChange,
}: {
  levels: string[];
  value: string | null;
  /** The level "Default" resolves to right now, when known: shown instead of the word "Default". */
  defaultLevel?: string | null;
  defaultHint: string;
  /** The CLI's own ceiling (Claude Code maxEffortLevel): a pick above it runs at it. */
  capLevel?: string | null;
  capHint?: string;
  onChange: (effort: string | null) => Promise<boolean>;
}) {
  const [open, setOpen] = useState(false);
  // The level under the pointer while dragging, and the level sent but not yet back as `value`.
  const [drag, setDrag] = useState<string | undefined>(undefined);
  const [pending, setPending] = useState<string | null | undefined>(undefined);
  const root = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const track = useRef<HTMLDivElement>(null);
  const dragging = useRef(false);

  useEffect(() => setPending(undefined), [value]);

  // Closing the popover (Escape, a click outside, the pill) drops an unfinished drag unsaved.
  useEffect(() => {
    if (open) return;
    dragging.current = false;
    setDrag(undefined);
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const away = (e: PointerEvent) => !root.current?.contains(e.target as Node) && setOpen(false);
    const esc = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      setOpen(false);
      trigger.current?.focus();
    };
    document.addEventListener("pointerdown", away);
    document.addEventListener("keydown", esc);
    return () => {
      document.removeEventListener("pointerdown", away);
      document.removeEventListener("keydown", esc);
    };
  }, [open]);

  const chosen = pending === undefined ? value : pending;
  const shown = drag ?? chosen;
  const index = shown === null ? null : levels.indexOf(shown);
  const at = index === null || index < 0 ? null : index;
  // On Default, the scale still shows where that lands (a hollow marker), when the level is on it.
  const defaultAt = defaultLevel ? levels.indexOf(defaultLevel) : -1;
  const onDefault = shown === null;
  const name = onDefault ? (defaultLevel ? effortLabel(defaultLevel) : "Default") : effortLabel(shown);
  const bars = onDefault ? (defaultAt >= 0 ? defaultAt + 1 : 0) : at === null ? 0 : at + 1;
  const pct = (i: number) => (levels.length > 1 ? (i / (levels.length - 1)) * 100 : 50);

  function pick(next: string | null) {
    setDrag(undefined);
    if (next === chosen) return;
    setPending(next);
    // A refused change shows the session's real effort again.
    void onChange(next).then((ok) => !ok && setPending(undefined));
  }

  function fromPointer(e: React.PointerEvent): string {
    const box = track.current!.getBoundingClientRect();
    return levels[stopAt((e.clientX - box.left) / box.width, levels.length)]!;
  }

  return (
    <div ref={root} className="relative mr-auto">
      <button
        ref={trigger}
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-label={`Reasoning effort: ${name}${onDefault ? " (default)" : ""}`}
        title={onDefault ? `Reasoning effort for this session: default. ${defaultHint}` : "Reasoning effort for this session"}
        className={`flex items-center gap-1.5 rounded-full border px-2 py-0.5 text-[12px] hover:text-fg ${open ? "border-accent/60 text-fg" : "border-line text-muted"}`}
      >
        <Bars filled={bars} total={levels.length} />
        {onDefault && !defaultLevel ? "Effort" : name}
        {onDefault && defaultLevel && <span className="text-faint">· default</span>}
      </button>

      {open && (
        <div role="dialog" aria-label="Reasoning effort" className="absolute bottom-full left-0 z-20 mb-2 w-72 rounded-xl border border-line/70 bg-panel p-3 shadow-card">
          <div className="mb-3 flex items-baseline justify-between gap-2">
            <div className="text-[12.5px] text-fg">
              Effort <span className="text-muted">· {name}{onDefault && defaultLevel ? " (default)" : ""}</span>
            </div>
            <button
              type="button"
              aria-pressed={onDefault}
              onClick={() => pick(null)}
              className={`rounded-full border px-2 py-0.5 text-[11px] ${onDefault ? "border-accent/60 text-fg" : "border-line text-muted hover:text-fg"}`}
            >
              {defaultLevel ? `Default · ${effortLabel(defaultLevel)}` : "Default"}
            </button>
          </div>

          <div
            ref={track}
            role="slider"
            tabIndex={0}
            aria-label="Reasoning effort"
            aria-valuemin={0}
            aria-valuemax={levels.length - 1}
            aria-valuenow={at ?? undefined}
            aria-valuetext={onDefault ? `${name} (default)` : name}
            onKeyDown={(e) => {
              const next = stepEffort(at, e.key, levels.length);
              if (next === null) return;
              e.preventDefault();
              pick(levels[next]!);
            }}
            onPointerDown={(e) => {
              dragging.current = true;
              e.currentTarget.setPointerCapture(e.pointerId);
              setDrag(fromPointer(e));
            }}
            onPointerMove={(e) => dragging.current && setDrag(fromPointer(e))}
            onPointerUp={(e) => {
              if (!dragging.current) return;
              dragging.current = false;
              pick(fromPointer(e));
            }}
            onPointerCancel={() => {
              dragging.current = false;
              setDrag(undefined);
            }}
            className="relative mx-2 h-5 cursor-pointer touch-none"
          >
            <div className="absolute inset-x-0 top-1/2 h-1 -translate-y-1/2 rounded-full bg-line" />
            {at !== null && <div className="absolute left-0 top-1/2 h-1 -translate-y-1/2 rounded-full bg-accent" style={{ width: `${pct(at)}%` }} />}
            {levels.map((l, i) => (
              <span
                key={l}
                className={`absolute top-1/2 h-1.5 w-1.5 -translate-x-1/2 -translate-y-1/2 rounded-full ${at !== null && i <= at ? "bg-accent-deep" : "bg-faint/60"}`}
                style={{ left: `${pct(i)}%` }}
              />
            ))}
            {at !== null && (
              <span
                className="absolute top-1/2 h-3.5 w-3.5 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-accent bg-fg shadow transition-[left] duration-100 motion-reduce:transition-none"
                style={{ left: `${pct(at)}%` }}
              />
            )}
            {onDefault && defaultAt >= 0 && (
              <span
                aria-hidden="true"
                title={`Default: ${effortLabel(defaultLevel!)}`}
                className="absolute top-1/2 h-3.5 w-3.5 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-accent/70 bg-panel"
                style={{ left: `${pct(defaultAt)}%` }}
              />
            )}
          </div>
          <div className="mt-1 flex justify-between text-[10.5px] text-faint">
            <span>{effortLabel(levels[0]!)}</span>
            <span>{effortLabel(levels[levels.length - 1]!)}</span>
          </div>

          <p className="mt-2.5 text-[11px] leading-snug text-muted">
            {shown === null
              ? defaultHint
              : capLevel && capHint && effortAbove(shown, capLevel)
                ? capHint
              : at === 0
                ? "Answers soonest, with the least thinking."
                : at === levels.length - 1
                  ? "Thinks longest before answering. Slowest, and uses the most tokens."
                  : "Higher thinks longer before answering; lower answers sooner."}
          </p>
        </div>
      )}
    </div>
  );
}

/** A small signal-bars glyph: how far up the scale the pick is. */
function Bars({ filled, total }: { filled: number; total: number }) {
  const bars = 4;
  const lit = total ? Math.ceil((filled / total) * bars) : 0;
  return (
    <svg width="11" height="10" viewBox="0 0 11 10" aria-hidden="true">
      {Array.from({ length: bars }, (_, i) => (
        <rect key={i} x={i * 3} y={7 - i * 2.3} width="2" height={3 + i * 2.3} rx="0.6" className={i < lit ? "fill-accent" : "fill-current opacity-35"} />
      ))}
    </svg>
  );
}
