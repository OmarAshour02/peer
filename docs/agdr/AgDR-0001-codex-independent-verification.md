---
id: AgDR-0001
timestamp: 2026-10-22T20:30:00Z
agent: claude-code
model: claude-opus-5-5
trigger: user-prompt
status: executed
category: patterns
projects: [peer]
---

# Codex as an independent verification stage

> In the context of AI-implemented changes to Peer, facing the risk that the implementing agent's own summary is taken as proof, I decided to add a harness-driven verification stage in which the real Codex CLI reviews each change in an isolated snapshot and the harness checks the review's own evidence, to achieve independent and falsifiable verification, accepting one Codex review's quota and time per verification.

## Context

- Claude Code implements. ApexYard governs: Rex reviews, and humans approve merges. Nothing independent of the implementing model checked its claims before Rex.
- Codex CLI 0.163.0 is installed and logged in. `codex exec` supports sandboxes, output schemas, JSONL events and session records.
- A previous incident: the collaboration harness silently ran expensive default models because `--model` was dropped. It was dropped in two ways: npm consumed the flag, and the model was sent where the API ignores it.

## Options considered

| Option | Pros | Cons |
|---|---|---|
| Claude subagent as reviewer | Cheap, already available | Same model family as the implementer; not independent |
| `codex review` (built-in) | One command | No control over instructions, output schema, sandbox root or evidence; reviews the live checkout |
| Change ApexYard's Rex flow | Single review surface | Forks the framework; hooks drift on `/update`; not portable |
| **`codex exec` driven by a repo-local harness, wired into ApexYard through private custom skills and handbooks** | Independent model, a structured report, a sandbox we control, evidence checked by code, portable | One more step before review |

## Decision

Chosen: **the harness** (`scripts/verify/`, `npm run verify:peer`), because it keeps the reviewer independent and lets code, not either model, decide what counts as evidence:

- The reviewer works in a throwaway snapshot, under the workspace-write sandbox, with no network and no user config.
- The verdict is decided by fixed rules that can only make the reviewer stricter.
- Executed checks come from the event log, and the model and sandbox actually applied come from Codex's session record.
- The checkout's fingerprint must not change during the review.
- The repair loop is limited to two cycles, then escalates to a human.

ApexYard integration uses its documented private extension points (`custom-skills`, `custom-handbooks`), so the framework is not modified.

## Consequences

- Every verification spends one Codex review. Real-model agent evaluations stay opt-in behind `eval:integration --confirm`.
- The real-model harnesses now reject npm-consumed and unknown flags, require an explicit model, and read the model back from each session before any prompt.
- Applied-settings checks depend on Codex's session-record format; a format change degrades the verdict to NEEDS_MANUAL_REVIEW, not to PASS.

## Artifacts

- `scripts/verify/`, `scripts/lib/`, `verify.config.json`, `docs/verification.md`, `tests/verify-workflow.test.ts`
- Portfolio: `custom-skills/independent-verify/SKILL.md`, `custom-handbooks/general/independent-verification.md`
