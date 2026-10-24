import { useState } from "react";
import { COLLABORATION_MODES, type CollaborationModeId, type TurnIntent } from "../../shared/types";
import { INTENT_UI, MODE_UI } from "../modes";
import { RUNTIME_UI } from "../runtimes";
import { runtimeInfo, usePeer } from "../store";

/** Model picker entry that opens "Models & providers" instead of choosing a model. */
const CONNECT = "__connect__";

export function Composer() {
  const { api, snapshot, models, modelsError } = usePeer();
  const runtimes = usePeer((s) => s.runtimes);
  const setError = usePeer((s) => s.setError);
  const [text, setText] = useState("");
  const [intent, setIntent] = useState<TurnIntent>("default");
  const [sending, setSending] = useState(false);
  if (!snapshot) return null;

  const { session, status, gate } = snapshot;
  const busy = status !== "idle";
  const waitingOnCheckpoint = snapshot.checkpoints.some((c) => c.status === "pending");
  const runtimeReady = runtimeInfo({ runtimes }, session.runtime).status.state === "ready";

  async function send() {
    if (!api || !text.trim() || sending) return;
    setSending(true);
    try {
      await api.send(session.id, text, intent);
      setText("");
      setIntent("default");
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSending(false);
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

  const placeholder = waitingOnCheckpoint
    ? "Answer the agent's question… (this replies to the open checkpoint)"
    : busy
      ? "The agent is working. Stop it to send a new message."
      : `Message the agent in ${MODE_UI[session.mode].label} mode…  (/go, /discuss, /hint, /answer)`;

  return (
    <div className="border-t border-line bg-panel px-6 pb-4 pt-3">
      <div className="mx-auto max-w-3xl">
        <div className="mb-2 flex flex-wrap items-center gap-3">
          <div className="flex overflow-hidden rounded-md border border-line" role="radiogroup" aria-label="Collaboration mode">
            {COLLABORATION_MODES.map((m) => (
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

        {gate.locked && (
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
            {(Object.keys(INTENT_UI) as (keyof typeof INTENT_UI)[]).map((k) => (
              <button
                key={k}
                title={INTENT_UI[k].hint}
                onClick={() => setIntent(intent === k ? "default" : k)}
                className={`rounded px-2 py-0.5 text-[11.5px] ${intent === k ? "bg-accent/20 text-accent" : "text-faint hover:text-muted"}`}
              >
                {INTENT_UI[k].label}
              </button>
            ))}
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
