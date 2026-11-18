import type { PeerMessage, TokenUsage } from "../shared/types";

/** What a turn (or a whole session) used: tokens, plus the time runtimes report for a turn. */
export interface Usage extends Required<TokenUsage> {
  /** Runtime-reported duration, summed; 0 when the runtime doesn't report one. */
  durationMs: number;
  /** Whether the runtime reported cache figures for every step counted. */
  cacheKnown: boolean;
}

const EMPTY: Usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, durationMs: 0, cacheKnown: true };

function add(a: Usage, tokens: TokenUsage, durationMs = 0): Usage {
  const cacheKnown = a.cacheKnown && tokens.cacheRead !== undefined;
  return {
    input: a.input + tokens.input,
    output: a.output + tokens.output,
    cacheRead: a.cacheRead + (tokens.cacheRead ?? 0),
    cacheWrite: a.cacheWrite + (tokens.cacheWrite ?? 0),
    durationMs: a.durationMs + durationMs,
    cacheKnown,
  };
}

function messageUsage(m: PeerMessage, into: Usage): { usage: Usage; found: boolean } {
  let usage = into;
  let found = false;
  for (const p of m.parts) {
    if (p.type !== "step-finish" || !p.tokens) continue;
    usage = add(usage, p.tokens, p.durationMs);
    found = true;
  }
  return { usage, found };
}

/**
 * Usage per turn, keyed by the id of the turn's last assistant message (where its line shows).
 * A turn is the run of assistant messages after a developer message: Claude Code reports the
 * turn's tokens once, on its last message; OpenCode reports each step, which are summed.
 */
export function turnUsages(messages: readonly PeerMessage[]): Map<string, Usage> {
  const out = new Map<string, Usage>();
  let usage = EMPTY;
  let found = false;
  let lastAssistant: string | null = null;
  const flush = () => {
    if (lastAssistant && found) out.set(lastAssistant, usage);
    usage = EMPTY;
    found = false;
    lastAssistant = null;
  };
  for (const m of messages) {
    if (m.role === "user") {
      flush();
      continue;
    }
    const r = messageUsage(m, usage);
    usage = r.usage;
    found ||= r.found;
    lastAssistant = m.id;
  }
  flush();
  return out;
}

/** Everything the session's turns used. Null when no runtime reported usage. */
export function sessionUsage(messages: readonly PeerMessage[]): Usage | null {
  let usage = EMPTY;
  let found = false;
  for (const m of messages) {
    const r = messageUsage(m, usage);
    usage = r.usage;
    found ||= r.found;
  }
  return found ? usage : null;
}

/** 950 → "950", 12_345 → "12.3k", 1_234_567 → "1.23M". */
export function formatTokens(n: number): string {
  if (n < 1000) return String(Math.round(n));
  if (n < 100_000) return `${(n / 1000).toFixed(1).replace(/\.0$/, "")}k`;
  if (n < 1_000_000) return `${Math.round(n / 1000)}k`;
  return `${(n / 1_000_000).toFixed(2).replace(/\.?0+$/, "")}M`;
}

function formatDuration(ms: number): string {
  const s = ms / 1000;
  if (s < 60) return `${s < 10 ? s.toFixed(1) : Math.round(s)}s`;
  return `${Math.floor(s / 60)}m ${Math.round(s % 60)}s`;
}

/** The short line under a turn: "38.1k in (31.8k cached) · 1.2k out · 12s". */
export function usageLine(u: Usage): string {
  const cached = u.cacheKnown && u.cacheRead > 0 ? ` (${formatTokens(u.cacheRead)} cached)` : "";
  const time = u.durationMs > 0 ? ` · ${formatDuration(u.durationMs)}` : "";
  return `${formatTokens(u.input)} in${cached} · ${formatTokens(u.output)} out${time}`;
}

/** The full breakdown, for a tooltip. */
export function usageDetail(u: Usage): string {
  const lines = [`Input: ${u.input.toLocaleString()} tokens read by the model`];
  if (u.cacheKnown) {
    const fresh = Math.max(0, u.input - u.cacheRead - u.cacheWrite);
    lines.push(`  from the prompt cache: ${u.cacheRead.toLocaleString()}`, `  written to the cache: ${u.cacheWrite.toLocaleString()}`, `  uncached: ${fresh.toLocaleString()}`);
  }
  lines.push(`Output: ${u.output.toLocaleString()} tokens (reply, tool calls and thinking)`);
  if (u.durationMs > 0) lines.push(`Time: ${formatDuration(u.durationMs)}`);
  lines.push("Each tool call re-sends the whole conversation, so a turn with many steps reads its context many times.");
  return lines.join("\n");
}
