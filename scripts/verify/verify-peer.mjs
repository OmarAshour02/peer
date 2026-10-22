#!/usr/bin/env node
// npm run verify:peer: independent verification of the current change.
//
//   1. Detect the change (feature branch vs main, plus uncommitted and untracked work).
//   2. Run the deterministic checks from verify.config.json in the developer's checkout.
//   3. Have the real Codex CLI review it in an isolated snapshot (no network, cannot write the
//      checkout), trying to prove it wrong.
//   4. Save a structured report under .peer-dev/verify/runs/<id>/ and exit with the verdict:
//      0 PASS, 1 FAIL, 2 NEEDS_MANUAL_REVIEW, 3 usage/config error, 4 repair-cycle limit reached.
//
// Re-review after fixing findings: npm run verify:peer -- --rereview latest
// Nothing here merges, pushes or calls the implementing agent.
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createHash, randomBytes } from "node:crypto";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs, UsageError } from "../lib/args.mjs";
import { run } from "../lib/proc.mjs";
import { appliedSettings, buildCodexArgs, checkApplied, codexCatalog, codexVersion, crossCheckTests, findRollout, parseEvents, resolveReviewer } from "./lib/codex.mjs";
import { loadConfig } from "./lib/config.mjs";
import { changedBetween, createSnapshot, detectScope, fingerprint, repoRoot, snapshotScratch } from "./lib/git.mjs";
import { renderEscalation, renderMarkdown, responsesTemplate } from "./lib/report.mjs";
import { decide, EXIT_CODES, needsResponse, validateResponses } from "./lib/verdict.mjs";

const SPEC = {
  task: { type: "string", help: "Task requirements / acceptance criteria (default: <reportsDir>/task.md)" },
  claims: { type: "string", help: "The implementer's summary of what it did (default: <reportsDir>/claims.md)" },
  base: { type: "string", help: "Compare against this commit instead of the merge-base with main" },
  model: { type: "string", help: "Codex reviewer model (default: codex.model in verify.config.json)" },
  effort: { type: "string", help: "Codex reasoning effort (default: codex.effort)" },
  rereview: { type: "string", help: "Targeted re-review of a previous run id, or 'latest'" },
  responses: { type: "string", help: "The implementer's responses (default: responses.json in the previous run)" },
  config: { type: "string", help: "Config file (default: verify.config.json)" },
  "skip-review": { type: "boolean", help: "Only run the deterministic checks (verdict is at best NEEDS_MANUAL_REVIEW)" },
  "review-on-red": { type: "boolean", help: "Run the review even when a required check failed" },
  "keep-snapshot": { type: "boolean", help: "Keep the reviewer's snapshot directory for inspection" },
  "dry-run": { type: "boolean", help: "Resolve scope and reviewer, print the plan, run nothing" },
  help: { type: "boolean" },
};

const say = (s = "") => process.stdout.write(`${s}\n`);
const sha256 = (s) => createHash("sha256").update(s).digest("hex");

function usage() {
  say("Usage: npm run verify:peer -- [flags]\n");
  for (const [k, s] of Object.entries(SPEC)) if (s.help) say(`  --${k}${s.type === "boolean" ? "" : " <value>"}`.padEnd(28) + s.help);
  say("\nExit codes: 0 PASS, 1 FAIL, 2 NEEDS_MANUAL_REVIEW, 3 usage/config error, 4 repair-cycle limit reached.");
}

function newRunId() {
  const t = new Date().toISOString().replace(/[-:]/g, "").replace("T", "-").slice(0, 15);
  return `${t}-${randomBytes(3).toString("hex")}`;
}

function readInput(repo, explicit, fallback, label) {
  const path = explicit ? resolve(process.cwd(), explicit) : fallback && existsSync(fallback) ? fallback : null;
  if (!path) return null;
  if (!existsSync(path)) throw new UsageError(`--${label} file not found: ${path}`);
  const text = readFileSync(path, "utf8");
  if (!text.trim()) throw new UsageError(`${label} file is empty: ${path}`);
  return { path: relative(repo, path).startsWith("..") ? path : relative(repo, path), text, sha256: sha256(text) };
}

function packageScripts(repo) {
  try {
    return JSON.parse(readFileSync(join(repo, "package.json"), "utf8")).scripts ?? {};
  } catch {
    return {};
  }
}

async function runChecks(repo, checks, runDir) {
  const scripts = packageScripts(repo);
  const env = { ...process.env };
  delete env.PEER_VERIFY_ACTIVE;
  const results = [];
  mkdirSync(join(runDir, "checks"), { recursive: true });
  for (const c of checks) {
    // `npm run <name>` for a script the project does not define is "not configured", not a failure.
    const npmScript = c.command[0] === "npm" && c.command[1] === "run" ? c.command[2] : c.command[0] === "npm" && c.command[1] === "test" ? "test" : null;
    if (npmScript && !scripts[npmScript]) {
      results.push({ name: c.name, command: c.command, required: c.required, status: "skipped", exitCode: null, reason: `no "${npmScript}" script in package.json` });
      say(`  ${c.name.padEnd(10)} skipped (no "${npmScript}" script)`);
      continue;
    }
    const log = join(runDir, "checks", `${c.name}.log`);
    process.stdout.write(`  ${c.name.padEnd(10)} running… `);
    const r = await run(c.command[0], c.command.slice(1), { cwd: repo, env, logFile: log, timeoutMs: 20 * 60_000 });
    const status = r.exitCode === 0 ? "passed" : "failed";
    say(`${status}${r.exitCode !== 0 ? ` (exit ${r.exitCode ?? r.signal ?? r.spawnError})` : ""} ${(r.durationMs / 1000).toFixed(1)}s`);
    results.push({ name: c.name, command: c.command, required: c.required, status, exitCode: r.exitCode, durationMs: r.durationMs, timedOut: r.timedOut, log: relative(runDir, log) });
  }
  return results;
}

function checksMarkdown(checks) {
  const lines = ["# Deterministic checks", "", "Run by the verification harness in the developer's checkout before this review. Logs are not included; exit codes are authoritative.", ""];
  for (const c of checks) lines.push(`- ${c.name} (\`${c.command.join(" ")}\`, ${c.required ? "required" : "optional"}): ${c.status}${c.exitCode !== null && c.exitCode !== undefined ? `, exit ${c.exitCode}` : ""}${c.reason ? `, ${c.reason}` : ""}`);
  return lines.join("\n") + "\n";
}

/** Parse and minimally validate the reviewer's final message. */
function readReviewerOutput(path) {
  if (!existsSync(path)) return { ok: false, error: "Codex wrote no final message" };
  const text = readFileSync(path, "utf8").trim();
  let out;
  try {
    out = JSON.parse(text);
  } catch {
    return { ok: false, error: `Codex's final message is not JSON: ${text.slice(0, 200)}` };
  }
  const arrays = ["findings", "tests_executed", "claims_checked", "collaboration_checks", "prior_findings_review", "unverified_assumptions"];
  if (!["PASS", "FAIL", "NEEDS_MANUAL_REVIEW"].includes(out?.verdict) || arrays.some((k) => !Array.isArray(out[k])) || typeof out.coverage_assessment !== "string") {
    return { ok: false, error: "Codex's final message does not match the report schema" };
  }
  const ids = out.findings.map((f) => f.id);
  if (new Set(ids).size !== ids.length) return { ok: false, error: "Codex reported duplicate finding ids" };
  return { ok: true, output: out };
}

/** Findings still open from the previous round: its findings plus earlier ones it did not close. */
function openPriorFindings(parent) {
  const carried = (parent.priorFindings ?? []).filter((f) => (parent.unresolved ?? []).includes(f.id));
  return [...carried, ...(parent.review?.findings ?? [])];
}

function resolveRun(reportsDir, id) {
  const runId = id === "latest" ? (existsSync(join(reportsDir, "latest")) ? readFileSync(join(reportsDir, "latest"), "utf8").trim() : null) : id;
  if (!runId || !/^[\w-]+$/.test(runId)) throw new UsageError(`No previous run ${id === "latest" ? "recorded" : `"${id}"`}`);
  const dir = join(reportsDir, "runs", runId);
  if (!existsSync(join(dir, "report.json"))) throw new UsageError(`No report for run ${runId} in ${dir}`);
  return { runId, dir, report: JSON.parse(readFileSync(join(dir, "report.json"), "utf8")) };
}

async function main() {
  if (process.env.PEER_VERIFY_ACTIVE) {
    throw new UsageError("verify:peer is already running in this environment (PEER_VERIFY_ACTIVE is set). Nested verification is not allowed.");
  }
  const args = parseArgs(SPEC, process.argv.slice(2));
  if (args.help) {
    usage();
    return EXIT_CODES.PASS;
  }
  const repo = repoRoot(process.cwd());
  const cfg = loadConfig(repo, args.config);
  const tool = dirname(fileURLToPath(import.meta.url));
  const fromRepo = (p) => (existsSync(join(repo, p)) ? join(repo, p) : join(tool, "..", "..", p));
  const reportsDir = join(repo, cfg.reportsDir);
  const runId = newRunId();
  const runDir = join(reportsDir, "runs", runId);

  // A re-review continues a chain, with a hard limit on repair cycles.
  let parent = null;
  let responses = null;
  if (args.rereview) {
    parent = resolveRun(reportsDir, args.rereview);
    const cycle = parent.report.chain.cycle + 1;
    if (cycle > cfg.loop.maxRepairCycles) {
      const esc = join(parent.dir, "escalation.md");
      const latest = join(parent.dir, "responses.json");
      writeFileSync(esc, renderEscalation(parent.report, existsSync(latest) ? JSON.parse(readFileSync(latest, "utf8")) : parent.report.responses));
      say(`Repair-cycle limit reached (${cfg.loop.maxRepairCycles}). No further automatic review.`);
      say(`Open points for a human decision: ${esc}`);
      return EXIT_CODES.ESCALATE;
    }
    const respPath = args.responses ? resolve(process.cwd(), args.responses) : join(parent.dir, "responses.json");
    const open = openPriorFindings(parent.report);
    if (!existsSync(respPath)) {
      if (open.some(needsResponse)) throw new UsageError(`No responses at ${respPath}. Fill in ${join(parent.dir, "responses.template.json")} and save it as responses.json.`);
      responses = [];
    } else {
      try {
        responses = JSON.parse(readFileSync(respPath, "utf8"));
      } catch (err) {
        throw new UsageError(`${respPath} is not valid JSON: ${err.message}`);
      }
    }
    const errors = validateResponses(open, responses);
    if (errors.length > 0) throw new UsageError(`Responses are incomplete:\n  - ${errors.join("\n  - ")}`);
  }

  // Requirements stay fixed across a re-review chain; claims are expected to change after fixes.
  const parentInput = (name) => (parent && existsSync(join(parent.dir, name)) ? join(parent.dir, name) : null);
  const task = readInput(repo, args.task, parentInput("TASK.md") ?? join(reportsDir, "task.md"), "task");
  const claimsFile = join(reportsDir, "claims.md");
  const claims = readInput(repo, args.claims, existsSync(claimsFile) ? claimsFile : parentInput("CLAIMS.md"), "claims");

  // Resolve the reviewer before anything runs, so a bad model fails in seconds, not after the tests.
  let reviewer = null;
  if (!args["skip-review"]) {
    const bin = process.env.PEER_VERIFY_CODEX_BIN || cfg.codex.bin;
    const version = await codexVersion(bin);
    const resolved = resolveReviewer({ model: args.model ?? cfg.codex.model, effort: args.effort ?? cfg.codex.effort }, await codexCatalog(bin));
    reviewer = { tool: "codex", bin, version, ...resolved, sandbox: "workspace-write, rooted at a throwaway snapshot" };
  }

  const scope = detectScope(repo, { base: args.base, baseBranches: cfg.baseBranches });
  const snap = createSnapshot(repo, scope.base, { exclude: cfg.snapshot.exclude, linkIgnored: cfg.snapshot.linkIgnored });
  const cleanup = () => {
    if (!args["keep-snapshot"]) rmSync(snap.dir, { recursive: true, force: true });
  };
  if (snap.files.length === 0) {
    cleanup();
    throw new UsageError(`No changes to verify (${scope.base.reason}). Use --base <ref> to choose what to compare against.`);
  }

  const cycle = parent ? parent.report.chain.cycle + 1 : 0;
  say(`Peer verification ${runId}`);
  say(`  change:   ${snap.files.length} file(s), +${snap.numstat.added}/-${snap.numstat.removed} vs ${scope.base.sha ? scope.base.sha.slice(0, 12) : "empty tree"} (${scope.base.reason})`);
  say(`  task:     ${task ? task.path : "NONE (verdict cannot be PASS)"}`);
  say(`  claims:   ${claims ? claims.path : "none"}`);
  say(`  reviewer: ${reviewer ? `Codex ${reviewer.version}, model ${reviewer.model}, effort ${reviewer.effort}` : "skipped"}`);
  say(`  cycle:    ${cycle} of ${cfg.loop.maxRepairCycles}${parent ? ` (re-review of ${parent.runId})` : ""}`);

  const schemaPath = fromRepo(cfg.reviewer.schema);
  const codexArgsPreview = reviewer ? buildCodexArgs({ model: reviewer.model, effort: reviewer.effort, snapshotDir: snap.dir, schemaPath, outputPath: join(runDir, "codex", "output.json") }) : null;
  if (args["dry-run"]) {
    say("\nDry run. Would run:");
    for (const c of cfg.checks) say(`  ${c.command.join(" ")}${c.required ? "" : "  (optional)"}`);
    if (codexArgsPreview) say(`  ${reviewer.bin} ${codexArgsPreview.join(" ")}  < prompt`);
    say("\nChanged files:");
    for (const f of snap.files.slice(0, 50)) say(`  ${f.status} ${f.path}`);
    if (snap.files.length > 50) say(`  … and ${snap.files.length - 50} more`);
    cleanup();
    return EXIT_CODES.PASS;
  }

  mkdirSync(join(runDir, "codex"), { recursive: true });
  if (task) writeFileSync(join(runDir, "TASK.md"), task.text);
  if (claims) writeFileSync(join(runDir, "CLAIMS.md"), claims.text);
  writeFileSync(join(runDir, "diff.patch"), snap.patch);

  say("\nDeterministic checks");
  const checks = await runChecks(repo, cfg.checks, runDir);
  const before = fingerprint(repo, cfg.snapshot.exclude);
  writeFileSync(join(runDir, "fingerprint.json"), JSON.stringify(before, null, 2));

  const requiredFailed = checks.some((c) => c.required && c.status === "failed");
  let reviewSkipped = args["skip-review"] ? "--skip-review was given" : null;
  if (!reviewSkipped && requiredFailed && !args["review-on-red"]) reviewSkipped = "a required deterministic check failed (use --review-on-red to review anyway)";

  let codex = null;
  let events = null;
  let codexRun = null;
  let scratchPatch = null;
  const priorFindings = parent ? openPriorFindings(parent.report) : [];
  if (!reviewSkipped) {
    const ctx = join(snap.dir, ".peer-verify");
    mkdirSync(ctx, { recursive: true });
    if (task) writeFileSync(join(ctx, "TASK.md"), task.text);
    if (claims) writeFileSync(join(ctx, "CLAIMS.md"), claims.text);
    writeFileSync(join(ctx, "CHECKS.md"), checksMarkdown(checks));
    writeFileSync(join(ctx, "diff.patch"), snap.patch);
    if (parent) {
      writeFileSync(join(ctx, "PRIOR_FINDINGS.json"), JSON.stringify(priorFindings, null, 2));
      writeFileSync(join(ctx, "RESPONSES.json"), JSON.stringify(responses, null, 2));
      const prevFp = existsSync(join(parent.dir, "fingerprint.json")) ? JSON.parse(readFileSync(join(parent.dir, "fingerprint.json"), "utf8")) : null;
      const since = prevFp ? changedBetween(prevFp, before) : snap.files.map((f) => f.path);
      writeFileSync(join(ctx, "CHANGED_SINCE.md"), `# Files changed since review ${parent.runId}\n\n${since.map((p) => `- ${p}`).join("\n") || "(none)"}\n`);
    }

    const sections = [readFileSync(fromRepo(cfg.reviewer.instructions), "utf8"), ...cfg.reviewer.rubrics.map((p) => readFileSync(fromRepo(p), "utf8"))];
    sections.push(
      [
        "# This run",
        "",
        `- Run ${runId}, ${parent ? `targeted re-review (repair cycle ${cycle} of ${cfg.loop.maxRepairCycles}) of ${parent.runId}` : "first review"}.`,
        `- Change: ${snap.files.length} file(s) against ${scope.base.sha ? `base ${scope.base.sha.slice(0, 12)}` : "an empty repository"} (${scope.base.reason}).`,
        task ? "- TASK.md is present." : "- **No TASK.md was given.** Review against PEER.md and the change itself, and say that requirements could not be checked.",
        claims ? "- CLAIMS.md is present." : "- No CLAIMS.md was given.",
        snap.files.length > 150 ? "- This is a large change. Prioritize the riskiest areas (collaboration enforcement, runtimes, persistence, boundaries) and say what you did not cover." : "",
        "- Skip lockfiles and generated files unless dependencies are the point of the change.",
      ]
        .filter(Boolean)
        .join("\n"),
    );
    const prompt = sections.join("\n\n---\n\n");
    writeFileSync(join(runDir, "codex", "prompt.md"), prompt);

    const outputPath = join(runDir, "codex", "output.json");
    const argv = buildCodexArgs({ model: reviewer.model, effort: reviewer.effort, snapshotDir: snap.dir, schemaPath, outputPath });
    reviewer.argv = argv;
    const lines = [];
    let seen = 0;
    say(`\nIndependent review (Codex ${reviewer.model}, up to ${cfg.codex.timeoutMinutes} min)`);
    const reviewTmp = join(ctx, "tmp");
    mkdirSync(reviewTmp, { recursive: true });
    codexRun = await run(reviewer.bin, argv, {
      cwd: snap.dir,
      env: { ...process.env, PEER_VERIFY_ACTIVE: "1", NO_COLOR: "1", TMPDIR: reviewTmp },
      input: prompt,
      logFile: join(runDir, "codex", "stderr.log"),
      timeoutMs: cfg.codex.timeoutMinutes * 60_000,
      onStdoutLine: (l) => {
        lines.push(l);
        if (l.includes('"command_execution"') && l.includes('"item.completed"')) {
          seen++;
          if (seen % 5 === 1) say(`  … ${seen} command(s) so far`);
        }
      },
    });
    writeFileSync(join(runDir, "codex", "events.jsonl"), lines.join("\n") + "\n");
    events = parseEvents(lines.join("\n"));
    writeFileSync(join(runDir, "codex", "commands.json"), JSON.stringify(events.commands, null, 2));
    Object.assign(reviewer, { exitCode: codexRun.exitCode, timedOut: codexRun.timedOut, durationMs: codexRun.durationMs, threadId: events.threadId, usage: events.usage });

    if (codexRun.spawnError) codex = { ok: false, error: `could not start Codex: ${codexRun.spawnError}` };
    else if (codexRun.timedOut) codex = { ok: false, error: `Codex timed out after ${cfg.codex.timeoutMinutes} minutes` };
    else if (codexRun.exitCode !== 0) codex = { ok: false, error: `Codex exited ${codexRun.exitCode}: ${(events.errors.at(-1) ?? codexRun.stderr.trim().split("\n").at(-1) ?? "").slice(0, 300)}` };
    else codex = readReviewerOutput(outputPath);
    if (!codex.ok) reviewer.error = codex.error;

    // Confirm from Codex's own session record which model, effort and sandbox were really used.
    const rollout = findRollout(events.threadId);
    if (rollout) {
      const text = readFileSync(rollout, "utf8");
      writeFileSync(join(runDir, "codex", "rollout.jsonl"), text);
      const applied = appliedSettings(text);
      writeFileSync(join(runDir, "codex", "applied-settings.json"), JSON.stringify(applied, null, 2));
      codex.applied = { confirmed: true, turns: applied.length, errors: checkApplied(applied, { model: reviewer.model, effort: reviewer.effort, repo, snapshotDir: snap.dir, tmpDir: reviewTmp }) };
    } else {
      codex.applied = { confirmed: false, turns: 0, errors: [] };
    }
    reviewer.applied = codex.applied;
    if (codex.ok) {
      codex.observedTests = crossCheckTests(codex.output.tests_executed, events.commands);
      codex.commandsRun = events.commands.length;
    }

    const scratch = snapshotScratch(snap.dir, snap.tree);
    if (scratch) {
      scratchPatch = "codex/scratch.patch";
      writeFileSync(join(runDir, scratchPatch), scratch);
    }
  }

  const after = fingerprint(repo, cfg.snapshot.exclude);
  const tamperedPaths = changedBetween(before, after);
  if (before.head !== after.head) tamperedPaths.unshift("HEAD");

  const decision = decide({ checks, hasTask: Boolean(task), tamperedPaths, reviewSkipped, codex, isLastCycle: Boolean(parent) && cycle >= cfg.loop.maxRepairCycles });
  const report = {
    schemaVersion: 1,
    runId,
    createdAt: new Date().toISOString(),
    project: cfg.project ?? null,
    verdict: decision.verdict,
    exitCode: EXIT_CODES[decision.verdict],
    reasons: decision.reasons,
    escalate: decision.escalate,
    unresolved: decision.unresolved,
    humanDecisionRequired: true,
    chain: { root: parent ? parent.report.chain.root : runId, parent: parent?.runId ?? null, cycle, maxRepairCycles: cfg.loop.maxRepairCycles },
    scope: { repo, head: scope.head, branch: scope.branch, base: scope.base, files: snap.files, numstat: snap.numstat, fingerprint: before.digest },
    inputs: { task: task && { path: task.path, sha256: task.sha256 }, claims: claims && { path: claims.path, sha256: claims.sha256 } },
    checks,
    reviewer: reviewer && { ...reviewer, verdict: decision.reviewerVerdict },
    review: codex?.ok ? codex.output : null,
    priorFindings,
    responses,
    evidence: {
      commandsRun: events?.commands.map((c) => ({ command: c.command, exitCode: c.exitCode })) ?? [],
      testsCrossCheck: codex?.observedTests ?? [],
      scratchPatch,
      tamperedPaths,
      reviewSkipped,
    },
  };
  writeFileSync(join(runDir, "report.json"), JSON.stringify(report, null, 2));
  writeFileSync(join(runDir, "report.md"), renderMarkdown(report));
  if (report.review?.findings.some(needsResponse)) writeFileSync(join(runDir, "responses.template.json"), JSON.stringify(responsesTemplate(report.review.findings), null, 2));
  if (report.escalate) writeFileSync(join(runDir, "escalation.md"), renderEscalation(report, responses));
  writeFileSync(join(reportsDir, "latest"), `${runId}\n`);
  cleanup();

  say(`\n${decision.verdict}${decision.escalate ? " (escalate to a human)" : ""}`);
  for (const r of decision.reasons) say(`  - ${r}`);
  if (report.review) {
    const counts = ["critical", "high", "medium", "low", "info"].map((s) => [s, report.review.findings.filter((f) => f.severity === s).length]).filter(([, n]) => n > 0);
    say(`  findings: ${counts.map(([s, n]) => `${n} ${s}`).join(", ") || "none"}`);
  }
  say(`\nReport: ${join(runDir, "report.md")}`);
  return report.exitCode;
}

try {
  process.exitCode = await main();
} catch (err) {
  if (err instanceof UsageError) {
    process.stderr.write(`verify:peer: ${err.message}\n`);
  } else {
    // Never let a crash look like FAIL (1): it is a harness problem, not a verdict.
    process.stderr.write(`verify:peer: internal error: ${err?.stack ?? err}\n`);
  }
  process.exitCode = EXIT_CODES.USAGE;
}

