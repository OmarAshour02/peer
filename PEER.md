# Peer: product and collaboration model

## Philosophy

Coding agents optimize for finishing tasks. That is useful, but it can disconnect developers from the problems they are solving. Peer is built on a different premise:

> **Automate tedious work. Collaborate on meaningful work. Preserve the thinking that makes developers grow.**

Peer is not a tutor, a quiz app, or a coding agent with a different system prompt. It is a coding workspace with a collaboration layer that decides, on every turn, whether the agent should **execute, discuss, challenge, explain, or let the human lead**. The agent behind it is a full coding agent in every mode.

**Higher collaboration means more meaningful human involvement, not more messages.**

## The three modes

| | Focus | Collaborate (default) | Learn |
|---|---|---|---|
| For | You know what you want; you want it done | You want an engineering teammate | You want to understand, and to grow |
| Questions the developer decides | architecture, ambiguous requirements, risk | + trade-offs, go-ahead on plans | + your hypothesis, concept checks |
| Checkpoints per turn (risk exempt) | 1 | 3 | 4 |
| Code changes at the start of a new task | allowed | allowed (agent discusses significant work first) | **locked until you engage** |
| Hints | on request | on request | offered on every question |

**Focus** works autonomously. It interrupts only for significant uncertainty, risky operations and architectural decisions, verifies its work, and summarizes trade-offs. If it tries to ask you about anything else, such as a stylistic trade-off, Peer declines the question and tells the agent to decide and report the decision in its summary.

**Collaborate** behaves like an experienced engineer. It explores first, proposes an approach with real alternatives and trade-offs, challenges questionable assumptions, and agrees on important decisions before significant implementation. It proceeds on routine work without asking.

**Learn** invites you to form a hypothesis or make the key decision before it hands over a solution. It asks one question grounded in *this* codebase, offers progressive hints, and helps you diagnose errors instead of silently fixing them. It still automates boilerplate, never forces a lesson on you, and moves on whenever you say so.

## Shared principles (all modes)

- No sycophancy. No agreeing just to please, and no manufactured disagreement.
- Challenge assumptions when there is a substantive reason, and give the reason.
- Respect the developer's expertise. Ask only questions whose answers change the outcome.
- Consequential decisions belong to the human; mechanical work does not need them.
- The developer can always delegate (**Just do it** / **You decide**), skip a discussion (**Skip to implementation**), ask for a **Hint**, or demand a **Direct answer**.
- **Safety is separate from collaboration.** Destructive commands (`rm`, `git push`, `git reset --hard`, `sudo`, …) always ask for permission, and access outside the chosen workspace is denied. This holds in every mode; Focus never bypasses it.

## What is enforced and what is guidance

Peer is explicit about this distinction.

**Enforced by Peer** (application state plus runtime hooks; the agent cannot bypass these):
- A checkpoint the agent opens **blocks the agent** until the developer responds. Checkpoints are stored, so they survive UI reconnects. If Peer or the runtime restarts, an open checkpoint becomes *interrupted*, and answering it resumes the work in the same conversation.
- While a checkpoint is open, **code changes are locked** in every mode.
- In **Learn**, code changes (edits and any non-read-only shell command) are **locked at the start of each new task** until the developer engages. Engaging means answering or choosing in a checkpoint, delegating, skipping, or simply replying. Reading and exploring the code stays allowed.
- **Discuss first** and **Hint** lock code changes for the turn; **Skip to implementation** releases them.
- **Which questions reach the developer** is decided by policy: per-mode categories and a per-turn budget. Declined questions are recorded and shown in the transcript.
- The safety permission rules above.

**Per runtime**, the same rules are wired into each agent's own control points:

| | OpenCode (bundled) | Claude Code | Codex |
|---|---|---|---|
| Gate on tool calls | Peer plugin, `tool.execute.before` | Peer `PreToolUse` hook (subagents included) | Peer is Codex's approver (approval policy `untrusted`): commands and file changes it doesn't consider safe come to Peer, which declines them while the gate is locked. Turns that start gated also run in Codex's **read-only sandbox**, so the OS blocks writes too. Codex fixes the sandbox for a whole turn, so when you engage mid-turn Peer ends that turn and continues the work in a new turn with write access |
| Checkpoints | plugin tool `peer_checkpoint` | in-process MCP tool `mcp__peer__checkpoint` | client-side ("dynamic") tool `peer_checkpoint` |
| Destructive commands | OpenCode permission rules (ask) | hook forces an approval → Peer permission card | Peer sends them to the developer as a permission card |
| Other approvals | OpenCode's own rules | Claude Code's own permission rules and modes (edits inside the workspace are pre-approved, like in the other runtimes); its prompts become Peer permission cards | Peer approves plain in-workspace commands and edits; network access, sandbox escalation, writes outside the workspace and permission requests go to the developer |
| Per-turn policy | `system` prompt per message | appended to Claude Code's system prompt per turn | sent as a tagged block with each message (Codex only takes instructions per thread) |
| Runtime's own question tool | disabled | `AskUserQuestion` disabled | `request_user_input` refused |

Known gaps:
- **Codex MCP tools** (from your `~/.codex` config) run without asking Codex's client, so Peer cannot block one beforehand. If one that isn't marked read-only starts while code changes are locked, Peer stops the turn and says why. That is detection after the fact, not prevention. On OpenCode and Claude Code, MCP tools go through the gate like any other tool.
- Hooks from your own Claude Code settings run as you configured them.
- Codex's dynamic tools (used for checkpoints) are part of its experimental app-server API.
- **Codex's sandbox has no network**, which also blocks tests that open a local port (`listen EPERM`). Peer tells Codex to rerun such tests with escalated permissions, which reach you as a permission card. That is guidance: a model can skip the tests instead, and small models sometimes do. Codex's experimental network proxy can allow local binding, but Peer does not depend on it.

**Guidance** (per-turn instructions the agent receives; good models follow them, but nothing forces them):
- Whether Collaborate actually proposes an approach before a significant change (the gate is open in Collaborate).
- The quality of questions. The Learn gate guarantees the developer engages before code changes; it cannot force the agent to ask a *good* question. In testing, the agent sometimes used a one-click "go-ahead" checkpoint where a hypothesis question would have taught more.
- Tone, depth of explanation, and how hints are phrased.
