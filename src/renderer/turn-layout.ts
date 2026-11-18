import type { PeerMessage, PeerPart } from "../shared/types";

// How the transcript lays out a turn: pure, so it is testable without a DOM.

export type ToolPart = Extract<PeerPart, { type: "tool" }>;

/** The transcript as blocks: each developer message, and each run of agent messages (one turn). */
export type TranscriptBlock = { kind: "user"; message: PeerMessage } | { kind: "agent"; messages: PeerMessage[] };

export function transcriptBlocks(messages: readonly PeerMessage[]): TranscriptBlock[] {
  const out: TranscriptBlock[] = [];
  for (const m of messages) {
    const last = out.at(-1);
    if (m.role === "user") out.push({ kind: "user", message: m });
    else if (last?.kind === "agent") last.messages.push(m);
    else out.push({ kind: "agent", messages: [m] });
  }
  return out;
}

/** Runtimes wrap some failures in their own words ("Claude Code returned an error result: …"); the message is what matters. */
export function cleanError(error: string): string {
  return error.replace(/^(Claude Code returned an error result:\s*)+/, "").trim() || error;
}

/**
 * The error each message of a turn shows: cleaned, and each distinct error once, on the last
 * message that carries it. Earlier versions of the Claude Code adapter put a turn's error on
 * every message of the turn, and those transcripts are still stored.
 */
export function turnErrors(messages: readonly PeerMessage[]): Map<string, string | null> {
  const out = new Map<string, string | null>();
  const seen = new Set<string>();
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]!;
    const error = m.error ? cleanError(m.error) : null;
    out.set(m.id, error && !seen.has(error) ? error : null);
    if (error) seen.add(error);
  }
  return out;
}

/**
 * What a reply's thinking is about right now, for the live "Thinking" line: the last bold heading
 * of a reasoning summary (Codex and OpenCode write "**Checking the cache**" before each step),
 * else its last line. Empty when there is nothing to show yet.
 */
export function thinkingHeadline(text: string, max = 90): string {
  const headings = [...text.matchAll(/\*\*([^*\n]+?)\*\*/g)].map((m) => m[1]!.trim()).filter(Boolean);
  const line =
    headings.at(-1) ??
    text
      .split("\n")
      .map((l) => l.trim())
      .filter(Boolean)
      .at(-1) ??
    "";
  return line.length > max ? `${line.slice(0, max - 1).trimEnd()}…` : line;
}

export const sameText = (a: string, b: string) => a.replace(/\s+/g, " ").trim() === b.replace(/\s+/g, " ").trim();

/** A run of tool calls shown as one line, or any other item on its own. */
export type TurnSegment<T> = { kind: "tools"; parts: ToolPart[]; items: T[] } | { kind: "item"; item: T };

/** Tool calls that collapse into a group: everything but checkpoints and edits that show a diff. */
export const groupable = (part: PeerPart): part is ToolPart => part.type === "tool" && part.tool !== "peer_checkpoint" && !part.diff;

/**
 * Group consecutive tool calls of a turn, across the agent's messages (Claude Code starts a new
 * message for every step). Items that render nothing (an empty thinking block, a usage record,
 * a message end with nothing to say) don't break a group.
 */
export function segmentTurn<T>(items: readonly T[], tool: (item: T) => ToolPart | null, visible: (item: T) => boolean): TurnSegment<T>[] {
  const out: TurnSegment<T>[] = [];
  let group: { kind: "tools"; parts: ToolPart[]; items: T[] } | null = null;
  for (const item of items) {
    const t = tool(item);
    if (t) {
      if (!group) {
        group = { kind: "tools", parts: [], items: [] };
        out.push(group);
      }
      group.parts.push(t);
      group.items.push(item);
    } else if (visible(item)) {
      group = null;
      out.push({ kind: "item", item });
    }
  }
  return out;
}

export const isBlocked = (part: ToolPart) => part.status === "error" && Boolean(part.error?.includes("Peer collaboration gate"));

/** Where the gate's message to the agent stops saying why and starts telling it what to do. */
const AGENT_INSTRUCTIONS = [" Engage the developer", " Wait for the developer", " The developer wants", " Reading and exploring", " Do not try"];

/**
 * Why Peer held a call, for the developer: the gate's own reason, without the instructions
 * addressed to the agent that follow it.
 */
export function heldReason(error: string | undefined): string {
  if (!error) return "Code changes are locked for this turn.";
  if (error.includes("not routine work")) return "You said this task is not routine: code changes wait until the agent asks you.";
  const marker = "was not run.";
  const at = error.indexOf(marker);
  if (at === -1) return "Code changes are locked for this turn.";
  let reason = error.slice(at + marker.length);
  for (const cut of AGENT_INSTRUCTIONS) {
    const i = reason.indexOf(cut);
    if (i !== -1) reason = reason.slice(0, i);
  }
  return reason.trim() || "Code changes are locked for this turn.";
}
export const isRunning = (part: ToolPart) => part.status === "running" || part.status === "pending";

/** What a tool kind did, for a group's summary: [singular, plural, verb]. */
const TOOL_PHRASE: Record<string, [string, string, string]> = {
  bash: ["command", "commands", "Ran"],
  read: ["file", "files", "Read"],
  grep: ["search", "searches", "Ran"],
  glob: ["file search", "file searches", "Ran"],
  edit: ["edit", "edits", "Made"],
  write: ["file", "files", "Wrote"],
  apply_patch: ["patch", "patches", "Applied"],
  webfetch: ["page", "pages", "Fetched"],
  task: ["subagent", "subagents", "Ran"],
  todowrite: ["plan update", "plan updates", "Made"],
};

/** "Ran 6 commands, read 2 files · 3 blocked" */
export function toolGroupSummary(parts: readonly ToolPart[]): string {
  const counts = new Map<string, number>();
  for (const p of parts) counts.set(p.tool, (counts.get(p.tool) ?? 0) + 1);
  const phrases = [...counts].map(([tool, n]) => {
    const [one, many, verb] = TOOL_PHRASE[tool] ?? ["tool call", "tool calls", "Made"];
    return `${verb} ${n} ${n === 1 ? one : many}`;
  });
  const text = phrases.map((ph, i) => (i === 0 ? ph : ph[0]!.toLowerCase() + ph.slice(1))).join(", ");
  const blocked = parts.filter(isBlocked).length;
  const failed = parts.filter((p) => p.status === "error" && !isBlocked(p)).length;
  return [text, blocked ? `${blocked} blocked` : "", failed ? `${failed} failed` : ""].filter(Boolean).join(" · ");
}
