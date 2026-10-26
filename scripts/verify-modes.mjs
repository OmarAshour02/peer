#!/usr/bin/env node
// Milestone 3 verification: run the same task in Focus, Collaborate and Learn against a real
// Peer server + OpenCode runtime + model, and record how the interaction differed.
//
// It drives the public Peer API exactly like the UI does. Checkpoints are answered by a scripted
// "developer" (see respond()); permission requests are rejected (the script never approves
// anything risky). Nothing is simulated: if the model or provider is unavailable, it fails.
//
// Usage:
//   npm run server &                          # or a running Peer desktop app
//   node scripts/verify-modes.mjs [--api http://127.0.0.1:4317] [--token <t>] [--model provider/model]
//                                 [--modes collaborate,learn] [--task "..."] [--runtime opencode|claude|codex] [--out report.json]
//   --model is required (or --allow-default-model): it is checked against the runtime and read back
//   from each created session before any prompt is sent.
import { cpSync, existsSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs, parseModelRef, formatModelRef } from "./lib/args.mjs";
import { assertSessionModel, resolveRuntimeModel } from "./lib/model-guard.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const args = parseArgs(
  {
    api: { type: "string" },
    token: { type: "string" },
    runtime: { type: "string" },
    model: { type: "string" },
    "allow-default-model": { type: "boolean" },
    modes: { type: "string" },
    task: { type: "string" },
    timeout: { type: "string" },
    out: { type: "string" },
  },
  process.argv.slice(2),
);

function defaultDataDir() {
  if (process.env.PEER_DATA_DIR) return process.env.PEER_DATA_DIR;
  const home = process.env.HOME;
  return process.platform === "darwin" ? join(home, "Library", "Application Support", "Peer") : join(process.env.XDG_CONFIG_HOME || join(home, ".config"), "Peer");
}

const API = args.api ?? `http://127.0.0.1:${process.env.PEER_PORT ?? 4317}`;
const TOKEN = args.token ?? readFileSync(join(defaultDataDir(), "api-token"), "utf8").trim();
// Focus is retired; pass --modes focus,… to include it.
const MODES = (args.modes ?? "collaborate,learn").split(",");
const TASK =
  args.task ??
  "Add rate limiting to this API so a single client cannot make more than 5 requests per minute to /api/notes. Include a test.";
const RUNTIME = args.runtime ?? "opencode";
const MODEL = args.model ? parseModelRef(args.model) : null;
const TURN_TIMEOUT_MS = Number(args.timeout ?? 15 * 60_000);

async function api(path, init = {}) {
  const res = await fetch(`${API}/api${path}`, {
    ...init,
    headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },
    body: init.body ? JSON.stringify(init.body) : undefined,
  });
  const text = await res.text();
  const body = text ? JSON.parse(text) : null;
  if (!res.ok) throw new Error(`${init.method ?? "GET"} ${path} -> ${res.status}: ${text}`);
  return body;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** The scripted developer. Engages briefly and concretely, like a real teammate would. */
function respond(cp, mode, state) {
  // In Learn mode, ask for one hint on the first hypothesis/concept question to exercise hints.
  if (mode === "learn" && ["hypothesis", "concept"].includes(cp.category) && !state.askedHint) {
    state.askedHint = true;
    return { action: "hint" };
  }
  if (cp.options.length > 0) {
    const pick = cp.options.find((o) => o.label === cp.recommendation) ?? cp.options[0];
    return { action: "choose", option: pick.label };
  }
  if (["hypothesis", "concept"].includes(cp.category)) {
    return {
      action: "answer",
      text: "If the counters live in process memory, each API instance counts separately, so a client could exceed the limit by spreading requests across instances; a shared store fixes that. For this single-process app in-memory is fine.",
    };
  }
  return { action: "answer", text: "Sounds good. Keep it simple and in-memory, keyed by client IP, then go ahead." };
}

function makeFixture() {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "peer-verify-")));
  cpSync(join(root, "tests", "fixtures", "notes-api"), dir, { recursive: true });
  execFileSync("git", ["init", "-q"], { cwd: dir });
  execFileSync("git", ["add", "-A"], { cwd: dir });
  execFileSync("git", ["-c", "user.email=peer@local", "-c", "user.name=peer", "commit", "-qm", "fixture"], { cwd: dir });
  return dir;
}

async function runMode(mode) {
  const dir = makeFixture();
  const ws = await api("/workspaces", { method: "POST", body: { path: dir } });
  const session = await api(`/workspaces/${ws.id}/sessions`, { method: "POST", body: { mode, model: MODEL, runtime: RUNTIME } });
  assertSessionModel(session, MODEL);
  const log = [];
  const state = { askedHint: false };
  const handled = new Set();
  const started = Date.now();
  console.log(`\n=== ${mode.toUpperCase()} on ${RUNTIME}  (${dir})`);

  let turns = 1;
  await api(`/sessions/${session.id}/messages`, { method: "POST", body: { text: TASK } });
  let idleSince = null;
  let finished = false;

  while (Date.now() - started < TURN_TIMEOUT_MS) {
    await sleep(1000);
    const snap = await api(`/sessions/${session.id}`);
    if (snap.lastError) throw new Error(`runtime error: ${snap.lastError}`);

    for (const perm of snap.permissions) {
      if (handled.has(perm.id)) continue;
      handled.add(perm.id);
      log.push({ kind: "permission", permission: perm.permission, patterns: perm.patterns, reply: "reject" });
      console.log(`  [permission] ${perm.permission} ${perm.patterns.join(" ")} -> reject`);
      await api(`/permissions/${perm.id}/reply`, { method: "POST", body: { reply: "reject" } });
    }

    for (const cp of snap.checkpoints) {
      if (handled.has(cp.id)) continue;
      if (cp.status === "auto_resolved") {
        handled.add(cp.id);
        log.push({ kind: "declined", category: cp.category, question: cp.question, note: cp.resolution?.note });
        console.log(`  [declined by policy] (${cp.category}) ${cp.question}\n      ${cp.resolution?.note}`);
      } else if (cp.status === "pending") {
        handled.add(cp.id);
        const reply = respond(cp, mode, state);
        log.push({ kind: "checkpoint", category: cp.category, question: cp.question, options: cp.options.map((o) => o.label), reply });
        console.log(`  [checkpoint] (${cp.category}) ${cp.question}\n      -> ${reply.action}${reply.option ? `: ${reply.option}` : ""}`);
        await api(`/checkpoints/${cp.id}/resolve`, { method: "POST", body: reply });
      }
    }

    if (snap.status === "idle") {
      idleSince ??= Date.now();
      if (Date.now() - idleSince < 2500) continue;
      // The agent ended its turn. If it ended with a question in prose (no checkpoint),
      // reply once like a developer would; otherwise we're done.
      const messages = await api(`/sessions/${session.id}/messages`);
      const last = messages.at(-1);
      const text = last?.parts.filter((p) => p.type === "text").map((p) => p.text).join("\n") ?? "";
      const changed = execFileSync("git", ["status", "--porcelain"], { cwd: dir }).toString().trim();
      if (turns < 3 && !changed && /\?\s*$/.test(text.trim())) {
        turns++;
        const reply = "Good question. Keep it in-memory per client IP with a fixed one-minute window, and go ahead.";
        log.push({ kind: "prose-question", question: text.trim().split("\n").at(-1), reply });
        console.log(`  [prose question] ${text.trim().split("\n").at(-1)}\n      -> reply`);
        await api(`/sessions/${session.id}/messages`, { method: "POST", body: { text: reply } });
        idleSince = null;
        continue;
      }
      finished = true;
      break;
    } else {
      idleSince = null;
    }
  }

  const events = await api(`/sessions/${session.id}/events`);
  const messages = await api(`/sessions/${session.id}/messages`);
  const tools = messages.flatMap((m) => m.parts.filter((p) => p.type === "tool"));
  const changed = execFileSync("git", ["status", "--porcelain"], { cwd: dir }).toString().trim().split("\n").filter(Boolean);
  let testsPass = null;
  try {
    execFileSync("node", ["--test"], { cwd: dir, stdio: "pipe", timeout: 60_000 });
    testsPass = true;
  } catch {
    testsPass = false;
  }
  if (!finished) {
    console.log(`  !! timed out after ${TURN_TIMEOUT_MS / 1000}s while the agent was still working; stopping it`);
    await api(`/sessions/${session.id}/abort`, { method: "POST" }).catch(() => {});
  }
  const texts = messages.filter((m) => m.role === "assistant").flatMap((m) => m.parts.filter((p) => p.type === "text").map((p) => p.text));
  const finalText = texts.at(-1) ?? "";
  const result = {
    runtime: RUNTIME,
    mode,
    dir,
    timedOut: !finished,
    seconds: Math.round((Date.now() - started) / 1000),
    userTurns: turns,
    checkpointsAsked: log.filter((l) => l.kind === "checkpoint").length,
    checkpointsDeclinedByPolicy: log.filter((l) => l.kind === "declined").length,
    hintsRequested: log.filter((l) => l.kind === "checkpoint" && l.reply.action === "hint").length,
    gateBlocks: events.filter((e) => e.type === "gate.blocked").length,
    firstEditAfterEngagement: firstEditAfterEngagement(events, tools),
    toolCalls: tools.length,
    filesChanged: changed,
    testsPass,
    log,
    finalText: finalText.slice(0, 1500),
  };
  console.log(`  -> ${result.checkpointsAsked} checkpoint(s), ${result.checkpointsDeclinedByPolicy} declined, ${result.gateBlocks} gate block(s), ${changed.length} file(s) changed, tests ${testsPass ? "pass" : "FAIL"}, ${result.seconds}s`);
  return result;
}

function firstEditAfterEngagement(events, tools) {
  const engaged = events.find((e) => e.type === "checkpoint.resolved" && e.payload.action !== "hint");
  const edits = tools.filter((t) => ["edit", "write", "apply_patch"].includes(t.tool) && t.status === "completed");
  if (edits.length === 0) return null;
  return engaged ? "edits happened after the developer engaged" : "edits happened without a checkpoint";
}

// Resolve and record the runtime and model before any prompt is sent.
const probe = await api("/workspaces", { method: "POST", body: { path: makeFixture() } });
const resolved = await resolveRuntimeModel(api, probe.id, RUNTIME, MODEL, { allowDefault: args["allow-default-model"] });
console.log(`Peer ${API}, runtime ${resolved.runtimeName} ${resolved.runtimeVersion}, model ${formatModelRef(resolved.model)}${resolved.usingDefault ? " (runtime default, explicitly allowed)" : ""}`);
console.log(`Task: ${TASK}`);

const results = [];
for (const mode of MODES) results.push(await runMode(mode));

console.log("\n| mode | checkpoints asked | declined by policy | hints | gate blocks | files changed | tests | time |");
console.log("|---|---|---|---|---|---|---|---|");
for (const r of results) {
  const time = `${r.seconds}s${r.timedOut ? " (timed out)" : ""}`;
  console.log(`| ${r.mode} | ${r.checkpointsAsked} | ${r.checkpointsDeclinedByPolicy} | ${r.hintsRequested} | ${r.gateBlocks} | ${r.filesChanged.length} | ${r.testsPass ? "pass" : "fail"} | ${time} |`);
}
const out = args.out ?? join(root, ".peer-dev", `verify-modes-${RUNTIME}-${Date.now()}.json`);
try {
  if (!existsSync(join(root, ".peer-dev"))) execFileSync("mkdir", ["-p", join(root, ".peer-dev")]);
  writeFileSync(out, JSON.stringify({ task: TASK, runtime: RUNTIME, model: resolved.model, resolved, results }, null, 2));
  console.log(`\nFull report: ${out}`);
} catch {
  // report file is best-effort
}
