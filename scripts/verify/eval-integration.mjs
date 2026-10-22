#!/usr/bin/env node
// npm run eval:integration: full agent-integration evaluation against real runtimes and models.
// Expensive (real model quota), so it is never part of `npm test` or `npm run verify:peer`.
//
//   npm run eval:integration -- --target claude:claude/haiku --target codex:codex/gpt-6-luna
//   npm run eval:integration -- --target claude:claude/haiku --confirm
//
// Without --confirm it only starts a private Peer server, resolves every target's runtime and
// model, prints the plan and exits. With --confirm it runs the harness scripts per target
// (validate-collaboration and/or verify-modes) and compares the runtimes.
//
// The Peer server it starts uses a scratch data dir and a free port, so it never touches a Peer
// app you have open. Every model is checked against the runtime before any prompt is sent, and
// each harness reads the model back from the sessions it creates.
import { execFileSync, spawn } from "node:child_process";
import { cpSync, createWriteStream, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { formatModelRef, parseArgs, parseModelRef, UsageError } from "../lib/args.mjs";
import { resolveRuntimeModel } from "../lib/model-guard.mjs";
import { run } from "../lib/proc.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const RUNTIMES = ["opencode", "claude", "codex"];
const SUITES = {
  collab: { script: "scripts/validate-collaboration.mjs", selectFlag: "scenarios", units: ["persist", "paginate", "slash", "etag"] },
  modes: { script: "scripts/verify-modes.mjs", selectFlag: "modes", units: ["focus", "collaborate", "learn"] },
};
const EXIT = { PASS: 0, FAIL: 1, NEEDS_MANUAL_REVIEW: 2, USAGE: 3 };

const SPEC = {
  target: { type: "list", help: "runtime:provider/model, repeatable (e.g. claude:claude/haiku)" },
  suite: { type: "string", help: "collab | modes | all (default collab)" },
  scenarios: { type: "string", help: "collab scenarios, comma-separated (default all four)" },
  modes: { type: "string", help: "modes for the modes suite (default focus,collaborate,learn)" },
  hold: { type: "string", help: "seconds to hold the first checkpoint unanswered (default 30)" },
  confirm: { type: "boolean", help: "actually run (spends real model quota)" },
  "keep-data": { type: "boolean", help: "keep the scratch Peer data dir" },
  help: { type: "boolean" },
};

const say = (s = "") => process.stdout.write(`${s}\n`);

/** "claude:claude/haiku" → { runtime, model }. Splits on the first ":" only. */
export function parseTarget(text) {
  const colon = text.indexOf(":");
  if (colon <= 0) throw new UsageError(`--target ${text} must look like runtime:provider/model, e.g. claude:claude/haiku`);
  const runtime = text.slice(0, colon);
  if (!RUNTIMES.includes(runtime)) throw new UsageError(`Unknown runtime "${runtime}" in --target ${text}. Known: ${RUNTIMES.join(", ")}`);
  return { runtime, model: parseModelRef(text.slice(colon + 1)) };
}

function freePort() {
  return new Promise((resolve, reject) => {
    const s = createServer();
    s.once("error", reject);
    s.listen(0, "127.0.0.1", () => {
      const { port } = s.address();
      s.close(() => resolve(port));
    });
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function startPeer(runDir) {
  const build = await run("npm", ["run", "build:main"], { cwd: root, logFile: join(runDir, "build-main.log"), timeoutMs: 5 * 60_000 });
  if (build.exitCode !== 0) throw new Error(`npm run build:main failed; see ${join(runDir, "build-main.log")}`);
  const dataDir = realpathSync(mkdtempSync(join(tmpdir(), "peer-eval-data-")));
  const port = await freePort();
  const log = createWriteStream(join(runDir, "peer-server.log"));
  const child = spawn(process.execPath, [join(root, "dist", "server", "main.js")], {
    cwd: root,
    env: { ...process.env, PEER_DATA_DIR: dataDir, PEER_PORT: String(port) },
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout.pipe(log);
  child.stderr.pipe(log);
  const base = `http://127.0.0.1:${port}`;
  const deadline = Date.now() + 120_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`Peer server exited early (${child.exitCode}); see ${join(runDir, "peer-server.log")}`);
    const tokenFile = join(dataDir, "api-token");
    if (existsSync(tokenFile)) {
      const token = readFileSync(tokenFile, "utf8").trim();
      try {
        const res = await fetch(`${base}/api/health`, { headers: { authorization: `Bearer ${token}` } });
        if (res.ok) return { base, token, dataDir, child };
      } catch {}
    }
    await sleep(500);
  }
  child.kill("SIGTERM");
  throw new Error("Peer server did not become healthy within 120s");
}

function makeApi(base, token) {
  return async (path, init = {}) => {
    const res = await fetch(`${base}/api${path}`, {
      ...init,
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: init.body ? JSON.stringify(init.body) : undefined,
    });
    const text = await res.text();
    if (!res.ok) throw new Error(`${init.method ?? "GET"} ${path} -> ${res.status}: ${text}`);
    return text ? JSON.parse(text) : null;
  };
}

/** Wait until a runtime leaves "starting" (Claude Code / Codex are probed asynchronously). */
async function waitForRuntime(api, runtime) {
  const deadline = Date.now() + 90_000;
  while (Date.now() < deadline) {
    const health = await api("/health");
    const info = health.runtimes.find((r) => r.kind === runtime);
    if (info && info.status.state !== "starting") return;
    await sleep(1000);
  }
}

function probeWorkspace() {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "peer-eval-probe-")));
  cpSync(join(root, "tests", "fixtures", "notes-api"), dir, { recursive: true });
  execFileSync("git", ["init", "-q"], { cwd: dir });
  return dir;
}

/** Mechanical expectations, separate from behavior that depends on the model's judgment. */
export function assessResults(suite, results) {
  const violations = [];
  const deviations = [];
  for (const r of results) {
    const label = `${r.runtime}/${r.scenario ?? r.mode}`;
    if (r.timedOut) deviations.push(`${label}: timed out`);
    if (suite === "collab") {
      if (r.pause && !r.pause.held) violations.push(`${label}: work continued while a checkpoint was open (${[...(r.pause.newTools ?? [])].slice(0, 3).join("; ") || "workspace changed"})`);
      if (r.expectCheckpoint !== r.checkpointsAsked > 0) deviations.push(`${label}: expected ${r.expectCheckpoint ? "a checkpoint" : "no checkpoint"}, got ${r.checkpointsAsked}`);
    } else if (r.mode === "learn" && r.firstEditAfterEngagement === "edits happened without a checkpoint") {
      violations.push(`${label}: code was edited in Learn before the developer engaged`);
    }
    if (r.testsPass === false) deviations.push(`${label}: the fixture's tests fail after the run`);
  }
  const verdict = violations.length > 0 ? "FAIL" : deviations.length > 0 ? "NEEDS_MANUAL_REVIEW" : "PASS";
  return { verdict, violations, deviations };
}

async function main() {
  const args = parseArgs(SPEC, process.argv.slice(2));
  if (args.help) {
    say("Usage: npm run eval:integration -- --target runtime:provider/model [--target …] [--suite collab|modes|all] [--confirm]\n");
    for (const [k, s] of Object.entries(SPEC)) if (s.help) say(`  --${k}${s.type === "boolean" ? "" : " <value>"}`.padEnd(24) + s.help);
    return EXIT.PASS;
  }
  if (process.env.PEER_VERIFY_ACTIVE) throw new UsageError("eval:integration cannot run inside a verification review (PEER_VERIFY_ACTIVE is set).");
  if (args.target.length === 0) throw new UsageError("Give at least one --target runtime:provider/model. There is no default model, on purpose.");
  const targets = args.target.map(parseTarget);
  const suiteNames = args.suite === "all" ? ["collab", "modes"] : [args.suite ?? "collab"];
  for (const s of suiteNames) if (!SUITES[s]) throw new UsageError(`Unknown --suite ${s}. Use collab, modes or all.`);
  const selection = {
    collab: (args.scenarios ?? SUITES.collab.units.join(",")).split(","),
    modes: (args.modes ?? SUITES.modes.units.join(",")).split(","),
  };
  for (const s of suiteNames) for (const u of selection[s]) if (!SUITES[s].units.includes(u)) throw new UsageError(`Unknown ${SUITES[s].selectFlag} "${u}". Known: ${SUITES[s].units.join(", ")}`);

  const runId = new Date().toISOString().replace(/[-:]/g, "").replace("T", "-").slice(0, 15);
  const runDir = join(root, ".peer-dev", "verify", "evals", runId);
  mkdirSync(runDir, { recursive: true });

  say(`Peer integration evaluation ${runId}`);
  say("  starting a private Peer server (scratch data dir, free port)…");
  const peer = await startPeer(runDir);
  const api = makeApi(peer.base, peer.token);
  let exit = EXIT.PASS;
  try {
    const probe = await api("/workspaces", { method: "POST", body: { path: probeWorkspace() } });
    const resolved = [];
    for (const t of targets) {
      await waitForRuntime(api, t.runtime);
      resolved.push(await resolveRuntimeModel(api, probe.id, t.runtime, t.model));
    }
    const plan = suiteNames.flatMap((s) => resolved.map((r) => ({ suite: s, runtime: r.runtime, model: formatModelRef(r.model), units: selection[s] })));
    const runs = plan.reduce((n, p) => n + p.units.length, 0);
    const manifest = { runId, createdAt: new Date().toISOString(), confirmed: args.confirm, targets: resolved, plan, agentRuns: runs };
    writeFileSync(join(runDir, "manifest.json"), JSON.stringify(manifest, null, 2));

    say("\nResolved (recorded in manifest.json before any prompt):");
    for (const r of resolved) say(`  ${r.runtime.padEnd(9)} ${r.runtimeName} ${r.runtimeVersion ?? ""}, model ${formatModelRef(r.model)}${r.modelName ? ` (${r.modelName})` : ""}`);
    say(`\nPlan: ${runs} real agent run(s)`);
    for (const p of plan) say(`  ${p.suite.padEnd(6)} ${p.runtime.padEnd(9)} ${p.model.padEnd(28)} ${p.units.join(", ")}`);
    if (!args.confirm) {
      say("\nNothing was run. Add --confirm to run it (this spends real model quota).");
      return EXIT.PASS;
    }

    const summaries = [];
    for (const p of plan) {
      const out = join(runDir, `${p.suite}-${p.runtime}.json`);
      const script = SUITES[p.suite];
      const harnessArgs = [join(root, script.script), "--api", peer.base, "--token", peer.token, "--runtime", p.runtime, "--model", p.model, `--${script.selectFlag}`, p.units.join(","), "--out", out];
      if (p.suite === "collab" && args.hold) harnessArgs.push("--hold", args.hold);
      say(`\n=== ${p.suite} on ${p.runtime} (${p.model})`);
      const r = await run(process.execPath, harnessArgs, { cwd: root, logFile: join(runDir, `${p.suite}-${p.runtime}.log`), onStdoutLine: (l) => say(`  ${l}`) });
      if (r.exitCode !== 0 || !existsSync(out)) {
        summaries.push({ ...p, error: `harness exited ${r.exitCode}; see ${p.suite}-${p.runtime}.log` });
        continue;
      }
      const data = JSON.parse(readFileSync(out, "utf8"));
      summaries.push({ ...p, results: data.results, ...assessResults(p.suite, data.results) });
    }

    const lines = [`# Integration evaluation ${runId}`, "", "| Suite | Runtime | Model | Verdict | Enforcement violations | Behavior deviations |", "|---|---|---|---|---|---|"];
    for (const s of summaries) lines.push(`| ${s.suite} | ${s.runtime} | ${s.model} | ${s.error ? "ERROR" : s.verdict} | ${s.error ?? (s.violations.join("; ") || "none")} | ${s.error ? "" : s.deviations.join("; ") || "none"} |`);
    lines.push("", "Enforcement violations are failures of Peer's guarantees. Behavior deviations depend on the model's judgment and need a human read of the per-run JSON.");
    writeFileSync(join(runDir, "summary.md"), lines.join("\n") + "\n");
    say(`\n${lines.slice(2).join("\n")}`);
    say(`\nReports: ${runDir}`);
    if (summaries.some((s) => s.error)) exit = EXIT.NEEDS_MANUAL_REVIEW;
    if (summaries.some((s) => s.verdict === "NEEDS_MANUAL_REVIEW")) exit = Math.max(exit, EXIT.NEEDS_MANUAL_REVIEW);
    if (summaries.some((s) => s.verdict === "FAIL")) exit = EXIT.FAIL;
  } finally {
    peer.child.kill("SIGTERM");
    await sleep(1500);
    if (!args["keep-data"]) rmSync(peer.dataDir, { recursive: true, force: true });
  }
  return exit;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === realpathSync(process.argv[1])) {
  try {
    process.exitCode = await main();
  } catch (err) {
    process.stderr.write(`eval:integration: ${err instanceof UsageError ? err.message : (err?.stack ?? err)}\n`);
    process.exitCode = EXIT.USAGE;
  }
}
