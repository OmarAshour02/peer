# Peer review guide

Peer is an Electron app that puts a collaboration layer (modes, checkpoints, a gate on code changes) between a developer and a coding agent (OpenCode, Claude Code or Codex). Product rules are in `PEER.md`; architecture is in `docs/architecture.md`.

## What matters most

1. **Gate bypasses.** Anything that lets a mutating tool call, shell command or file change through while the gate is locked (open checkpoint, Learn mode at task start, Discuss first, Hint). Check every runtime adapter (`src/server/runtime/{opencode,claude,codex}`), the OpenCode plugin (`src/plugin/peer-plugin.ts`) and subagent paths.
2. **Tool classification.** `src/server/collaboration/tool-classification.ts` must stay conservative: when unsure, a command is mutating. Flag any change that classifies a write-capable command as read-only.
3. **Safety rules.** Destructive commands (`src/server/collaboration/safety.ts`) must always reach the developer as a permission card, in every mode. Workspace access outside the chosen directory must be denied.
4. **Checkpoint lifecycle.** Checkpoints must survive reconnects and restarts (interrupted → resumable), never resolve twice, and never leave a turn blocked forever.
5. **Security.** Everything binds to `127.0.0.1`; the API and bridge need their tokens; credentials never reach the renderer; the renderer has no Node access.
6. **Docs drift.** `PEER.md` separates what is *enforced* from what is *guidance*. Flag code changes that make an "enforced" claim untrue, or docs that claim enforcement the code does not provide.

## Conventions

- TypeScript, ESM, Node >= 22.13. SQLite via `node:sqlite` (no native modules).
- The renderer depends only on the HTTP/SSE API, never on the engine.
- Tests use Vitest (`tests/`). A behavior change in the engine or an adapter should come with a test.

## Less important

Skip purely stylistic nits (formatting, naming preferences) unless they hide a bug.
