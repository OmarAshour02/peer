// Regression tests for the verification workflow itself (scripts/verify, scripts/lib).
// Codex is replaced by tests/fixtures/fake-codex.mjs; nothing here calls a model.
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { parseArgs, parseModelRef, UsageError } from "../scripts/lib/args.mjs";
import { assertSessionModel, resolveRuntimeModel } from "../scripts/lib/model-guard.mjs";
import { run } from "../scripts/lib/proc.mjs";
import { appliedSettings, buildCodexArgs, checkApplied, crossCheckTests, parseEvents, resolveReviewer, unwrapShell } from "../scripts/verify/lib/codex.mjs";
import { changedBetween, createSnapshot, detectScope, fingerprint } from "../scripts/verify/lib/git.mjs";
import { decide, validateResponses } from "../scripts/verify/lib/verdict.mjs";
import { assessResults, parseTarget } from "../scripts/verify/eval-integration.mjs";

const ROOT = join(import.meta.dirname, "..");
const FAKE_CODEX = join(ROOT, "tests", "fixtures", "fake-codex.mjs");
const temps: string[] = [];
afterAll(() => {
  for (const d of temps) rmSync(d, { recursive: true, force: true });
});
const temp = (prefix: string) => {
  const d = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  temps.push(d);
  return d;
};
const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, stdio: ["ignore", "pipe", "pipe"] }).toString().trim();
function gitRepo() {
  const dir = temp("peer-vw-repo-");
  git(dir, "init", "-q", "-b", "main");
  git(dir, "config", "user.email", "t@t");
  git(dir, "config", "user.name", "t");
  git(dir, "config", "commit.gpgsign", "false");
  return dir;
}
const commit = (dir: string, msg: string) => {
  git(dir, "add", "-A");
  git(dir, "commit", "-qm", msg);
};

describe("strict argument parsing", () => {
  const spec = { model: { type: "string" }, target: { type: "list" }, confirm: { type: "boolean" } } as const;

  it("accepts --flag value, --flag=value, lists and switches", () => {
    expect(parseArgs(spec, ["--model", "claude/haiku", "--target=a", "--target", "b", "--confirm"], {})).toEqual({ model: "claude/haiku", target: ["a", "b"], confirm: true });
  });

  it("rejects a bare value: the shape npm leaves when it swallows --model", () => {
    // `npm run validate:collab --runtime claude --model claude/haiku` passes only ["claude", "claude/haiku"].
    expect(() => parseArgs(spec, ["claude", "claude/haiku"], { npm_lifecycle_event: "validate:collab" })).toThrow(/put the flags after "--"/);
  });

  it("rejects a flag npm consumed even when nothing else is left over", () => {
    expect(() => parseArgs(spec, [], { npm_lifecycle_event: "verify:peer", npm_config_model: "true" })).toThrow(/npm consumed --model/);
  });

  it("rejects unknown flags, missing values, empty values and repeats", () => {
    expect(() => parseArgs(spec, ["--modle", "x"], {})).toThrow(/Unknown flag --modle/);
    expect(() => parseArgs(spec, ["--model"], {})).toThrow(/needs a value/);
    expect(() => parseArgs(spec, ["--model", "--confirm"], {})).toThrow(/needs a value/);
    expect(() => parseArgs(spec, ["--model="], {})).toThrow(/non-empty/);
    expect(() => parseArgs(spec, ["--model", "a", "--model", "b"], {})).toThrow(/twice/);
  });

  it("parses provider/model refs, keeping slashes in the model id", () => {
    expect(parseModelRef("openrouter/anthropic/claude")).toEqual({ providerId: "openrouter", modelId: "anthropic/claude" });
    expect(() => parseModelRef("haiku")).toThrow(UsageError);
    expect(() => parseModelRef("claude/")).toThrow(UsageError);
  });
});

describe("structured subprocesses", () => {
  it("passes arguments verbatim, with no shell re-splitting", async () => {
    const tricky = ["--model", "claude/haiku", "a b", `it's "quoted"`, "$(touch /tmp/peer-pwned)", "*"];
    const r = await run(process.execPath, ["-e", "process.stdout.write(JSON.stringify(process.argv.slice(1)))", "--", ...tricky]);
    expect(JSON.parse(r.stdout)).toEqual(tricky);
  });

  it("kills a command that exceeds its timeout", async () => {
    const r = await run(process.execPath, ["-e", "setTimeout(() => {}, 60_000)"], { timeoutMs: 300 });
    expect(r.timedOut).toBe(true);
    expect(r.exitCode).not.toBe(0);
  });

  it("refuses a shell-style command string", () => {
    expect(() => run("npm", "run test" as unknown as string[])).toThrow(TypeError);
  });
});

describe("model guard for real-model harnesses", () => {
  const api = async (path: string) => {
    if (path === "/health") return { runtimes: [{ kind: "claude", name: "Claude Code", status: { state: "ready", version: "2.1" } }] };
    if (path.startsWith("/workspaces/w/models")) return { providers: [{ id: "claude", name: "Claude", models: [{ id: "haiku", name: "Haiku" }] }], default: { providerId: "claude", modelId: "opus" } };
    throw new Error(`unexpected ${path}`);
  };

  it("requires an explicit model unless the default is explicitly allowed", async () => {
    await expect(resolveRuntimeModel(api, "w", "claude", null)).rejects.toThrow(/No --model given/);
    await expect(resolveRuntimeModel(api, "w", "claude", null, { allowDefault: true })).resolves.toMatchObject({ usingDefault: true, model: { modelId: "opus" } });
  });

  it("fails clearly for a model the runtime does not offer, listing what it does", async () => {
    await expect(resolveRuntimeModel(api, "w", "claude", { providerId: "claude", modelId: "hiaku" })).rejects.toThrow(/not available on claude. Available: claude\/haiku/);
    await expect(resolveRuntimeModel(api, "w", "claude", { providerId: "claude", modelId: "haiku" })).resolves.toMatchObject({ runtimeVersion: "2.1", modelName: "Haiku" });
  });

  it("stops when the created session does not carry the requested model", () => {
    expect(() => assertSessionModel({ id: "s", model: null }, { providerId: "claude", modelId: "haiku" })).toThrow(/Stopping before any prompt/);
    expect(() => assertSessionModel({ id: "s", model: { providerId: "claude", modelId: "haiku" } }, { providerId: "claude", modelId: "haiku" })).not.toThrow();
  });
});

describe("Codex reviewer invocation", () => {
  const catalog = [{ slug: "gpt-x", displayName: "X", efforts: ["low", "medium"], defaultEffort: "low" }];

  it("resolves the model against Codex's catalog and never falls back", () => {
    expect(resolveReviewer({ model: "gpt-x", effort: "medium" }, catalog)).toEqual({ model: "gpt-x", displayName: "X", effort: "medium" });
    expect(() => resolveReviewer({ model: "gpt-y", effort: "medium" }, catalog)).toThrow(/does not offer model "gpt-y"/);
    expect(() => resolveReviewer({ model: "gpt-x", effort: "high" }, catalog)).toThrow(/does not support reasoning effort/);
    expect(() => resolveReviewer({ model: null, effort: "low" }, catalog)).toThrow(/No reviewer model/);
  });

  it("builds an isolated, explicit command line", () => {
    const argv = buildCodexArgs({ model: "gpt-x", effort: "low", snapshotDir: "/snap", schemaPath: "/s.json", outputPath: "/o.json" });
    const after = (f: string) => argv[argv.indexOf(f) + 1];
    expect(argv[0]).toBe("exec");
    expect(after("--model")).toBe("gpt-x");
    expect(after("--sandbox")).toBe("workspace-write");
    expect(after("--cd")).toBe("/snap");
    expect(argv).toContain("--ignore-user-config");
    expect(argv).toContain("sandbox_workspace_write.network_access=false");
    expect(argv).toContain("sandbox_workspace_write.exclude_slash_tmp=true");
    expect(argv).toContain('model_reasoning_effort="low"');
    expect(argv.join(" ")).not.toMatch(/dangerously|danger-full-access|--ephemeral/);
    expect(argv.at(-1)).toBe("-");
    expect(() => buildCodexArgs({ model: "", effort: "low", snapshotDir: "/s", schemaPath: "/s", outputPath: "/o" })).toThrow(/model is required/);
    expect(() => buildCodexArgs({ model: "m", effort: 'low" --x', snapshotDir: "/s", schemaPath: "/s", outputPath: "/o" })).toThrow(/invalid effort/);
  });

  it("takes executed commands from the event log, not the reviewer's summary", () => {
    const events = [
      { type: "thread.started", thread_id: "t1" },
      { type: "item.completed", item: { type: "command_execution", command: "/bin/zsh -lc 'npx vitest run tests/a.test.ts'", exit_code: 1, status: "completed" } },
      { type: "turn.completed", usage: { input_tokens: 5 } },
    ]
      .map((e) => JSON.stringify(e))
      .join("\n");
    const parsed = parseEvents(events);
    expect(parsed).toMatchObject({ threadId: "t1", completed: true, commands: [{ command: "npx vitest run tests/a.test.ts", exitCode: 1 }] });
    const checked = crossCheckTests(
      [
        { command: "npx vitest run tests/a.test.ts", purpose: "", exit_code: 0, result: "pass" },
        { command: "npm run typecheck", purpose: "", exit_code: 0, result: "pass" },
      ],
      parsed.commands,
    );
    expect(checked[0]).toMatchObject({ observed: true, observedExitCode: 1 }); // the claimed 0 is overridden
    expect(checked[1]).toMatchObject({ observed: false });
    // Seen in a real run: the event log escapes quotes that the reviewer's report does not.
    const escaped = crossCheckTests([{ command: `rg -n 'a|"bash"|b' src`, purpose: "", exit_code: 0, result: "" }], [{ command: `rg -n 'a|\\"bash\\"|b' src`, exitCode: 0 }]);
    expect(escaped[0]).toMatchObject({ observed: true });
    expect(unwrapShell(`/bin/bash -c 'echo '\\''hi'\\'''`)).toBe("echo 'hi'");
  });

  it("confirms the applied model and sandbox from the session rollout", () => {
    const rollout = (payload: object) => JSON.stringify({ type: "turn_context", payload });
    const good = { model: "gpt-x", effort: "low", cwd: "/snap", sandbox_policy: { type: "workspace-write", writable_roots: ["/snap"], network_access: false, exclude_tmpdir_env_var: true, exclude_slash_tmp: true } };
    const req = { model: "gpt-x", effort: "low", repo: "/work/peer", snapshotDir: "/snap" };
    expect(checkApplied(appliedSettings(rollout(good)), req)).toEqual([]);
    expect(checkApplied(appliedSettings(rollout({ ...good, model: "gpt-mini" })), req)).toEqual([expect.stringMatching(/model gpt-mini, not the requested gpt-x/)]);
    expect(checkApplied(appliedSettings(rollout({ ...good, sandbox_policy: { ...good.sandbox_policy, writable_roots: ["/work"] } })), req)[0]).toMatch(/overlaps the checkout/);
    expect(checkApplied(appliedSettings(rollout({ ...good, sandbox_policy: { type: "danger-full-access" } })), req)[0]).toMatch(/not workspace-write/);
    expect(checkApplied(appliedSettings(rollout({ ...good, sandbox_policy: { ...good.sandbox_policy, network_access: true } })), req)[0]).toMatch(/network/);
    expect(checkApplied([], req)).toEqual([expect.stringMatching(/no turn settings/)]);
    // A checkout under /tmp is writable through the implicit /tmp root unless that is excluded.
    const implicitTmp = { ...good, sandbox_policy: { ...good.sandbox_policy, exclude_slash_tmp: false } };
    expect(checkApplied(appliedSettings(rollout(implicitTmp)), { ...req, repo: "/tmp/work/peer" })[0]).toMatch(/could write \/tmp/);
  });
});

describe("verdict policy", () => {
  const passingChecks = [{ name: "test", required: true, status: "passed" as const }];
  const review = (over: object = {}) => ({
    ok: true,
    output: { verdict: "PASS", findings: [], collaboration_checks: [], prior_findings_review: [], ...over },
    observedTests: [{ observed: true, observedExitCode: 0 }],
    commandsRun: 1,
    applied: { confirmed: true, errors: [] },
  });
  const base = { checks: passingChecks, hasTask: true, tamperedPaths: [] as string[], codex: review() };

  it("passes only with checks, requirements, an intact checkout and observed independent checks", () => {
    expect(decide(base).verdict).toBe("PASS");
  });

  it("is stricter than the reviewer, never more lenient", () => {
    expect(decide({ ...base, checks: [{ name: "test", required: true, status: "failed" }] }).verdict).toBe("FAIL");
    expect(decide({ ...base, hasTask: false }).verdict).toBe("NEEDS_MANUAL_REVIEW");
    expect(decide({ ...base, tamperedPaths: ["src/a.ts"] }).verdict).toBe("FAIL");
    const high = { id: "F1", severity: "high" };
    expect(decide({ ...base, codex: review({ findings: [high] }) }).verdict).toBe("FAIL");
    expect(decide({ ...base, codex: review({ collaboration_checks: [{ status: "violated" }] }) }).verdict).toBe("FAIL");
    expect(decide({ ...base, codex: { ...review(), observedTests: [{ observed: false, observedExitCode: null }], commandsRun: 0 } }).verdict).toBe("NEEDS_MANUAL_REVIEW");
    expect(decide({ ...base, codex: { ok: false, error: "timed out" } }).verdict).toBe("NEEDS_MANUAL_REVIEW");
    expect(decide({ ...base, codex: null, reviewSkipped: "--skip-review" }).verdict).toBe("NEEDS_MANUAL_REVIEW");
  });

  it("voids a review that ran on another model or sandbox", () => {
    expect(decide({ ...base, codex: { ...review(), applied: { confirmed: true, errors: ["turn 1 ran on model gpt-mini"] } } }).verdict).toBe("FAIL");
    expect(decide({ ...base, codex: { ...review(), applied: { confirmed: false, errors: [] } } }).verdict).toBe("NEEDS_MANUAL_REVIEW");
  });

  it("escalates open disagreements at the repair-cycle limit", () => {
    const d = decide({ ...base, codex: review({ prior_findings_review: [{ id: "F1", status: "rejection_disputed" }] }), isLastCycle: true });
    expect(d).toMatchObject({ verdict: "NEEDS_MANUAL_REVIEW", escalate: true, unresolved: ["F1"] });
    expect(decide({ ...base, isLastCycle: true }).escalate).toBe(false);
  });

  it("requires a reasoned response to every finding that needs one", () => {
    const findings = [
      { id: "F1", severity: "high", title: "a" },
      { id: "F2", severity: "medium", title: "b" },
      { id: "F3", severity: "low", title: "c" },
    ];
    expect(validateResponses(findings, [])).toEqual([expect.stringMatching(/missing response for F1/), expect.stringMatching(/missing response for F2/)]);
    const errs = validateResponses(findings, [
      { id: "F1", disposition: "deferred", rationale: "Not now, later sprint." },
      { id: "F2", disposition: "rejected", rationale: "The reviewer misread it." },
    ]);
    expect(errs.join("\n")).toMatch(/cannot be deferred/);
    expect(errs.join("\n")).toMatch(/rejection needs evidence/);
    expect(
      validateResponses(findings, [
        { id: "F1", disposition: "fixed", rationale: "Changed <= to < and added a test." },
        { id: "F2", disposition: "rejected", rationale: "The reviewer misread it.", evidence: "src/a.ts:10 already guards it." },
      ]),
    ).toEqual([]);
  });
});

describe("change detection and the review snapshot", () => {
  it("reviews every file as new in a repository without commits", () => {
    const repo = gitRepo();
    writeFileSync(join(repo, "a.txt"), "a\n");
    const scope = detectScope(repo);
    expect(scope.base).toMatchObject({ sha: null });
    const snap = createSnapshot(repo, scope.base);
    temps.push(snap.dir);
    expect(snap.files).toEqual([{ status: "A", path: "a.txt" }]);
  });

  it("measures a feature branch from its merge-base and includes committed, uncommitted, untracked and deleted work", () => {
    const repo = gitRepo();
    writeFileSync(join(repo, "keep.txt"), "1\n");
    writeFileSync(join(repo, "gone.txt"), "x\n");
    writeFileSync(join(repo, ".gitignore"), "node_modules/\nbig/\n");
    commit(repo, "base");
    const baseSha = git(repo, "rev-parse", "HEAD");
    git(repo, "checkout", "-q", "-b", "feature");
    writeFileSync(join(repo, "committed.txt"), "c\n");
    commit(repo, "feature work");
    writeFileSync(join(repo, "keep.txt"), "2\n");
    writeFileSync(join(repo, "untracked.txt"), "u\n");
    rmSync(join(repo, "gone.txt"));
    mkdirSync(join(repo, "node_modules", "dep"), { recursive: true });
    writeFileSync(join(repo, "node_modules", "dep", "index.js"), "");
    mkdirSync(join(repo, "release-next"));
    writeFileSync(join(repo, "release-next", "huge.bin"), "zz");

    const scope = detectScope(repo);
    expect(scope.base).toMatchObject({ ref: "main", sha: baseSha });
    const snap = createSnapshot(repo, scope.base, { exclude: ["release-next/"], linkIgnored: ["node_modules"] });
    temps.push(snap.dir);
    expect(Object.fromEntries(snap.files.map((f: { path: string; status: string }) => [f.path, f.status]))).toEqual({
      "committed.txt": "A",
      "gone.txt": "D",
      "keep.txt": "M",
      "untracked.txt": "A",
    });
    // git diff in the snapshot shows the same change, and the linked dependencies stay out of it.
    expect(git(snap.dir, "diff", "--name-only", "HEAD").split("\n").sort()).toEqual(["committed.txt", "gone.txt", "keep.txt", "untracked.txt"]);
    expect(existsSync(join(snap.dir, "node_modules", "dep", "index.js"))).toBe(true);
    expect(git(snap.dir, "status", "--porcelain")).not.toMatch(/node_modules|release-next/);
  });

  it("on the base branch itself, reviews only uncommitted work", () => {
    const repo = gitRepo();
    writeFileSync(join(repo, "a.txt"), "1\n");
    commit(repo, "base");
    expect(detectScope(repo).base).toMatchObject({ ref: "HEAD" });
    expect(() => detectScope(repo, { base: "nope" })).toThrow(/not a commit/);
  });

  it("fingerprints detect any write to the checkout", () => {
    const repo = gitRepo();
    writeFileSync(join(repo, "a.txt"), "1\n");
    const before = fingerprint(repo);
    writeFileSync(join(repo, "a.txt"), "2\n");
    writeFileSync(join(repo, "b.txt"), "new\n");
    expect(changedBetween(before, fingerprint(repo))).toEqual(["a.txt", "b.txt"]);
  });
});

describe("eval:integration guards", () => {
  it("parses runtime:provider/model targets and rejects unknown runtimes", () => {
    expect(parseTarget("claude:claude/haiku")).toEqual({ runtime: "claude", model: { providerId: "claude", modelId: "haiku" } });
    expect(() => parseTarget("gpt:openai/x")).toThrow(/Unknown runtime/);
    expect(() => parseTarget("claude")).toThrow(/runtime:provider\/model/);
  });

  it("separates enforcement violations from model-judgment deviations", () => {
    expect(assessResults("collab", [{ runtime: "codex", scenario: "persist", expectCheckpoint: true, checkpointsAsked: 1, pause: { held: false, newTools: ["edit x"] } }]).verdict).toBe("FAIL");
    expect(assessResults("collab", [{ runtime: "codex", scenario: "slash", expectCheckpoint: false, checkpointsAsked: 1, pause: { held: true } }]).verdict).toBe("NEEDS_MANUAL_REVIEW");
    expect(assessResults("modes", [{ runtime: "claude", mode: "learn", firstEditAfterEngagement: "edits happened without a checkpoint" }]).verdict).toBe("FAIL");
  });

  it("refuses to run without an explicit target, before starting anything", () => {
    const r = spawnSync(process.execPath, [join(ROOT, "scripts", "verify", "eval-integration.mjs")], { encoding: "utf8", env: cleanEnv() });
    expect(r.status).toBe(3);
    expect(r.stderr).toMatch(/at least one --target/);
  });
});

function cleanEnv(extra: Record<string, string> = {}) {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined && !k.startsWith("npm_") && k !== "PEER_VERIFY_ACTIVE") env[k] = v;
  return { ...env, ...extra };
}

describe("verify:peer end to end (fake Codex)", () => {
  const codexHome = temp("peer-vw-codexhome-");

  /** A small project on a feature branch, with its own verify.config.json. */
  function project({ failingTest = false } = {}) {
    const repo = gitRepo();
    writeFileSync(join(repo, "a.js"), "export const limit = (n) => n < 5;\n");
    writeFileSync(join(repo, ".gitignore"), ".peer-dev/\nnode_modules/\n");
    writeFileSync(
      join(repo, "verify.config.json"),
      JSON.stringify({
        project: "fixture",
        checks: [
          { name: "test", command: [process.execPath, "-e", `process.exit(${failingTest ? 1 : 0})`], required: true },
          { name: "lint", command: ["npm", "run", "lint"], required: false },
        ],
        codex: { model: "fake-model", effort: "low", timeoutMinutes: 2 },
        reviewer: { instructions: "scripts/verify/reviewer/instructions.md", rubrics: ["scripts/verify/reviewer/peer-rubric.md"], schema: "scripts/verify/reviewer/report.schema.json" },
      }),
    );
    writeFileSync(join(repo, "package.json"), JSON.stringify({ name: "fixture", scripts: {} }));
    commit(repo, "base");
    git(repo, "checkout", "-q", "-b", "feature");
    writeFileSync(join(repo, "a.js"), "export const limit = (n) => n <= 5;\n");
    mkdirSync(join(repo, ".peer-dev", "verify"), { recursive: true });
    writeFileSync(join(repo, ".peer-dev", "verify", "task.md"), "# Task\nLimit to 5 requests.\n");
    writeFileSync(join(repo, ".peer-dev", "verify", "claims.md"), "Implemented the limit and tested it.\n");
    return repo;
  }

  function verify(repo: string, mode: string, args: string[] = [], extra: Record<string, string> = {}) {
    const record = join(repo, "..", `${repo.split("/").at(-1)}-codex-record.jsonl`);
    const r = spawnSync(process.execPath, [join(ROOT, "scripts", "verify", "verify-peer.mjs"), ...args], {
      cwd: repo,
      encoding: "utf8",
      env: cleanEnv({ PEER_VERIFY_CODEX_BIN: FAKE_CODEX, FAKE_CODEX_MODE: mode, FAKE_CODEX_RECORD: record, CODEX_HOME: codexHome, ...extra }),
    });
    const latest = join(repo, ".peer-dev", "verify", "latest");
    const runId = existsSync(latest) ? readFileSync(latest, "utf8").trim() : null;
    const runDir = runId ? join(repo, ".peer-dev", "verify", "runs", runId) : null;
    const report = runDir && existsSync(join(runDir, "report.json")) ? JSON.parse(readFileSync(join(runDir, "report.json"), "utf8")) : null;
    const calls = existsSync(record) ? readFileSync(record, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)) : [];
    rmSync(record, { force: true });
    return { status: r.status, out: r.stdout + r.stderr, report, runDir, calls };
  }

  it("PASS: runs checks, reviews in a snapshot with the requested model, and leaves the checkout untouched", () => {
    const repo = project();
    const before = fingerprint(repo);
    const r = verify(repo, "pass");
    expect(r.out).toContain("PASS");
    expect(r.status).toBe(0);
    expect(r.report).toMatchObject({ verdict: "PASS", humanDecisionRequired: true, chain: { cycle: 0 } });
    expect(r.report.checks).toEqual([
      expect.objectContaining({ name: "test", status: "passed" }),
      expect.objectContaining({ name: "lint", status: "skipped" }),
    ]);
    expect(r.report.reviewer).toMatchObject({ model: "fake-model", effort: "low", applied: { confirmed: true, errors: [] } });
    expect(r.report.evidence.testsCrossCheck).toEqual([expect.objectContaining({ command: "npm test", observed: true, observedExitCode: 0 })]);

    expect(r.calls).toHaveLength(1);
    const call = r.calls[0];
    expect(call.argv).toEqual(expect.arrayContaining(["--model", "fake-model", "--sandbox", "workspace-write"]));
    expect(call.cwd).not.toBe(repo);
    expect(call.env.PEER_VERIFY_ACTIVE).toBe("1");
    expect(call.prompt).toContain("Independent verification: reviewer instructions");
    expect(call.prompt).toContain("Peer-specific verification rubric");
    expect(existsSync(call.cwd)).toBe(false); // snapshot cleaned up

    expect(changedBetween(before, fingerprint(repo))).toEqual([]);
    expect(readFileSync(join(r.runDir!, "report.md"), "utf8")).toContain("A human makes the final decision");
  });

  it("does not spend a review on a red build", () => {
    const r = verify(project({ failingTest: true }), "pass");
    expect(r.status).toBe(1);
    expect(r.calls).toHaveLength(0);
    expect(r.report.evidence.reviewSkipped).toMatch(/required deterministic check failed/);
  });

  it("fails before any check when the requested model is not offered", () => {
    const repo = project();
    const r = verify(repo, "pass", ["--model", "gpt-imaginary"]);
    expect(r.status).toBe(3);
    expect(r.out).toMatch(/does not offer model "gpt-imaginary"/);
    expect(r.calls).toHaveLength(0);
    expect(r.report).toBeNull();
  });

  it("voids the review when Codex ran on a different model", () => {
    const r = verify(project(), "wrong-model");
    expect(r.status).toBe(1);
    expect(r.report.reasons.join(" ")).toMatch(/ran on model gpt-cheaper, not the requested fake-model/);
  });

  it("cannot pass when the model actually used is unconfirmed", () => {
    expect(verify(project(), "no-rollout").status).toBe(2);
  });

  it("detects a reviewer that writes to the developer's checkout", () => {
    const repo = project();
    const r = verify(repo, "tamper", [], { FAKE_CODEX_TAMPER: join(repo, "a.js") });
    expect(r.status).toBe(1);
    expect(r.report.evidence.tamperedPaths).toEqual(["a.js"]);
  });

  it("keeps the reviewer's probe files as evidence without touching the checkout", () => {
    const repo = project();
    const r = verify(repo, "probe");
    expect(r.status).toBe(0);
    expect(readFileSync(join(r.runDir!, "codex", "scratch.patch"), "utf8")).toContain("probe.test.js");
    expect(existsSync(join(repo, "probe.test.js"))).toBe(false);
  });

  it("does not trust checks the reviewer claims but never ran", () => {
    const r = verify(project(), "unobserved");
    expect(r.status).toBe(2);
    expect(r.report.evidence.testsCrossCheck[0]).toMatchObject({ observed: false });
  });

  it("treats a PASS with a high-severity finding as FAIL", () => {
    expect(verify(project(), "pass-with-high").status).toBe(1);
  });

  it("does not pass a malformed or crashed review", () => {
    expect(verify(project(), "invalid").status).toBe(2);
    expect(verify(project(), "crash").status).toBe(2);
  });

  it("cannot pass without task requirements", () => {
    const repo = project();
    rmSync(join(repo, ".peer-dev", "verify", "task.md"));
    expect(verify(repo, "pass").status).toBe(2);
  });

  it("allows a re-review without responses when nothing needed one", () => {
    const repo = project({ failingTest: true });
    expect(verify(repo, "pass").status).toBe(1); // red build, no review, no findings
    writeFileSync(join(repo, "verify.config.json"), readFileSync(join(repo, "verify.config.json"), "utf8").replace("process.exit(1)", "process.exit(0)"));
    const r = verify(repo, "pass", ["--rereview", "latest"]);
    expect(r.status).toBe(0);
    expect(r.report.chain.cycle).toBe(1);
  });

  it("refuses to run nested inside another verification", () => {
    const r = verify(project(), "pass", [], { PEER_VERIFY_ACTIVE: "1" });
    expect(r.status).toBe(3);
    expect(r.calls).toHaveLength(0);
  });

  it("limits the repair loop to two targeted re-reviews, then escalates", () => {
    const repo = project();
    const first = verify(repo, "rereview");
    expect(first.status).toBe(1);
    expect(existsSync(join(first.runDir!, "responses.template.json"))).toBe(true);

    // A re-review needs the implementer's reasoned response to every finding.
    expect(verify(repo, "rereview", ["--rereview", "latest"]).status).toBe(3);
    writeFileSync(join(first.runDir!, "responses.json"), JSON.stringify([{ id: "F1", disposition: "rejected", rationale: "The limit is inclusive by spec.", evidence: "TASK.md says up to 5." }]));

    // Updated claims replace the previous run's; the task stays the one the chain started with.
    writeFileSync(join(repo, ".peer-dev", "verify", "claims.md"), "Updated claims after review.\n");
    writeFileSync(join(repo, ".peer-dev", "verify", "task.md"), "# A different task\n");
    const second = verify(repo, "rereview", ["--rereview", "latest"], { FAKE_CODEX_PRIOR: "rejection_disputed" });
    expect(second.report.chain).toMatchObject({ cycle: 1, parent: first.report.runId, root: first.report.runId });
    expect(readFileSync(join(second.runDir!, "CLAIMS.md"), "utf8")).toBe("Updated claims after review.\n");
    expect(readFileSync(join(second.runDir!, "TASK.md"), "utf8")).toContain("Limit to 5 requests.");
    expect(second.calls[0].prompt).toContain("targeted re-review (repair cycle 1 of 2)");
    expect(second.report.unresolved).toEqual(["F1"]);
    expect(second.report.escalate).toBe(false);

    writeFileSync(join(second.runDir!, "responses.json"), JSON.stringify([{ id: "F1", disposition: "rejected", rationale: "Still inclusive by spec.", evidence: "TASK.md line 2." }]));
    const third = verify(repo, "rereview", ["--rereview", "latest"], { FAKE_CODEX_PRIOR: "rejection_disputed" });
    expect(third.report).toMatchObject({ chain: { cycle: 2 }, escalate: true });
    expect(readFileSync(join(third.runDir!, "escalation.md"), "utf8")).toContain("F1");

    writeFileSync(join(third.runDir!, "responses.json"), JSON.stringify([{ id: "F1", disposition: "rejected", rationale: "Same as before, see TASK.", evidence: "TASK.md line 2." }]));
    const fourth = verify(repo, "rereview", ["--rereview", "latest"]);
    expect(fourth.status).toBe(4);
    expect(fourth.calls).toHaveLength(0);
  });
});
