import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { Checkpoint, CollaborationModeId, PeerMessage, PeerPart } from "../../shared/types";
import { stripTopicNotesInParts } from "../../shared/topics";
import { isFreshPart, usePeer } from "../store";
import { Constellation } from "./Constellation";
import { CheckpointCard, PermissionCard } from "./Interactions";
import { StreamingMarkdown } from "./StreamingMarkdown";

type ToolPart = Extract<PeerPart, { type: "tool" }>;

/** How long the constellation takes to fade out once the thread's first message lands. */
export const BACKDROP_FADE_MS = 900;

const prefersReducedMotion = () =>
  typeof window !== "undefined" && typeof window.matchMedia === "function" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;

/**
 * An empty thread is an orientation surface: the constellation spans the whole session pane,
 * behind the header and the composer too. When the thread's first message lands it fades out
 * rather than vanishing; switching to another session drops it at once.
 */
export function ThreadBackdrop() {
  const sessionId = usePeer((s) => s.snapshot?.session.id ?? null);
  const empty = usePeer((s) => Boolean(s.snapshot) && s.messages.length === 0);
  const [prev, setPrev] = useState({ sessionId, empty });
  const [leaving, setLeaving] = useState(false);
  // Derive "leaving" during render (not in an effect), so the figure never blinks out for a
  // frame between the first message and the start of the fade.
  if (prev.sessionId !== sessionId || prev.empty !== empty) {
    setPrev({ sessionId, empty });
    setLeaving(prev.empty && !empty && prev.sessionId === sessionId && !prefersReducedMotion());
  }
  useEffect(() => {
    if (!leaving) return;
    const t = setTimeout(() => setLeaving(false), BACKDROP_FADE_MS);
    return () => clearTimeout(t);
  }, [leaving]);
  if (empty) return <Constellation />;
  if (leaving) return <Constellation className="constellation-leave" />;
  return null;
}

/** How close to the end counts as "at the bottom" when the developer scrolls back down. */
const NEAR_BOTTOM_PX = 8;
/** Scroll movement this soon after a wheel, touch, key or pointer press is the developer's. */
const INTENT_MS = 1200;
const SCROLL_KEYS = new Set(["ArrowUp", "ArrowDown", "PageUp", "PageDown", "Home", "End", " "]);

/**
 * Keep the transcript pinned to its end while the developer is there, and let go the moment
 * they scroll up, however small the step: trackpads scroll a few pixels at a time, and a
 * distance threshold would snap them back on every streamed frame. Only the developer's own
 * input unpins (content shrinking also moves scrollTop); scrolling back to the end re-pins.
 */
export function useStickToBottom(sessionId: string | null, lastUserMessageId: string | null) {
  const scroller = useRef<HTMLDivElement>(null);
  const content = useRef<HTMLDivElement>(null);
  const stick = useRef(true);
  const lastTop = useRef(0);
  const intentAt = useRef(-Infinity);
  const [pinned, setPinned] = useState(true);

  const pin = useCallback((on: boolean) => {
    stick.current = on;
    setPinned(on);
  }, []);
  /**
   * At the very end: nothing is left to scroll to (sub-pixel slack). Content that shrinks while the
   * developer was scrolled up (a finished reply drops its "Working…" line, a diagram replaces its
   * source) can leave them there with no scroll down to re-pin, so this re-pins too.
   */
  const atEnd = useCallback(() => {
    const sc = scroller.current;
    return sc !== null && sc.scrollHeight - sc.scrollTop - sc.clientHeight <= 0.5;
  }, []);
  const toBottom = useCallback(() => {
    const sc = scroller.current;
    if (!sc) return;
    sc.scrollTop = sc.scrollHeight;
    lastTop.current = sc.scrollTop;
  }, []);

  // A session opens at its end, and so does the thread right after the developer sends a message.
  useLayoutEffect(() => {
    pin(true);
    toBottom();
  }, [sessionId, lastUserMessageId, pin, toBottom]);

  // New messages and parts re-render the transcript; streamed text grows inside its own component
  // and the composer can change the visible height, so follow both sizes too.
  useLayoutEffect(() => {
    if (stick.current) toBottom();
  });
  const hasScroller = sessionId !== null;
  useEffect(() => {
    const sc = scroller.current;
    const el = content.current;
    if (!sc || !el || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(() => {
      if (stick.current) toBottom();
      else if (atEnd()) pin(true);
    });
    ro.observe(el);
    ro.observe(sc);
    return () => ro.disconnect();
  }, [hasScroller, toBottom, atEnd, pin]);

  const intent = () => {
    intentAt.current = performance.now();
  };
  const handlers = {
    onWheel: (e: React.WheelEvent) => {
      intent();
      if (e.deltaY < 0 && stick.current) pin(false);
    },
    onTouchStart: intent,
    onTouchMove: intent,
    onPointerDown: intent,
    onKeyDown: (e: React.KeyboardEvent) => {
      if (SCROLL_KEYS.has(e.key)) intent();
    },
    onScroll: () => {
      const sc = scroller.current;
      if (!sc) return;
      const top = sc.scrollTop;
      const gap = sc.scrollHeight - top - sc.clientHeight;
      const byDeveloper = performance.now() - intentAt.current < INTENT_MS;
      // At the very end nobody is scrolled up, whatever moved the view there.
      if (gap <= 0.5) {
        if (!stick.current) pin(true);
      } else if (byDeveloper && top < lastTop.current - 0.5) {
        if (stick.current) pin(false);
      } else if (top > lastTop.current && gap <= NEAR_BOTTOM_PX) {
        if (!stick.current) pin(true);
      }
      lastTop.current = top;
    },
  };

  const jumpToLatest = useCallback(() => {
    pin(true);
    toBottom();
  }, [pin, toBottom]);

  return { scroller, content, pinned, handlers, jumpToLatest };
}

export function Transcript() {
  const { messages, snapshot } = usePeer();
  const mode = snapshot?.session.mode ?? "collaborate";
  const lastUserMessageId = useMemo(() => [...messages].reverse().find((m) => m.role === "user")?.id ?? null, [messages]);
  const { scroller, content, pinned, handlers, jumpToLatest } = useStickToBottom(snapshot?.session.id ?? null, lastUserMessageId);

  // Place each checkpoint where the agent asked it (its peer_checkpoint tool call).
  const { byPart, unplaced } = useMemo(() => placeCheckpoints(messages, snapshot?.checkpoints ?? []), [messages, snapshot?.checkpoints]);

  if (!snapshot) return <div className="flex-1" />;
  const empty = messages.length === 0;
  const busy = snapshot.status !== "idle";

  return (
    <div className="relative flex min-h-0 flex-1 flex-col">
      <div ref={scroller} {...handlers} tabIndex={-1} data-transcript-scroller className="min-h-0 flex-1 overflow-y-auto overscroll-contain outline-none [scrollbar-gutter:stable_both-edges]">
        <div ref={content} className={`relative mx-auto max-w-[1008px] px-6 py-6 ${empty ? "flex min-h-full flex-col justify-center" : ""}`}>
          {empty && <div className="text-center text-[13px] text-faint">Describe a task, ask a question, or paste an error to start.</div>}
          {messages.map((m) => (
            <Message key={m.id} message={m} checkpoints={byPart} mode={mode} live={busy && !m.completedAt} />
          ))}
          {unplaced.map((cp) => (
            <CheckpointCard key={cp.id} checkpoint={cp} mode={mode} />
          ))}
          {snapshot.permissions.map((p) => (
            <PermissionCard key={p.id} request={p} />
          ))}
          {snapshot.lastError && (
            <div className="my-3 rounded-md border border-danger/60 bg-danger/10 px-3 py-2 text-[13px] text-danger">{snapshot.lastError}</div>
          )}
          {busy && (
            <Working
              label={
                snapshot.checkpoints.some((c) => c.status === "pending")
                  ? "Waiting for you"
                  : snapshot.permissions.length > 0
                    ? "Waiting for your permission"
                    : snapshot.status === "retry"
                      ? "Provider busy, retrying…"
                      : "Working…"
              }
            />
          )}
          <div className="h-4" />
        </div>
      </div>
      {!pinned && !empty && (
        <button
          onClick={jumpToLatest}
          className="jump-latest absolute bottom-3 left-1/2 flex -translate-x-1/2 items-center gap-1.5 rounded-full border border-line bg-raised px-3 py-1 text-[12px] text-muted shadow-card hover:text-fg"
        >
          {busy && <span className="inline-block h-1.5 w-1.5 animate-pulse rounded-full bg-accent" />}
          Jump to latest ↓
        </button>
      )}
    </div>
  );
}

function placeCheckpoints(messages: PeerMessage[], checkpoints: Checkpoint[]) {
  const byPart = new Map<string, Checkpoint>();
  const used = new Set<string>();
  for (const m of messages) {
    for (const p of m.parts) {
      if (p.type !== "tool" || p.tool !== "peer_checkpoint") continue;
      const question = typeof p.input.question === "string" ? p.input.question.trim() : "";
      const cp = checkpoints.find((c) => !used.has(c.id) && c.question === question);
      if (cp) {
        used.add(cp.id);
        byPart.set(p.id, cp);
      }
    }
  }
  return { byPart, unplaced: checkpoints.filter((c) => !used.has(c.id)) };
}

function Working({ label }: { label: string }) {
  return (
    <div className="my-3 flex items-center gap-2 text-[12px] text-faint">
      <span className="inline-block h-2 w-2 animate-pulse rounded-full bg-accent" />
      {label}
    </div>
  );
}

function Message({ message, checkpoints, mode, live }: { message: PeerMessage; checkpoints: Map<string, Checkpoint>; mode: CollaborationModeId; live: boolean }) {
  if (message.role === "user") {
    const text = message.parts
      .filter((p): p is Extract<PeerPart, { type: "text" }> => p.type === "text" && !p.synthetic)
      .map((p) => p.text)
      .join("\n");
    if (text.startsWith("Resuming after an interruption.")) {
      return <div className="my-4 text-center text-[12px] text-faint">Resumed with your checkpoint answer</div>;
    }
    return (
      <div className="my-5 flex justify-end">
        <div className="max-w-[85%] whitespace-pre-wrap rounded-lg border border-line bg-raised px-4 py-2.5 text-[14px] leading-relaxed">{text}</div>
      </div>
    );
  }
  // The learning map's topic note is for Peer, not the developer; it may span text parts.
  const textParts = message.parts.filter((p): p is Extract<PeerPart, { type: "text" }> => p.type === "text" && !p.synthetic);
  const shown = new Map(stripTopicNotesInParts(textParts.map((p) => p.text)).map((t, i) => [textParts[i]!.id, t]));
  return (
    <div className="my-3">
      {message.parts.map((p, i) => {
        const cp = checkpoints.get(p.id);
        if (cp) return <CheckpointCard key={p.id} checkpoint={cp} mode={mode} />;
        const part = p.type === "text" && shown.has(p.id) ? { ...p, text: shown.get(p.id)! } : p;
        return <PartView key={p.id} part={part} live={partIsLive(message.parts, i, live)} />;
      })}
      {message.error && message.error !== "Stopped." && (
        <div className="my-2 rounded-md border border-danger/60 bg-danger/10 px-3 py-2 text-[13px] text-danger">{message.error}</div>
      )}
      {message.error === "Stopped." && <div className="my-2 text-[12px] text-faint">Stopped.</div>}
      {message.warning && <div className="my-2 rounded-md border border-warn/60 bg-warn/10 px-3 py-2 text-[13px] text-warn">{message.warning}</div>}
    </div>
  );
}

/**
 * Only the last part of a running reply is still being written. Once the agent moves on (a tool
 * call, a checkpoint question it is now waiting on), the text before it is final: it stops
 * animating and its diagrams render, even though the turn itself is still open.
 */
export function partIsLive(parts: readonly PeerPart[], index: number, messageLive: boolean): boolean {
  return messageLive && index === parts.length - 1;
}

function PartView({ part, live }: { part: PeerPart; live: boolean }) {
  switch (part.type) {
    case "text":
      if (part.synthetic || !part.text.trim()) return null;
      return <StreamingMarkdown text={part.text} live={live} fromStart={isFreshPart(part.id)} className="markdown my-2 text-[14px] text-fg" />;
    case "reasoning":
      return part.text.trim() ? <Reasoning text={part.text} /> : null;
    case "tool":
      return part.tool === "peer_checkpoint" ? null : <ToolCard part={part} />;
    case "patch":
      return part.files.length ? (
        <div className="my-1 text-[12px] text-faint">Changed {part.files.map((f) => f.split("/").pop()).join(", ")}</div>
      ) : null;
    default:
      return null;
  }
}

function Reasoning({ text }: { text: string }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="my-1.5">
      <button onClick={() => setOpen(!open)} className="text-[12px] text-faint hover:text-muted">
        {open ? "▾" : "▸"} Thinking
      </button>
      {open && <div className="mt-1 whitespace-pre-wrap border-l border-line pl-3 text-[12px] leading-relaxed text-faint">{text}</div>}
    </div>
  );
}

function summarize(part: ToolPart): string {
  const i = part.input;
  const str = (k: string) => (typeof i[k] === "string" ? (i[k] as string) : "");
  switch (part.tool) {
    case "bash":
      return str("command");
    case "read":
    case "edit":
    case "write":
      return str("filePath");
    case "glob":
    case "grep":
      return `${str("pattern")}${str("path") ? `  in ${str("path")}` : ""}`;
    case "task":
      return str("description");
    default:
      return part.title ?? "";
  }
}

const TOOL_LABEL: Record<string, string> = { bash: "Run", read: "Read", edit: "Edit", write: "Write", glob: "Find", grep: "Search", task: "Subagent", webfetch: "Fetch", todowrite: "Plan", apply_patch: "Patch" };

function ToolCard({ part }: { part: ToolPart }) {
  const isEdit = Boolean(part.diff);
  const [open, setOpen] = useState(false);
  // Runtimes may prefix the gate's reason (e.g. Claude Code's "PreToolUse:Bash hook error: ").
  const blocked = part.status === "error" && Boolean(part.error?.includes("Peer collaboration gate"));
  const statusColor =
    part.status === "error" ? (blocked ? "text-warn" : "text-danger") : part.status === "completed" ? "text-faint" : "text-accent";
  const summary = summarize(part);

  return (
    <div className="my-1.5 overflow-hidden rounded-xl border border-line/70 bg-panel">
      <button onClick={() => setOpen(!open)} className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-[12px] hover:bg-raised/60">
        <span className="w-14 shrink-0 font-medium text-muted">{TOOL_LABEL[part.tool] ?? part.tool}</span>
        <span className="min-w-0 flex-1 truncate font-mono text-fg/90">{summary}</span>
        <span className={`shrink-0 ${statusColor}`}>
          {blocked ? "blocked by gate" : part.status === "running" || part.status === "pending" ? "running…" : part.status === "error" ? "failed" : ""}
        </span>
      </button>
      {isEdit && !open && part.diff && <DiffView diff={part.diff} maxLines={14} />}
      {open && (
        <div className="border-t border-line/60">
          {part.diff ? (
            <DiffView diff={part.diff} />
          ) : (
            <pre className="max-h-80 overflow-auto whitespace-pre-wrap break-words px-3 py-2 font-mono text-[11.5px] text-muted">
              {part.error ?? part.output ?? JSON.stringify(part.input, null, 2)}
            </pre>
          )}
        </div>
      )}
    </div>
  );
}

export function DiffView({ diff, maxLines }: { diff: string; maxLines?: number }) {
  const lines = diff.split("\n").filter((l) => !l.startsWith("Index:") && !l.startsWith("====") && !l.startsWith("diff --git"));
  const shown = maxLines ? lines.slice(0, maxLines) : lines;
  return (
    <pre className="max-h-96 overflow-auto border-t border-line/60 bg-bg/60 py-1 font-mono text-[11.5px] leading-[1.45]">
      {shown.map((l, idx) => {
        const cls =
          l.startsWith("+") && !l.startsWith("+++")
            ? "bg-focus/10 text-focus"
            : l.startsWith("-") && !l.startsWith("---")
              ? "bg-danger/10 text-danger"
              : l.startsWith("@@")
                ? "text-learn/80"
                : "text-faint";
        return (
          <div key={idx} className={`whitespace-pre-wrap px-3 [overflow-wrap:anywhere] ${cls}`}>
            {l || " "}
          </div>
        );
      })}
      {maxLines && lines.length > maxLines && <div className="px-3 text-faint">… {lines.length - maxLines} more lines</div>}
    </pre>
  );
}
