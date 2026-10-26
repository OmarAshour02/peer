import { useState } from "react";
import { PRIMARY_MODES, type CollaborationModeId, type TurnIntent } from "../../shared/types";
import { CONTROL_UI, MODE_CONTROLS, MODE_UI } from "../modes";
import { RUNTIME_UI } from "../runtimes";
import { runtimeInfo, usePeer } from "../store";

/** Model picker entry that opens "Models & providers" instead of choosing a model. */
const CONNECT = "__connect__";

export function Composer() {
  const { api, snapshot, models, modelsError } = usePeer();
  const runtimes = usePeer((s) => s.runtimes);
  const setError = usePeer((s) => s.setError);
  const hasMessages = usePeer((s) => s.messages.length > 0);
  const [text, setText] = useState("");
  const [sending, setSending] = useState(false);
  if (!snapshot) return null;

  const { session, status, gate } = snapshot;
  const busy = status !== "idle";
  const waitingOnCheckpoint = snapshot.checkpoints.some((c) => c.status === "pending");
  const runtimeReady = runtimeInfo({ runtimes }, session.runtime).status.state === "ready";
  const canAct = runtimeReady && !sending && (!busy || waitingOnCheckpoint);
  // A focus session is retired: it is shown, so it can be switched away from.
  const modes: CollaborationModeId[] = session.mode === "focus" ? ["focus", ...PRIMARY_MODES] : [...PRIMARY_MODES];

  /**
   * Send the message with an intent. A control (or Proceed) works without text once there is a
   * conversation to apply it to; while the agent waits on a question, it answers that question.
   */
  async function send(intent: TurnIntent = "default") {
    if (!api || sending) return;
    if (!text.trim() && (intent === "default" || (!hasMessages && !waitingOnCheckpoint))) return;
    setSending(true);
    try {
      await api.send(session.id, text, intent);
      setText("");
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSending(false);
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

  async function setModel(value: string) {
    if (!api) return;
    if (value === CONNECT) return usePeer.getState().setProvidersOpen(true);
    const [providerId, ...rest] = value.split("/");
    const model = value && providerId ? { providerId, modelId: rest.join("/") } : null;
    try {
      await api.updateSession(session.id, { model });
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  const controls = MODE_CONTROLS[session.mode];
  const placeholder = waitingOnCheckpoint
    ? "Answer the agent's question… (this replies to the open checkpoint)"
    : busy
      ? "The agent is working. Stop it to send a new message."
      : session.discussing
        ? "Continue the discussion… (no code changes until you proceed)"
        : `Message the agent in ${MODE_UI[session.mode].label} mode…  (${controls.map((c) => CONTROL_UI[c].hint.match(/\(([^)]+)\)$/)?.[1]).join(", ")})`;

  return (
    <div className="border-t border-line bg-panel px-6 pb-4 pt-3">
      <div className="mx-auto max-w-3xl">
        <div className="mb-2 flex flex-wrap items-center gap-3">
          <div className="flex overflow-hidden rounded-md border border-line" role="radiogroup" aria-label="Collaboration mode">
            {modes.map((m) => (
              <button
                key={m}
                role="radio"
                aria-checked={session.mode === m}
                title={MODE_UI[m].blurb}
                onClick={() => void setMode(m)}
                className={`flex items-center gap-1.5 px-3 py-1 text-[12px] ${
                  session.mode === m ? `bg-raised ${MODE_UI[m].color}` : "text-muted hover:text-fg"
                }`}
              >
                <span className={`h-1.5 w-1.5 rounded-full ${MODE_UI[m].dot}`} />
                {MODE_UI[m].label}
              </button>
            ))}
          </div>
          <div className="text-[11px] text-faint">
            {MODE_UI[session.mode].blurb}
            {busy && " Mode changes apply from your next message."}
          </div>
        </div>

        {session.discussing && (
          <div className="mb-2 flex items-center gap-2 rounded-md border border-collab/40 bg-collab/5 px-3 py-1.5 text-[12px] text-collab">
            <span>Discussing</span>
            <span className="min-w-0 flex-1 text-muted">· no code changes until you choose to proceed</span>
            <button
              onClick={() => void send("proceed")}
              disabled={!canAct}
              title="Go ahead with the approach you discussed (/proceed)"
              className="rounded border border-collab/60 px-2 py-0.5 text-[11.5px] text-fg hover:bg-collab/10 disabled:opacity-40"
            >
              Proceed
            </button>
            <button onClick={() => void endDiscussion()} title="Stop discussing without implementing" className="text-[11.5px] text-faint hover:text-fg">
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

        <div className="rounded-lg border border-line bg-bg focus-within:border-accent/70">
          <textarea
            value={text}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                void send();
              }
            }}
            disabled={!runtimeReady || (busy && !waitingOnCheckpoint)}
            rows={3}
            placeholder={runtimeReady ? placeholder : `${RUNTIME_UI[session.runtime].label} is not available.`}
            className="block w-full resize-none bg-transparent px-3 py-2.5 text-[14px] outline-none placeholder:text-faint disabled:opacity-60"
          />
          <div className="flex flex-wrap items-center gap-2 border-t border-line px-2 py-1.5">
            <div className="flex-1" />
            <select
              value={session.model ? `${session.model.providerId}/${session.model.modelId}` : ""}
              onChange={(e) => void setModel(e.target.value)}
              title={modelsError ?? "Model"}
              className="max-w-56 truncate rounded border border-line bg-raised px-1.5 py-0.5 text-[11.5px] text-muted outline-none"
            >
              <option value="">
                Default{models?.default ? ` (${models.default.providerId}/${models.default.modelId})` : ""}
              </option>
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
            {busy && !waitingOnCheckpoint ? (
              <button
                onClick={() => api && void api.abort(session.id).catch((err: Error) => setError(err.message))}
                className="rounded-md border border-danger/60 px-3 py-1 text-[12px] text-danger hover:bg-danger/10"
              >
                Stop
              </button>
            ) : (
              <>
                {busy && (
                  <button
                    onClick={() => api && void api.abort(session.id).catch((err: Error) => setError(err.message))}
                    className="rounded-md border border-line px-3 py-1 text-[12px] text-muted hover:text-danger"
                  >
                    Stop
                  </button>
                )}
                {controls.map((c) => (
                  <button
                    key={c}
                    title={waitingOnCheckpoint ? `${CONTROL_UI[c].hint} Answers the open question.` : CONTROL_UI[c].hint}
                    onClick={() => void send(c)}
                    disabled={!canAct || (!text.trim() && !hasMessages && !waitingOnCheckpoint) || (c === "discuss" && session.discussing && !waitingOnCheckpoint)}
                    className="rounded-md border border-line px-2.5 py-1 text-[12px] text-muted hover:border-accent/60 hover:text-fg disabled:opacity-40"
                  >
                    {CONTROL_UI[c].label}
                  </button>
                ))}
                <button
                  onClick={() => void send()}
                  disabled={!text.trim() || sending || !runtimeReady}
                  className="rounded-md bg-accent px-3 py-1 text-[12px] font-medium text-bg disabled:opacity-40"
                >
                  {waitingOnCheckpoint ? "Answer" : "Send"}
                </button>
              </>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
