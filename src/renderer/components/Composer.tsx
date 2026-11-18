import { useEffect, useRef, useState } from "react";
import { PRIMARY_MODES, type CollaborationModeId, type EffortDefault, type TurnIntent } from "../../shared/types";
import { CONTROL_UI, MODE_CONTROLS, MODE_UI } from "../modes";
import { effortLabel, effortOptions, modelEfforts } from "../effort";
import { queuedAsDraft, queuedControlLabel, withReturnedDraft } from "../queue";
import { EffortSlider } from "./EffortSlider";
import { RUNTIME_UI } from "../runtimes";
import { runtimeInfo, updateDraft, usePeer } from "../store";

/** Model picker entry that opens "Models & providers" instead of choosing a model. */
const CONNECT = "__connect__";

/** Bring the open question into view and put the keyboard on it (its card owns the answer). */
export function focusPendingCheckpoint() {
  const card = document.querySelector<HTMLElement>("[data-checkpoint-pending]");
  if (!card) return;
  card.scrollIntoView?.({ block: "center", behavior: "smooth" });
  card.focus({ preventScroll: true });
}

/** Where the default effort comes from, in words, for the Effort popover. */
export function effortDefaultHint(d: EffortDefault | null, runtime: string): string {
  if (!d) return `Not set in Runtime settings or ${runtime}'s configuration: ${runtime} decides.`;
  const level = effortLabel(d.level);
  const from = d.source === "settings" ? "Runtime settings" : d.source === "cli" ? `${runtime}'s own configuration` : "the model's default";
  if (d.cappedFrom) return `${level}: ${from} asks for ${effortLabel(d.cappedFrom)}, and ${runtime}'s maxEffortLevel caps it at ${level}.`;
  return d.source === "model" ? `${level}, the model's default.` : `${level}, from ${from}.`;
}

/** The composer's text after a send: what was sent goes, whatever was typed meanwhile stays. */
export function afterSubmit(current: string, submitted: string): string {
  if (current === submitted) return "";
  return current.startsWith(submitted) ? current.slice(submitted.length).replace(/^\s+/, "") : current;
}

export function Composer() {
  const { api, snapshot, models, modelsError } = usePeer();
  const runtimes = usePeer((s) => s.runtimes);
  const setError = usePeer((s) => s.setError);
  const hasMessages = usePeer((s) => s.messages.length > 0);
  const composerFocus = usePeer((s) => s.composerFocus);
  const returnedDraft = usePeer((s) => (s.snapshot ? (s.returnedDrafts[s.snapshot.session.id] ?? null) : null));
  const sessionId = snapshot?.session.id ?? null;
  // The draft lives in the store, per session: it survives switching sessions and the learning
  // map, and an unsent draft keeps its session from being discarded as unused.
  const text = usePeer((s) => (sessionId ? (s.drafts[sessionId] ?? "") : ""));
  const sending = usePeer((s) => Boolean(sessionId && s.sendingIn[sessionId]));
  const setText = (next: string | ((current: string) => string)) => sessionId && updateDraft(sessionId, next);
  const setSendingIn = (id: string, on: boolean) => usePeer.setState((s) => ({ sendingIn: { ...s.sendingIn, [id]: on } }));
  const input = useRef<HTMLTextAreaElement>(null);
  const modeButtons = useRef<Map<CollaborationModeId, HTMLButtonElement>>(new Map());
  const settingsVersion = usePeer((s) => s.settingsVersion);
  const modelKey = snapshot?.session.model ? `${snapshot.session.model.providerId}/${snapshot.session.model.modelId}` : "";
  // What "Default" means for this session right now, so the pill can name the level.
  const [effortDefault, setEffortDefault] = useState<EffortDefault | null>(null);
  const [effortCap, setEffortCap] = useState<string | null>(null);
  useEffect(() => {
    setEffortDefault(null);
    setEffortCap(null);
    if (!api || !sessionId) return;
    let current = true;
    api
      .effortDefault(sessionId)
      .then((r) => {
        if (!current) return;
        setEffortDefault(r.default);
        setEffortCap(r.cap ?? null);
      })
      .catch(() => {});
    return () => {
      current = false;
    };
  }, [api, sessionId, modelKey, settingsVersion]);

  // Opening or creating a session puts the keyboard here, unless a question is waiting: then its
  // card has it (the card is where it is answered).
  useEffect(() => {
    if (!sessionId) return;
    const card = document.querySelector<HTMLElement>("[data-checkpoint-pending]");
    if (card) card.focus({ preventScroll: true });
    else input.current?.focus();
  }, [sessionId]);
  // ⌘L asks for the message box itself.
  const firstFocus = useRef(composerFocus);
  useEffect(() => {
    if (composerFocus !== firstFocus.current) input.current?.focus();
  }, [composerFocus]);

  // A queued message that came back unsent (Stop, or it failed) is the developer's text again.
  // Taken from the store, not from the render: an effect that runs twice (StrictMode) finds it gone.
  useEffect(() => {
    if (!returnedDraft || !sessionId) return;
    const { [sessionId]: back, ...rest } = usePeer.getState().returnedDrafts;
    if (!back) return;
    usePeer.setState({ returnedDrafts: rest });
    setText((draft) => withReturnedDraft(draft, { text: back, intent: "default" }));
    input.current?.focus();
  }, [returnedDraft, sessionId]);

  if (!snapshot) return null;

  const { session, status, gate, queued } = snapshot;
  const busy = status !== "idle";
  const waitingOnCheckpoint = snapshot.checkpoints.some((c) => c.status === "pending");
  const runtimeReady = runtimeInfo({ runtimes }, session.runtime).status.state === "ready";
  const canAct = runtimeReady && !sending && !busy;
  // A focus session is retired: it is shown, so it can be switched away from.
  const modes: CollaborationModeId[] = session.mode === "focus" ? ["focus", ...PRIMARY_MODES] : [...PRIMARY_MODES];

  /**
   * Send the message with an intent. A control (or Proceed) works without text once there is a
   * conversation to apply it to. While the agent works, the message is queued instead: it goes out
   * when the turn ends. Open questions are answered on their card, never from here.
   */
  async function send(intent: TurnIntent = "default") {
    if (!api || sending) return;
    // Proceed (the discussion banner) is the one control that needs no words.
    if (!text.trim() && intent !== "proceed") return;
    const id = session.id;
    setSendingIn(id, true);
    const submitted = text;
    try {
      if (busy) await api.queue(id, submitted, intent);
      else await api.send(id, submitted, intent);
      // Only what was sent leaves the box: anything typed while the request ran stays (in that
      // session's draft, even if the developer has moved to another one meanwhile).
      updateDraft(id, (current) => afterSubmit(current, submitted));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSendingIn(id, false);
    }
  }

  function stop() {
    if (api) void api.abort(session.id).catch((err: Error) => setError(err.message));
  }

  /** Take the queued message back into the composer to change it; it is not sent. */
  async function editQueued() {
    if (!api || !queued) return;
    try {
      const { returned } = await api.unqueue(session.id);
      if (returned) setText((draft) => withReturnedDraft(draft, returned));
      input.current?.focus();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  async function dropQueued() {
    if (!api) return;
    try {
      await api.unqueue(session.id);
      input.current?.focus();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  async function endDiscussion() {
    if (!api) return;
    try {
      await api.updateSession(session.id, { discussing: false });
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  async function setMode(mode: CollaborationModeId) {
    if (!api || mode === session.mode) return;
    try {
      await api.updateSession(session.id, { mode });
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  /** Arrow keys move through the modes, as in any radio group; the choice applies at once. */
  function onModeKey(e: React.KeyboardEvent, current: CollaborationModeId) {
    const step = e.key === "ArrowRight" || e.key === "ArrowDown" ? 1 : e.key === "ArrowLeft" || e.key === "ArrowUp" ? -1 : 0;
    if (!step) return;
    e.preventDefault();
    const next = modes[(modes.indexOf(current) + step + modes.length) % modes.length]!;
    modeButtons.current.get(next)?.focus();
    void setMode(next);
  }

  async function setModel(value: string) {
    if (!api) return;
    if (value === CONNECT) return usePeer.getState().setProvidersOpen(true);
    const [providerId, ...rest] = value.split("/");
    const model = value && providerId ? { providerId, modelId: rest.join("/") } : null;
    // A level the new model doesn't take goes back to the default rather than failing the next turn.
    const keepEffort = session.effort === null || modelEfforts(models, model).includes(session.effort);
    try {
      await api.updateSession(session.id, keepEffort ? { model } : { model, effort: null });
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  async function setEffort(value: string | null): Promise<boolean> {
    if (!api) return false;
    try {
      await api.updateSession(session.id, { effort: value });
      return true;
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      return false;
    }
  }

  const efforts = session.runtime === "codex" || session.runtime === "claude" ? effortOptions(modelEfforts(models, session.model), session.effort) : [];

  const controls = MODE_CONTROLS[session.mode];
  const slashHints = controls.map((c) => CONTROL_UI[c].hint.match(/\(([^)]+)\)$/)?.[1]).join(", ");
  const placeholder = busy
    ? queued
      ? "Write a message to replace the queued one…"
      : "Write your next message. It sends when this turn ends…"
    : session.discussing
      ? "Continue the discussion… (no code changes until you proceed)"
      : `Message the agent in ${MODE_UI[session.mode].label} mode…  (${slashHints})`;
  const queuedControl = queued ? queuedControlLabel(queued.intent) : null;

  return (
    // No strip, no divider: the composer is a card floating on the page (and over the
    // constellation while the thread is empty). 34px sides = the transcript's 24px gutter + the
    // 10px scrollbar space it reserves on each side, so the composer and the text share one column.
    <div className="relative px-[34px] pb-5 pt-2" id="composer">
      <div className="mx-auto max-w-[960px]">
        <div className="mb-2 flex flex-wrap items-center gap-3">
          <div className="flex overflow-hidden rounded-lg border border-line/60 bg-panel" role="radiogroup" aria-label="Collaboration mode">
            {modes.map((m) => (
              <button
                key={m}
                ref={(el) => {
                  if (el) modeButtons.current.set(m, el);
                  else modeButtons.current.delete(m);
                }}
                role="radio"
                aria-checked={session.mode === m}
                tabIndex={session.mode === m ? 0 : -1}
                title={`${MODE_UI[m].blurb} (⌘⇧M switches)`}
                onClick={() => void setMode(m)}
                onKeyDown={(e) => onModeKey(e, m)}
                className={`flex items-center gap-1.5 px-3 py-1 text-[12px] ${
                  session.mode === m ? `bg-raised ${MODE_UI[m].color}` : "text-muted hover:text-fg"
                }`}
              >
                <span aria-hidden="true" className={`h-1.5 w-1.5 rounded-full ${MODE_UI[m].dot}`} />
                {MODE_UI[m].label}
              </button>
            ))}
          </div>
          {/* The mode's one-line explanation orients a new thread; after that it lives on the toggle's tooltip. */}
          {(!hasMessages || busy) && (
            <div className="text-[11px] text-muted">
              {!hasMessages && MODE_UI[session.mode].blurb}
              {busy && hasMessages && "Mode changes apply from your next message."}
            </div>
          )}
        </div>

        {waitingOnCheckpoint && (
          <div className="mb-2 flex items-center gap-2 rounded-md border border-accent/50 bg-accent/5 px-3 py-1.5 text-[12px] text-fg">
            <span className="min-w-0 flex-1">The agent is waiting for your answer to the question above.</span>
            <button onClick={focusPendingCheckpoint} className="shrink-0 rounded border border-accent/60 px-2 py-0.5 text-[12px] hover:bg-accent/10">
              Go to the question
            </button>
          </div>
        )}

        {session.discussing && (
          <div className="mb-2 flex items-center gap-2 rounded-md border border-collab/40 bg-collab/5 px-3 py-1.5 text-[12px] text-collab">
            <span>Discussing</span>
            <span className="min-w-0 flex-1 text-muted">· no code changes until you choose to proceed</span>
            <button
              onClick={() => void send("proceed")}
              disabled={!canAct}
              title="Go ahead with the approach you discussed (/proceed)"
              className="rounded border border-collab/60 px-2 py-0.5 text-[12px] text-fg hover:bg-collab/10 disabled:opacity-40"
            >
              Proceed
            </button>
            <button onClick={() => void endDiscussion()} title="Stop discussing without implementing" className="text-[12px] text-muted hover:text-fg">
              End discussion
            </button>
          </div>
        )}

        {gate.locked && !(session.discussing && gate.kind === "hold") && (
          <div className="mb-2 flex items-center gap-2 rounded-md border border-learn/40 bg-learn/5 px-3 py-1.5 text-[12px] text-learn">
            <span>Code changes locked</span>
            <span className="text-muted">· {gate.reason}</span>
          </div>
        )}

        {queued && (
          <div className="mb-2 flex items-center gap-2 rounded-md border border-line bg-raised px-3 py-1.5 text-[12px]" aria-label="Queued message">
            <span className="shrink-0 text-muted">Queued{queuedControl ? ` · ${queuedControl}` : ""}</span>
            <span className="min-w-0 flex-1 truncate text-fg" title={queuedAsDraft(queued)}>
              {queued.text.trim() || <span className="text-muted">(no text)</span>}
            </span>
            <span className="hidden shrink-0 text-faint sm:inline">sends when this turn ends</span>
            <button onClick={() => void editQueued()} className="shrink-0 rounded px-1.5 py-0.5 text-muted hover:bg-bg/60 hover:text-fg">
              Edit
            </button>
            <button onClick={() => void dropQueued()} className="shrink-0 rounded px-1.5 py-0.5 text-muted hover:bg-bg/60 hover:text-danger">
              Remove
            </button>
          </div>
        )}

        <div className="rounded-2xl border border-line/70 bg-panel shadow-composer focus-within:border-accent/60">
          <textarea
            ref={input}
            value={text}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
                e.preventDefault();
                void send();
              } else if (e.key === "Escape" && busy) {
                e.preventDefault();
                // With a question open, Esc goes to it rather than cancelling it: stopping then is a
                // decision, made with the Stop button. Otherwise Esc stops the agent, as in the agent
                // CLIs, and a queued message comes back here.
                if (waitingOnCheckpoint) focusPendingCheckpoint();
                else stop();
              }
            }}
            disabled={!runtimeReady}
            rows={3}
            aria-label="Message the agent"
            placeholder={runtimeReady ? placeholder : `${RUNTIME_UI[session.runtime].label} is not available.`}
            className="block w-full resize-none bg-transparent px-3 py-2.5 text-[14px] outline-none placeholder:text-faint disabled:opacity-60"
          />
          <div className="flex flex-wrap items-center justify-end gap-2 border-t border-line/50 px-2 py-1.5">
            <select
              value={session.model ? `${session.model.providerId}/${session.model.modelId}` : ""}
              onChange={(e) => void setModel(e.target.value)}
              title={modelsError ?? "Model"}
              aria-label="Model"
              className={`${efforts.length ? "" : "mr-auto "}min-w-0 max-w-56 truncate rounded border border-line bg-raised px-1.5 py-0.5 text-[12px] text-muted`}
            >
              {/* One "Default" entry: the runtime's own default, named only when it is a real model id. */}
              <option value="">{models?.default && models.default.modelId !== "default" ? `Default · ${models.default.modelId}` : "Default model"}</option>
              {models?.providers.map((p) => (
                <optgroup key={p.id} label={p.name}>
                  {p.models.map((m) => (
                    <option key={m.id} value={`${p.id}/${m.id}`}>
                      {m.name}
                    </option>
                  ))}
                </optgroup>
              ))}
              {session.runtime === "opencode" && <option value={CONNECT}>Connect a provider…</option>}
            </select>
            {efforts.length > 0 && (
              <EffortSlider
                levels={efforts}
                value={session.effort}
                onChange={setEffort}
                defaultLevel={effortDefault?.level ?? null}
                capLevel={effortCap}
                capHint={effortCap ? `${RUNTIME_UI[session.runtime].label}'s maxEffortLevel caps effort at ${effortLabel(effortCap)}: higher picks run at ${effortLabel(effortCap)}.` : undefined}
                defaultHint={effortDefaultHint(effortDefault, RUNTIME_UI[session.runtime].label)}
              />
            )}
            <div className="flex shrink-0 items-center gap-2 whitespace-nowrap">
              {busy ? (
                <>
                  <button
                    onClick={stop}
                    title={waitingOnCheckpoint ? "Stop the agent; the open question is cancelled" : "Stop the agent (Esc). A queued message comes back here."}
                    className="rounded-md border border-danger/60 px-3 py-1 text-[12px] text-danger hover:bg-danger/10"
                  >
                    Stop
                  </button>
                  <button
                    onClick={() => void send()}
                    disabled={!text.trim() || sending || !runtimeReady}
                    title="Sends when this turn ends (Enter)"
                    className="rounded-md bg-accent px-3 py-1 text-[12px] font-medium text-bg hover:bg-accent-deep disabled:cursor-not-allowed disabled:bg-raised disabled:text-faint"
                  >
                    {queued ? "Replace queued" : "Queue"}
                  </button>
                </>
              ) : (
                <>
                  {controls.map((c) => (
                    <button
                      key={c}
                      title={CONTROL_UI[c].hint}
                      onClick={() => void send(c)}
                      // A control goes with a message, never instead of one: an empty box can't
                      // hand over or reopen a task by a stray click. (Slash commands are typed.)
                      disabled={!canAct || !text.trim() || (c === "discuss" && session.discussing)}
                      className="rounded-md border border-line/60 px-2.5 py-1 text-[12px] text-muted hover:border-accent/60 hover:text-fg disabled:opacity-40"
                    >
                      {CONTROL_UI[c].label}
                    </button>
                  ))}
                  <button
                    onClick={() => void send()}
                    disabled={!text.trim() || !canAct}
                    title="Send (Enter)"
                    className="rounded-md bg-accent px-3 py-1 text-[12px] font-medium text-bg hover:bg-accent-deep disabled:cursor-not-allowed disabled:bg-raised disabled:text-faint"
                  >
                    Send
                  </button>
                </>
              )}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
