# Peer

AI coding that makes developers better, not just faster.

Peer is a desktop coding workspace (macOS and Linux) that drives a real coding agent through a **collaboration engine**. The agent can be the bundled [OpenCode](https://github.com/anomalyco/opencode) runtime, or the **Claude Code** or **Codex** CLI you already have installed and logged in (connected the way [T3 Code](https://github.com/pingdotgg/t3code) does it: the CLI runs as a subprocess behind an adapter). You choose how you want to work: **Focus** (execute), **Collaborate** (work like a teammate) or **Learn** (build understanding). Peer decides when the agent should act, ask, explain, or wait for you, and it enforces those decisions in application state. It does not rely on prompting alone.

- Product and behavior: [PEER.md](PEER.md)
- How it works: [docs/architecture.md](docs/architecture.md)
- What's next: [docs/roadmap.md](docs/roadmap.md)

## Requirements

- macOS 12+ (Apple Silicon or Intel) or Linux (x86_64 or arm64, glibc)
- Node.js 22.13+ and npm (development only)
- Network access for a model provider. Peer bundles a pinned OpenCode runtime (1.19.3) and uses your existing OpenCode setup:
  - With no configuration, OpenCode's free `opencode/*` models work out of the box.
  - For other providers, run `opencode auth login` (Peer reuses `~/.local/share/opencode/auth.json`) or configure providers in `~/.config/opencode/opencode.json`. Then use **Restart runtime** in Peer or relaunch it.
- Optional, to use them as the agent:
  - **Claude Code**: install it and run `claude auth login`. Peer drives it through the Claude Agent SDK (0.3.308, matching Claude Code 2.1.x) with your login, settings, CLAUDE.md files and MCP servers.
  - **Codex**: install the Codex CLI and run `codex login`. Peer drives `codex app-server` (tested with 0.163.0) with your login and `~/.codex` config.

  Peer finds `claude` and `codex` on your login shell's `PATH` (override with `PEER_CLAUDE_BIN` / `PEER_CODEX_BIN`) and never logs in for you. A runtime that is missing or logged out shows as unavailable, with what to do.

## Run it

```bash
npm install          # also downloads the OpenCode runtime for your platform into vendor/
npm start            # build and launch the desktop app
```

Development with hot-reloading UI:

```bash
npm run dev          # Vite dev server + Electron
```

Headless (browser UI, used for Linux servers and scripted checks):

```bash
npm run server       # prints a URL with an access token, e.g. http://127.0.0.1:4317/?api=…#token=…
```

Data lives in `~/Library/Application Support/Peer` (macOS) or `~/.config/Peer` (Linux); override it with `PEER_DATA_DIR`. Other environment variables: `PEER_PORT` (headless port, default 4317) and `PEER_OPENCODE_BIN` (use a different runtime binary).

## Using Peer

1. **Open project…** and choose a folder. The agent cannot touch files outside the folders you choose.
2. Pick the agent next to **+ New session** (OpenCode, Claude Code or Codex) and click it. Peer remembers your choice. A session stays on its runtime; the model list under the prompt is that runtime's. New sessions use Collaborate unless you change the default.
3. Pick a mode next to the prompt. You can switch at any time; the change applies to your next message, and the conversation continues.
4. One-shot controls under the prompt (or slash commands):
   - **Just do it** (`/go`)
   - **Discuss first** (`/discuss`)
   - **Hint** (`/hint`)
   - **Direct answer** (`/answer`)
5. When the agent brings you a decision, answer it in the card (or just type in the composer). You can also pick an option, ask for a hint, use **You decide**, or use **Skip to implementation**.
6. Permission requests (destructive commands and the like) appear as cards in every mode. **Stop** interrupts the agent at any time.

## Checks

```bash
npm run check                  # typecheck + unit tests + build
npm run verify:peer            # independent verification of the current change: checks + a Codex review (see below)
npm run smoke                  # dev Electron smoke test (runtime, plugin, API, persistence, renderer)

# Real agent runs (spend model quota; an explicit --model is required):
npm run eval:integration -- --target claude:claude/haiku [--target codex:codex/gpt-6-luna] [--suite collab|modes|all] [--confirm]
npm run verify:modes -- --runtime claude --model claude/haiku     # against a running `npm run server`
npm run validate:collab -- --runtime claude --model claude/haiku  # adaptive asks, checkpoint pauses, Learn misconceptions
```

`eval:integration`, `verify:modes`, `validate:collab` and `PEER_SMOKE_LLM=1` use a real model and network. They are never simulated. `eval:integration` starts its own server and only prints its plan until you add `--confirm`.

**Independent verification.** Claude implements, deterministic checks run, the real Codex CLI tries to prove the change wrong in an isolated sandbox, Claude responds to each finding (at most two repair cycles), and a human decides. See [docs/verification.md](docs/verification.md). Nothing in it commits, pushes or merges.

## Packaging

The runtime binary is per platform, so build one target at a time:

```bash
node scripts/fetch-opencode.mjs --target mac-arm64     # mac-x64 | linux-x64 | linux-arm64
npm run build
npx electron-builder --mac --arm64 --publish never     # → release/*.dmg, *.zip
npx electron-builder --linux --x64 --publish never     # → release/*.AppImage, *.deb
node scripts/smoke-packaged.mjs                        # smoke-test the packaged app (Linux: wrap in xvfb-run -a)
```

**Signing and notarization.** For macOS, electron-builder signs when `CSC_LINK`/`CSC_KEY_PASSWORD` (or a keychain identity) are set. It notarizes when App Store Connect API key variables (`APPLE_API_KEY`, `APPLE_API_KEY_ID`, `APPLE_API_ISSUER`) or Apple ID variables are set. For an unsigned local build, use `CSC_IDENTITY_AUTO_DISCOVERY=false … -c.mac.identity=null`.

CI (`.github/workflows/ci.yml`) runs checks, then packages and smoke-tests the **packaged** app natively on macOS arm64, macOS x64, Linux x64 and Linux arm64. On Linux it smoke-tests the unpacked app, the AppImage, and the installed `.deb`. Signing secrets are listed in [docs/architecture.md](docs/architecture.md#distribution).
