# Independent verification

**Claude builds. Codex independently tries to prove it wrong. A human makes the final decision.**

```
task.md ─► Claude implements + tests ─► npm run verify:peer
                                          ├─ 1. detect the change (vs merge-base with main)
                                          ├─ 2. deterministic checks (typecheck, lint, test, build)
                                          ├─ 3. real Codex CLI reviews an isolated snapshot
                                          ├─ 4. harness checks the evidence and decides the verdict
                                          └─ 5. report.md / report.json, exit code
          ◄── findings ──┘
Claude triages each finding (fix / reject with evidence) ─► npm run verify:peer -- --rereview latest
          (at most 2 repair cycles, then escalate) ─► human decision. Nothing is merged or pushed.
```

## Commands

| Command | What it does | Cost |
|---|---|---|
| `npm run verify:peer` | Full verification of the current change | One Codex review (ChatGPT quota) |
| `npm run verify:peer -- --dry-run` | Shows the scope, the resolved reviewer model and the exact commands, then exits | Free |
| `npm run verify:peer -- --skip-review` | Deterministic checks only; verdict at best NEEDS_MANUAL_REVIEW | Free |
| `npm run verify:peer -- --rereview latest` | Targeted re-review after you respond to findings | One Codex review |
| `npm run eval:integration -- --target claude:claude/haiku` | Starts a private Peer server, resolves the runtime and model, prints the plan | Free |
| `npm run eval:integration -- --target … --confirm` | Real agent runs: collaboration scenarios and/or mode comparison per runtime | Real model quota |

Other flags: `--task <file>`, `--claims <file>`, `--base <ref>`, `--model <codex model>`, `--effort <level>`, `--review-on-red`, `--keep-snapshot`. Script flags always go after `--`. Without the `--`, npm consumes them, and the scripts now reject the call instead of silently running with defaults.

Exit codes: `0` PASS, `1` FAIL, `2` NEEDS_MANUAL_REVIEW, `3` usage or configuration error, `4` repair-cycle limit reached.

## Inputs

- `.peer-dev/verify/task.md`: the task and acceptance criteria (or `--task`). Without it, the verdict cannot be PASS.
- `.peer-dev/verify/claims.md`: the implementer's summary (or `--claims`). Codex receives it labelled as claims to falsify, not as evidence.

## What the reviewer gets, and what it cannot do

Codex runs as `codex exec` with an argument array (never a shell string). See `buildCodexArgs` in `scripts/verify/lib/codex.mjs`.

- **Isolated snapshot.** A throwaway git repository whose `HEAD` is the base of the change and whose working tree is the change. `node_modules` and `vendor` are read-only links. Codex works and runs tests there.
- **Sandbox.** `workspace-write` rooted at the snapshot, `/tmp` excluded, `TMPDIR` pointed inside the snapshot, and no network. Codex cannot write your checkout, install packages, or reach a model through a nested agent.
- **Clean configuration.** `--ignore-user-config` and `--ignore-rules`: none of your `~/.codex` MCP servers, plugins or profiles, which could otherwise write to external systems. Your login still works.
- **Instructions.** `scripts/verify/reviewer/instructions.md` (adversarial protocol, severity scale, verdict rules) plus `scripts/verify/reviewer/peer-rubric.md` (collaboration enforcement, Learn behavior, cross-runtime consistency, cancellation, streaming, persistence, workspace boundaries). Output must match `scripts/verify/reviewer/report.schema.json`.
- **No recursion.** `PEER_VERIFY_ACTIVE=1` is set for the reviewer, and `verify:peer` and `eval:integration` refuse to start under it. No network is the backstop.

## What the harness checks, and does not take on trust

| Claim | How it is checked |
|---|---|
| The requested model was used | Before the run, the model and effort are checked against `codex debug models`; an unknown model exits 3 before any check runs. After the run, every turn in Codex's session record (`~/.codex/sessions/…/rollout-*.jsonl`, copied to `codex/rollout.jsonl`) must show that model, effort, sandbox, cwd and no network. A mismatch voids the review (FAIL). A missing record caps the verdict at NEEDS_MANUAL_REVIEW. |
| Codex did not modify the source | A content fingerprint of every working file and `HEAD` is taken before and after the review. Any difference is FAIL. Codex's probe files in the snapshot are kept as `codex/scratch.patch`. |
| Codex ran the tests it reports | Each entry in `tests_executed` is matched against the command log from `codex exec --json` (`codex/commands.json`). Unmatched entries are marked **not in log**; the observed exit code replaces the reported one. With no observed checks, the verdict cannot be PASS. |
| The checks pass | The harness runs them itself and stores logs under `checks/`. A failed required check is FAIL, and the review is skipped (`--review-on-red` overrides). |

## Verdict rules

These are in `scripts/verify/lib/verdict.mjs`. The reviewer's verdict can only be made stricter.

- **FAIL**: a required check failed, the checkout changed during the review, the review ran with other settings, the reviewer says FAIL, any critical or high finding, or any violated collaboration check.
- **NEEDS_MANUAL_REVIEW**: no task requirements, the review was skipped, crashed, timed out or returned invalid output, the applied settings could not be confirmed, no independent check was observed, or prior findings are still open.
- **PASS**: none of the above. PASS means that a determined attempt to break the change failed. It is not approval.

## Feedback loop

1. The report lists findings with severity, file and line, evidence and reproduction, plus `responses.template.json`.
2. Claude evaluates each finding independently: it fixes confirmed defects, rejects wrong ones with evidence, and may defer medium or lower findings. It records these decisions in `responses.json` in the run directory. Critical, high and medium findings need an entry, and a rejection needs evidence. The harness rejects incomplete responses (exit 3).
3. `--rereview latest` gives Codex the open findings, the responses and the files changed since the last review. Codex marks each finding resolved, not resolved, rejection accepted or rejection disputed, and reviews the new changes.
4. The loop is limited by `loop.maxRepairCycles` (2). At the limit, open disagreements go to `escalation.md`, and a further `--rereview` exits 4 without calling Codex.

## Reports

`.peer-dev/verify/runs/<run-id>/` (gitignored):

```
report.md  report.json            verdict, reasons, scope, checks, reviewer, findings, evidence
TASK.md  CLAIMS.md  diff.patch    exactly what was reviewed
fingerprint.json                  checkout fingerprint (also used to scope re-reviews)
checks/<name>.log                 deterministic check output
codex/prompt.md  events.jsonl  commands.json  stderr.log  output.json
codex/rollout.jsonl  applied-settings.json  scratch.patch
responses.template.json  responses.json  escalation.md
```

`.peer-dev/verify/latest` holds the latest run id.

## Real-model integration evaluations

`npm run eval:integration` drives `scripts/validate-collaboration.mjs` (suite `collab`: adaptive asks, real checkpoint pauses, Learn misconception handling) and `scripts/verify-modes.mjs` (suite `modes`: the same task in Focus, Collaborate and Learn). It runs them against a private Peer server (scratch data dir, free port), for one or more `--target runtime:provider/model`.

- No default model. Each target is resolved against the runtime's model list and written to `manifest.json` before any prompt. Each harness also reads the model back from every session it creates and stops if it differs.
- `--confirm` is required to spend quota.
- `summary.md` separates **enforcement violations** (work continued during an open checkpoint, Learn edited before engagement: exit 1) from **behavior deviations** that depend on model judgment (exit 2, read the JSON).

The old harnesses silently dropped `--model` in two ways, and both now fail loudly. First, `npm run validate:collab --model x` without `--` let npm consume the flag. Second, `validate-collaboration.mjs` put the model in the message body, which the API ignores, and so ran every scenario on the runtime's default model.

## Configuration and portability

`verify.config.json` holds the checks (argument arrays), the reviewer model and effort, base branches, snapshot exclusions and the loop limit. Unknown keys are errors. The scripts in `scripts/verify/` and `scripts/lib/` depend only on Node, git and the Codex CLI. To use them in another repository, copy those two directories and the reviewer files, write a `verify.config.json`, and replace `peer-rubric.md` with that project's rubric.

## ApexYard

ApexYard stays the governance system. Codex is added through ApexYard's private extension points in the portfolio repo, not by changing the framework:

- `custom-skills/independent-verify/SKILL.md`: an `/independent-verify` skill for any registered project that ships `verify.config.json`. It runs the project's command and records the verdict as builder evidence in the PR's `## Testing` section.
- `custom-handbooks/general/independent-verification.md`: a rule Rex applies on every review. For projects with `verify.config.json`, the PR must carry the verification verdict for its head commit. A PASS does not replace Rex, the Security Auditor or the human merge approval.

ApexYard's two-review-round cap and its human merge gate (`/approve-merge`) are unchanged and line up with this loop.

## Limitations

- The reviewer is an LLM. It can miss defects, and PASS is not proof. The harness verifies *how* the review ran (model, sandbox, commands, untouched checkout), not that its judgment is right.
- Applied-settings checks depend on Codex's session-record format (tested with codex-cli 0.163.0). If the format changes, the verdict drops to NEEDS_MANUAL_REVIEW instead of passing silently.
- The fingerprint covers tracked and untracked non-ignored files. Ignored paths (`node_modules`, `dist`, `.peer-dev`) are protected only by the sandbox.
- `verify:peer` does not exercise real agent runtimes; collaboration behavior is checked through code and deterministic tests. Use `eval:integration` for real-model behavior.
- Codex reviews are not deterministic. Two runs on the same change can report different findings.
