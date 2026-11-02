# CLI proof: runtimes and runtime polish

This records the no-model-quota probes behind the runtime-polish roadmap entries.
No probe created a real assistant turn, spent model quota, or wrote to the
developer's real Claude/Codex session state. `.peer-dev/verify/cli-proof.md`
holds the working notes from the implementing session; this file is the
reviewable copy that ships with the change.

## Environment

```text
$ command -v gemini; command -v claude; command -v codex
(no gemini on PATH)
/Users/omarashour/.local/bin/claude
/opt/homebrew/bin/codex
$ claude --version
2.1.316 (Claude Code)
$ codex --version
codex-cli 0.166.0
```

Gemini is absent here. Its adapter therefore proves only the tested unavailable
path plus documented stream/resume semantics; no live Gemini turn is claimed.

## Claude undo truncation

The installed Agent SDK exposes the exact functions the adapter injects in
tests:

```text
$ node -e "import('@anthropic-ai/claude-agent-sdk').then(m => console.log(JSON.stringify({forkSession: typeof m.forkSession, deleteSession: typeof m.deleteSession, query: typeof m.query})))"
{"forkSession":"function","deleteSession":"function","query":"function"}
```

`sdk.d.ts` declares `forkSession(sessionId, { dir?, upToMessageId?, title? })`
returning `{ sessionId }`, and `deleteSession(sessionId, { dir? })`. A bogus-ID
probe reached the real session store without touching a real session:

```text
fork bogus-id error: Session 00000000-0000-0000-0000-000000000000 not found in project directory for /tmp/peer-proof-nonexistent
delete bogus-id error: Session 00000000-0000-0000-0000-000000000000 not found in project directory for /tmp/peer-proof-nonexistent
```

The SDK docs also state that `forkSession` remaps every message UUID. The repair
therefore re-reads the original and forked transcripts with
`getSessionMessages`, pairs top-level assistant messages by order, and stores
the forked UUIDs for kept turns. Regression coverage is in
`tests/undo-truncate.test.ts` ("keeps valid UUIDs across repeated undos after a
fork"). A full undo cycle against a real Claude session was not run.

## Codex undo truncation

`codex app-server generate-json-schema --out /tmp/codex-schema` succeeds for the
installed CLI. Its `ThreadRevertParams` is:

```json
{
  "beforeTurnId": "Turn excluded from the replacement history, together with every later turn.",
  "threadId": "string",
  "required": ["beforeTurnId", "threadId"]
}
```

That matches `CodexAdapter.forgetTurns`'s call:

```ts
call("thread/revert", { threadId, beforeTurnId })
```

A live app-server probe used an isolated `HOME=/tmp/peer-codex-home`, completed
the `initialize`/`initialized` handshake, and called methods with bogus IDs:

```json
[
  { "call": "initialize", "response": "ok" },
  { "call": "thread/revert bogus", "response": { "code": -32600, "message": "thread not found: 00000000-0000-0000-0000-000000000000" } },
  { "call": "thread/list", "response": "ok" }
]
```

So `thread/revert` exists and routes in 0.166.0. With the developer's real
`HOME`, this sandbox refused to start the app-server (`failed to initialize
sqlite state runtime`), which is why the probe used an isolated HOME. A full
undo cycle against a real thread was not run; it needs a model turn.

## Codex MCP gating

Enumerating `*/requestApproval` methods in the generated 0.166.0 schema returns
only:

```text
Item/commandExecution/requestApproval
Item/fileChange/requestApproval
Item/permissions/requestApproval
item/commandExecution/requestApproval
item/fileChange/requestApproval
item/permissions/requestApproval
```

There is no `item/mcpToolCall/requestApproval`; MCP progress exists, but there
is no pre-execution approval request to answer. The honest shipped behavior is
therefore an upfront locked-turn instruction plus a fail-closed abort if a
non-read-only MCP item starts. True prevention remains open in the roadmap.

## Gemini CLI (docs-corroborated; live semantics unverified)

No local binary exists to probe, so this item's evidence is pinned
documentation, not a run. Sources, retrieved 2026-11-01:

- [Gemini CLI cheatsheet](https://geminicli.com/docs/cli/cli-reference/):
  "`--approval-mode` … Choices: `default`, `auto_edit`, `yolo`, `plan`", and
  "`gemini -r "<session-id>" "query"` | Resume session by ID".
- [Session management](https://geminicli.com/docs/cli/session-management/):
  "Resume by ID: You can also provide the full session UUID:
  `gemini --resume a1b2c3d4-e5f6-7890-abcd-ef1234567890`".
- [Headless mode](https://geminicli.com/docs/cli/headless/):
  "`--output-format` … `stream-json` (newline-delimited JSON events) …
  `init`: Session metadata (session ID, model); `message`: User and assistant
  message chunks". Third-party stream-json drivers likewise record the `init`
  event field as `session_id`.

Peer always uses `--approval-mode plan`, captures `init.session_id` per Peer
session, and resumes that exact ID. That is implemented and fake-tested
(`tests/gemini.test.ts`: read-only args, exact resume, interleaved sessions,
unavailable startup, abort-until-exit). Whether the real CLI's plan mode blocks
every consequential operation, and whether real stream/resume behavior matches
the fakes, is **not verified**; the roadmap keeps writable Gemini and live-CLI
confirmation open.

## Runtime settings

This item's interface is Peer's preferences API, not a CLI, so its proof is
API-level plus the binary probes above:

- The binaries the settings point at are the ones probed in Environment:
  `claude` 2.1.316 and `codex-cli` 0.166.0 resolve on PATH, and
  `GeminiAdapter`/`ClaudeCodeAdapter`/`CodexAdapter` report `unavailable`
  when their binary is missing (Gemini's case is unit-tested).
- `tests/runtime-settings.test.ts` (10 tests) covers validation, persistence
  through `PATCH /preferences`, a configured CLI path overriding PATH
  discovery (and back), Claude permission-mode selection, and Codex effort
  applied at session start via the engine.

No Electron click-through was performed; the dialog itself is untested UI.
