import { mkdtempSync, realpathSync, rmSync, writeFileSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, delimiter } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { GeminiAdapter, geminiArgs, geminiTurnPrompt, GEMINI_WARNING } from "../src/server/runtime/gemini/adapter.js";
import { Transcript } from "../src/server/runtime/transcript.js";
import { Store } from "../src/server/store.js";
import type { RuntimeEvent } from "../src/server/runtime/adapter.js";
import { pickDefaultRuntime } from "../src/shared/types.js";

let dir: string;
let store: Store;

const envWith = (binDir: string | null) => ({
  ...process.env,
  PATH: binDir ? [binDir, ...(process.env.PATH ?? "").split(delimiter)].join(delimiter) : "/nonexistent",
});

/** A fake `gemini` CLI: logs argv, prints stdout, exits as told by env (except --version). */
function fakeGemini(binDir: string) {
  writeFileSync(
    join(binDir, "gemini"),
    `#!/bin/sh
echo "$@" >> "$GEMINI_ARGS_LOG"
if [ "$1" = "--version" ]; then echo "fake-gemini 1.2.3"; exit 0; fi
if [ -n "$GEMINI_STDERR" ]; then echo "$GEMINI_STDERR" >&2; fi
if [ -n "$GEMINI_EXIT" ]; then exit "$GEMINI_EXIT"; fi
case "$*" in
  *FIRST_A*) printf '%s\n%s\n' '{"type":"init","session_id":"cli-a","model":"fake"}' '{"type":"message","role":"assistant","content":"answer A"}'; exit 0 ;;
  *FIRST_B*) printf '%s\n%s\n' '{"type":"init","session_id":"cli-b","model":"fake"}' '{"type":"message","role":"assistant","content":"answer B"}'; exit 0 ;;
  *AGAIN_A*) printf '%s\n' '{"type":"message","role":"assistant","content":"answer A2"}'; exit 0 ;;
  *AGAIN_B*) printf '%s\n' '{"type":"message","role":"assistant","content":"answer B2"}'; exit 0 ;;
esac
if [ -n "$GEMINI_SLOW" ]; then trap 'sleep 0.3; exit 0' TERM; echo slow; while :; do sleep 0.05; done; fi
printf '%s\n%s\n' '{"type":"init","session_id":"cli-default","model":"fake"}' '{"type":"message","role":"assistant","content":"did the work"}'
`,
  );
  chmodSync(join(binDir, "gemini"), 0o755);
}

function adapter(binDir: string | null, extraEnv: Record<string, string> = {}) {
  const events: RuntimeEvent[] = [];
  const a = new GeminiAdapter({ env: { ...envWith(binDir), ...extraEnv }, storage: store, dataDir: join(dir, "data"), log: () => {} });
  a.onEvent((e) => events.push(e));
  return { adapter: a, events };
}

function waitFor(events: RuntimeEvent[], type: RuntimeEvent["type"], ms = 5000, fromIndex = 0) {
  return new Promise<RuntimeEvent>((resolve, reject) => {
    const end = Date.now() + ms;
    const poll = () => {
      const found = events.slice(fromIndex).find((e) => e.type === type);
      if (found) return resolve(found);
      if (Date.now() > end) return reject(new Error(`timed out waiting for ${type}`));
      setTimeout(poll, 10);
    };
    poll();
  });
}

beforeEach(() => {
  dir = realpathSync(mkdtempSync(join(tmpdir(), "peer-gemini-")));
  store = new Store(":memory:");
  process.env.GEMINI_ARGS_LOG = join(dir, "args.log");
  writeFileSync(process.env.GEMINI_ARGS_LOG, "");
});

afterEach(() => {
  delete process.env.GEMINI_ARGS_LOG;
  delete process.env.GEMINI_EXIT;
  delete process.env.GEMINI_STDERR;
  delete process.env.GEMINI_SLOW;
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

describe("gemini CLI arguments", () => {
  const input = (gate: "open" | "engage" | "hold") => ({ text: "do it", system: "POLICY", gate });

  it("runs every turn read-only until Peer can approve Gemini commands", () => {
    for (const gate of ["open", "engage", "hold"] as const) {
      expect(geminiArgs(input(gate), null)).toEqual(["--approval-mode", "plan", "--output-format", "stream-json", "-p", expect.stringContaining("POLICY")]);
    }
  });

  it("resumes the exact CLI session for this Peer session", () => {
    expect(geminiArgs(input("open"), null).slice(0, 2)).toEqual(["--approval-mode", "plan"]);
    expect(geminiArgs(input("open"), "cli-a").slice(0, 2)).toEqual(["--resume", "cli-a"]);
    expect(geminiArgs(input("open"), "cli-b")).toContain("cli-b");
    expect(geminiArgs(input("open"), "cli-b")).not.toContain("cli-a");
  });

  it("tells the model what the runtime can and cannot do", () => {
    expect(geminiTurnPrompt(input("open"))).toContain("do it");
    expect(geminiTurnPrompt(input("open"))).toMatch(/no peer_checkpoint tool/i);
    expect(geminiTurnPrompt(input("engage"))).toMatch(/read-only/i);
    expect(geminiTurnPrompt(input("open"))).toMatch(/read-only/i);
  });
});

describe("gemini adapter lifecycle", () => {
  it("is unavailable without the CLI, ready with it (with a standing warning)", async () => {
    const missing = adapter(null);
    await missing.adapter.start();
    expect(missing.adapter.status().state).toBe("unavailable");

    const binDir = join(dir, "bin");
    const { mkdirSync } = await import("node:fs");
    mkdirSync(binDir, { recursive: true });
    fakeGemini(binDir);
    const { adapter: a } = adapter(binDir);
    await a.start();
    expect(a.status()).toMatchObject({ state: "ready", warning: GEMINI_WARNING });
    await a.stop();
    expect(a.status().state).toBe("stopped");
  });

  it("runs a turn headlessly and records the transcript", async () => {
    const binDir = join(dir, "bin");
    const { mkdirSync } = await import("node:fs");
    mkdirSync(binDir, { recursive: true });
    fakeGemini(binDir);
    const { adapter: a, events } = adapter(binDir);
    await a.start();
    const { id } = await a.createSession(dir, {});
    await a.prompt(dir, id, { text: "do it", system: "POLICY", gate: "open" });
    await waitFor(events, "session.idle");
    const messages = await a.getMessages(dir, id);
    expect(messages.map((m) => m.role)).toEqual(["user", "assistant"]);
    expect(JSON.stringify(messages[1])).toContain("did the work");
    // Second turn resumes the CLI session.
    const seen = events.length;
    await a.prompt(dir, id, { text: "again", system: "POLICY", gate: "engage" });
    await waitFor(events, "session.idle", 5000, seen);
    const log = (await import("node:fs")).readFileSync(process.env.GEMINI_ARGS_LOG!, "utf8");
    expect(log).toMatch(/--approval-mode plan/);
    expect(log).toMatch(/--resume cli-default/);
    expect(log).not.toMatch(/--approval-mode yolo/);
  });

  it("keeps interleaved Peer sessions on separate CLI conversations", async () => {
    const binDir = join(dir, "bin");
    const { mkdirSync, readFileSync } = await import("node:fs");
    mkdirSync(binDir, { recursive: true });
    fakeGemini(binDir);
    const { adapter: a, events } = adapter(binDir);
    await a.start();
    const sa = await a.createSession(dir, {});
    const sb = await a.createSession(dir, {});

    await a.prompt(dir, sa.id, { text: "FIRST_A", system: "POLICY", gate: "open" });
    await waitFor(events, "session.idle");
    let seen = events.length;
    await a.prompt(dir, sb.id, { text: "FIRST_B", system: "POLICY", gate: "open" });
    await waitFor(events, "session.idle", 5000, seen);
    seen = events.length;
    await a.prompt(dir, sa.id, { text: "AGAIN_A", system: "POLICY", gate: "open" });
    await waitFor(events, "session.idle", 5000, seen);
    seen = events.length;
    await a.prompt(dir, sb.id, { text: "AGAIN_B", system: "POLICY", gate: "open" });
    await waitFor(events, "session.idle", 5000, seen);

    const log = readFileSync(process.env.GEMINI_ARGS_LOG!, "utf8");
    expect(log).toContain("--resume cli-a");
    expect(log).toContain("--resume cli-b");
    expect(JSON.stringify(await a.getMessages(dir, sa.id))).toContain("answer A2");
    expect(JSON.stringify(await a.getMessages(dir, sb.id))).toContain("answer B2");
  });

  it("does not release a session until the aborted process has exited", async () => {
    const binDir = join(dir, "bin");
    const { mkdirSync } = await import("node:fs");
    mkdirSync(binDir, { recursive: true });
    fakeGemini(binDir);
    process.env.GEMINI_SLOW = "1";
    const { adapter: a, events } = adapter(binDir);
    await a.start();
    const { id } = await a.createSession(dir, {});
    await a.prompt(dir, id, { text: "slow work", system: "POLICY", gate: "open" });
    await new Promise((resolve) => setTimeout(resolve, 100));
    const stopping = a.abort(dir, id);
    await expect(a.prompt(dir, id, { text: "next", system: "POLICY", gate: "open" })).rejects.toThrow(/still working/);
    await stopping;
    expect(events.filter((e) => e.type === "session.idle")).toHaveLength(1);
  });

  it("reports a failing CLI as a turn error", async () => {
    const binDir = join(dir, "bin");
    const { mkdirSync } = await import("node:fs");
    mkdirSync(binDir, { recursive: true });
    fakeGemini(binDir);
    const { adapter: a, events } = adapter(binDir, { GEMINI_EXIT: "3", GEMINI_STDERR: "not logged in" });
    await a.start();
    expect(a.status().state).toBe("ready");
    const { id } = await a.createSession(dir, {});
    await a.prompt(dir, id, { text: "do it", system: "POLICY", gate: "open" });
    const idle = await waitFor(events, "session.idle");
    expect(idle).toBeDefined();
    expect(events.some((e) => e.type === "session.error" && e.error.includes("not logged in"))).toBe(true);
    const [, assistant] = await a.getMessages(dir, id);
    expect(assistant!.error).toContain("not logged in");
  });

  it("undo drops Peer's transcript and tells the agent next turn", async () => {
    const binDir = join(dir, "bin");
    const { mkdirSync } = await import("node:fs");
    mkdirSync(binDir, { recursive: true });
    fakeGemini(binDir);
    const { adapter: a, events } = adapter(binDir);
    await a.start();
    const { id } = await a.createSession(dir, {});
    const since = Date.now();
    await a.prompt(dir, id, { text: "do it", system: "POLICY", gate: "open" });
    await waitFor(events, "session.idle");
    expect(await a.forgetTurns(dir, id, since)).toBe(false);
    expect(new Transcript("gemini", id, store, () => {}).list()).toHaveLength(0);
  });

  it("offers the CLI default model and no permission surface", async () => {
    const { adapter: a } = adapter(null);
    expect(await a.listModels()).toMatchObject({ default: { providerId: "gemini", modelId: "default" } });
    expect(await a.listPermissions(dir)).toEqual([]);
    await expect(a.replyPermission(dir, "x", "once")).rejects.toThrow(/never asks/);
  });
});

describe("gemini in runtime selection", () => {
  it("is preferred over the bundled runtime, after Claude Code and Codex", () => {
    const rt = (gemini: string, claude = "unavailable", codex = "unavailable") => [
      { kind: "opencode" as const, status: { state: "ready" } },
      { kind: "claude" as const, status: { state: claude } },
      { kind: "codex" as const, status: { state: codex } },
      { kind: "gemini" as const, status: { state: gemini } },
    ];
    expect(pickDefaultRuntime(null, rt("ready"))).toBe("gemini");
    expect(pickDefaultRuntime(null, rt("ready", "ready"))).toBe("claude");
    expect(pickDefaultRuntime(null, rt("ready", "unavailable", "ready"))).toBe("codex");
    expect(pickDefaultRuntime(null, rt("unavailable"))).toBe("opencode");
  });
});
