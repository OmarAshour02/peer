# Peer

**AI coding that makes developers better, not just faster.**

Peer is a desktop coding workspace for macOS and Linux. It pairs a real coding agent with a collaboration engine that decides when to execute, discuss a trade-off, ask for your reasoning, or hand a decision back to you.

Use the bundled OpenCode runtime, or connect your existing Claude Code, Codex, or Gemini CLI installation. Your projects and session history stay on your machine; model requests go through the selected runtime and provider.

> Automate tedious work. Collaborate on meaningful work. Preserve the thinking that makes developers grow.

## Why Peer?

A coding agent can finish a task while leaving you disconnected from the decisions behind it. Peer keeps those decisions part of the work:

- **Collaborate on consequential choices.** Discuss architecture and trade-offs while the agent handles mechanical work.
- **Learn in your own codebase.** Work through the hypothesis behind a bug or the concept behind a change, with progressive hints when you need them.
- **Make pauses enforceable.** On supported runtimes, Peer holds tool calls and locks code changes while a discussion or learning checkpoint is open.
- **Catch decisions the agent might skip.** Peer detects certain new dependencies and public API edits before they run. An optional approach gate pauses a Collaborate task before its edits grow beyond five files.
- **Keep the work inspectable.** Review the transcript, tool activity, and file changes, stop a running agent, or undo a turn where supported.

Peer is under active development. Runtime capabilities differ; see [runtime limits](#runtime-limits) before relying on a gate.

## Quick start

You need **Node.js 22.13+**, npm, and Git on macOS or Linux. Supported build targets are Apple Silicon and Intel Macs, plus Linux x64 and arm64 with glibc. Windows is not currently a supported target.

```bash
git clone https://github.com/OmarAshour02/peer.git
cd peer
npm ci
npm start
```

`npm ci` downloads the pinned OpenCode binary for your platform into `vendor/`. `npm start` builds the app and launches Electron. A separate OpenCode installation is not required.

To start working:

1. Choose **Open project…** and select a local project folder.
2. Select a runtime and create a session. Each session stays on the runtime it was created with.
3. Choose **Collaborate** or **Learn**, select a model, and describe the task.
4. Answer decisions in the checkpoint card or composer. Use **Stop** to interrupt the agent.

## Choose how you work

| Mode | How it works | Temporary controls |
| --- | --- | --- |
| **Collaborate** — default | The agent handles routine work and involves you in decisions that shape the result. | **Just do it** delegates the task; **Discuss first** locks code changes while you agree on an approach. |
| **Learn** | The agent asks for your hypothesis or reasoning before meaningful code changes, then helps you work through the result. Routine work can proceed without a lesson. | **Give me a hint** offers the next step; **Direct answer** gives the answer and opens the learning gate for the task. |

Controls apply temporarily without changing the session's mode. You can also use `/go`, `/discuss`, `/hint`, `/answer`, and `/proceed`. **You decide** hands a single checkpoint decision to the agent.

The older **Focus** mode is retired. Existing Focus sessions still work; for new tasks, use Collaborate with Just do it.

## Connect a runtime

Only the runtimes you want to use need to be configured. Peer discovers installed CLIs through your login shell's `PATH` and reuses their authentication. It does not sign you in automatically.

| Runtime | Setup | Integration |
| --- | --- | --- |
| **OpenCode** | Bundled. Connect a model provider in Peer, or use your existing OpenCode credentials and configuration. | Local OpenCode server with a Peer plugin for tool gates and checkpoints. |
| **Claude Code** | Install the CLI and run `claude auth login`. | Claude Agent SDK using your CLI login, settings, `CLAUDE.md` files, and MCP servers. |
| **Codex** | Install the CLI and run `codex login`. | `codex app-server` using your login and `~/.codex` configuration. |
| **Gemini CLI** | Install the CLI and complete its login in a terminal. | Read-only exploration and proposed changes through the CLI's plan mode. |

OpenCode also reads credentials from `~/.local/share/opencode/auth.json` and provider configuration from `~/.config/opencode/opencode.json`. If you already have the OpenCode CLI installed, `opencode auth login` is another way to connect a provider. Available models depend on your provider configuration and account.

Use **Restart runtime** after changing authentication or executable settings. A missing or unavailable runtime is reported in the UI without preventing the others from starting.

The repository records tested Claude Code and Codex version ranges in [versions.ts](src/server/runtime/versions.ts). Peer warns about versions outside those ranges; CLI protocol changes may affect compatibility.

### Runtime limits

- **Gemini CLI is read-only.** It can explore and propose changes but cannot apply them in Peer. Its questions are ordinary replies; it has no Peer checkpoint tool or per-command permission cards.
- **Codex MCP calls cannot be held before execution.** Peer detects them after the fact and aborts a locked turn. Codex commands that its own rules allow without asking can also bypass Peer's per-call inspection.
- **Detected decisions are deliberately scoped.** Peer inspects recognized tool arguments and manifests. Indirect changes through scripts, generators, or unrecognized commands may not be detected.
- **Permissions and collaboration are separate.** Just do it delegates collaboration decisions; it does not grant filesystem or destructive-command permissions. Outside-workspace behavior and available approval settings vary by runtime.
- **Undo has runtime-specific behavior.** File snapshots restore a turn's changes, and conversation history is rewound where the runtime supports it. Later edits to affected files can prevent undo.

Read [PEER.md](PEER.md) for the full behavior contract, including enforcement boundaries and approval semantics.

## Local data and configuration

Peer's API listens on `127.0.0.1` and requires an access token. Workspaces, sessions, preferences, and collaboration history are stored in a local SQLite database in the app's data directory:

| Platform | Default directory |
| --- | --- |
| macOS | `~/Library/Application Support/Peer` |
| Linux | `$XDG_CONFIG_HOME/Peer`, or `~/.config/Peer` |

Cross-session memory derives recent delegation tendencies and mode/model habits from local history. It is on by default and can be disabled or reset in settings; it does not carry answers, decisions, or topics into new sessions.

| Environment variable | Purpose |
| --- | --- |
| `PEER_DATA_DIR` | Override the app's data directory. Useful for an isolated development profile. |
| `PEER_PORT` | Headless server port; defaults to `4317`. |
| `PEER_OPENCODE_BIN` | Override the bundled OpenCode executable. |
| `PEER_CLAUDE_BIN` | Path to a Claude Code executable. |
| `PEER_CODEX_BIN` | Path to a Codex executable. |
| `PEER_GEMINI_BIN` | Path to a Gemini CLI executable. |

Runtime settings also support executable paths for the external CLIs. Restart the affected runtime after changing them.

## Development

```bash
npm run dev          # Build the backend, start Vite, and launch Electron
npm run typecheck    # TypeScript checks
npm test             # Unit and regression tests
npm run build        # Bundle the backend, plugin, and renderer
npm run check        # Typecheck, test, and build
npm run smoke        # Electron smoke test; build first
```

The renderer hot-reloads under `npm run dev`. Restart the command after changing the Electron main process or backend.

To run the browser UI without Electron:

```bash
npm run build        # Includes the renderer assets served by the backend
npm run server
```

Open the token-bearing URL printed by the server. `npm run server` rebuilds the backend only, so rebuild the renderer after UI changes. Treat the printed URL as a credential.

### Project layout

```text
electron/                  Desktop shell, preload bridge, and smoke tests
src/renderer/              React UI and client state
src/server/collaboration/  Turn planning, policies, gates, and decisions
src/server/runtime/        OpenCode, Claude Code, Codex, and Gemini adapters
src/server/                Local API, SQLite storage, and workspace services
src/shared/                Shared TypeScript types
tests/                     Automated tests and fixtures
scripts/                   Build, packaging, evaluation, and verification tools
docs/                      Architecture, roadmap, and CLI proof notes
```

### Real-model checks

Real-model checks use network access and model quota. Run them deliberately with an explicit model:

```bash
# Print an integration plan; add --confirm to execute it
npm run eval:integration -- --target claude:claude/haiku --suite all

# Against a running Peer server
npm run verify:modes -- --runtime claude --model claude/haiku
npm run validate:collab -- --runtime claude --model claude/haiku
```

`npm run verify:peer` runs deterministic checks and an independent Codex review in an isolated snapshot. It requires an available Codex reviewer and uses model quota. Reports are written under `.peer-dev/verify/`; the command does not commit, push, or merge.

## Packaging

Build on the target operating system with the matching OpenCode binary. For example:

```bash
# macOS Apple Silicon
node scripts/fetch-opencode.mjs --target mac-arm64
npm run build
npx electron-builder --mac --arm64 --publish never

# Linux x64
node scripts/fetch-opencode.mjs --target linux-x64
npm run build
npx electron-builder --linux --x64 --publish never
```

Other runtime targets are `mac-x64` and `linux-arm64`. Installers are written to `release/`: DMG and ZIP for macOS, AppImage and DEB for Linux.

Run `npm run smoke:packaged` to check the packaged app; use `xvfb-run -a npm run smoke:packaged` on a headless Linux host. Signing and notarization configuration lives in [electron-builder.yml](electron-builder.yml) and the [distribution guide](docs/architecture.md#distribution).

[CI](.github/workflows/ci.yml) checks the project and packages and smoke-tests all four platform targets. Installer artifacts are uploaded on manual workflow runs.

## Further reading

- [Product and collaboration model](PEER.md) — modes, controls, detected decisions, and runtime guarantees.
- [Architecture](docs/architecture.md) — local services, runtime adapters, persistence, and distribution.
- [Roadmap](docs/roadmap.md) — current scope, deferred work, and open questions.
- [CLI proof notes](docs/cli-proof.md) — runtime integration evidence and limitations.

## License

This repository is currently marked `UNLICENSED` in `package.json`; no open-source license is provided.
