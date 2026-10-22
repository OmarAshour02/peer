---
name: verify-peer
description: Independent verification loop for Peer changes. Use before calling any implementation task in this repo done - Claude implements, deterministic checks run, the real Codex CLI tries to prove the change wrong, Claude triages each finding, at most two repair cycles, then a human decides.
---

# verify-peer: Claude builds, Codex tries to prove it wrong, a human decides

A change is not done because you say it is. It is ready for a human decision when `npm run verify:peer` has run against it and every finding has a reasoned disposition.

## 1. Before you implement

Write the task and its acceptance criteria to `.peer-dev/verify/task.md` (gitignored). Use the developer's words. Add criteria you inferred, marked as inferred. Without this file the verdict cannot be PASS.

## 2. Implement

Implement, add tests that fail without the change, and run `npm run typecheck` and `npm test`. Then write `.peer-dev/verify/claims.md`: what you changed, what you tested, and what you did not test. Keep it factual. The reviewer treats every claim as a hypothesis to falsify.

## 3. Verify

```bash
npm run verify:peer
```

Flags go after `--`, for example `npm run verify:peer -- --base origin/main`.

Read `.peer-dev/verify/runs/<id>/report.md`. The exit code is the verdict: 0 PASS, 1 FAIL, 2 NEEDS_MANUAL_REVIEW, 3 usage/config error, 4 repair-cycle limit reached.

## 4. Triage every finding yourself

For each finding in the report, decide independently. Do not accept a finding because the reviewer said it, and do not dismiss one because you wrote the code.

- Reproduce it: run the reproduction, read the cited code, write a failing test if you can.
- **Confirmed**: fix it, add a regression test, rerun the relevant tests.
- **Wrong**: reject it with evidence (a file and line, a test, or command output). "I think it's fine" is not evidence.
- **Real but out of scope** (medium or lower only): defer it and say where it is tracked.

Record each decision in `responses.json` in the run directory. Start from `responses.template.json` there:

```json
[{ "id": "F1", "disposition": "fixed", "rationale": "…", "evidence": "…" }]
```

Every critical, high and medium finding needs an entry. Critical and high findings cannot be deferred.

## 5. Targeted re-review

```bash
npm run verify:peer -- --rereview latest
```

The harness enforces a limit of **two** repair cycles. After the second, or when it exits 4, stop. Summarize the open disagreements for the developer from `escalation.md`. Do not start another round, and do not argue past the limit.

## 6. Hand off

Give the developer the verdict, the report path, the findings and your dispositions, and anything listed as unverified. PASS is evidence, not approval.

## Never

- Commit, push or merge on your own initiative. Do it only when the developer asks.
- Edit a report, `output.json`, or the reviewer's findings.
- Run `verify:peer` with `--skip-review` and present the result as verified.
- Run `npm run eval:integration -- … --confirm` (real model quota) unless the developer asks. Without `--confirm` it only prints the plan.

## When to run the real-model evaluation

`verify:peer` never calls Peer's agent runtimes. When a change affects how agents behave at runtime (prompts, the engine, a runtime adapter, the plugin, hooks), tell the developer and suggest:

```bash
npm run eval:integration -- --target claude:claude/haiku --target codex:codex/gpt-6-luna            # plan only
npm run eval:integration -- --target claude:claude/haiku --target codex:codex/gpt-6-luna --confirm  # runs
```
