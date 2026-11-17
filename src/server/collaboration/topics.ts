// The learning map (docs/roadmap.md, Learning Space): concepts the agent tagged while it worked,
// drawn as a graph. Topics come only from real turns: the agent's hidden note at the end of a turn
// and the topics it puts on its checkpoint questions. Peer caps what the agent claims the developer
// did by what it saw happen in the turn, so engagement is never taken on the agent's word alone.

import { TOPIC_LEVELS, type LearningMap, type LearningMapLink, type LearningMapTopic, type PeerMessage, type TopicLevel, type Turn } from "../../shared/types.js";
import { parseTopicNotes, topicKey } from "../../shared/topics.js";
import type { Store } from "../store.js";

/**
 * Responses to a tagged question that count as the developer engaging with its topics: their own
 * answer, a choice, or talking it through. Asking for a hint is not yet their reasoning.
 */
const ENGAGED_ACTIONS = new Set(["answer", "choose", "discuss"]);
/** Turn intents in which the developer wrote their own message (not a hand-off or a hint request). */
const OWN_WORDS_INTENTS = new Set(["default", "discuss"]);

const rank = (level: TopicLevel) => TOPIC_LEVELS.indexOf(level);
const lower = (a: TopicLevel, b: TopicLevel): TopicLevel => (rank(a) <= rank(b) ? a : b);
const higher = (a: TopicLevel, b: TopicLevel): TopicLevel => (rank(a) >= rank(b) ? a : b);

/** Record the topics the agent tagged on a checkpoint question. Their level follows the developer's response. */
export function recordCheckpointTopics(store: Store, sessionId: string, turnId: string | null, checkpointId: string, names: string[]) {
  for (const name of names) {
    const topicId = store.ensureTopic(topicKey(name), name);
    store.addTopicMention({ topicId, sessionId, turnId, checkpointId, level: "encountered" });
  }
}

/**
 * The developer leaned on a hint or a direct answer in this turn: sent with "hint" or "Direct
 * answer", or used either on any question in it, whoever asked (the agent, or Peer pausing a tool call).
 */
function usedHint(store: Store, turn: Turn): boolean {
  if (turn.intent === "hint" || turn.intent === "answer") return true;
  return store.listCheckpointsForTurn(turn.id).some((cp) => cp.resolution?.by === "human" && (cp.resolution.action === "hint" || cp.resolution.action === "direct"));
}

/**
 * The highest level Peer can confirm for the turn, from what it saw: the developer engaged when they
 * responded to one of the agent's questions themselves, or wrote this task's message in their own
 * words; it is "demonstrated" only when no hint or direct answer was used in the task.
 */
export function levelCap(store: Store, turn: Turn): TopicLevel {
  // A continuation carries on the turn the developer engaged in: they are one task.
  const chain: Turn[] = [turn];
  for (let t = turn; t.continuedFrom; ) {
    const prev = store.getTurn(t.continuedFrom);
    if (!prev) break;
    chain.push(prev);
    t = prev;
  }
  const root = chain[chain.length - 1]!;
  let engaged = OWN_WORDS_INTENTS.has(root.intent);
  let hinted = chain.some((t) => usedHint(store, t));
  for (const t of chain) {
    for (const cp of store.listCheckpointsForTurn(t.id)) {
      const r = cp.resolution;
      if (cp.source === "agent" && r && r.by === "human" && ENGAGED_ACTIONS.has(r.action)) engaged = true;
    }
  }
  // An answer that follows a hint (asked for in the turn just before this task) leaned on the hint.
  const before = store.listTurns(root.sessionId).find((t) => t.startedAt < root.startedAt && t.undoneAt === null && t.id !== root.id);
  if (before && usedHint(store, before)) hinted = true;
  if (!engaged) return "encountered";
  return hinted ? "engaged" : "demonstrated";
}

/**
 * Read the topic notes in the agent's replies during `turn` and record them. Returns how many
 * topics were recorded. A reply belongs to the turn it was created in: after the turn started and,
 * strictly, after the previous turn ended (a reply is always created before its own turn ends, so
 * the previous turn's last reply is never read as this one's, even in the same millisecond).
 */
export function recordTurnTopics(store: Store, sessionId: string, turn: Turn, messages: PeerMessage[]): number {
  const end = turn.endedAt ?? Number.POSITIVE_INFINITY;
  const turns = store.listTurns(sessionId); // newest first
  const previous = turns[turns.findIndex((t) => t.id === turn.id) + 1];
  const after = previous?.endedAt ?? Number.NEGATIVE_INFINITY;
  const text = messages
    .filter((m) => m.role === "assistant" && m.createdAt >= turn.startedAt && m.createdAt > after && m.createdAt <= end)
    .flatMap((m) => m.parts)
    .map((p) => (p.type === "text" && !p.synthetic ? p.text : ""))
    // Joined as written: a note split across parts must read back as one.
    .join("");
  const noted = parseTopicNotes(text);
  if (noted.length === 0) return 0;
  const cap = levelCap(store, turn);
  const ids = new Map<string, string>();
  for (const topic of noted) {
    const topicId = store.ensureTopic(topicKey(topic.name), topic.name);
    ids.set(topicKey(topic.name), topicId);
    store.addTopicMention({ topicId, sessionId, turnId: turn.id, checkpointId: null, level: lower(topic.level, cap) });
  }
  // Related topics link only to concepts already on the map or named in this note: a name the
  // agent merely mentions as related never becomes a dot of its own.
  for (const topic of noted) {
    const from = ids.get(topicKey(topic.name))!;
    for (const name of topic.related) {
      const to = ids.get(topicKey(name)) ?? store.topicIdByKey(topicKey(name));
      if (to) store.addTopicLink(from, to, sessionId, turn.id);
    }
  }
  return noted.length;
}

/** The map: every topic with a mention on a kept turn, how they connect, and the sessions behind them. */
export function buildLearningMap(store: Store): LearningMap {
  const topics = new Map<string, LearningMapTopic>();
  const perSession = new Map<string, Map<string, LearningMapTopic["sessions"][number]>>();
  const byTurn = new Map<string, Set<string>>();

  for (const m of store.listTopicMentions()) {
    let level = m.level;
    if (m.checkpoint) {
      const r = m.checkpoint.resolution;
      level = r && r.by === "human" && ENGAGED_ACTIONS.has(r.action) ? higher(level, "engaged") : level;
    }
    let topic = topics.get(m.topicId);
    if (!topic) {
      topic = { id: m.topicId, name: m.name, level, mentions: 0, firstSeenAt: m.createdAt, lastSeenAt: m.createdAt, sessions: [] };
      topics.set(m.topicId, topic);
      perSession.set(m.topicId, new Map());
    }
    topic.mentions++;
    topic.level = higher(topic.level, level);
    topic.lastSeenAt = Math.max(topic.lastSeenAt, m.createdAt);
    const sessions = perSession.get(m.topicId)!;
    const s = sessions.get(m.sessionId) ?? { sessionId: m.sessionId, mentions: 0, level, lastAt: m.createdAt };
    s.mentions++;
    s.level = higher(s.level, level);
    s.lastAt = Math.max(s.lastAt, m.createdAt);
    sessions.set(m.sessionId, s);
    if (m.turnId) {
      const set = byTurn.get(m.turnId) ?? new Set<string>();
      set.add(m.topicId);
      byTurn.set(m.turnId, set);
    }
  }

  const links = new Map<string, LearningMapLink>();
  const link = (x: string, y: string, related: boolean) => {
    if (x === y || !topics.has(x) || !topics.has(y)) return;
    const [source, target] = x < y ? [x, y] : [y, x];
    const key = `${source}|${target}`;
    const l = links.get(key) ?? { source, target, weight: 0, related: false };
    l.weight++;
    l.related ||= related;
    links.set(key, l);
  };
  // Discussed in the same turn.
  for (const ids of byTurn.values()) {
    const list = [...ids];
    for (let i = 0; i < list.length; i++) for (let j = i + 1; j < list.length; j++) link(list[i]!, list[j]!, false);
  }
  for (const l of store.listTopicLinks()) link(l.a, l.b, true);

  const sessions: LearningMap["sessions"] = {};
  for (const [topicId, map] of perSession) {
    const topic = topics.get(topicId)!;
    topic.sessions = [...map.values()].sort((a, b) => b.lastAt - a.lastAt);
    for (const s of topic.sessions) {
      if (sessions[s.sessionId]) continue;
      const session = store.getSession(s.sessionId);
      if (!session) continue;
      const ws = store.getWorkspace(session.workspaceId);
      sessions[s.sessionId] = { ...session, workspaceName: ws?.general ? "Chats" : (ws?.name ?? ""), general: ws?.general === true };
    }
  }

  return {
    topics: [...topics.values()].sort((a, b) => b.lastSeenAt - a.lastSeenAt),
    links: [...links.values()],
    sessions,
  };
}
