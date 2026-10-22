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

Peer connects to coding agents the way [T3 Code](https://github.com/pingdotgg/t3code) does: each agent's own CLI runs as a subprocess, using the developer's existing install and login, and a per-runtime adapter translates its native protocol into one normalized event model. Peer adds what T3 Code doesn't have: the collaboration engine sits between the developer and every runtime, and each adapter wires the engine's gate and checkpoints into that runtime's control points.

## Responsibilities

**The runtime** (OpenCode, Claude Code or Codex) owns providers and models, the agent loop, codebase exploration, file and shell tools, its own conversation state, and its permission system. Peer does not reimplement any of these. For Claude Code and Codex, Peer also keeps a normalized copy of the transcript (to render history after a restart) and computes the session's file changes from a git snapshot.

**Peer** owns the UI, workspaces, the collaboration engine and policies, per-session mode/model settings, checkpoints, the collaboration gate, and the collaboration event log.

## Components

| Path | Role |
|---|---|
| `src/shared/types.ts` | Domain types shared by backend and UI (no runtime dependency). |
| `src/server/collaboration/policies.ts` | `CollaborationPolicy` per mode, as **data**: allowed checkpoint categories, budget, default gate, guidance. `resolveEffectivePolicy(mode, intent, …)` applies one-shot intents. |
| `src/server/collaboration/engine.ts` | `CollaborationEngine`: plans each turn (policy → system prompt + gate), evaluates every tool call against the gate, opens/declines/awaits/resolves/cancels checkpoints, resumes interrupted ones, recovers after restarts. |
| `src/server/collaboration/prompt.ts` | Composes per-turn instructions from the effective policy. |
| `src/server/collaboration/tool-classification.ts` | Conservative read-only vs mutating classification (including shell commands). Shared with the plugin. |
| `src/server/runtime/adapter.ts` | `AgentRuntimeAdapter`: the only interface the engine, service and API use. `RuntimeHooks`: the engine's gate and checkpoint functions for in-process adapters. |
| `src/server/runtime/set.ts` | `RuntimeSet`: the adapters by kind. Each session is bound to one runtime (`sessions.runtime`). |
| `src/server/runtime/claude/*` | `ClaudeCodeAdapter`: Claude Agent SDK `query()` per turn (`sessionId`, then `resume`), policy appended to Claude Code's system prompt, `PreToolUse` gate hook, `canUseTool` → permission cards, in-process MCP checkpoint tool, streaming normalization. |
| `src/server/runtime/codex/*` | `CodexAdapter` + `CodexRpc`: one `codex app-server` (JSON-RPC/stdio, crash restarts), threads created on the first prompt and resumed after restarts, Peer as approver, dynamic `peer_checkpoint` tool, item normalization. |
| `src/server/runtime/transcript.ts`, `git-snapshot.ts`, `cli.ts` | Persisted normalized transcripts, git-tree session diffs (private index file, no refs or commits), CLI discovery and status probes. |
| `src/server/collaboration/safety.ts` | Destructive-command patterns shared by all runtimes. |
| `src/server/runtime/opencode/*` | `OpenCodeAdapter` (SDK client, global event stream, normalization) and `OpenCodeProcess` (spawn, isolation, auth passthrough, safety rules, crash restarts). |
| `src/plugin/peer-plugin.ts` | Runs **inside** OpenCode. Thin enforcement: asks the engine (via `/bridge`) before each tool call and blocks on checkpoints. |
| `src/server/service.ts`, `app.ts`, `server.ts` | Session mapping, event forwarding, HTTP API + SSE, composition root. |
| `src/server/store.ts` | SQLite via `node:sqlite` (no native modules): workspaces, sessions (mode, model), turns (gate), checkpoints, collaboration events, preferences. |
| `electron/` | Window, folder picker, lifecycle, `--smoke-test`. |
| `src/renderer/` | React UI. It depends only on the HTTP/SSE API, not on the engine. |

## How a turn works

1. The developer sends a message (optionally with an intent: `/go`, `/discuss`, `/hint`, `/answer`).
2. If the agent is blocked on a checkpoint, the message **answers that checkpoint** instead of starting a turn.
3. Otherwise the engine resolves the effective policy and records a `turn` with its gate (`open` | `engage` | `hold`). It then calls `session.promptAsync` with the composed policy in the per-prompt `system` field and disables OpenCode's generic `question` tool. The policy rides on **every** prompt, so it always applies; we do not depend on a skill being loaded.
4. Before every tool call, the plugin's `tool.execute.before` asks `/bridge/tool-check`. Read-only tools pass; mutating tools are rejected with an explanation while the gate is locked. Subagent sessions resolve to their parent.
5. When the agent calls `peer_checkpoint`, the engine either declines it by policy (wrong category for the mode, or budget spent; recorded and shown) or opens it. If opened, the plugin long-polls `/bridge/checkpoints/:id/wait` until the developer resolves it. The answer is returned as the tool result; engaging unlocks an `engage` gate.
6. Runtime events (text deltas, tool states, permissions, status) are normalized and streamed to the UI over SSE. On reconnect the UI re-fetches a full snapshot.

## Runtime integration details

- **Process.** `opencode serve --hostname 127.0.0.1 --port 0` with a random `OPENCODE_SERVER_PASSWORD` (basic auth). Peer parses the printed URL. The runtime runs in its own process group so stopping Peer also stops its shells and language servers. The plugin exits the runtime if Peer's process disappears (orphan protection, verified with `kill -9`).
- **Isolation.** `XDG_DATA_HOME`/`STATE`/`CACHE` point into Peer's data dir. This is required: another OpenCode version's database schema can break the pinned runtime. The user's **config** dir is untouched, and their `auth.json` is passed via `OPENCODE_AUTH_CONTENT` to the runtime process only.
- **Plugin loading.** `OPENCODE_CONFIG_DIR=<peer>/opencode/peer-config` with `plugin/peer.js` (bundled by esbuild, including zod).
- **Safety rules.** These go in `OPENCODE_CONFIG_CONTENT.permission`: `external_directory: deny`, plus `ask` for destructive shell patterns. They merge after the user's config, tightening but never loosening it.
- **Diffs.** OpenCode 1.19's session-level diff is empty, so Peer aggregates the per-turn `summary.diffs` from user messages.
- **GUI PATH.** Apps launched from Finder or a desktop launcher get a minimal `PATH`, so Peer resolves the login shell's `PATH` at startup.

## Claude Code and Codex details

- **Discovery and login.** At startup Peer looks for `claude` and `codex` on the login shell's `PATH` and runs only status probes (`--version`, `claude auth status --json`, `codex login status`); it never starts a login. Missing or logged-out CLIs show as *unavailable* with instructions; **Restart runtime** re-probes. Credentials stay with the CLIs.
- **Claude Code.** Each Peer turn is one Agent SDK `query()` that resumes the Claude Code session (Peer picks its id on the first turn). Your settings, CLAUDE.md files, MCP servers and permission rules load (`settingSources: user, project, local`); `permissionMode: acceptEdits` pre-approves in-workspace edits; `AskUserQuestion` is disabled. Model list: the SDK's `supportedModels()` (no prompt is sent), falling back to aliases. Session titles come from Claude Code's own summary.
- **Codex.** One `codex app-server` serves every Codex session. Peer opts into the experimental API for dynamic tools. A Codex thread is created on a session's first prompt (a thread with no turns cannot be resumed later) and resumed with `excludeTurns` when the app-server restarts. Approval requests carry `threadId`, which maps them to the Peer session.
- **Diffs.** The first prompt records the workspace as a git tree (`git add -A` + `write-tree` into a private index file under Peer's data dir); the Changes panel diffs the current workspace against it. Outside a git repository there is no Changes panel for these runtimes. Changes the developer makes during the session show up too.
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
- `checkpoint.opened` / `declined` / `resolved` (category, question, the developer's action and answer)
- `gate.blocked`, `mode.changed`, `permission.*`, `runtime.error`

Together with the runtime transcript, this is the capture point for conversation-derived learning. See [roadmap.md](roadmap.md). No learning data model is built yet, on purpose.
