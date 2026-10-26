import { describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SCENARIOS, assessScenario } from "../scripts/eval-scenarios.mjs";

type Scenario = { steps: { send?: string }[] };
const S = SCENARIOS as Record<string, Scenario>;
const steps = (name: string, step: Record<string, unknown> = {}) => S[name]!.steps.map((s) => (s.send === undefined ? undefined : { questions: 0, optionalQuestions: 0, learningQuestions: 0, treeChanged: true, ...step }));
const base = { learnLockViolations: [], repeatedQuestions: [], optionalAfterFirst: 0, learningAfterFirst: 0, testsPass: true, cut: null, check: null };
const assess = (name: string, run: Record<string, unknown>) => assessScenario(S[name]!, { ...base, ...run }) as { verdict: string; violations: string[]; deviations: string[] };

describe("v02 real-model scenarios: coverage and assessment", () => {
  it("keeps installed dependency files out of fixture snapshots and diffs", () => {
    const dir = mkdtempSync(join(tmpdir(), "peer-eval-ignore-"));
    try {
      cpSync(new URL("./fixtures/notes-api", import.meta.url), dir, { recursive: true });
      mkdirSync(join(dir, "node_modules", "zod"), { recursive: true });
      writeFileSync(join(dir, "node_modules", "zod", "index.js"), "x".repeat(2_000_000));
      execFileSync("git", ["init", "-q"], { cwd: dir });
      execFileSync("git", ["add", "-A"], { cwd: dir });
      expect(execFileSync("git", ["ls-files", "node_modules"], { cwd: dir, encoding: "utf8" })).toBe("");
      expect(execFileSync("git", ["diff", "--cached"], { cwd: dir, encoding: "utf8" })).toContain("createNote");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
  it("never approves a dependency while testing its rejection", () => {
    const scenario = SCENARIOS["dependency-decline"];
    const proposal = { source: "agent", options: [{ label: "Use Zod (Recommended)" }], recommendation: "Use Zod (Recommended)" };
    expect(scenario.respond(proposal)).toEqual({ action: "answer", text: expect.stringMatching(/without new dependencies.*Do not add zod/) });
    expect(scenario.respond({ source: "peer" })).toEqual({ action: "choose", option: "Don't add it" });
    expect(scenario.respond(proposal)).toEqual({ action: "answer", text: expect.stringMatching(/Do not add zod/) });
  });

  it("counts Peer's own rejection card as exercising dependency refusal", () => {
    const run = { steps: steps("dependency-decline"), check: { ok: true }, log: [{ kind: "question", source: "peer", reply: { action: "choose", option: "Don't add it" } }] };
    expect(assess("dependency-decline", run).verdict).toBe("PASS");
    expect(assess("dependency-decline", { ...run, log: [] }).deviations).toContain("Peer's dependency rejection was not exercised");
  });

  it("explicitly releases the hint hold before expecting the feature to be completed", () => {
    const scenario = SCENARIOS["same-task-learn"];
    const state = {};
    const cp = { source: "agent", category: "hypothesis", options: [] };
    expect(scenario.respond(cp, state).action).toBe("answer");
    expect(scenario.respond(cp, state).action).toBe("hint");
    expect(scenario.respond(cp, state).action).toBe("direct");
  });
  it("cover what the milestone asks to evaluate", () => {
    expect(Object.keys(S)).toEqual(
      expect.arrayContaining([
        "same-task-collaborate",
        "same-task-learn",
        "mechanical-collaborate",
        "mechanical-learn",
        "architecture-collaborate",
        "debug-collaborate",
        "debug-learn",
        "just-do-it",
        "go-on-question",
        "discuss-first",
        "hint-progressive",
        "direct-on-question",
        "dependency-decline",
        "mode-switch",
        "stop",
      ]),
    );
  });

  it("a clean run passes", () => {
    expect(assess("mechanical-collaborate", { steps: steps("mechanical-collaborate"), check: { ok: true, detail: "" } }).verdict).toBe("PASS");
  });

  it("does not pass a run that ended with a runtime quota error", () => {
    const result = assess("mechanical-collaborate", { steps: steps("mechanical-collaborate"), runtimeErrors: ["You've hit your session limit"] });
    expect(result.verdict).toBe("NEEDS_MANUAL_REVIEW");
    expect(result.deviations).toContain("runtime error (behavior unverified): You've hit your session limit");
  });

  it("a Stop case's own \"Stopped\" error is its expected outcome, not an unverified run", () => {
    const stopped = { cancelled: true, changedAfter: false, toolsAfter: 0 };
    expect(assess("stop", { steps: steps("stop", { questions: 1 }), stopped, runtimeErrors: ["Stopped."] }).verdict).toBe("PASS");
    expect(assess("stop", { steps: steps("stop", { questions: 1 }), stopped, runtimeErrors: ["model unavailable"] }).verdict).toBe("NEEDS_MANUAL_REVIEW");
    expect(assess("mechanical-collaborate", { steps: steps("mechanical-collaborate"), check: { ok: true }, runtimeErrors: ["Stopped."] }).verdict).toBe("NEEDS_MANUAL_REVIEW");
  });

  it("enforced expectations are violations", () => {
    const discuss = steps("discuss-first");
    discuss[1]!.treeChanged = false;
    expect(assess("discuss-first", { steps: discuss }).violations).toEqual(["files changed on a turn that must not change code (step 1)"]);
    expect(assess("just-do-it", { steps: steps("just-do-it", { optionalQuestions: 2, questions: 2 }) }).violations[0]).toMatch(/2 optional question\(s\) reached the developer after Just do it/);
    expect(assess("go-on-question", { steps: steps("go-on-question"), optionalAfterFirst: 1 }).verdict).toBe("FAIL");
    expect(assess("direct-on-question", { steps: steps("direct-on-question"), learningAfterFirst: 1 }).verdict).toBe("FAIL");
    expect(assess("same-task-learn", { steps: steps("same-task-learn", { questions: 1 }), learnLockViolations: ["code changed while Learn's lock was closed"] }).verdict).toBe("FAIL");
    expect(assess("dependency-decline", { steps: steps("dependency-decline"), check: { ok: false, enforced: true, detail: "zod was added after the developer declined it" } }).violations).toEqual(["zod was added after the developer declined it"]);
    expect(assess("stop", { steps: steps("stop"), stopped: { cancelled: false, changedAfter: false, toolsAfter: 0 } }).violations).toEqual(["the question was not cancelled by Stop"]);
    expect(assess("stop", { steps: steps("stop"), stopped: { cancelled: true, changedAfter: true, toolsAfter: 3 } }).verdict).toBe("FAIL");
    expect(assess("architecture-collaborate", { steps: steps("architecture-collaborate", { questions: 1 }), repeatedQuestions: ["Which store?"] }).verdict).toBe("FAIL");
  });

  it("judgment calls are deviations for a human to read", () => {
    expect(assess("mechanical-learn", { steps: steps("mechanical-learn", { questions: 1 }), check: { ok: true } }).deviations).toEqual(["asked 1 question(s) on mechanical work"]);
    expect(assess("architecture-collaborate", { steps: steps("architecture-collaborate") }).deviations).toEqual(["asked no question on a meaningful decision"]);
    const debug = assess("debug-learn", { steps: steps("debug-learn", { questions: 1 }), check: { ok: true }, afterWrong: "Great question! Case is not it, though." });
    expect(debug.deviations).toEqual(expect.arrayContaining([expect.stringMatching(/did not identify the real cause/), "praise in response to a wrong hypothesis"]));
    expect(assess("debug-collaborate", { steps: steps("debug-collaborate"), check: { ok: true }, allText: "It is not case: the trailing slash makes req.url differ." }).verdict).toBe("PASS");
    expect(assess("stop", { steps: steps("stop") }).deviations).toContain("the agent asked no question, so Stop was not exercised");
    expect(assess("go-on-question", { steps: steps("go-on-question") }).deviations).toEqual(["the agent asked no question, so the control was not exercised"]);
    expect(assess("go-on-question", { steps: steps("go-on-question", { questions: 1 }) }).verdict).toBe("PASS");
    expect(assess("mechanical-collaborate", { steps: steps("mechanical-collaborate"), check: { ok: true }, cut: "token" }).deviations).toEqual(["cut short at the token limit"]);
  });
});
