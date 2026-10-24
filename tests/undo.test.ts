import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../src/server/app.js";
import { undoneNote } from "../src/server/collaboration/engine.js";
import { EventHub } from "../src/server/hub.js";
import { RuntimeSet } from "../src/server/runtime/set.js";
import { Transcript } from "../src/server/runtime/transcript.js";
import { PeerService } from "../src/server/service.js";
import { Store } from "../src/server/store.js";
import { NOTHING_TO_UNDO, type PeerEvent, type PeerSession } from "../src/shared/types.js";
import { FakeRuntime } from "./helpers.js";

let repo: string;
let data: string;
let store: Store;
let runtime: FakeRuntime;
let service: PeerService;
let events: PeerEvent[];

const git = (...args: string[]) => execFileSync("git", args, { cwd: repo, encoding: "utf8" });
const read = (file: string) => readFileSync(join(repo, file), "utf8");
const put = (file: string, text: string) => {
  mkdirSync(join(repo, file, ".."), { recursive: true });
  writeFileSync(join(repo, file), text);
};

async function until(check: () => boolean, ms = 5000) {
  const end = Date.now() + ms;
  while (!check()) {
    if (Date.now() > end) throw new Error("timed out");
    await new Promise((r) => setTimeout(r, 10));
  }
}

beforeEach(() => {
  repo = realpathSync(mkdtempSync(join(tmpdir(), "peer-undo-repo-")));
  data = realpathSync(mkdtempSync(join(tmpdir(), "peer-undo-data-")));
  git("init", "-q");
  git("config", "user.email", "dev@example.com");
  git("config", "user.name", "dev");
  put("a.txt", "base\n");
  put("d.txt", "doomed\n");
  git("add", ".");
  git("commit", "-qm", "init");
  store = new Store(":memory:");
  runtime = new FakeRuntime();
  const hub = new EventHub();
  events = [];
  hub.subscribe((e) => events.push(e));
  service = new PeerService(store, new RuntimeSet([runtime]), hub, { snapshotDir: join(data, "snapshots") });
});

afterEach(() => {
  store.close();
  rmSync(repo, { recursive: true, force: true });
  rmSync(data, { recursive: true, force: true });
});

async function newSession(mode: PeerSession["mode"] = "focus", dir = repo) {
  const ws = service.addWorkspace(dir);
  return service.createSession(ws.id, { mode });
}

/** One agent turn: the prompt reaches the runtime, `work` changes files, the runtime goes idle. */
async function turn(s: PeerSession, work: () => void, text = "do it") {
  const before = runtime.prompts.length;
  await service.send(s.id, text);
  expect(runtime.prompts).toHaveLength(before + 1);
  work();
  runtime.emit({ type: "session.idle", sessionId: s.runtimeSessionId });
  await service.engine.settled(s.id);
}

describe("undo last turn", () => {
  it("puts back exactly the files the turn changed, and keeps the developer's other work", async () => {
    put("c.txt", "developer's uncommitted work\n");
    const s = await newSession();
    expect(service.snapshot(s.id).undo).toEqual({ available: false, reason: NOTHING_TO_UNDO });
    await turn(s, () => {
      put("a.txt", "agent edit\n");
      put("new/deep/b.txt", "agent file\n");
      unlinkSync(join(repo, "d.txt"));
    });
    expect(service.snapshot(s.id).undo).toEqual({ available: true, reason: null });

    const result = await service.undoLastTurn(s.id);
    expect(result.files.sort()).toEqual(["a.txt", "d.txt", "new/deep/b.txt"]);
    expect(result).toMatchObject({ turns: 1, forgotten: false });
    expect(read("a.txt")).toBe("base\n");
    expect(read("d.txt")).toBe("doomed\n");
    expect(existsSync(join(repo, "new"))).toBe(false); // directories the turn created are gone too
    expect(read("c.txt")).toBe("developer's uncommitted work\n");
    // The developer's index is untouched: nothing staged, the repo is as before the turn.
    expect(git("status", "--porcelain")).toBe("?? c.txt\n");

    expect(runtime.forgotten).toEqual([{ sessionId: s.runtimeSessionId, since: store.latestTurn(s.id)!.startedAt }]);
    expect(store.latestTurn(s.id)!.undoneAt).not.toBeNull();
    expect(events.some((e) => e.type === "session.undone" && e.sessionId === s.id)).toBe(true);
    expect(service.snapshot(s.id).undo).toEqual({ available: false, reason: NOTHING_TO_UNDO });
  });

  it("walks back one turn at a time", async () => {
    const s = await newSession();
    await turn(s, () => put("a.txt", "one\n"));
    await turn(s, () => put("a.txt", "two\n"));
    await service.undoLastTurn(s.id);
    expect(read("a.txt")).toBe("one\n");
    await service.undoLastTurn(s.id);
    expect(read("a.txt")).toBe("base\n");
    await expect(service.undoLastTurn(s.id)).rejects.toThrow(NOTHING_TO_UNDO);
  });

  it("refuses, changing nothing, when a file the turn changed was edited afterwards", async () => {
    const s = await newSession();
    await turn(s, () => {
      put("a.txt", "agent edit\n");
      put("b.txt", "agent file\n");
    });
    put("a.txt", "developer fixed it up\n");
    put("other.txt", "unrelated developer file\n");

    await expect(service.undoLastTurn(s.id)).rejects.toThrow(/Nothing was undone: a\.txt changed after the turn ended/);
    expect(read("a.txt")).toBe("developer fixed it up\n");
    expect(read("b.txt")).toBe("agent file\n");
    expect(store.latestTurn(s.id)!.undoneAt).toBeNull();

    // Edits to files the turn did not touch do not block an undo, and survive it.
    put("a.txt", "agent edit\n");
    await service.undoLastTurn(s.id);
    expect(read("a.txt")).toBe("base\n");
    expect(existsSync(join(repo, "b.txt"))).toBe(false);
    expect(read("other.txt")).toBe("unrelated developer file\n");
  });

  it("tells an agent that keeps the turn in its context, once, on its next turn", async () => {
    const s = await newSession();
    await turn(s, () => put("a.txt", "x\n"));
    await service.undoLastTurn(s.id);
    await turn(s, () => {});
    expect(runtime.lastPrompt().input.system).toContain(undoneNote(1));
    await turn(s, () => {});
    expect(runtime.lastPrompt().input.system).not.toContain("Undone by the developer");
  });

  it("tells nothing when the runtime dropped the turn from the conversation itself", async () => {
    runtime.forgets = true;
    const s = await newSession();
    await turn(s, () => put("a.txt", "x\n"));
    expect((await service.undoLastTurn(s.id)).forgotten).toBe(true);
    await turn(s, () => {});
    expect(runtime.lastPrompt().input.system).not.toContain("Undone by the developer");
  });

  it("undoes a Codex task together with the continuation that carried it on", async () => {
    runtime.sandboxFixedPerTurn = true;
    const s = await newSession("learn");
    await service.send(s.id, "add ETag support");
    const { checkpoint } = await service.engine.requestCheckpoint(s.runtimeSessionId, null, { category: "hypothesis", question: "What should the ETag be?" });
    await service.engine.resolveCheckpoint(checkpoint!.id, { action: "answer", text: "A hash" });
    runtime.emit({ type: "session.idle", sessionId: s.runtimeSessionId });
    await until(() => runtime.prompts.length === 2); // the continuation, with write access
    put("a.txt", "etag\n");
    runtime.emit({ type: "session.idle", sessionId: s.runtimeSessionId });
    await service.engine.settled(s.id);

    const result = await service.undoLastTurn(s.id);
    expect(result).toMatchObject({ turns: 2, files: ["a.txt"] });
    expect(read("a.txt")).toBe("base\n");
    // One forget, from the start of the task.
    expect(runtime.forgotten).toHaveLength(1);
    await turn(s, () => {});
    expect(runtime.lastPrompt().input.system).toContain(undoneNote(2));
  });

  it("is unavailable while the agent works, and outside git", async () => {
    const s = await newSession();
    await service.send(s.id, "work");
    expect(service.snapshot(s.id).undo).toEqual({ available: false, reason: "Wait for the agent to finish this turn." });
    await expect(service.undoLastTurn(s.id)).rejects.toThrow(/Wait for the agent/);

    const plain = realpathSync(mkdtempSync(join(tmpdir(), "peer-undo-plain-")));
    try {
      const p = await newSession("focus", plain);
      await turn(p, () => writeFileSync(join(plain, "x.txt"), "x"));
      expect(service.snapshot(p.id).undo.reason).toMatch(/git repository/);
    } finally {
      rmSync(plain, { recursive: true, force: true });
    }
  });

  it("does not offer a turn the runtime never ran", async () => {
    const s = await newSession();
    runtime.prompt = async () => {
      throw new Error("model unavailable");
    };
    await expect(service.send(s.id, "x")).rejects.toThrow("model unavailable");
    expect(service.snapshot(s.id).undo.reason).toBe(NOTHING_TO_UNDO);
  });

  it("refuses when Peer restarted during the turn (no record of how it ended)", async () => {
    const s = await newSession();
    await service.send(s.id, "x");
    put("a.txt", "agent edit\n");
    // A restart ends open turns without a snapshot.
    const restarted = new PeerService(store, new RuntimeSet([runtime]), new EventHub(), { snapshotDir: join(data, "snapshots") });
    await expect(restarted.undoLastTurn(s.id)).rejects.toThrow(/no record of how this turn ended/);
    expect(read("a.txt")).toBe("agent edit\n");
  });
});

describe("undo edge cases (review findings)", () => {
  it("reports idle only once the end of the turn is recorded, so later edits are the developer's", async () => {
    const s = await newSession();
    await service.send(s.id, "edit");
    put("a.txt", "agent\n");
    events.length = 0;
    runtime.emit({ type: "session.idle", sessionId: s.runtimeSessionId });
    // Still busy while the end snapshot is taken; no idle has gone out.
    expect(service.snapshot(s.id).status).toBe("busy");
    await expect(service.send(s.id, "next")).rejects.toThrow(/still working/);
    expect(events.some((e) => e.type === "session.status" && e.status === "idle")).toBe(false);
    await until(() => events.some((e) => e.type === "session.status" && e.sessionId === s.id && e.status === "idle"));
    expect(store.turnTrees(store.latestTurn(s.id)!.id).end).not.toBeNull();
    expect(service.snapshot(s.id).status).toBe("idle");

    put("a.txt", "developer after idle\n");
    await expect(service.undoLastTurn(s.id)).rejects.toThrow(/a\.txt changed after the turn ended/);
    expect(read("a.txt")).toBe("developer after idle\n");
  });

  it("does not forward a runtime's early idle status while the turn is still open", async () => {
    const s = await newSession();
    await service.send(s.id, "edit");
    events.length = 0;
    runtime.emit({ type: "session.status", sessionId: s.runtimeSessionId, status: "idle" });
    await new Promise((r) => setImmediate(r));
    expect(events.some((e) => e.type === "session.status" && e.status === "idle")).toBe(false);
    // The engine agrees: still busy, so a new message cannot start an overlapping turn.
    expect(service.snapshot(s.id).status).toBe("busy");
    await expect(service.send(s.id, "next")).rejects.toThrow(/still working/);
    expect(runtime.prompts).toHaveLength(1);
    runtime.emit({ type: "session.idle", sessionId: s.runtimeSessionId });
    await until(() => events.some((e) => e.type === "session.status" && e.status === "idle"));
  });

  it("only undoes inside the workspace folder of a larger repository", async () => {
    put("app/a.txt", "before\n");
    put("outside.txt", "before\n");
    git("add", ".");
    git("commit", "-qm", "app");
    const s = await newSession("focus", join(repo, "app"));
    await turn(s, () => {
      put("app/a.txt", "agent\n");
      put("outside.txt", "developer, elsewhere in the repo\n");
    });
    const result = await service.undoLastTurn(s.id);
    expect(result.files).toEqual(["app/a.txt"]);
    expect(read("app/a.txt")).toBe("before\n");
    expect(read("outside.txt")).toBe("developer, elsewhere in the repo\n");
  });

  it("does not start the agent when Stop comes during the start snapshot", async () => {
    const s = await newSession();
    const sending = service.send(s.id, "edit");
    await service.abort(s.id);
    await sending;
    expect(runtime.prompts).toHaveLength(0);
    await service.engine.settled(s.id);
    expect(service.snapshot(s.id).status).toBe("idle");
    expect(service.snapshot(s.id).undo.reason).toBe(NOTHING_TO_UNDO);
    await turn(s, () => {}); // the session stays usable
  });

  it("undoes a file replaced by a directory, and a directory replaced by a file", async () => {
    put("dir/x.txt", "x\n");
    git("add", ".");
    git("commit", "-qm", "dir");
    const s = await newSession();
    await turn(s, () => {
      unlinkSync(join(repo, "a.txt"));
      put("a.txt/nested.txt", "agent\n");
      rmSync(join(repo, "dir"), { recursive: true });
      put("dir", "now a file\n");
    });
    await service.undoLastTurn(s.id);
    expect(read("a.txt")).toBe("base\n");
    expect(read("dir/x.txt")).toBe("x\n");
    expect(git("status", "--porcelain")).toBe("");
  });
});

describe("undo over the API", () => {
  it("POST /sessions/:id/undo reports why it cannot undo", async () => {
    const hub = new EventHub();
    const app = createApp({ service, hub, apiToken: "token", bridgeToken: "bridge", allowedOrigins: [] });
    const s = await newSession();
    const res = await app.request(`/api/sessions/${s.id}/undo`, { method: "POST", headers: { authorization: "Bearer token" } });
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: NOTHING_TO_UNDO });

    await turn(s, () => put("a.txt", "x\n"));
    const ok = await app.request(`/api/sessions/${s.id}/undo`, { method: "POST", headers: { authorization: "Bearer token" } });
    expect(ok.status).toBe(200);
    expect(await ok.json()).toEqual({ files: ["a.txt"], turns: 1, forgotten: false });
  });
});

describe("transcript", () => {
  it("drops an undone turn and everything after it, in memory and in storage", () => {
    const s = new Store(":memory:");
    const t = new Transcript("codex", "rt", s, () => {});
    t.addUserMessage("u1", "first");
    t.startAssistantMessage("a1");
    const since = Date.now() + 1;
    while (Date.now() < since); // the next message is created after `since`
    t.addUserMessage("u2", "second");
    t.startAssistantMessage("a2");
    const cut = t.list().find((m) => m.id === "u2")!.createdAt;
    expect(t.dropSince(cut)).toBe(2);
    expect(t.list().map((m) => m.id)).toEqual(["u1", "a1"]);
    expect(new Transcript("codex", "rt", s, () => {}).list().map((m) => m.id)).toEqual(["u1", "a1"]);
    s.close();
  });
});
