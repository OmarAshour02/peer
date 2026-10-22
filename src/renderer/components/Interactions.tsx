import { useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import type { Checkpoint, CheckpointAction, CollaborationModeId, PermissionReply, PermissionRequest } from "../../shared/types";
import { CATEGORY_UI } from "../modes";
import { usePeer } from "../store";

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
  const [text, setText] = useState("");
  const open = cp.status === "pending" || cp.status === "interrupted";
  const resolve = (action: CheckpointAction, extra: { text?: string; option?: string } = {}) =>
    run(() => api!.resolveCheckpoint(cp.id, action, extra));

  if (cp.status === "auto_resolved") {
    return (
      <div className="my-2 rounded-md border border-dashed border-line px-3 py-2 text-[12px] text-faint">
        <span className="text-muted">Not asked ({CATEGORY_UI[cp.category]}):</span> {cp.question}
        <div className="mt-0.5">Peer policy: {cp.resolution?.note}. The agent decided.</div>
      </div>
    );
  }

  const r = cp.resolution;
  return (
    <div className={`my-3 rounded-lg border ${open ? "border-accent/60 bg-accent/5" : "border-line bg-raised/40"} px-4 py-3`}>
      <div className="mb-1 flex items-center gap-2 text-[11px] uppercase tracking-wider">
        <span className={open ? "text-accent" : "text-faint"}>{CATEGORY_UI[cp.category]}</span>
        {cp.status === "pending" && <span className="text-faint">· the agent is waiting for you</span>}
        {cp.status === "interrupted" && <span className="text-warn">· the run ended before you answered; answering resumes it</span>}
        {cp.status === "cancelled" && <span className="text-faint">· cancelled</span>}
      </div>
      <div className="text-[14px] leading-relaxed text-fg">{cp.question}</div>
      {cp.context && (
        <div className="markdown mt-1 text-[13px] text-muted">
          <ReactMarkdown remarkPlugins={[remarkGfm]}>{cp.context}</ReactMarkdown>
        </div>
      )}

      {cp.options.length > 0 && (
        <div className="mt-3 flex flex-col gap-1.5">
          {cp.options.map((o) => {
            const chosen = r?.option === o.label;
            return (
              <button
                key={o.label}
                disabled={!open || busy}
                onClick={() => resolve("choose", { option: o.label, text: text || undefined })}
                className={`rounded-md border px-3 py-2 text-left text-[13px] ${
                  chosen ? "border-accent bg-accent/10" : "border-line bg-bg/40"
                } ${open ? "hover:border-accent/70" : "opacity-70"}`}
              >
                <div className="flex items-center gap-2">
                  <span className="font-medium text-fg">{o.label}</span>
                  {cp.recommendation === o.label && <span className="text-[11px] text-faint">recommended</span>}
                </div>
                {o.description && <div className="mt-0.5 text-[12px] text-muted">{o.description}</div>}
              </button>
            );
          })}
        </div>
      )}

      {open ? (
        <div className="mt-3">
          <textarea
            value={text}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey && text.trim()) {
                e.preventDefault();
                void resolve("answer", { text });
              }
            }}
            rows={2}
            placeholder={cp.options.length ? "Or answer in your own words…" : "Your answer…"}
            className="w-full resize-none rounded-md border border-line bg-bg px-3 py-2 text-[13px] outline-none focus:border-accent"
          />
          <div className="mt-2 flex flex-wrap gap-2">
            <Btn primary disabled={busy || !text.trim()} onClick={() => resolve("answer", { text })}>
              Answer
            </Btn>
            {mode === "learn" && (
              <Btn disabled={busy} onClick={() => resolve("hint", { text: text || undefined })}>
                Give me a hint
              </Btn>
            )}
            <Btn disabled={busy} onClick={() => resolve("delegate", { text: text || undefined })} title="Let the agent make this call">
              You decide
            </Btn>
            <Btn disabled={busy} onClick={() => resolve("skip", { text: text || undefined })} title="Skip the discussion and implement">
              Skip to implementation
            </Btn>
            {mode !== "learn" && (
              <Btn disabled={busy} onClick={() => resolve("hint", { text: text || undefined })}>
                Hint
              </Btn>
            )}
          </div>
        </div>
      ) : (
        r && (
          <div className="mt-2 text-[12px] text-muted">
            <span className="text-faint">You: </span>
            {r.action === "choose" && <>chose “{r.option}”</>}
            {r.action === "answer" && <>“{r.text}”</>}
            {r.action === "delegate" && <>delegated the decision to the agent</>}
            {r.action === "skip" && <>skipped to implementation</>}
            {r.action === "hint" && <>asked for a hint</>}
            {r.action === "cancelled" && <>{r.note}</>}
            {r.text && r.action !== "answer" && <> · “{r.text}”</>}
          </div>
        )
      )}
    </div>
  );
}

/** A runtime permission request (destructive command, outside-workspace access…). Same in every mode. */
export function PermissionCard({ request }: { request: PermissionRequest }) {
  const { api, busy, run } = useAct();
  const reply = (r: PermissionReply) => run(() => api!.replyPermission(request.id, r));
  return (
    <div className="my-3 rounded-lg border border-warn/60 bg-warn/5 px-4 py-3">
      <div className="text-[11px] uppercase tracking-wider text-warn">Permission needed · {request.permission}</div>
      <pre className="mt-1.5 whitespace-pre-wrap break-all font-mono text-[12px] text-fg">{request.patterns.join("\n")}</pre>
      <div className="mt-2 flex gap-2">
        <Btn primary disabled={busy} onClick={() => reply("once")}>
          Allow once
        </Btn>
        <Btn disabled={busy} onClick={() => reply("always")}>
          Always allow
        </Btn>
        <Btn disabled={busy} onClick={() => reply("reject")}>
          Reject
        </Btn>
      </div>
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
