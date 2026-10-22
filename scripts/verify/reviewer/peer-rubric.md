# Peer-specific verification rubric

Peer is a coding workspace with a collaboration layer (Focus / Collaborate / Learn) on top of three agent runtimes (bundled OpenCode, Claude Code, Codex). `PEER.md` defines the product rules, including the table "What is enforced and what is guidance". `docs/architecture.md` describes how they are wired. Read the parts relevant to the change before judging it.

For a Peer change, verify **collaboration behavior** as well as code correctness. Record each question below that the change touches in `collaboration_checks` (`holds`, `violated`, `not_applicable` or `unverified`, with evidence). Skip the ones the change cannot affect by marking them `not_applicable` with one line of reasoning.

## Enforcement (things the agent must not be able to bypass)

1. **Checkpoints block.** While a checkpoint is open, does the agent stay blocked, and are code changes locked in every mode? Look at `src/server/collaboration/engine.ts` and each runtime's gate (`src/plugin/peer-plugin.ts` for OpenCode, the `PreToolUse` hook path for Claude Code, the approval handler and read-only sandbox for Codex).
2. **No bypass routes.** Can a tool call reach the workspace without passing the gate? Check new tools, subagents, MCP tools, shell commands that write (`sed -i`, `tee`, redirects, `git apply`), and tool-name variants the classifier might not recognize (`src/server/collaboration/tool-classification.ts`).
3. **Collaborate stops before consequential decisions.** Architecture, risky operations and ambiguous requirements must reach the developer. Check that policy categories and per-turn budgets (`src/server/collaboration/policies.ts`) are applied as PEER.md describes, and that declined questions are recorded.
4. **Learn gate.** Code changes are locked at the start of each new task until the developer engages (answer, choose, delegate, skip, or reply). Reading and exploring stay allowed. Does the change keep that true?
5. **Learn encourages reasoning.** Does Learn still ask for the developer's hypothesis or reasoning, offer progressive hints, and diagnose instead of silently fixing? A change that turns Learn questions into one-click multiple choice, or that lets the agent skip the hypothesis step, is a collaboration regression.
6. **Consistency across runtimes.** A rule enforced on one runtime must be enforced on the others, or the gap must be documented in PEER.md's "Known gaps". Compare the three adapters for any behavior the change adds or alters.
7. **Safety is separate from collaboration.** Destructive commands still ask for permission in every mode (Focus included), and access outside the chosen workspace is denied (`src/server/collaboration/safety.ts`, `src/server/workspaces.ts`).

## Reliability

8. **Cancellation.** Does Stop/abort end the runtime turn, release open checkpoints and permission waits, and leave the session usable?
9. **Streaming.** Are events delivered in order and once? Is a reconnecting UI brought up to date from stored state?
10. **Session persistence.** Do sessions, checkpoints and their statuses survive a restart (`src/server/store.ts`)? Does an open checkpoint become *interrupted* and resume correctly?
11. **Workspace boundaries and permissions.** Paths are resolved and checked before use (symlinks, `..`, absolute paths). Runtime permissions match PEER.md's per-runtime table.

## Honesty

12. **Enforced vs guidance.** If the change touches PEER.md or the UI's descriptions, check that nothing claims enforcement for something that is only prompting.

## How to verify without a real model

Run tests with `npx vitest run --configLoader runner <files>`. The default config loader writes into `node_modules`, which is a read-only link in your snapshot.

Do not call a real model. Use the deterministic test doubles: `tests/helpers.ts` has a `FakeRuntime` that records prompts and lets tests drive the engine. Write probe tests in the snapshot against the engine, policies and tool classification when you need to demonstrate a bypass. If a claim can only be verified with a real model, say so in `unverified_assumptions`; the developer runs `npm run eval:integration` for that.
