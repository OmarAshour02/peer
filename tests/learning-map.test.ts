// The learning map: the agent tags each turn's concepts (a hidden note, and topics on its
// questions); Peer records them only from real turns, caps the claimed level by what it saw, and
// builds the graph. Deterministic: a fake runtime supplies the agent's replies.
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../src/server/app.js";
import { buildLearningMap } from "../src/server/collaboration/topics.js";
import { EventHub } from "../src/server/hub.js";
import { RuntimeSet } from "../src/server/runtime/set.js";
import { PeerService } from "../src/server/service.js";
import { Store } from "../src/server/store.js";
import { fitView, layoutGraph } from "../src/renderer/learning-map-layout.js";
import { parseTopicNotes, stripTopicNotes, stripTopicNotesInParts, topicKey, TOPIC_NOTE_PREFIX } from "../src/shared/topics.js";
import { writeFileSync } from "node:fs";
import type { PeerEvent } from "../src/shared/types.js";
import type { CheckpointAction, PeerMessage, PeerSession, TurnIntent } from "../src/shared/types.js";
import { FakeRuntime } from "./helpers.js";

let dir: string;
let store: Store;
let runtime: FakeRuntime;
let service: PeerService;
let replies: PeerMessage[];

beforeEach(() => {
  dir = realpathSync(mkdtempSync(join(tmpdir(), "peer-map-")));
  store = new Store(":memory:");
  runtime = new FakeRuntime();
  replies = [];
  runtime.getMessages = async () => replies;
  service = new PeerService(store, new RuntimeSet([runtime]), new EventHub());
});

afterEach(() => {
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

const engine = () => service.engine;
const system = () => runtime.lastPrompt().input.system ?? "";

async function newSession(mode: PeerSession["mode"] = "collaborate") {
  const ws = service.addWorkspace(dir);
  return service.createSession(ws.id, { mode });
}

const note = (topics: unknown) => `${TOPIC_NOTE_PREFIX} ${JSON.stringify(topics)} -->`;

/** The agent replies with `text` during the current turn. */
function reply(text: string) {
  replies.push({ id: `m${replies.length}`, role: "assistant", createdAt: Date.now(), parts: [{ type: "text", id: `p${replies.length}`, text }] });
}

/** One turn: the developer's message, the agent's reply, then the runtime goes idle. */
/** Real turns take time: the clock moves between a turn's end, the next prompt and its reply. */
const later = () => new Promise((r) => setTimeout(r, 2));

async function turn(s: PeerSession, text: string, agentReply: string, intent?: TurnIntent, during?: () => Promise<void>) {
  await later();
  await service.send(s.id, text, intent);
  await during?.();
  await later();
  reply(agentReply);
  runtime.emit({ type: "session.idle", sessionId: s.runtimeSessionId });
  await engine().topicsSettled();
}

const ask = (s: PeerSession, topics: unknown, category = "hypothesis") =>
  engine().requestCheckpoint(s.runtimeSessionId, null, { category, question: "Why does the cache miss?", topics });
const resolve = (id: string, action: CheckpointAction, text?: string) => engine().resolveCheckpoint(id, { action, text });
const topic = (name: string) => buildLearningMap(store).topics.find((t) => topicKey(t.name) === topicKey(name));

// ---------------------------------------------------------------------------

describe("the topic note", () => {
  it("parses notes, merging repeats, ignoring malformed ones and capping how many", () => {
    const text = [
      "Here is the fix.",
      note([{ name: "Rate limiting", level: "engaged", related: ["Token bucket", "rate-limiting"] }, "Token bucket"]),
      `${TOPIC_NOTE_PREFIX} not json -->`,
      note([{ name: "rate  limiting", level: "demonstrated" }, { level: "engaged" }, 42, ...["a", "b", "c", "d", "e", "f"]]),
    ].join("\n");
    const topics = parseTopicNotes(text);
    // Names are single-spaced; the later note's level wins for the same concept.
    expect(topics.map((t) => t.name)).toEqual(["rate limiting", "Token bucket", "a", "b", "c", "d"]);
    expect(topics[0]!.level).toBe("demonstrated");
    // A topic is never related to itself, however it is spelled.
    expect(parseTopicNotes(note([{ name: "Rate limiting", related: ["rate-limiting", "Token bucket"] }]))[0]!.related).toEqual(["Token bucket"]);
    expect(parseTopicNotes(note([{ name: "X", level: "mastered" }]))[0]!.level).toBe("encountered");
  });

  it("topic identity ignores case, spacing, hyphens and surrounding punctuation", () => {
    expect(topicKey("  Sliding-Window  rate_limiting. ")).toBe(topicKey("sliding window rate limiting"));
    expect(topicKey("ÉTag")).toBe(topicKey("étag"));
  });

  it("is hidden from the transcript, including while it streams in", () => {
    const full = `Done.\n\n${note(["Caching"])}`;
    expect(stripTopicNotes(full)).toBe("Done.");
    expect(stripTopicNotes(`Done.\n\n${TOPIC_NOTE_PREFIX} [{"name": "Cach`)).toBe("Done.");
    for (let n = 1; n < TOPIC_NOTE_PREFIX.length; n++) expect(stripTopicNotes(`Done.\n${TOPIC_NOTE_PREFIX.slice(0, n)}`)).toBe("Done.");
    expect(stripTopicNotes("a < b and <!-- a comment -->")).toBe("a < b and <!-- a comment -->");
    expect(stripTopicNotes(`Before ${note(["X"])} after`)).toBe("Before  after");
  });
});

describe("a note split across text parts", () => {
  it("is hidden in every part it spans", () => {
    expect(stripTopicNotesInParts(["Done. <!-- peer-topics: [", '"Private topic"] -->', " After."])).toEqual(["Done.", "", " After."]);
    // Split inside the prefix itself.
    expect(stripTopicNotesInParts(["Done. <!-- peer-", 'topics: ["X"] -->'])).toEqual(["Done.", ""]);
    // Still streaming: the rest of the message is hidden until the note closes.
    expect(stripTopicNotesInParts(["Done.", "<!-- peer-topics: [", '"X"'])).toEqual(["Done.", "", ""]);
    // Not a note: nothing is hidden.
    expect(stripTopicNotesInParts(["a < b", "c"])).toEqual(["a < b", "c"]);
  });

  it("leaves the rest of the reply visible wherever the parts split, including inside either delimiter", () => {
    const visible = (parts: string[]) => stripTopicNotesInParts(parts).join("").replace(/\s+/g, " ").trim();
    const text = `Done. ${note(["Caching"])} The next step is to test it.`;
    for (let i = 0; i <= text.length; i++) {
      expect(visible([text.slice(0, i), text.slice(i)])).toBe("Done. The next step is to test it.");
      for (let j = i; j <= text.length; j += 7) expect(visible([text.slice(0, i), text.slice(i, j), text.slice(j)])).toBe("Done. The next step is to test it.");
    }
    expect(stripTopicNotesInParts(['Done. <!-- peer-topics: ["Caching"] --', "> The next step is to test it.", " Run npm test."])).toEqual(["Done.", " The next step is to test it.", " Run npm test."]);
  });

  it("is read back as one note", async () => {
    const s = await newSession();
    await service.send(s.id, "t");
    await later();
    replies.push({
      id: "split",
      role: "assistant",
      createdAt: Date.now(),
      parts: [
        { type: "text", id: "a", text: 'Done. <!-- peer-topics: [{"name": "Split ' },
        { type: "text", id: "b", text: 'topic"}] -->' },
      ],
    });
    runtime.emit({ type: "session.idle", sessionId: s.runtimeSessionId });
    await engine().topicsSettled();
    expect(buildLearningMap(store).topics.map((t) => t.name)).toEqual(["Split topic"]);
  });
});

describe("the prompt", () => {
  it("asks the agent to tag topics while the map is on, reusing this session's names only", async () => {
    const s = await newSession();
    await turn(s, "add caching", `ok ${note(["HTTP caching"])}`);
    await service.send(s.id, "next");
    expect(system()).toContain("## Learning map");
    expect(system()).toContain(TOPIC_NOTE_PREFIX);
    expect(system()).toContain('Names already used in this conversation: "HTTP caching"');
    // Another session never hears this one's topics.
    const other = await newSession();
    await service.send(other.id, "task");
    expect(system()).toContain("## Learning map");
    expect(system()).not.toContain("HTTP caching");
  });

  it("asks for nothing, and records nothing, while the map is off", async () => {
    store.setPreferences({ learningMap: false });
    const s = await newSession();
    await turn(s, "add caching", `ok ${note(["HTTP caching"])}`);
    expect(system()).not.toContain("Learning map");
    const { checkpoint } = await ask(s, ["Cache keys"]);
    expect(checkpoint).not.toBeNull();
    expect(buildLearningMap(store).topics).toEqual([]);
  });
});

describe("recording topics from turns", () => {
  it("records the note of the turn's own replies only", async () => {
    const s = await newSession();
    reply(note(["Before the turn"])); // an earlier reply, outside this turn's window
    replies[0]!.createdAt = 0;
    await turn(s, "explain ETags", `ETags work like this. ${note([{ name: "ETag", level: "encountered" }])}`);
    const map = buildLearningMap(store);
    expect(map.topics.map((t) => t.name)).toEqual(["ETag"]);
    expect(map.topics[0]!.sessions).toEqual([expect.objectContaining({ sessionId: s.id, mentions: 1, level: "encountered" })]);
    expect(map.sessions[s.id]).toMatchObject({ title: s.title, workspaceName: expect.any(String), general: false });
  });

  it("never reads the previous turn's reply as this turn's, even in the same millisecond", async () => {
    const s = await newSession();
    await turn(s, "t1", note(["Indexes"]));
    await later();
    await service.send(s.id, "t2");
    // The previous reply's time collides with the previous turn's end and this turn's start.
    const t1 = store.listTurns(s.id)[1]!;
    replies[0]!.createdAt = t1.endedAt!;
    store.db.prepare("UPDATE turns SET started_at = ? WHERE id = ?").run(t1.endedAt!, store.latestTurn(s.id)!.id);
    await later();
    reply(note(["B-trees"]));
    runtime.emit({ type: "session.idle", sessionId: s.runtimeSessionId });
    await engine().topicsSettled();
    expect(buildLearningMap(store).links).toEqual([]);
    expect(topic("Indexes")!.mentions).toBe(1);
  });

  it("caps the agent's claim by what Peer saw in the turn", async () => {
    const s = await newSession();
    // The developer wrote the task in their own words, with no hint: demonstrated stands.
    await turn(s, "my guess: the cache key ignores the query string", note([{ name: "Cache keys", level: "demonstrated" }]));
    expect(topic("Cache keys")!.level).toBe("demonstrated");
    // "Just do it": nothing the developer reasoned about, whatever the agent says.
    await turn(s, "add pagination", note([{ name: "Cursor pagination", level: "demonstrated" }]), "delegate");
    expect(topic("Cursor pagination")!.level).toBe("encountered");
    // A hint in the task: engaged at most.
    await turn(s, "why is it slow?", note([{ name: "N+1 queries", level: "demonstrated" }]), "hint");
    expect(topic("N+1 queries")!.level).toBe("encountered"); // a hint request is not the developer's reasoning
    await turn(s, "is it the ORM loading each row?", note([{ name: "N+1 queries", level: "demonstrated" }]));
    expect(topic("N+1 queries")!.level).toBe("engaged"); // their answer came right after a hint
  });

  it("a hint on a question Peer itself opened also caps the level", async () => {
    writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "app", dependencies: {} }));
    // Collaborate: Peer pauses a new dependency and asks (Learn's lock would block the install first).
    const s = await newSession("collaborate");
    await turn(s, "add validation", note([{ name: "Schema validation", level: "demonstrated" }]), undefined, async () => {
      const call = engine().checkTool(s.runtimeSessionId, "bash", { command: "npm install zod" });
      await new Promise((r) => setImmediate(r));
      const cp = store.listCheckpoints(s.id).find((c) => c.source === "peer" && c.status === "pending");
      expect(cp).toBeDefined();
      await resolve(cp!.id, "hint");
      await call;
    });
    expect(topic("Schema validation")!.level).toBe("engaged");
  });

  it("a hint on Peer's own question in the turn before also caps the next answer", async () => {
    writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "app", dependencies: {} }));
    const s = await newSession("collaborate");
    await turn(s, "add validation", note([]), undefined, async () => {
      const call = engine().checkTool(s.runtimeSessionId, "bash", { command: "npm install zod" });
      await new Promise((r) => setImmediate(r));
      const cp = store.listCheckpoints(s.id).find((c) => c.source === "peer" && c.status === "pending");
      await resolve(cp!.id, "hint");
      await call;
    });
    await turn(s, "zod validates at the boundary, so handlers get typed data", note([{ name: "Schema validation", level: "demonstrated" }]));
    expect(topic("Schema validation")!.level).toBe("engaged");
  });

  it("answering the agent's question counts as engaging, even in a turn that was only a go-ahead", async () => {
    const s = await newSession();
    await turn(s, "go ahead", note([{ name: "Race conditions", level: "demonstrated" }]), "proceed", async () => {
      expect(topic("Race conditions")).toBeUndefined();
      const { checkpoint } = await ask(s, ["Race conditions"], "tradeoff");
      expect(checkpoint!.status).toBe("pending");
      await resolve(checkpoint!.id, "answer", "Two writers share the temp dir");
    });
    expect(topic("Race conditions")!.level).toBe("demonstrated");
    // The same go-ahead without an answer: nothing the developer reasoned about.
    await turn(s, "go ahead", note([{ name: "Lock files", level: "demonstrated" }]), "proceed");
    expect(topic("Lock files")!.level).toBe("encountered");
  });

  it("links topics discussed in the same turn, and topics the agent names as related", async () => {
    const s = await newSession();
    await turn(s, "t1", note(["Indexes"]));
    await turn(s, "t2", note([{ name: "B-trees", related: ["Indexes", "Never mentioned"] }, "Page splits"]));
    const map = buildLearningMap(store);
    expect(map.topics.map((t) => t.name).sort()).toEqual(["B-trees", "Indexes", "Page splits"]);
    const id = (name: string) => map.topics.find((t) => t.name === name)!.id;
    const linked = (a: string, b: string) => map.links.find((l) => (l.source === id(a) && l.target === id(b)) || (l.source === id(b) && l.target === id(a)));
    expect(linked("B-trees", "Indexes")).toMatchObject({ related: true, weight: 1 });
    expect(linked("B-trees", "Page splits")).toMatchObject({ related: false, weight: 1 });
    expect(linked("Indexes", "Page splits")).toBeUndefined();
  });

  it("an undone turn leaves the map, and a deleted session takes its topics with it", async () => {
    const s = await newSession();
    await turn(s, "t1", note(["Kept"]));
    await turn(s, "t2", note(["Undone", { name: "Kept", related: ["Undone"] }]));
    store.markTurnsUndone([store.latestTurn(s.id)!.id]);
    let map = buildLearningMap(store);
    expect(map.topics.map((t) => t.name)).toEqual(["Kept"]);
    expect(map.topics[0]!.mentions).toBe(1);
    expect(map.links).toEqual([]);
    store.deleteSession(s.id);
    map = buildLearningMap(store);
    expect(map).toEqual({ topics: [], links: [], sessions: {} });
  });
});

describe("a topic read still in progress", () => {
  /** A turn whose messages the runtime is still returning when the developer acts. */
  async function slowRead() {
    const s = await newSession();
    await service.send(s.id, "explain caches");
    await later();
    let release!: () => void;
    let entered!: () => void;
    const reading = new Promise<void>((r) => (entered = r));
    runtime.getMessages = () => {
      entered();
      return new Promise((r) => (release = () => r([{ id: "a", role: "assistant", createdAt: store.latestTurn(s.id)!.startedAt + 1, parts: [{ type: "text", id: "p", text: note(["Caching"]) }] }])));
    };
    runtime.emit({ type: "session.idle", sessionId: s.runtimeSessionId });
    await reading;
    return release;
  }

  it("writes nothing after the map is cleared", async () => {
    const release = await slowRead();
    store.clearLearningMap();
    release();
    await engine().topicsSettled();
    expect(buildLearningMap(store).topics).toEqual([]);
  });

  it("writes nothing after tagging is turned off", async () => {
    const release = await slowRead();
    store.setPreferences({ learningMap: false });
    release();
    await engine().topicsSettled();
    expect(buildLearningMap(store).topics).toEqual([]);
  });

  it("still writes when nothing changed meanwhile", async () => {
    const release = await slowRead();
    release();
    await engine().topicsSettled();
    expect(buildLearningMap(store).topics.map((t) => t.name)).toEqual(["Caching"]);
  });
});

describe("telling the UI", () => {
  it("emits learningMap.updated when a turn's topics or a question's topics are recorded, and not otherwise", async () => {
    const events: PeerEvent[] = [];
    const hub = new EventHub();
    hub.subscribe((e) => events.push(e));
    // A service of its own, on a runtime of its own (the default one's service would end turns first).
    runtime = new FakeRuntime();
    runtime.getMessages = async () => replies;
    service = new PeerService(store, new RuntimeSet([runtime]), hub);
    const updates = () => events.filter((e) => e.type === "learningMap.updated").length;
    const s = await newSession();
    await turn(s, "small talk", "Hi!");
    expect(updates()).toBe(0);
    await turn(s, "t", note(["Caching"]));
    expect(updates()).toBe(1);
    await service.send(s.id, "next");
    await ask(s, ["Eviction"], "tradeoff");
    expect(updates()).toBe(2);
  });
});

describe("topics on the agent's questions", () => {
  it("follow the developer's response: answering engages, handing it back does not", async () => {
    const s = await newSession("learn");
    await service.send(s.id, "speed up the build");
    const a = await ask(s, ["Build caching", "build-caching", "", 7, "Incremental builds", "Content hashing", "Too many"]);
    expect(topic("Build caching")!.level).toBe("encountered");
    await resolve(a.checkpoint!.id, "answer", "Cache by content hash");
    expect(topic("Build caching")!.level).toBe("engaged");
    expect(topic("Incremental builds")!.level).toBe("engaged");
    expect(topic("Too many")).toBeUndefined(); // three topics per question at most
    // Each question in its own turn: Learn asks few questions per turn.
    const next = async (text: string) => {
      runtime.emit({ type: "session.idle", sessionId: s.runtimeSessionId });
      await service.send(s.id, text);
    };
    await next("and the remote cache?");
    const b = await ask(s, ["Remote caches"], "concept");
    expect(b.checkpoint!.status).toBe("pending");
    await resolve(b.checkpoint!.id, "delegate");
    expect(topic("Remote caches")!.level).toBe("encountered");
    await next("and invalidation?");
    const c = await ask(s, ["Cache invalidation"], "concept");
    expect(c.checkpoint!.status).toBe("pending");
    await resolve(c.checkpoint!.id, "hint");
    expect(topic("Cache invalidation")!.level).toBe("encountered");
  });

  it("routine work tags nothing", async () => {
    const s = await newSession("learn");
    await service.send(s.id, "rename the helper");
    await engine().requestCheckpoint(s.runtimeSessionId, null, { category: "routine", question: "Renaming", topics: ["Renaming"] });
    expect(buildLearningMap(store).topics).toEqual([]);
  });
});

describe("the API", () => {
  it("serves the map, validates the preference, and clears the map", async () => {
    const s = await newSession();
    await turn(s, "t", note(["Idempotency keys"]));
    const app = createApp({ service, hub: new EventHub(), apiToken: "api", bridgeToken: "b", allowedOrigins: [] });
    const call = (method: string, path: string, body?: unknown) =>
      app.request(`/api${path}`, { method, headers: { authorization: "Bearer api", "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
    const map = await (await call("GET", "/learning-map")).json();
    expect(map.topics.map((t: { name: string }) => t.name)).toEqual(["Idempotency keys"]);
    expect((await call("PATCH", "/preferences", { learningMap: "yes" })).status).toBe(400);
    expect((await (await call("PATCH", "/preferences", { learningMap: false })).json()).learningMap).toBe(false);
    expect(await (await call("DELETE", "/learning-map")).json()).toEqual({ topics: [], links: [], sessions: {} });
  });
});

describe("the layout", () => {
  it("is deterministic, separates nodes, and keeps seeded nodes near where they were", () => {
    const nodes = ["a", "b", "c", "d"].map((id) => ({ id, r: 4 }));
    const links = [
      { source: "a", target: "b", weight: 1 },
      { source: "b", target: "c", weight: 2 },
    ];
    const first = layoutGraph(nodes, links);
    expect(layoutGraph(nodes, links)).toEqual(first);
    for (const p of first.values()) expect(Number.isFinite(p.x) && Number.isFinite(p.y)).toBe(true);
    const d = (m: Map<string, { x: number; y: number }>, a: string, b: string) => Math.hypot(m.get(a)!.x - m.get(b)!.x, m.get(a)!.y - m.get(b)!.y);
    expect(d(first, "a", "d")).toBeGreaterThan(10);
    const again = layoutGraph([...nodes, { id: "e", r: 4 }], links, first);
    expect(d(again, "a", "b")).toBeLessThan(d(first, "a", "b") * 2);
    expect(again.has("e")).toBe(true);
    expect(layoutGraph([], [])).toEqual(new Map());
  });

  it("fits every point inside the view", () => {
    const pts = [
      { x: -100, y: 0 },
      { x: 100, y: 50 },
    ];
    const v = fitView(pts, 800, 600);
    for (const p of pts) {
      const sx = p.x * v.k + v.x;
      const sy = p.y * v.k + v.y;
      expect(sx).toBeGreaterThanOrEqual(0);
      expect(sx).toBeLessThanOrEqual(800);
      expect(sy).toBeGreaterThanOrEqual(0);
      expect(sy).toBeLessThanOrEqual(600);
    }
  });
});
