import { useEffect, useMemo, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import type { Checkpoint, CollaborationModeId, PeerMessage, PeerPart } from "../../shared/types";
import { usePeer } from "../store";
import { CheckpointCard, PermissionCard } from "./Interactions";

type ToolPart = Extract<PeerPart, { type: "tool" }>;

export function Transcript() {
  const { messages, snapshot } = usePeer();
  const bottom = useRef<HTMLDivElement>(null);
  const scroller = useRef<HTMLDivElement>(null);
  const stick = useRef(true);
  const mode = snapshot?.session.mode ?? "collaborate";

  // Place each checkpoint where the agent asked it (its peer_checkpoint tool call).
  const { byPart, unplaced } = useMemo(() => placeCheckpoints(messages, snapshot?.checkpoints ?? []), [messages, snapshot?.checkpoints]);

  useEffect(() => {
    if (stick.current) bottom.current?.scrollIntoView({ block: "end" });
  });

  if (!snapshot) return <div className="flex-1" />;

  return (
    <div
      ref={scroller}
      onScroll={(e) => {
        const el = e.currentTarget;
        stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
      }}
      className="min-h-0 flex-1 overflow-y-auto"
    >
      <div className="mx-auto max-w-3xl px-6 py-6">
        {messages.length === 0 && (
          <div className="mt-16 text-center text-[13px] text-faint">Describe a task, ask a question, or paste an error to start.</div>
        )}
        {messages.map((m) => (
          <Message key={m.id} message={m} checkpoints={byPart} mode={mode} />
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
        {snapshot.status !== "idle" && (
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
        <div ref={bottom} className="h-4" />
      </div>
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

function Message({ message, checkpoints, mode }: { message: PeerMessage; checkpoints: Map<string, Checkpoint>; mode: CollaborationModeId }) {
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
  return (
    <div className="my-3">
      {message.parts.map((p) => {
        const cp = checkpoints.get(p.id);
        if (cp) return <CheckpointCard key={p.id} checkpoint={cp} mode={mode} />;
        return <PartView key={p.id} part={p} />;
      })}
      {message.error && message.error !== "Stopped." && (
        <div className="my-2 rounded-md border border-danger/60 bg-danger/10 px-3 py-2 text-[13px] text-danger">{message.error}</div>
      )}
      {message.error === "Stopped." && <div className="my-2 text-[12px] text-faint">Stopped.</div>}
      {message.warning && <div className="my-2 rounded-md border border-warn/60 bg-warn/10 px-3 py-2 text-[13px] text-warn">{message.warning}</div>}
    </div>
  );
}

function PartView({ part }: { part: PeerPart }) {
  switch (part.type) {
    case "text":
      if (part.synthetic || !part.text.trim()) return null;
      return (
        <div className="markdown my-2 text-[14px] text-fg">
          <ReactMarkdown remarkPlugins={[remarkGfm]}>{part.text}</ReactMarkdown>
        </div>
      );
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
    <div className="my-1.5 overflow-hidden rounded-md border border-line bg-panel">
      <button onClick={() => setOpen(!open)} className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-[12px] hover:bg-raised/60">
        <span className="w-14 shrink-0 font-medium text-muted">{TOOL_LABEL[part.tool] ?? part.tool}</span>
        <span className="min-w-0 flex-1 truncate font-mono text-fg/90">{summary}</span>
        <span className={`shrink-0 ${statusColor}`}>
          {blocked ? "blocked by gate" : part.status === "running" || part.status === "pending" ? "running…" : part.status === "error" ? "failed" : ""}
        </span>
      </button>
      {isEdit && !open && part.diff && <DiffView diff={part.diff} maxLines={14} />}
      {open && (
        <div className="border-t border-line">
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
    <pre className="max-h-96 overflow-auto border-t border-line bg-bg/60 py-1 font-mono text-[11.5px] leading-[1.45]">
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
          <div key={idx} className={`px-3 ${cls}`}>
            {l || " "}
          </div>
        );
      })}
      {maxLines && lines.length > maxLines && <div className="px-3 text-faint">… {lines.length - maxLines} more lines</div>}
    </pre>
  );
}
