// The learning map's topic note: a hidden line the agent ends its turn with, naming the concepts
// the turn dealt with. Shared by the backend (which reads it) and the renderer (which hides it).
// No runtime dependencies: the renderer imports this file directly.

import { TOPIC_LEVELS, type TopicLevel } from "./types.js";

/** How the note starts. An HTML comment, so Markdown renderers that skip raw HTML never show it. */
export const TOPIC_NOTE_PREFIX = "<!-- peer-topics:";
const TOPIC_NOTE_END = "-->";

/** Most topics one note may record; more is noise, not a summary of one turn. */
export const MAX_TOPICS_PER_NOTE = 6;
/** Longest topic name kept, in characters. */
export const MAX_TOPIC_NAME = 80;
const MAX_RELATED = 6;

export interface NotedTopic {
  name: string;
  /** What the agent says happened; Peer caps it by what it saw in the turn. */
  level: TopicLevel;
  /** Names of concepts this one builds on or connects to. */
  related: string[];
}

/** A concept's identity: case, spacing, hyphens and surrounding punctuation don't make a new topic. */
export function topicKey(name: string): string {
  return name
    .normalize("NFC")
    .toLowerCase()
    .replace(/[\s_\-–—]+/g, " ")
    .replace(/^[\s"'`.,:;!?()[\]{}]+|[\s"'`.,:;!?()[\]{}]+$/g, "")
    .trim();
}

/** A display name: trimmed, single-spaced, and short; null when nothing usable is left. */
export function cleanTopicName(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const name = raw.replace(/\s+/g, " ").trim().slice(0, MAX_TOPIC_NAME).trim();
  return name && topicKey(name) ? name : null;
}

/** Topic names from a checkpoint's `topics` argument (validated here, not trusted). */
export function parseTopicNames(raw: unknown, max = 3): string[] {
  if (!Array.isArray(raw)) return [];
  const seen = new Set<string>();
  const names: string[] = [];
  for (const item of raw) {
    const name = cleanTopicName(item);
    if (!name || seen.has(topicKey(name))) continue;
    seen.add(topicKey(name));
    names.push(name);
    if (names.length >= max) break;
  }
  return names;
}

/**
 * Every topic note in `text`, merged (a later note's level wins for a repeated topic). Malformed
 * notes are ignored, never guessed at.
 */
export function parseTopicNotes(text: string): NotedTopic[] {
  const byKey = new Map<string, NotedTopic>();
  let from = 0;
  for (;;) {
    const start = text.indexOf(TOPIC_NOTE_PREFIX, from);
    if (start < 0) break;
    const end = text.indexOf(TOPIC_NOTE_END, start + TOPIC_NOTE_PREFIX.length);
    if (end < 0) break;
    from = end + TOPIC_NOTE_END.length;
    let data: unknown;
    try {
      data = JSON.parse(text.slice(start + TOPIC_NOTE_PREFIX.length, end));
    } catch {
      continue;
    }
    if (!Array.isArray(data)) continue;
    for (const entry of data) {
      const topic = toNotedTopic(entry);
      if (!topic) continue;
      const key = topicKey(topic.name);
      if (!byKey.has(key) && byKey.size >= MAX_TOPICS_PER_NOTE) continue;
      byKey.set(key, topic);
    }
  }
  return [...byKey.values()];
}

function toNotedTopic(entry: unknown): NotedTopic | null {
  // A bare string is a topic that came up.
  if (typeof entry === "string") {
    const name = cleanTopicName(entry);
    return name ? { name, level: "encountered", related: [] } : null;
  }
  if (!entry || typeof entry !== "object") return null;
  const e = entry as { name?: unknown; level?: unknown; related?: unknown };
  const name = cleanTopicName(e.name);
  if (!name) return null;
  const level = TOPIC_LEVELS.includes(e.level as TopicLevel) ? (e.level as TopicLevel) : "encountered";
  const related = parseTopicNames(e.related, MAX_RELATED).filter((r) => topicKey(r) !== topicKey(name));
  return { name, level, related };
}

/**
 * `text` without its topic notes, for display. While a reply streams, a note that has started but
 * not closed (or the first characters of one at the very end) is hidden too, so it never flashes.
 */
export function stripTopicNotes(text: string): string {
  if (!text.includes("<")) return text;
  let out = "";
  let from = 0;
  for (;;) {
    const start = text.indexOf(TOPIC_NOTE_PREFIX, from);
    if (start < 0) {
      out += text.slice(from);
      break;
    }
    out += text.slice(from, start);
    const end = text.indexOf(TOPIC_NOTE_END, start + TOPIC_NOTE_PREFIX.length);
    if (end < 0) return out.trimEnd();
    from = end + TOPIC_NOTE_END.length;
  }
  // A trailing partial prefix ("<!-- peer-to") is the start of a note still streaming in.
  for (let n = Math.min(TOPIC_NOTE_PREFIX.length - 1, out.length); n > 0; n--) {
    if (out.endsWith(TOPIC_NOTE_PREFIX.slice(0, n))) return out.slice(0, out.length - n).trimEnd();
  }
  return from > 0 ? out.trimEnd() : out;
}

/**
 * A message's text parts, in order, without topic notes, for display. A note may start in one part
 * and end in a later one, with either delimiter split at a part boundary, so notes are found in the
 * parts joined together and each part keeps only its characters outside them. While a reply
 * streams, an unclosed note (or the first characters of one at the very end) is hidden too.
 */
export function stripTopicNotesInParts(texts: readonly string[]): string[] {
  const full = texts.join("");
  if (!full.includes("<")) return [...texts];
  const hidden: [number, number][] = [];
  let from = 0;
  for (;;) {
    const start = full.indexOf(TOPIC_NOTE_PREFIX, from);
    if (start < 0) break;
    const end = full.indexOf(TOPIC_NOTE_END, start + TOPIC_NOTE_PREFIX.length);
    if (end < 0) {
      hidden.push([start, full.length]);
      from = full.length;
      break;
    }
    from = end + TOPIC_NOTE_END.length;
    hidden.push([start, from]);
  }
  if (from < full.length) {
    for (let n = Math.min(TOPIC_NOTE_PREFIX.length - 1, full.length - from); n > 0; n--) {
      if (full.endsWith(TOPIC_NOTE_PREFIX.slice(0, n))) {
        hidden.push([full.length - n, full.length]);
        break;
      }
    }
  }
  if (hidden.length === 0) return [...texts];
  let offset = 0;
  return texts.map((text) => {
    const lo = offset;
    const hi = offset + text.length;
    offset = hi;
    let out = "";
    let at = lo;
    for (const [a, b] of hidden) {
      if (b <= at || a >= hi) continue;
      if (a > at) out += full.slice(at, a);
      at = Math.max(at, Math.min(b, hi));
    }
    // A part that ends in a note loses the spacing before it, as a single text would.
    if (at >= hi) return out.trimEnd();
    return out + full.slice(at, hi);
  });
}
