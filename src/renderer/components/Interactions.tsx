import { useEffect, useRef, useState } from "react";
import type { Checkpoint, CheckpointAction, CollaborationModeId, PermissionReply, PermissionRequest } from "../../shared/types";
import { CATEGORY_UI, CONTROL_UI } from "../modes";
import { usePeer } from "../store";
import { StreamingMarkdown } from "./StreamingMarkdown";

function useAct() {
  const api = usePeer((s) => s.api);
  const setError = usePeer((s) => s.setError);
  const [busy, setBusy] = useState(false);
  async function run(fn: () => Promise<unknown>) {
    if (busy) return;
    setBusy(true);
    try {
      await fn();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }
  return { api, busy, run };
}

/** A decision the agent brought to the developer. Pending checkpoints block the agent. */
export function CheckpointCard({ checkpoint: cp, mode }: { checkpoint: Checkpoint; mode: CollaborationModeId }) {
  const { api, busy, run } = useAct();
  // While discussing, the way out of the discussion is to proceed.
  const discussing = usePeer((s) => s.snapshot?.session.discussing === true || (s.snapshot?.gate.locked === true && s.snapshot.gate.kind === "hold"));
  // The turn this checkpoint belongs to is still running.
  const running = usePeer((s) => s.snapshot?.turn?.id === cp.turnId && s.snapshot?.turn?.endedAt === null && s.snapshot?.status !== "idle");
  const [text, setText] = useState("");
  const open = cp.status === "pending" || cp.status === "interrupted";
  const card = useRef<HTMLDivElement>(null);
  // A question that arrives takes the keyboard, unless the developer is writing somewhere: the
  // card is where it is answered.
  useEffect(() => {
    if (cp.status !== "pending" || !card.current) return;
    const active = document.activeElement;
    const writing = (active instanceof HTMLTextAreaElement || active instanceof HTMLInputElement) && active.value.trim() !== "";
    if (writing || (active && active !== document.body && active.closest("[role=dialog]"))) return;
    card.current.focus({ preventScroll: true });
  }, [cp.status]);
  const resolve = (action: CheckpointAction, extra: { text?: string; option?: string } = {}) =>
    run(() => api!.resolveCheckpoint(cp.id, action, extra));

  // Peer noted a decision it detected without interrupting (Focus, "Just do it").
  if (cp.status === "auto_resolved" && cp.decision) {
    return (
      <div className="my-2 rounded-md border border-dashed border-line px-3 py-2 text-[12px] text-faint">
        <span className="text-muted">Noted by Peer, not asked:</span> {cp.question}
        <div className="mt-0.5">
          {cp.context} {cp.resolution?.note}.
        </div>
      </div>
    );
  }

  if (cp.status === "auto_resolved" && cp.category === "routine") {
    return (
      <div className="my-2 rounded-md border border-dashed border-line px-3 py-2 text-[12px] text-faint">
        <span className="text-muted">Routine work, no question asked:</span> {cp.question}
        {cp.resolution?.note?.includes("unlocked") && (
          <div className="mt-1 flex items-center gap-2">
            <span>Code changes unlocked for this task.</span>
            {running && (
              <button
                disabled={busy}
                onClick={() => run(() => api!.contestRoutine(cp.id))}
                title="This task deserves your reasoning: lock code changes again until the agent asks you"
                className="rounded border border-line px-2 py-0.5 text-[11.5px] text-muted hover:text-fg disabled:opacity-40"
              >
                Not routine, ask me
              </button>
            )}
          </div>
        )}
        {cp.resolution?.note?.includes("refused") ? (
          <div className="mt-0.5">Not accepted: you said this task is not routine.</div>
        ) : (
          cp.resolution?.note?.includes("not routine") && <div className="mt-0.5">You said this is not routine; the agent asks you before changing code.</div>
        )}
      </div>
    );
  }

  if (cp.status === "auto_resolved" && cp.resolution?.repeatOf) {
    return (
      <div className="my-2 rounded-md border border-dashed border-line px-3 py-2 text-[12px] text-faint">
        <span className="text-muted">Not asked again:</span> {cp.question}
        <div className="mt-0.5">You already answered this in this session; the agent was given your earlier answer.</div>
      </div>
    );
  }

  if (cp.status === "auto_resolved") {
    return (
      <div className="my-2 rounded-md border border-dashed border-line px-3 py-2 text-[12px] text-faint">
        <span className="text-muted">Not asked ({CATEGORY_UI[cp.category]}):</span> {cp.question}
        <div className="mt-0.5">Peer policy: {cp.resolution?.note}. The agent decided.</div>
      </div>
    );
  }

  const r = cp.resolution;
  // Peer paused a tool call itself: the options already say go ahead or not, so skipping the
  // discussion means the same as going ahead; hints are for Learn's reasoning questions.
  const peer = cp.source === "peer";
  const kind = peer ? "Peer paused the agent" : CATEGORY_UI[cp.category];
  const detail = peer ? (cp.decision?.kind === "contract" ? "public API change" : cp.decision?.kind === "approach" ? "large change" : "new dependency") : null;

  if (!open) return <ResolvedCheckpoint checkpoint={cp} kind={kind} detail={detail} />;

  /**
   * 1–9 move to an option and the arrow keys move between them; Enter (or Space) on the option
   * chooses it. A key never answers by itself: the card can take focus on its own, and a stray
   * digit must not make a decision.
   */
  function onCardKey(e: React.KeyboardEvent<HTMLDivElement>) {
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    if (e.target instanceof HTMLTextAreaElement || e.target instanceof HTMLInputElement) return;
    const buttons = [...(card.current?.querySelectorAll<HTMLButtonElement>("[data-option]") ?? [])];
    if (buttons.length === 0) return;
    const at = buttons.indexOf(e.target as HTMLButtonElement);
    const n = Number(e.key);
    let next: number | null = null;
    if (Number.isInteger(n) && n >= 1 && n <= buttons.length) next = n - 1;
    else if (e.key === "ArrowDown") next = at === -1 ? 0 : Math.min(buttons.length - 1, at + 1);
    else if (e.key === "ArrowUp") next = at === -1 ? 0 : Math.max(0, at - 1);
    if (next === null) return;
    e.preventDefault();
    buttons[next]!.focus();
  }

  return (
    <div
      ref={card}
      tabIndex={-1}
      role="group"
      aria-label={`${kind}: question waiting for you`}
      data-checkpoint-pending={cp.status === "pending" ? "" : undefined}
      onKeyDown={onCardKey}
      className="checkpoint-card my-3 rounded-xl border border-accent/60 bg-panel px-4 py-3 shadow-card"
    >
      <div className="mb-1.5 flex flex-wrap items-center gap-x-2 text-[11px] uppercase tracking-wider">
        <span className="text-accent">{kind}</span>
        {detail && <span className="text-muted">· {detail}</span>}
        {cp.status === "pending" && <span className="normal-case tracking-normal text-muted">· the agent is waiting for you</span>}
        {cp.status === "interrupted" && <span className="normal-case tracking-normal text-warn">· the run ended before you answered; answering resumes it</span>}
      </div>
      {/* Questions can carry code (a rule to diagnose, a query to read): render them as Markdown, like the context. */}
      <StreamingMarkdown text={cp.question} live={false} className="markdown checkpoint-question text-[15px] font-semibold leading-snug text-fg" />
      {cp.context && <StreamingMarkdown text={cp.context} live={false} className="markdown mt-1.5 text-[13px] text-muted" />}

      {cp.options.length > 0 && (
        <div className="mt-3 flex flex-col gap-1.5" role="group" aria-label="Options">
          {cp.options.map((o, i) => (
            <button
              key={o.label}
              data-option
              disabled={busy}
              aria-keyshortcuts={i < 9 ? String(i + 1) : undefined}
              onClick={() => resolve("choose", { option: o.label, text: text || undefined })}
              className="flex items-start gap-3 rounded-md border border-line bg-bg/40 px-3 py-2 text-left text-[13px] hover:border-accent/70 focus-visible:border-accent focus-visible:bg-accent/10 disabled:opacity-60"
            >
              {i < 9 && (
                <kbd aria-hidden="true" className="mt-px shrink-0 rounded border border-line px-1.5 font-mono text-[11px] text-muted">
                  {i + 1}
                </kbd>
              )}
              <span className="min-w-0 flex-1">
                <span className="flex items-center gap-2">
                  <span className="font-medium text-fg">{o.label}</span>
                  {cp.recommendation === o.label && <span className="text-[11px] text-accent">recommended</span>}
                </span>
                {o.description && <span className="mt-0.5 block text-[12px] text-muted">{o.description}</span>}
              </span>
            </button>
          ))}
          <p className="text-[11px] text-muted">
            {cp.options.length > 1 ? `1–${Math.min(9, cp.options.length)} or ↑↓ to move, Enter to choose` : "Enter to choose"}
          </p>
        </div>
      )}

      <div className="mt-3">
        <textarea
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing && text.trim()) {
              e.preventDefault();
              void resolve("answer", { text });
            }
          }}
          rows={2}
          aria-label={cp.options.length ? "Answer in your own words" : "Your answer"}
          placeholder={cp.options.length ? "Or answer in your own words… (Enter sends)" : "Your answer… (Enter sends)"}
          className="w-full resize-none rounded-md border border-line bg-bg px-3 py-2 text-[13px] outline-none placeholder:text-faint focus:border-accent"
        />
        <div className="mt-2 flex flex-wrap items-center gap-2">
          <Btn primary disabled={busy || !text.trim()} onClick={() => resolve("answer", { text })}>
            Answer
          </Btn>
          {/* Handing over or slowing down: kept apart from answering, and quieter. */}
          <span aria-hidden="true" className="mx-1 h-4 w-px bg-line" />
          {mode === "learn" ? (
            <>
              <Btn disabled={busy} onClick={() => resolve("hint", { text: text || undefined })} title={CONTROL_UI.hint.hint}>
                {CONTROL_UI.hint.label}
              </Btn>
              <Btn disabled={busy} onClick={() => resolve("direct", { text: text || undefined })} title={CONTROL_UI.answer.hint}>
                {CONTROL_UI.answer.label}
              </Btn>
            </>
          ) : (
            <>
              <Btn disabled={busy} onClick={() => resolve("discuss", { text: text || undefined })} title={CONTROL_UI.discuss.hint}>
                {CONTROL_UI.discuss.label}
              </Btn>
              {discussing && !peer && (
                <Btn disabled={busy} onClick={() => resolve("skip", { text: text || undefined })} title="Stop discussing and implement the agreed approach">
                  Proceed
                </Btn>
              )}
              <Btn disabled={busy} onClick={() => resolve("go", { text: text || undefined })} title={`${CONTROL_UI.delegate.hint} Covers this question and the rest of the task.`}>
                {CONTROL_UI.delegate.label}
              </Btn>
            </>
          )}
          <Btn
            disabled={busy}
            onClick={() => resolve("delegate", { text: text || undefined })}
            title={peer ? "Let the agent go ahead with this call" : "Let the agent make this one call; later questions still come to you"}
          >
            {DELEGATE_ONE}
          </Btn>
        </div>
      </div>
    </div>
  );
}

/** "You decide" on a question: the agent makes this one call. Named for who decides. */
export const DELEGATE_ONE = "Agent decides this one";

/**
 * An answered (or cancelled) question: the question and what the developer chose, as a record.
 * The options and context fold away; they open on request.
 */
function ResolvedCheckpoint({ checkpoint: cp, kind, detail }: { checkpoint: Checkpoint; kind: string; detail: string | null }) {
  const [expanded, setExpanded] = useState(false);
  const r = cp.resolution;
  const hasMore = cp.options.length > 0 || Boolean(cp.context);
  return (
    <div className="my-3 rounded-xl border border-dashed border-line px-4 py-2.5">
      <div className="mb-1 flex flex-wrap items-center gap-x-2 text-[11px] uppercase tracking-wider text-muted">
        <span>{kind}</span>
        {detail && <span>· {detail}</span>}
        {cp.status === "cancelled" && <span className="normal-case tracking-normal">· cancelled</span>}
      </div>
      <StreamingMarkdown text={cp.question} live={false} className="markdown checkpoint-question text-[14px] font-medium leading-snug text-fg" />
      {r && (
        <div className="mt-1.5 text-[12px] text-fg">
          <span className="text-muted">You: </span>
          {r.action === "choose" && <>chose “{r.option}”</>}
          {r.action === "answer" && <>“{r.text}”</>}
          {r.action === "delegate" && <>let the agent decide this one</>}
          {r.action === "skip" && <>chose to proceed</>}
          {r.action === "go" && <>said Just do it (the agent decides the rest of this task)</>}
          {r.action === "direct" && <>asked for the direct answer</>}
          {r.action === "discuss" && <>asked to discuss first</>}
          {r.action === "hint" && <>asked for a hint</>}
          {r.action === "cancelled" && <>{r.note}</>}
          {r.text && r.action !== "answer" && <> · “{r.text}”</>}
        </div>
      )}
      {hasMore && (
        <button onClick={() => setExpanded(!expanded)} aria-expanded={expanded} className="mt-1 text-[12px] text-muted hover:text-fg">
          {expanded ? "Hide the details" : cp.options.length ? `Show the ${cp.options.length} options` : "Show the context"}
        </button>
      )}
      {expanded && (
        <div className="mt-2">
          {cp.context && <StreamingMarkdown text={cp.context} live={false} className="markdown text-[13px] text-muted" />}
          {cp.options.length > 0 && (
            <ul className="mt-2 flex flex-col gap-1">
              {cp.options.map((o) => {
                const chosen = r?.option === o.label;
                return (
                  <li key={o.label} className={`rounded-md border px-3 py-1.5 text-[12px] ${chosen ? "border-accent/70" : "border-line"}`}>
                    <span className={chosen ? "font-medium text-fg" : "text-muted"}>{o.label}</span>
                    {chosen && <span className="ml-2 text-[11px] text-accent">your choice</span>}
                    {cp.recommendation === o.label && <span className="ml-2 text-[11px] text-muted">recommended</span>}
                    {o.description && <span className="mt-0.5 block text-muted">{o.description}</span>}
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}

/** A runtime permission request (destructive command, outside-workspace access…). Same in every mode. */
export function PermissionCard({ request }: { request: PermissionRequest }) {
  const { api, busy, run } = useAct();
  const reply = (r: PermissionReply) => run(() => api!.replyPermission(request.id, r));
  // Claude Code says what "Always allow" saves; it is often narrower than it sounds (one exact command).
  const always = Array.isArray(request.metadata.always) ? (request.metadata.always as { grant: string; scope: string }[]) : null;
  return (
    <div className="my-3 rounded-xl border border-warn/60 bg-panel px-4 py-3 shadow-card">
      <div className="text-[11px] uppercase tracking-wider text-warn">Permission needed · {request.permission}</div>
      <pre className="mt-1.5 whitespace-pre-wrap break-all font-mono text-[12px] text-fg">{request.patterns.join("\n")}</pre>
      <div className="mt-2 flex gap-2">
        <Btn primary disabled={busy} onClick={() => reply("once")}>
          Allow once
        </Btn>
        {always?.length !== 0 && (
          <Btn disabled={busy} onClick={() => reply("always")}>
            Always allow
          </Btn>
        )}
        <Btn disabled={busy} onClick={() => reply("reject")}>
          Reject
        </Btn>
      </div>
      {always && always.length > 0 && (
        <div className="mt-2 text-[11px] text-faint">
          <span className="text-muted">Always allow saves:</span>
          {always.map((a) => (
            <div key={`${a.grant}|${a.scope}`} className="mt-0.5 break-all">
              <code className="font-mono text-muted">{a.grant}</code> · {a.scope}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

export function Btn(props: { children: React.ReactNode; onClick: () => void; disabled?: boolean; primary?: boolean; title?: string }) {
  return (
    <button
      title={props.title}
      disabled={props.disabled}
      onClick={props.onClick}
      className={`rounded-md border px-3 py-1 text-[12px] disabled:cursor-not-allowed disabled:opacity-40 ${
        props.primary ? "border-accent bg-accent/15 text-fg hover:bg-accent/25" : "border-line bg-raised text-muted hover:text-fg"
      }`}
    >
      {props.children}
    </button>
  );
}
