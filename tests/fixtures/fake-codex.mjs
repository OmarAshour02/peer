#!/usr/bin/env node
// Stand-in for the Codex CLI in verify-workflow tests. Deterministic, no network, no model.
// FAKE_CODEX_MODE picks the behavior; FAKE_CODEX_RECORD (a file) receives argv, cwd and the prompt.
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const argv = process.argv.slice(2);
const mode = process.env.FAKE_CODEX_MODE ?? "pass";

if (argv[0] === "--version") {
  console.log("codex-cli 0.0.0-fake");
  process.exit(0);
}
if (argv[0] === "debug" && argv[1] === "models") {
  console.log(JSON.stringify({ models: [{ slug: "fake-model", display_name: "Fake Model", supported_reasoning_levels: [{ effort: "low" }, { effort: "medium" }] }] }));
  process.exit(0);
}
if (argv[0] !== "exec") {
  console.error(`fake-codex: unsupported ${argv.join(" ")}`);
  process.exit(2);
}

const flag = (name) => argv[argv.indexOf(name) + 1];
const cwd = flag("--cd");
const outFile = flag("--output-last-message");
let prompt = "";
for await (const chunk of process.stdin) prompt += chunk;
if (process.env.FAKE_CODEX_RECORD) appendFileSync(process.env.FAKE_CODEX_RECORD, JSON.stringify({ argv, cwd, prompt, env: { PEER_VERIFY_ACTIVE: process.env.PEER_VERIFY_ACTIVE ?? null } }) + "\n");

const emit = (e) => console.log(JSON.stringify(e));
const threadId = `fake-${process.pid}-${Date.now()}`;
// Like Codex, record the settings applied to the turn in a session rollout under $CODEX_HOME.
if (mode !== "no-rollout" && process.env.CODEX_HOME) {
  const dir = join(process.env.CODEX_HOME, "sessions", "2026", "10", "22");
  mkdirSync(dir, { recursive: true });
  const effort = /model_reasoning_effort="(\w+)"/.exec(argv.join(" "))?.[1] ?? null;
  const turn = {
    type: "turn_context",
    payload: { cwd, model: mode === "wrong-model" ? "gpt-cheaper" : flag("--model"), effort, sandbox_policy: { type: flag("--sandbox"), writable_roots: [cwd], network_access: false, exclude_tmpdir_env_var: true, exclude_slash_tmp: true } },
  };
  writeFileSync(join(dir, `rollout-2026-10-22T00-00-00-${threadId}.jsonl`), JSON.stringify({ type: "session_meta", payload: { id: threadId } }) + "\n" + JSON.stringify(turn) + "\n");
}
const ran = (command, exit_code) => emit({ type: "item.completed", item: { type: "command_execution", command: `/bin/zsh -lc '${command}'`, aggregated_output: "ok", exit_code, status: "completed" } });
emit({ type: "thread.started", thread_id: threadId });
emit({ type: "turn.started" });

const base = {
  verdict: "PASS",
  verdict_rationale: "Tried to break it and could not.",
  findings: [],
  tests_executed: [{ command: "npm test", purpose: "full suite", exit_code: 0, result: "passed" }],
  claims_checked: [],
  collaboration_checks: [],
  prior_findings_review: [],
  coverage_assessment: "Adequate for the change.",
  unverified_assumptions: ["Real-model behavior not exercised."],
};
const high = { id: "F1", severity: "high", category: "correctness", title: "Off-by-one in limit", file: "src/a.js", line: 1, description: "The limit allows one extra request.", evidence: "src/a.js:1 uses <=", reproduction: "node -e ...", confidence: "confirmed", suggested_fix: "Use <" };

let output = base;
switch (mode) {
  case "pass":
  case "wrong-model":
  case "no-rollout":
    ran("npm test", 0);
    break;
  case "fail-high":
    ran("npm test", 0);
    output = { ...base, verdict: "FAIL", findings: [high] };
    break;
  case "pass-with-high":
    ran("npm test", 0);
    output = { ...base, verdict: "PASS", findings: [high] };
    break;
  case "unobserved":
    // Claims it ran npm test but never did.
    break;
  case "invalid":
    writeFileSync(outFile, "I think it looks fine.");
    emit({ type: "turn.completed", usage: { input_tokens: 1, output_tokens: 1 } });
    process.exit(0);
  case "crash":
    console.error("fake-codex: model unavailable");
    process.exit(1);
  case "tamper":
    ran("npm test", 0);
    writeFileSync(process.env.FAKE_CODEX_TAMPER, "reviewer was here\n");
    break;
  case "probe":
    ran("npm test", 0);
    writeFileSync(join(cwd, "probe.test.js"), "// reviewer probe\n");
    break;
  case "rereview": {
    ran("npm test", 0);
    const priorFile = join(cwd, ".peer-verify", "PRIOR_FINDINGS.json");
    const prior = existsSync(priorFile) ? JSON.parse(readFileSync(priorFile, "utf8")) : [];
    const status = process.env.FAKE_CODEX_PRIOR ?? "resolved";
    output = prior.length
      ? { ...base, verdict: status === "resolved" ? "PASS" : "FAIL", prior_findings_review: prior.map((f) => ({ id: f.id, status, evidence: "checked" })) }
      : { ...base, verdict: "FAIL", findings: [high] };
    break;
  }
  default:
    console.error(`fake-codex: unknown mode ${mode}`);
    process.exit(2);
}
writeFileSync(outFile, JSON.stringify(output));
emit({ type: "turn.completed", usage: { input_tokens: 100, cached_input_tokens: 0, output_tokens: 10 } });
