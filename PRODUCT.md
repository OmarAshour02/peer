# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Users

Two co-primary audiences; neither wins when they conflict:

- Experienced developers who already drive coding agents (Claude Code, Codex, OpenCode) daily and want to stay in control and stay sharp while the agent does the work — served mainly by Collaborate mode.
- Developers learning while shipping real work, whose job is to grow into stronger engineers without stopping delivery — served mainly by Learn mode.

Both work at a desk, in a desktop workspace, on their own codebases, in sessions that mix discussion, decisions, and code changes.

## Product Purpose

Peer is a coding workspace with a collaboration layer. A full coding agent does the work, but on every turn Peer decides whether the agent should execute, discuss, challenge, explain, or let the human lead — and enforces that decision in application state rather than relying on prompting alone.

Success means: tedious work is automated, meaningful work stays collaborative, and the developer's own thinking — and growth — is preserved instead of being quietly replaced by the agent. It is a product intended for other developers to use, not only a personal tool.

## Positioning

Coding agents optimize for finishing tasks; Peer optimizes for the developer the tasks were supposed to build. Its mechanism is an enforced collaboration engine between the developer and whichever agent runtime they already use: gated code changes, blocking checkpoints, and decisions Peer detects itself (new dependencies, public API changes, a task outgrowing its agreed size) are held before they run on every runtime that exposes a gate (OpenCode, Claude Code, and Codex — with the documented exceptions in PEER.md: Gemini CLI is read-only, and Codex MCP calls are detected after the fact, not prevented). No neighboring agent client can truthfully copy that claim today: they prompt for this behavior; Peer enforces it where enforcement exists.

## Operating Context

- A desktop app (Electron shell, web UI) for macOS and Linux, also runnable headless. The developer picks a workspace (a local project directory) and works in sessions bound to one agent runtime each.
- Runtimes: OpenCode (bundled, pinned), or the developer's own Claude Code, Codex, or Gemini CLI installs and logins, driven as subprocesses behind adapters. Peer never logs in for the developer and never receives their credentials in the UI.
- The unit of work is a turn: a developer message (optionally with a control — Just do it, Discuss first, Give me a hint, Direct answer) that the engine plans under the session's mode, gates, and history.
- Everything is local: the API binds to 127.0.0.1, history lives in a local SQLite store, and cross-session memory is derived from that local history.

## Capabilities and Constraints

Confirmed capabilities (see PEER.md for the binding specification):

- Two modes, Collaborate (default) and Learn, with temporary per-task controls; the retired Focus mode still works for existing sessions.
- Enforced gates: code changes lock in Learn until the developer engages (a go-ahead on a confirm checkpoint does not count), and under Discuss first / hint turns in any mode. Safety permissions (destructive commands, outside-workspace access) are separate and always apply.
- Peer-detected decisions — adding a dependency, changing a public API contract, and (opt-in, Collaborate) a task's edits passing five files — pause the tool call before it runs.
- Adaptive involvement: a per-turn question ceiling, narrowing after hands-off responses, no repeated questions, and cross-session memory (tendency and mode/model habits, on by default, local, resettable). Answers, decisions, and topics are not remembered across sessions.
- Undo that reverts a turn's files and truncates the CLI conversation where the runtime supports it.

Constraints future work must preserve:

- Detection reads tool-call arguments and manifests; it does not see shell-driven or generated changes, and a missed detection never blocks on a guess.
- Gemini CLI is read-only in Peer until individual commands can pass Peer's gates; Codex MCP calls cannot yet be blocked before they run (a locked turn aborts instead).
- No fabricated learning data: every future learning feature must trace back to a real conversation or diff (see docs/roadmap.md, Learning Space guardrails).

## Brand Commitments

- Name: Peer. Tagline: "AI coding that makes developers better, not just faster."
- Philosophy, verbatim from PEER.md: "Automate tedious work. Collaborate on meaningful work. Preserve the thinking that makes developers grow."
- Voice: no sycophancy, no praise by default, challenge assumptions only with concrete evidence, respect the developer's expertise. This governs agent behavior and product copy alike.

## Evidence on Hand

- Product and behavior specification: PEER.md. Architecture: docs/architecture.md. Roadmap and deferred decisions: docs/roadmap.md. CLI proof notes: docs/cli-proof.md.
- Verification evidence: the deterministic test suite and the independent Codex review loop (docs/verification.md), with run reports under .peer-dev/verify/runs/.
- There are no testimonials, named customers, benchmarks, or usage metrics on hand. Future work must not fabricate them.

## Product Principles

1. Automate tedious work; collaborate on meaningful work; preserve the thinking that makes developers grow.
2. Higher collaboration means more meaningful human involvement, not more messages.
3. Consequential decisions belong to the human; mechanical work does not need them.
4. Enforcement over guidance: what Peer promises, Peer enforces in application state — and it says plainly which parts are only guidance.
5. Safety is separate from collaboration: no mode or control ever bypasses a permission or destructive-command approval.

## Accessibility & Inclusion

Keyboard-first is the bar: new UI work must be fully keyboard-operable. No formal visual standard (such as WCAG AA) has been committed yet; readable contrast and visible focus remain expected good practice, and a formal standard is an explicitly open decision.
