# Roadmap

## Done (milestones 1–3)

- Real OpenCode integration: bundled, pinned runtime on four targets; sessions; streaming; tools; diffs; permissions.
- Collaboration engine with three modes, a policy model, an enforced gate, blocking checkpoints, intents, and restart recovery.
- Desktop app, headless mode, persistence, unit tests, real three-mode verification, packaged-app smoke tests, CI.

## Done: connectable runtimes (Claude Code, Codex)

- Sessions run on OpenCode (bundled), Claude Code (user's CLI via the Claude Agent SDK) or Codex (user's CLI via `codex app-server`), picked per session, with the same modes, gate, checkpoints, safety rules and restart recovery. Verified with real Learn and Focus runs on both, restart + resume, permission approval, and Stop.

## Done: model-agnostic and runtime polish

- *Models & providers*: connect OpenCode providers in-app; local models (Ollama, LM Studio, any OpenAI-compatible server); provider keys exported in the login shell reach OpenCode.
- Per-workspace network switch for Codex's sandbox; warnings for Claude Code / Codex versions outside the tested range.
- Rename and delete sessions; undo the last turn (files on every runtime, conversation on OpenCode).

## Done: v0.2, the collaboration experience

- Two modes: Collaborate (default) and Learn. Focus is retired (kept for existing sessions and the API).
- Mode-specific controls in the composer and on questions, as temporary overrides applied by the engine on every runtime: Just do it, Discuss first (until you proceed), Give me a hint (progressive), Direct answer.
- Adaptive involvement instead of quotas: a ceiling, per-session adaptation to hands-off responses, earlier decisions given to the agent, repeated questions declined, routine work in Learn without a question.
- Claude Code and Codex report token usage like OpenCode; the integration evaluation has run, time, tool-call and token limits.

## Done: runtime polish

- **Undo truncates the CLI session.** Claude `forgetTurns` forks at the last kept turn's message UUID (deletes when all undone) and remaps kept turn UUIDs into the fork so repeated undos keep working; Codex `forgetTurns` calls `thread/revert` with the first undone turn's id; both fall back to telling the agent. CLI proof: live `thread/revert` method-exists probe against `codex app-server` 0.166.0, live SDK `forkSession`/`deleteSession` probes, schema `ThreadRevertParams` match. Evidence: [`docs/cli-proof.md`](cli-proof.md).

## Partially done: Gemini CLI and runtime settings

- **Gemini CLI (read-only adapter; live CLI unverified).** Shipped: the adapter behind the same interface: headless `gemini -p` per turn with `--output-format stream-json`; Peer captures the `init` event's `session_id` and later resumes that exact conversation. Every turn runs `--approval-mode plan`, because Peer cannot approve individual Gemini commands, so Gemini explores and proposes but does not apply changes. It has no checkpoint tool or detected-decision gate; those gaps are documented in `PEER.md`. Graceful degradation when the binary is absent is tested. Not done (proof pending): a live headless turn was not run (binary not installed here; would need login + quota), and no binary/schema probe was run, so real plan-mode/stream/resume semantics remain unverified. Evidence: [`docs/cli-proof.md`](cli-proof.md).
- **Runtime settings in the UI.** Shipped: CLI paths, Claude permission mode, Codex reasoning effort; persisted via preferences, CLI paths applied on runtime restart, mode/effort at session start. Covered by unit tests. Not done (proof pending): no live UI click-through, and no CLI/SDK probe showing the configured permission mode and reasoning effort reaching the supported runtime interfaces; existing evidence is preferences-API tests and binary-version probes only. Evidence: [`docs/cli-proof.md`](cli-proof.md).

## Partially done: Codex MCP gating

- Shipped: gated turns are told up front not to start MCP tools, and a non-read-only `mcpToolCall` that starts while locked aborts the turn (fail closed). A forward-compatible `item/mcpToolCall/requestApproval` handler is ready if Codex adds that method.
- Not done: true pre-execution prevention. Codex 0.166.0 has no MCP approval method in its protocol schema, so prevention still needs Codex protocol support or Peer proxying the developer's MCP servers. This item stays open below.

## Next: more runtimes and MCP prevention

1. **Cursor or ACP** behind the same `AgentRuntimeAdapter` interface, including anything speaking the Agent Client Protocol (ACP), which T3 Code also uses for some providers.
2. **Writable Gemini turns** once individual Gemini commands can pass through Peer's permission and destructive-command gates.
3. **Codex MCP pre-execution prevention**: proxy the developer's MCP servers through Peer, or adopt a Codex protocol approval method if one ships.

## Next: Milestone 4, collaboration quality

1. **Question quality in Learn.** The gate guarantees engagement, not a good question. Ideas:
   - Done: a "confirm" checkpoint no longer opens an `engage` gate in Learn. An ordinary answer or choice on it approves the plan but keeps code changes locked (live and on a resumed turn); explicit controls on it (You decide, Just do it, Direct answer, Proceed) still unlock, and routine work keeps its own path. The agent is told to ask a hypothesis or concept question instead.
   - Classify tasks with a cheap model call.
   - Track how often each kind of checkpoint is answered versus skipped.
2. **Collaborate approach gate.** Done: an optional "agree before significant edits" gate for Collaborate, on a file-count threshold instead of always being on. Per-session opt-in in the header (off by default, persisted); Peer counts distinct files a task's edit/write/patch calls target and pauses the call that would pass five on a Peer checkpoint ("Continue with the changes / Stop here") for the rest of the task. Just do it / Proceed / Direct answer tasks are not interrupted; shell-driven changes are not counted (documented limit).
3. **Adaptive policy across sessions.** v0.2 adapts within a session (hands-off responses narrow the questions). Carrying that across sessions needs per-developer memory, deliberately not built yet.
4. **Routine-work review.** Learn's routine declaration is the agent's judgment. Track how often it is used on tasks the developer later engages with, and consider a "this isn't routine, ask me" control.
5. **Session UX.**
   - Reopen runtime sub-sessions (subagents).
   - Show checkpoint history per file.
   - Redo after undo (OpenCode has `unrevert`; others would restore the turn's end tree).
6. **Model handling.** Per-mode default models. Per-model context limits for local models (OpenCode compacts by them).
7. **Updates.** Auto-update via electron-builder (zip + `latest-mac.yml` / AppImage update info). Publish signed builds from tagged CI runs.

## Later: Learning Space

The Learning Space should reinforce the collaboration model and be grounded in the developer's real projects and conversations.

**Capture (already in place):** `collaboration_events` records which concepts came up (checkpoint questions and categories), what the developer answered, whether they asked for hints, delegated, or skipped, plus the transcript itself in the runtime.

**Proposed pipeline (not built):**
1. After a session goes idle, a background extraction job reads new events and transcript excerpts.
2. It extracts *concept mentions* (e.g. "sliding window rate limiting", "socket remote address vs X-Forwarded-For") with a link back to the session, turn, and code location.
3. Each concept is tracked as **encountered** (it came up), **engaged** (the developer answered a hypothesis/concept checkpoint), or **demonstrated** (answered correctly without hints, or later applied unaided).
4. Built on top of that:
   - A personal knowledge map.
   - Spaced-repetition review: questions generated from the developer's own past checkpoints, with answers checked against what happened in the code.
   - Short debugging challenges built from real diffs.
   - Curated reading with read/completed state.
5. Human progress is reported separately from project progress.

**Guardrails:**
- No fabricated quizzes or metrics.
- Every learning item must trace back to a real conversation or diff.
- The developer can opt out per project.
