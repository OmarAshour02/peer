# Architecture

```
┌──────────────────────── Electron main process ────────────────────────┐
│                                                                       │
│  Peer backend (Node, Hono, 127.0.0.1:<random>)                        │
│  ┌──────────────┐   ┌───────────────────────┐   ┌───────────────────┐ │
│  │ HTTP API     │──▶│ PeerService           │──▶│ RuntimeSet         │ │
│  │ /api  (token)│   │  CollaborationEngine  │   │  OpenCodeAdapter   │ │
│  │ /bridge      │◀─┐│  Store (SQLite)       │◀──│  ClaudeCodeAdapter │ │
│  └──────▲───────┘  │└───────────────────────┘   │  CodexAdapter      │ │
│         │ SSE+REST │       RuntimeHooks (gate,  │  GeminiAdapter     │ │
│         │ SSE+REST │       RuntimeHooks (gate,  └──┬──────┬──────┬──┘ │
│         │          │       checkpoints) in-process   │      │      │    │
└─────────┼──────────┼─────────────────────────────────┼──────┼──────┼────┘
          │          │                                  ▼      │      ▼
  ┌───────┴──────┐   │   ┌── opencode serve (bundled) ────┐   │   codex app-server (user's CLI,
  │ Renderer     │   └───│ Peer plugin: peer_checkpoint + │   │   JSON-RPC over stdio)
  │ React + Vite │       │ tool.execute.before gate       │   ▼
  └──────────────┘       └────────────────────────────────┘   claude (user's CLI, driven by the
                                                               Claude Agent SDK, one query per turn)
```

Peer connects to coding agents the way [T3 Code](https://github.com/pingdotgg/t3code) does: each agent's own CLI runs as a subprocess, using the developer's existing install and login, and a per-runtime adapter translates its native protocol into one normalized event model. Peer adds what T3 Code doesn't have: the collaboration engine sits between the developer and every runtime, and each adapter wires the engine's gate and checkpoints into that runtime's control points. Gemini CLI is the fourth runtime (`GeminiAdapter`): headless `gemini -p` per turn with `--output-format stream-json`; Peer stores the `init` event's `session_id` and resumes that exact conversation. Peer cannot approve individual Gemini commands, so every turn runs read-only (`--approval-mode plan`), with a standing warning; there is no checkpoint tool, so the model asks in its reply text instead.

## Responsibilities

**The runtime** (OpenCode, Claude Code, Codex or Gemini CLI) owns providers and models, the agent loop, codebase exploration, file and shell tools, its own conversation state, and its permission system. Peer does not reimplement any of these. For Claude Code, Codex and Gemini CLI, Peer also keeps a normalized copy of the transcript (to render history after a restart) and computes the session's file changes from a git snapshot.

**Peer** owns the UI, workspaces, the collaboration engine and policies, per-session mode/model settings, checkpoints, the collaboration gate, and the collaboration event log.

## Components

| Path | Role |
|---|---|
| `src/shared/types.ts` | Domain types shared by backend and UI (no runtime dependency). |
| `src/server/collaboration/policies.ts` | `CollaborationPolicy` per mode, as **data**: allowed checkpoint categories, a per-turn question ceiling, default gate, guidance. `resolveEffectivePolicy(mode, intent, …, context)` applies the developer's controls (intents) and what Peer knows from the session's history (hint level, hands-off responses, a discussion in progress). Collaborate and Learn are the product's modes; Focus is retired but kept for existing sessions. |
| `src/server/collaboration/intent.ts` | Slash commands to intents (`/go`, `/discuss`, `/hint`, `/answer`, `/proceed`), and `isGoAhead`: a message that only says go ahead ends a discussion. |
| `src/server/collaboration/engine.ts` | `CollaborationEngine`: plans each turn (policy → system prompt + gate), evaluates every tool call against the gate, opens/declines/awaits/resolves/cancels checkpoints, resumes interrupted ones, recovers after restarts. |
| `src/server/collaboration/prompt.ts` | Composes per-turn instructions from the effective policy. |
| `src/server/collaboration/decisions.ts` | Detects consequential decisions in a tool call's arguments before it runs: new dependencies (installer commands, manifest edits) and public API contract changes (spec files by name and location, `exports`/`bin` in `package.json`), through edit/write/patch tools (OpenCode, Claude Code and Codex argument shapes). Pure, given a file reader. Also exports `editTargetPaths`, the files a write-like call targets, which the engine's Collaborate approach gate counts per task. |
| `src/server/collaboration/tool-classification.ts` | Conservative read-only vs mutating classification (including shell commands). Shared with the plugin. |
| `src/server/runtime/adapter.ts` | `AgentRuntimeAdapter`: the only interface the engine, service and API use. `RuntimeHooks`: the engine's gate and checkpoint functions for in-process adapters. |
| `src/server/runtime/set.ts` | `RuntimeSet`: the adapters by kind. Each session is bound to one runtime (`sessions.runtime`). |
| `src/server/runtime/gemini/*` | `GeminiAdapter`: headless `gemini -p` per turn with `stream-json`, exact `--resume <session_id>` from the `init` event, policy prepended as a tagged block, every turn read-only via `--approval-mode plan` (Peer cannot approve Gemini commands), stdout parsed into the transcript. No checkpoint tool and no permission surface; the model asks in its reply text. Abort and stop wait for the subprocess to exit before releasing the Peer session. |
| `src/server/runtime/claude/*` | `ClaudeCodeAdapter`: Claude Agent SDK `query()` per turn (`sessionId`, then `resume`), the turn's policy as a tagged block at the start of the message (a resumed session keeps its first system prompt; the system prompt only says the latest block is in force), `PreToolUse` gate hook, `canUseTool` → permission cards, in-process MCP checkpoint tool, streaming normalization. |
| `src/server/runtime/codex/*` | `CodexAdapter` + `CodexRpc`: one `codex app-server` (JSON-RPC/stdio, crash restarts), threads created on the first prompt and resumed after restarts, Peer as approver, dynamic `peer_checkpoint` tool, item normalization. Codex 0.166.0 has no MCP approval method in its protocol schema, so MCP is gated by an upfront locked-turn instruction plus a fail-closed abort when a non-read-only `mcpToolCall` starts; `item/mcpToolCall/requestApproval` is handled only as forward compatibility. |
| `src/server/runtime/transcript.ts`, `git-snapshot.ts`, `cli.ts` | Persisted normalized transcripts, git-tree session diffs (private index file, no refs or commits), CLI discovery and status probes. |
| `src/server/collaboration/safety.ts` | Destructive-command patterns shared by all runtimes. |
| `src/server/runtime/opencode/*` | `OpenCodeAdapter` (SDK client, global event stream, normalization, provider connections), `OpenCodeProcess` (spawn, isolation, safety rules, crash restarts), `credentials.ts` (importing the developer's OpenCode logins) and `providers.ts` (provider catalog, deferred provider reloads). |
| `src/plugin/peer-plugin.ts` | Runs **inside** OpenCode. Thin enforcement: asks the engine (via `/bridge`) before each tool call and blocks on checkpoints. |
| `src/server/service.ts`, `app.ts`, `server.ts` | Session mapping, event forwarding, HTTP API + SSE, composition root. |
| `src/server/store.ts` | SQLite via `node:sqlite` (no native modules): workspaces, sessions (mode, model), turns (gate), checkpoints, collaboration events, preferences. |
| `electron/` | Window, folder picker, lifecycle, `--smoke-test`. |
| `src/renderer/` | React UI. It depends only on the HTTP/SSE API, not on the engine. |

## How a turn works

1. The developer sends a message, optionally with a control: an intent from the composer or a slash command (`/go`, `/discuss`, `/hint`, `/answer`, `/proceed`).
2. If the agent is blocked on a checkpoint, the message **answers that checkpoint** instead of starting a turn; a control answers it with its own action (`go`, `discuss`, `hint`, `direct`, `skip`), which can change the turn's intent for the rest of the task (`turns.intent`) or lock code changes again (`turns.relocked_at`, "Discuss first" mid-turn; `turns.gate` keeps the gate the turn started with, which fixed Codex's sandbox).
3. Otherwise the engine resolves the effective policy and records a `turn` with its gate (`open` | `engage` | `hold`). While `sessions.discussing` is set ("Discuss first"), a plain follow-up becomes a `discuss` turn and a go-ahead-only message a `proceed` turn. The policy context comes from stored history: consecutive hint turns, the developer's last two responses (hands-off or engaged), and the decisions they made in the session (sent to the agent as "Already decided"). It then calls `session.promptAsync` with the composed policy in the per-prompt `system` field and disables OpenCode's generic `question` tool. The policy rides on **every** prompt, so it always applies; we do not depend on a skill being loaded.
4. Before every tool call, the plugin's `tool.execute.before` asks `/bridge/tool-check`. Read-only tools pass; mutating tools are rejected with an explanation while the gate is locked. Subagent sessions resolve to their parent.
5. If the gate is open and the call carries a decision Peer detects (`decisions.ts`), the engine checks what the developer already decided in this session (its own earlier checkpoints, and the developer's words in messages, answers, chosen options and approved plans). An undecided one is noted (Focus, "Just do it") or held on a Peer-opened checkpoint (`source: "peer"`): the bridge answers `{ wait: <id> }` and the plugin long-polls `/bridge/tool-check/:id/wait`; in-process adapters wait in `engine.checkTool` with the run's abort signal (Claude Code's `PreToolUse` hook has a 24-hour timeout for this). The developer's response becomes allow or a rejection whose reason reaches the agent (Codex: `turn/steer`).
6. When the agent calls `peer_checkpoint`, the engine either declines it by policy (wrong category for the mode and controls in effect, the ceiling reached, or a question the developer already answered in this session; recorded and shown), records it without asking (category `routine`, which opens Learn's `engage` lock but never a `hold`), or opens it. If opened, the plugin long-polls `/bridge/checkpoints/:id/wait` until the developer resolves it. The answer is returned as the tool result; engaging unlocks an `engage` gate.
7. Runtime events (text deltas, tool states, permissions, status) are normalized and streamed to the UI over SSE. On reconnect the UI re-fetches a full snapshot.

### Undo last turn

Before each turn's prompt the engine records the workspace as a git tree (`turns.start_tree`; a private index file per session under `<data>/snapshots/turns`, never the developer's index), and again when the turn ends (`end_tree`). The session counts as busy, and the UI gets its idle, only once that end snapshot is recorded; a runtime's earlier "idle" status is held back. **Undo last turn** (`POST /sessions/:id/undo`, only while idle) puts every file inside the workspace folder that changed between the two back to its `start_tree` version: files the turn created are deleted first (with directories left empty), then the rest are written through a temporary index, so a file replaced by a directory, or the reverse, comes back too. Changes elsewhere in a larger repository are left alone. If a file the turn changed was changed again after Peer reported the turn finished, undo refuses and names it, so those edits are not overwritten; edits made while the turn was still running count as the turn's. A restore that fails part-way puts the files back as they were before the undo. Stop during the start snapshot keeps the prompt from reaching the runtime. A Codex task and the continuation that carried it on are one undo; repeating undo walks back turn by turn. The runtime then forgets the turn (`forgetTurns`): OpenCode reverts natively (`session.revert`; Peer hides reverted messages and their diffs until OpenCode drops them on the next prompt). Claude Code forks its session at the last kept turn (`forkSession upToMessageId`, from the assistant UUIDs Peer records per turn), remaps those UUIDs into the fork by transcript order, and deletes the session when every turn is undone, so the next turn starts fresh; Codex reverts its thread (`thread/revert beforeTurnId`, from the turn ids Peer records). When the CLI session cannot be truncated (no fork point recorded, or the operation fails), the turns stay there and the next turn's policy tells the agent they were undone (`sessions.undone_untold`). Undo needs a git workspace when the turn starts; turns cut short by a Peer restart have no end record and cannot be undone.

## Runtime integration details

- **Process.** `opencode serve --hostname 127.0.0.1 --port 0` with a random `OPENCODE_SERVER_PASSWORD` (basic auth). Peer parses the printed URL. The runtime runs in its own process group so stopping Peer also stops its shells and language servers. The plugin exits the runtime if Peer's process disappears (orphan protection, verified with `kill -9`).
- **Isolation.** `XDG_DATA_HOME`/`STATE`/`CACHE` point into Peer's data dir. This is required: another OpenCode version's database schema can break the pinned runtime. The user's **config** dir is untouched.
- **Plugin loading.** `OPENCODE_CONFIG_DIR=<peer>/opencode/peer-config` with `plugin/peer.js` (bundled by esbuild, including zod).
- **Safety rules.** These go in `OPENCODE_CONFIG_CONTENT.permission`: `external_directory: deny`, plus `ask` for destructive shell patterns. They merge after the user's config, tightening but never loosening it.
- **Diffs.** OpenCode 1.19's session-level diff is empty, so Peer aggregates the per-turn `summary.diffs` from user messages.
- **Credentials.** The runtime reads and writes one credential file, `auth.json` in its isolated data dir (mode 0600). Before each start Peer syncs in the developer's own `opencode auth login` credentials (`~/.local/share/opencode/auth.json`): theirs win for providers they logged into there, entries the pinned version can't read are skipped, and Peer records which ids it imported and which the developer connected in Peer (`peer-imported.json`, ids only), so a provider they later log out of is removed again. Imported providers can't be disconnected in Peer; connecting one in Peer makes it Peer's own, and later imports leave that key alone until it is disconnected in Peer. Peer does not use `OPENCODE_AUTH_CONTENT`: with it set, OpenCode ignores keys saved through its API.
- **Connecting providers.** *Models & providers* lists OpenCode's provider catalog (`GET /provider`, `GET /provider/auth`) and connects one with an API key (`PUT /auth/{id}`) or OpenCode's own browser/device logins (`/provider/{id}/oauth/*`). Only providers connected in Peer can be disconnected there. The UI never receives a credential: the catalog is rebuilt from safe fields only, since OpenCode's provider entries include keys.
- **Local models.** *Models & providers* shows Ollama (`OLLAMA_HOST`, default `127.0.0.1:11434`) and LM Studio (`127.0.0.1:1234`) with whether they answer `GET <base>/models`, and accepts any other OpenAI-compatible address (http(s) only, no credentials in it). An added server is stored in `peer-local-models.json` and written as a custom `@ai-sdk/openai-compatible` provider (models with `tool_call: true`) into `peer-config/opencode.json`, which OpenCode reads from its config dir at start and again on a provider reload. Model lists refresh when the catalog is opened and when the runtime starts; a server that is down keeps its last known models. Embedding models are left out.
- **Provider reloads.** OpenCode reads providers once per instance, so a new credential needs `POST /global/dispose`, which aborts every running session (verified). Peer reloads only when no OpenCode session is busy (checked with `session.status` per known directory), otherwise once they go idle; new prompts wait while a reload runs. The UI shows the wait and refreshes the model list after the reload (`providers.updated`).
- **GUI PATH and shell keys.** Apps launched from Finder or a desktop launcher get a minimal environment, so Peer reads the login shell's environment once at startup (`env -0`). Every runtime gets its `PATH`. Model-provider variables (`*_API_KEY`, `*_API_TOKEN`, and cloud credentials such as `AWS_PROFILE` or `GOOGLE_APPLICATION_CREDENTIALS`) that Peer's own environment lacks go to OpenCode only, where they show as *environment* providers. Claude Code and Codex keep Peer's own environment, so an `ANTHROPIC_API_KEY` exported in a shell profile cannot switch Claude Code from the subscription to API billing. Only the variable names are logged.

## Claude Code and Codex details

- **Version drift.** `TESTED_VERSIONS` (in `runtime/versions.ts`) names the CLI versions Peer was tested with (Claude Code 2.1.x, Codex 0.163.x). A CLI outside that range still runs, with a warning in the runtime's status (amber dot, tooltip, *Models & providers*).
- **Discovery and login.** At startup Peer looks for `claude` and `codex` on the login shell's `PATH` and runs only status probes (`--version`, `claude auth status --json`, `codex login status`); it never starts a login. The probes also say how each CLI is signed in (e.g. *Claude Pro*, *ChatGPT*), shown in *Models & providers*; Peer keeps only that label, never the email or key the probes print. Missing or logged-out CLIs show as *unavailable* with instructions; **Restart runtime** re-probes. New sessions default to the first ready runtime among Claude Code, Codex and OpenCode (`pickDefaultRuntime`): the agents the developer is signed in to first, the bundled runtime for every other model last. Once the developer picks a runtime in the sidebar, or asks the API for a non-default one, that choice sticks while the runtime is ready or starting; while it is down (unavailable, crashed, stopped) new sessions fall back, and the choice applies again once it is back. Credentials stay with the CLIs: a Claude subscription login is not reused for OpenCode sessions, which need an Anthropic API key.
- **Runtime settings.** *Runtime settings* (gear in the sidebar, `PATCH /preferences` → `preferences.runtimeSettings`) sets the agent CLI paths, Claude Code's permission mode and Codex's reasoning effort. Paths override the matching `PEER_*_BIN` variable and apply when the runtime (re)starts; the permission mode (the default for turns without session auto-approvals) and the effort (`turn/start effort`) apply to sessions as they start.
- **Claude Code.** Each Peer turn is one Agent SDK `query()` that resumes the Claude Code session (Peer picks its id on the first turn). Your settings, CLAUDE.md files, MCP servers and permission rules load (`settingSources: user, project, local`); `permissionMode: acceptEdits` pre-approves in-workspace edits, or `auto` when the session's **Auto approvals** is on (Claude Code's classifier settles permission prompts; Peer's `PreToolUse` gate and destructive-command "ask" run first and still apply); session-scoped "Always allow" grants are kept per Peer session and passed to each turn as `allowedTools`/`additionalDirectories`; `AskUserQuestion` is disabled. Model list: the SDK's `supportedModels()` (no prompt is sent), falling back to aliases. Session titles come from Claude Code's own summary.
- **Codex.** One `codex app-server` serves every Codex session. Peer opts into the experimental API for dynamic tools. A Codex thread is created on a session's first prompt (a thread with no turns cannot be resumed later) and resumed with `excludeTurns` when the app-server restarts. Approval requests carry `threadId`, which maps them to the Peer session. Writable turns run in `workspaceWrite` without network unless the workspace allows it (**Network** in the session header, `workspaces.sandbox_network`); read-only turns never get network, and the agent is told which applies.
- **Diffs.** The first prompt records the workspace as a git tree (`git add -A` + `write-tree` into a private index file under Peer's data dir); the Changes panel diffs the current workspace against it. Outside a git repository there is no Changes panel for these runtimes. Changes the developer makes during the session show up too.
- **Token usage.** Each turn's tokens go into the transcript as a `step-finish` part, the way OpenCode reports them: Claude Code from the query's result (`usage`: the main agent loop of that query; Peer runs one query per turn), Codex from `thread/tokenUsage/updated` (thread totals now minus the totals before the turn). The integration evaluation uses them for its token limit.
- **Bundling.** The Agent SDK is bundled into the backend. Its own platform binaries are not shipped; Peer passes the user's `claude` as `pathToClaudeCodeExecutable`.

## Security (local MVP)

- Everything binds to `127.0.0.1`. The API requires a per-launch bearer token. Desktop gets it over IPC; headless mode persists it at `<data>/api-token` (mode 0600) and passes it in the URL fragment.
- CORS allows only Peer's own origin and, in development, the Vite origin.
- The bridge uses a separate token known only to the runtime process.
- Credentials never reach the renderer.
- The renderer runs with `contextIsolation` and `sandbox`, has no Node access, cannot navigate away from Peer, and opens external links in the browser.
- Workspaces must be absolute existing directories. Neither `/` nor `$HOME` is accepted.

## Platforms

| | macOS arm64 | macOS x64 | Linux x64 | Linux arm64 |
|---|---|---|---|---|
| Runtime binary | `opencode-darwin-arm64` | `opencode-darwin-x64-baseline` | `opencode-linux-x64-baseline` | `opencode-linux-arm64` |
| Packages | DMG, zip | DMG, zip | AppImage, deb | AppImage, deb |

The "baseline" x64 builds don't require AVX2, so they work on older CPUs. `scripts/fetch-opencode.mjs` downloads the pinned version (`package.json` → `opencode.version`) from the official npm platform packages, and electron-builder copies `vendor/opencode/${os}-${arch}` into `Resources/opencode/`.

## Distribution

macOS signing and notarization use electron-builder:
- The app and the bundled runtime binary (`mac.binaries`) are signed with the hardened runtime.
- Entitlements are in `build/entitlements.mac.plist`. JIT is required by Electron and by Bun/JavaScriptCore in the runtime.
- CI secrets:

| Secret | Purpose |
|---|---|
| `MAC_CERTIFICATE_P12_BASE64` | Developer ID Application cert (→ `CSC_LINK`) |
| `MAC_CERTIFICATE_PASSWORD` | → `CSC_KEY_PASSWORD` |
| `APPLE_API_KEY_P8`, `APPLE_API_KEY_ID`, `APPLE_API_ISSUER` | App Store Connect API key for notarization |

Without secrets, CI builds unsigned apps and says so. When a certificate is present, CI verifies the result with `codesign --verify --deep --strict` and `spctl --assess`.

## Learning events (future Learning Space)

`collaboration_events` is an append-only log per session:
- `turn.started` (mode, intent, gate, text)
- `checkpoint.opened` / `declined` / `resolved` (category, question, the developer's action and answer; `source: "peer"` for decisions Peer detected; `repeatOf` for a repeat Peer declined), `checkpoint.routine` (work the agent declared routine, and whether it unlocked code changes)
- `discussion.started` / `discussion.ended` (what started or ended "Discuss first")
- `decision.noted`, `decision.reused` (a detected decision recorded without asking, or one already decided)
- `gate.blocked`, `mode.changed`, `permission.*`, `runtime.error`

Together with the runtime transcript, this is the capture point for conversation-derived learning. See [roadmap.md](roadmap.md). No learning data model is built yet, on purpose. Cross-session adaptation derives from this log and the sessions table at read time (the last 20 hands-off signals and the recent mode/model habits since `preferences.memoryResetAt`, only while `crossSessionMemory` is on); no separate memory store exists.
