# Roadmap

## Done (milestones 1–3)

- Real OpenCode integration: bundled, pinned runtime on four targets; sessions; streaming; tools; diffs; permissions.
- Collaboration engine with three modes, a policy model, an enforced gate, blocking checkpoints, intents, and restart recovery.
- Desktop app, headless mode, persistence, unit tests, real three-mode verification, packaged-app smoke tests, CI.

## Done: connectable runtimes (Claude Code, Codex)

- Sessions run on OpenCode (bundled), Claude Code (user's CLI via the Claude Agent SDK) or Codex (user's CLI via `codex app-server`), picked per session, with the same modes, gate, checkpoints, safety rules and restart recovery. Verified with real Learn and Focus runs on both, restart + resume, permission approval, and Stop.

## Next: more runtimes and runtime polish

1. **More agents** behind the same adapter interface: Gemini CLI, Cursor, or anything speaking the Agent Client Protocol (ACP), which T3 Code also uses for some providers.
2. **Codex sandbox options.** Codex's default sandbox blocks network, which includes binding a local port, so test suites that start a server fail (seen in verification). Offer a per-workspace "allow network in the sandbox" switch instead of changing Codex's default.
3. **Gate MCP tools on Codex before they run.** Today Peer stops the turn after a locked-gate MCP call starts. Prevention needs Codex to ask its client before MCP calls, or Peer to proxy the developer's MCP servers.
4. **Version drift.** Check Claude Code / Codex versions against the tested range and warn; the Codex dynamic-tool API is experimental.
5. **Runtime settings in the UI**: CLI paths, Claude permission mode, Codex reasoning effort.

## Next: Milestone 4, collaboration quality

1. **Question quality in Learn.** The gate guarantees engagement, not a good question. Ideas:
   - Make a "confirm" checkpoint insufficient to open an `engage` gate for non-mechanical tasks.
   - Classify tasks with a cheap model call.
   - Track how often each kind of checkpoint is answered versus skipped.
2. **Collaborate approach gate.** An optional "agree before significant edits" gate for Collaborate, triggered by a diff-size or file-count threshold instead of always being on.
3. **Adaptive policy.** Adjust per-developer budgets and categories from history. For example, if a developer always presses *You decide* for trade-offs, stop asking about them.
4. **Session UX.**
   - Rename and delete sessions.
   - Reopen runtime sub-sessions (subagents).
   - Show checkpoint history per file.
   - Revert a turn (OpenCode supports revert).
5. **Model handling.** Per-mode default models. Local models (Ollama, LM Studio) from *Models & providers* instead of a hand-written OpenCode config. Provider API keys exported in the login shell (e.g. `OPENAI_API_KEY`) reach a Finder-launched Peer only if the developer connects them in Peer; importing them like `PATH` is not done. (Connecting providers in-app is done: *Models & providers*.)
6. **Updates.** Auto-update via electron-builder (zip + `latest-mac.yml` / AppImage update info). Publish signed builds from tagged CI runs.

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
