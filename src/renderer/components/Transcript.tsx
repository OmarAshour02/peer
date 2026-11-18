import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { Checkpoint, CollaborationModeId, PeerMessage, PeerPart } from "../../shared/types";
import { stripTopicNotesInParts } from "../../shared/topics";
import { isFreshPart, usePeer } from "../store";
import { Constellation } from "./Constellation";
import { CheckpointCard, PermissionCard } from "./Interactions";
import { StreamingMarkdown } from "./StreamingMarkdown";
import { NOTHING_TO_UNDO } from "../../shared/types";
import { cleanError, groupable, heldReason, thinkingHeadline, turnErrors, isBlocked, isRunning, sameText, segmentTurn, toolGroupSummary, transcriptBlocks, type ToolPart } from "../turn-layout";
import { turnUsages, usageDetail, usageLine, type Usage } from "../usage";

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
  const usages = useMemo(() => turnUsages(messages), [messages]);
  const blocks = useMemo(() => transcriptBlocks(messages), [messages]);

  if (!snapshot) return <div className="flex-1" />;
  const empty = messages.length === 0;
  const busy = snapshot.status !== "idle";
  const pendingQuestion = snapshot.checkpoints.find((c) => c.status === "pending");
  const statusLabel = pendingQuestion
    ? "Waiting for you"
    : snapshot.permissions.length > 0
      ? "Waiting for your permission"
      : snapshot.status === "retry"
        ? "Provider busy, retrying…"
        : "Working…";
  const lastBlock = blocks.at(-1);
  // Undo sits with the turn it undoes: the last one, once it has ended.
  const undo = !busy && snapshot.undo && (snapshot.undo.available || snapshot.undo.reason !== NOTHING_TO_UNDO) ? <UndoTurn /> : null;

  return (
    <div className="relative flex min-h-0 flex-1 flex-col">
      <div ref={scroller} {...handlers} tabIndex={-1} data-transcript-scroller className="min-h-0 flex-1 overflow-y-auto overscroll-contain outline-none [scrollbar-gutter:stable_both-edges]">
        <div ref={content} className={`relative mx-auto max-w-[1008px] px-6 py-6 ${empty ? "flex min-h-full flex-col justify-center" : ""}`}>
          {empty && <div className="text-center text-[13px] text-faint">Describe a task, ask a question, or paste an error to start.</div>}
          {blocks.map((b) =>
            b.kind === "user" ? (
              <UserMessage key={b.message.id} message={b.message} />
            ) : (
              <AssistantTurn
                key={b.messages[0]!.id}
                messages={b.messages}
                checkpoints={byPart}
                mode={mode}
                busy={busy}
                usage={usages.get(b.messages.at(-1)!.id)}
                footer={b === lastBlock ? undo : null}
              />
            ),
          )}
          {lastBlock?.kind === "user" && undo && <div className="-mt-2 mb-3 flex justify-end">{undo}</div>}
          {unplaced.map((cp) => (
            <CheckpointCard key={cp.id} checkpoint={cp} mode={mode} />
          ))}
          {snapshot.permissions.map((p) => (
            <PermissionCard key={p.id} request={p} />
          ))}
          {snapshot.lastError && !messages.some((m) => m.error && cleanError(m.error) === cleanError(snapshot.lastError!)) && (
            <div className="my-3 rounded-md border border-danger/60 bg-danger/10 px-3 py-2 text-[13px] text-danger">{snapshot.lastError}</div>
          )}
          {busy && <Working label={statusLabel} />}
          <div className="h-4" />
        </div>
      </div>
      <StatusAnnouncer
        sessionId={snapshot.session.id}
        busy={busy}
        message={busy ? (pendingQuestion ? `The agent is waiting for your answer: ${pendingQuestion.question.slice(0, 200)}` : statusLabel) : null}
      />
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

/**
 * What a screen reader hears: the run's status as it changes, and its end. Only changes are
 * announced: opening a session that finished long ago says nothing.
 */
function StatusAnnouncer({ sessionId, busy, message }: { sessionId: string; busy: boolean; message: string | null }) {
  const [text, setText] = useState("");
  const seen = useRef({ sessionId, busy });
  useEffect(() => {
    const before = seen.current;
    seen.current = { sessionId, busy };
    if (before.sessionId !== sessionId) return setText(busy && message ? message : "");
    if (busy && message) setText(message);
    else if (!busy && before.busy) setText("The agent finished this turn.");
  }, [sessionId, busy, message]);
  return (
    <div role="status" aria-live="polite" className="sr-only">
      {text}
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

function UserMessage({ message }: { message: PeerMessage }) {
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

/** One rendered item of an agent turn: a part, or the end of a message (its error or warning). */
type TurnItem =
  | { kind: "part"; part: PeerPart; live: boolean; checkpoint?: Checkpoint }
  | { kind: "end"; message: PeerMessage; error: string | null };

function AssistantTurn({
  messages,
  checkpoints,
  mode,
  busy,
  usage,
  footer,
}: {
  messages: PeerMessage[];
  checkpoints: Map<string, Checkpoint>;
  mode: CollaborationModeId;
  busy: boolean;
  usage: Usage | undefined;
  /** Actions on this turn (Undo, on the last one). */
  footer?: React.ReactNode;
}) {
  const items: TurnItem[] = [];
  const errors = turnErrors(messages);
  for (const message of messages) {
    const live = busy && !message.completedAt;
    const error = errors.get(message.id) ?? null;
    const ownError = message.error ? cleanError(message.error) : null;
    // The learning map's topic note is for Peer, not the developer; it may span text parts.
    const textParts = message.parts.filter((p): p is Extract<PeerPart, { type: "text" }> => p.type === "text" && !p.synthetic);
    const shown = new Map(stripTopicNotesInParts(textParts.map((p) => p.text)).map((t, i) => [textParts[i]!.id, t]));
    // A reply that only repeats the turn's error (a usage limit) shows once, as the error, even when
    // the sentence arrived in several text parts.
    const repeatsError = ownError !== null && textParts.length > 0 && sameText([...shown.values()].join(""), ownError);
    message.parts.forEach((p, i) => {
      let part = p.type === "text" && shown.has(p.id) ? { ...p, text: shown.get(p.id)! } : p;
      if (part.type === "text" && repeatsError) part = { ...part, synthetic: true };
      items.push({ kind: "part", part, live: partIsLive(message.parts, i, live), checkpoint: checkpoints.get(p.id) });
    });
    items.push({ kind: "end", message, error });
  }
  const segments = segmentTurn(
    items,
    // A call Peer held is never folded into a group: it shows on its own line, with why.
    (it) => (it.kind === "part" && !it.checkpoint && groupable(it.part) && !isBlocked(it.part) ? it.part : null),
    (it) => (it.kind === "part" ? Boolean(it.checkpoint) || partVisible(it.part) : Boolean(it.error || it.message.warning)),
  );
  const done = !busy || messages.every((m) => m.completedAt);
  return (
    <div className="my-3">
      {segments.map((seg) => {
        if (seg.kind === "tools") return <ToolGroup key={seg.parts[0]!.id} parts={seg.parts} />;
        const it = seg.item;
        if (it.kind === "end") {
          return (
            <div key={`${it.message.id}:end`}>
              {it.error && it.error !== "Stopped." && <div className="my-2 rounded-md border border-danger/60 bg-danger/10 px-3 py-2 text-[13px] text-danger">{it.error}</div>}
              {it.error === "Stopped." && <div className="my-2 text-[12px] text-faint">Stopped.</div>}
              {it.message.warning && <div className="my-2 rounded-md border border-warn/60 bg-warn/10 px-3 py-2 text-[13px] text-warn">{it.message.warning}</div>}
            </div>
          );
        }
        if (it.checkpoint) return <CheckpointCard key={it.part.id} checkpoint={it.checkpoint} mode={mode} />;
        return <PartView key={it.part.id} part={it.part} live={it.live} />;
      })}
      {done && (usage || footer) && (
        <div className="mt-1 flex flex-wrap items-center gap-x-3 text-[11px]">
          {usage && (
            <span className="select-none tabular-nums text-faint" title={usageDetail(usage)}>
              {usageLine(usage)}
            </span>
          )}
          {footer}
        </div>
      )}
    </div>
  );
}

/** Whether PartView draws anything for this part. */
function partVisible(part: PeerPart): boolean {
  switch (part.type) {
    case "text":
      return !part.synthetic && part.text.trim() !== "";
    case "reasoning":
      return part.text.trim() !== "";
    case "tool":
      return part.tool !== "peer_checkpoint";
    case "patch":
      return part.files.length > 0;
    default:
      return false;
  }
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
      return part.text.trim() ? <Reasoning text={part.text} live={live} /> : null;
    case "tool":
      if (part.tool === "peer_checkpoint") return null;
      if (isBlocked(part)) return <HeldCall part={part} />;
      return part.diff ? <ToolCard part={part} /> : <ToolRow part={part} />;
    case "patch":
      return part.files.length ? (
        <div className="my-1 text-[12px] text-faint">Changed {part.files.map((f) => f.split("/").pop()).join(", ")}</div>
      ) : null;
    default:
      return null;
  }
}

/** The agent's reasoning, folded. While it is the part being written, the line shows what it is on. */
function Reasoning({ text, live }: { text: string; live: boolean }) {
  const [open, setOpen] = useState(false);
  const headline = live && !open ? thinkingHeadline(text) : "";
  return (
    <div className="my-1.5">
      <button onClick={() => setOpen(!open)} aria-expanded={open} className="flex max-w-full items-center gap-1.5 text-left text-[12px] text-faint hover:text-muted">
        <span className="shrink-0">{open ? "▾" : "▸"}</span>
        {live && <span className="inline-block h-1.5 w-1.5 shrink-0 animate-pulse rounded-full bg-accent" />}
        <span className="shrink-0">{live ? "Thinking" : "Thought"}</span>
        {headline && <span className="min-w-0 truncate text-faint">· {headline}</span>}
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

/**
 * The tool calls of a stretch of the turn, as one quiet line that opens into a list. While a call
 * runs, the line shows it; a lone call shows as its row.
 */
function ToolGroup({ parts }: { parts: ToolPart[] }) {
  const [open, setOpen] = useState(false);
  if (parts.length === 1) return <ToolRow part={parts[0]!} />;
  const running = parts.find(isRunning);
  return (
    <div className="my-1">
      <button
        onClick={() => setOpen(!open)}
        aria-expanded={open}
        className="group flex max-w-full items-center gap-1.5 py-0.5 text-left text-[12px] text-faint hover:text-muted"
      >
        <span className="w-3 shrink-0 text-center">{open ? "▾" : "▸"}</span>
        {running && !open ? (
          <>
            <span className="inline-block h-1.5 w-1.5 shrink-0 animate-pulse rounded-full bg-accent" />
            <span className="shrink-0">{TOOL_LABEL[running.tool] ?? running.tool}</span>
            <span className="min-w-0 truncate font-mono text-[11.5px]">{summarize(running)}</span>
          </>
        ) : (
          <span className="min-w-0 truncate">{toolGroupSummary(parts)}</span>
        )}
      </button>
      {open && (
        <div className="ml-[5px] border-l border-line/60 pl-3">
          {parts.map((p) => (
            <ToolRow key={p.id} part={p} />
          ))}
        </div>
      )}
    </div>
  );
}

/** One tool call: a plain line (label, what it ran, status) that opens to its output. */
function ToolRow({ part }: { part: ToolPart }) {
  const [open, setOpen] = useState(false);
  const blocked = isBlocked(part);
  const status = blocked ? "blocked" : isRunning(part) ? "running…" : part.status === "error" ? "failed" : "";
  const statusColor = blocked ? "text-warn/90" : part.status === "error" ? "text-danger/90" : "text-accent";
  return (
    <div>
      <button
        onClick={() => setOpen(!open)}
        aria-expanded={open}
        title={blocked ? "Peer's collaboration gate held this call" : undefined}
        className="flex w-full min-w-0 items-center gap-2 rounded px-1 py-0.5 text-left text-[12px] hover:bg-raised/50"
      >
        <span className="w-12 shrink-0 text-faint">{TOOL_LABEL[part.tool] ?? part.tool}</span>
        <span className="min-w-0 flex-1 truncate font-mono text-[11.5px] text-muted">{summarize(part)}</span>
        {status && <span className={`shrink-0 text-[11px] ${statusColor}`}>{status}</span>}
      </button>
      {open && (
        <pre className="my-1 ml-14 max-h-80 overflow-auto whitespace-pre-wrap break-words rounded-md bg-panel px-3 py-2 font-mono text-[11.5px] text-muted">
          {part.error ?? part.output ?? JSON.stringify(part.input, null, 2)}
        </pre>
      )}
    </div>
  );
}

/**
 * A call Peer's gate held before it ran: the moment Peer enforced something, so it gets its own
 * line (never folded into "Ran 5 commands"), with the reason in words, not only on hover.
 */
function HeldCall({ part }: { part: ToolPart }) {
  const what = summarize(part);
  return (
    <div className="my-1.5 flex items-baseline gap-2.5 rounded-md border border-warn/50 px-3 py-1.5 text-[12px]">
      <span className="shrink-0 font-medium text-warn">Peer held</span>
      <span className="min-w-0 flex-1">
        <span className="flex min-w-0 items-baseline gap-2">
          <span className="shrink-0 text-muted">{TOOL_LABEL[part.tool] ?? part.tool}</span>
          <span className="min-w-0 truncate font-mono text-[12px] text-fg" title={what}>
            {what}
          </span>
        </span>
        <span className="mt-0.5 block text-muted">{heldReason(part.error)}</span>
      </span>
    </div>
  );
}

/**
 * Undo, on the last turn it would undo. It asks in place (not a system dialog): the files the turn
 * changed go back, and the turn leaves the conversation.
 */
function UndoTurn() {
  const api = usePeer((s) => s.api);
  const snapshot = usePeer((s) => s.snapshot);
  const [confirming, setConfirming] = useState(false);
  const [running, setRunning] = useState(false);
  const confirmButton = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (confirming) confirmButton.current?.focus();
  }, [confirming]);
  if (!snapshot) return null;
  const { undo, session } = snapshot;

  async function run() {
    if (!api) return;
    setRunning(true);
    try {
      await api.undoTurn(session.id);
    } catch (err) {
      usePeer.getState().setError(err instanceof Error ? err.message : String(err));
    } finally {
      setRunning(false);
      setConfirming(false);
    }
  }

  if (!undo.available) {
    // Said briefly in place; the full reason is one hover away.
    // A general chat has no project to restore: nothing to say there.
    const general = usePeer.getState().workspaces.find((w) => w.id === session.workspaceId)?.general === true;
    const short = undo.reason?.includes("git repository") ? (general ? null : "No undo: not a git repository") : undo.reason === "Undoing…" ? "Undoing…" : null;
    return short ? (
      <span className="text-muted" title={undo.reason ?? undefined}>
        {short}
      </span>
    ) : null;
  }
  if (!confirming) {
    return (
      <button onClick={() => setConfirming(true)} className="rounded px-1 text-muted hover:bg-raised hover:text-fg">
        Undo this turn
      </button>
    );
  }
  return (
    <span
      role="group"
      aria-label="Undo this turn"
      className="flex flex-wrap items-center gap-2 text-[12px]"
      onKeyDown={(e) => {
        if (e.key === "Escape") {
          e.preventDefault();
          setConfirming(false);
        }
      }}
    >
      <span className="text-fg">Revert the files this turn changed and remove it from the conversation?</span>
      <button ref={confirmButton} disabled={running} onClick={() => void run()} className="rounded-md border border-danger/60 px-2 py-0.5 text-danger hover:bg-danger/10 disabled:opacity-40">
        {running ? "Undoing…" : "Undo turn"}
      </button>
      <button disabled={running} onClick={() => setConfirming(false)} className="rounded-md px-2 py-0.5 text-muted hover:text-fg">
        Cancel
      </button>
    </span>
  );
}

/** An edit with a diff: the diff is the point, so it shows as a card with a preview. */
function ToolCard({ part }: { part: ToolPart }) {
  const [open, setOpen] = useState(false);
  const blocked = isBlocked(part);
  const statusColor = part.status === "error" ? (blocked ? "text-warn" : "text-danger") : "text-accent";
  return (
    <div className="my-1.5 overflow-hidden rounded-lg border border-line/50">
      <button onClick={() => setOpen(!open)} className="flex w-full items-center gap-2 px-3 py-1 text-left text-[12px] hover:bg-raised/50">
        <span className="w-12 shrink-0 text-faint">{TOOL_LABEL[part.tool] ?? part.tool}</span>
        <span className="min-w-0 flex-1 truncate font-mono text-[11.5px] text-muted">{summarize(part)}</span>
        <span className={`shrink-0 text-[11px] ${statusColor}`}>
          {blocked ? "blocked" : isRunning(part) ? "running…" : part.status === "error" ? "failed" : ""}
        </span>
      </button>
      {part.diff && <DiffView diff={part.diff} maxLines={open ? undefined : 14} />}
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
