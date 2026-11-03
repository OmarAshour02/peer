# Peer: product and collaboration model

## Philosophy

Coding agents optimize for finishing tasks. That is useful, but it can disconnect developers from the problems they are solving. Peer is built on a different premise:

> **Automate tedious work. Collaborate on meaningful work. Preserve the thinking that makes developers grow.**

Peer is not a tutor, a quiz app, or a coding agent with a different system prompt. It is a coding workspace with a collaboration layer that decides, on every turn, whether the agent should **execute, discuss, challenge, explain, or let the human lead**. The agent behind it is a full coding agent in every mode.

**Higher collaboration means more meaningful human involvement, not more messages.**

## The two modes

| | Collaborate (default) | Learn |
|---|---|---|
| For | You want an engineering teammate | You want to understand the work, and to grow |
| The agent involves you in | architecture, trade-offs, ambiguous requirements, risk, go-ahead on plans | + your hypothesis, and the concept the task depends on |
| Code changes at the start of a task | allowed | **locked until you engage**, or until the agent says the work is routine |
| Controls | **Just do it**, **Discuss first** | **Give me a hint**, **Direct answer** |
| New dependencies (Peer detects them itself) | Peer pauses and asks: add it or not | Peer pauses and asks for your reasoning first |
| Public API changes (Peer detects them itself) | Peer pauses and asks: change it or not | Peer pauses and asks for your reasoning first |

**Collaborate** works like an experienced engineer pairing with you. It decides the things that shape the result with you (architecture, data model, public interfaces, new dependencies, real trade-offs): it explores first, proposes a concrete approach with the alternative it would not take, and says what it recommends. It challenges assumptions when it has a concrete reason, including your diagnosis of a bug, and shows the evidence. It does mechanical work (renames, boilerplate, wiring, obvious fixes, tests for agreed behavior) without asking, and doesn't re-ask what was agreed.

**Learn** keeps you thinking while the task still gets done. At the meaningful part of a task (its key decision, the cause of a bug, the concept it depends on) it asks for your hypothesis or decision, grounded in this codebase, and responds to your reasoning honestly: it names a misconception plainly, without praise by default. It guides progressively, hint by hint, gives the full answer when you ask, and does boilerplate and routine follow-ups normally instead of turning them into lessons.

**Focus** (the autonomous mode of earlier versions) is retired: Collaborate with **Just do it** covers it. Sessions created with Focus keep working and show it as retired, the API still accepts it, and new sessions never default to it.

### Controls

Each mode has two controls, in the composer and on the agent's questions. They are temporary: the mode never changes, and the next task gets the mode's normal behavior. They work the same on every runtime, because Peer applies them in its own engine.

| Control | Pressed with a message | Pressed on the agent's question | Lasts |
|---|---|---|---|
| **Just do it** (Collaborate) | The agent does the task without optional questions or discussion | The agent goes ahead with its recommendation and asks nothing optional for the rest of the task | The task (the turn, and a Codex continuation of it) |
| **Discuss first** (Collaborate) | The agent explores the approach and trade-offs; code changes are locked | Code changes lock again for the rest of the turn; the agent discusses | Until you proceed: **Proceed**, **Just do it**, a message that only says go ahead ("go ahead", "OK, proceed", "ship it"), a mode switch, or **End discussion**. Any other message continues the discussion |
| **Give me a hint** (Learn) | One hint, no code changes in that turn. Hints in a row are numbered, and each goes a step further | One hint, then the agent asks again | One response |
| **Direct answer** (Learn) | The answer directly, no questions back | The agent answers its own question and asks no more Socratic ones; the Learn lock opens | The task |

What they never change: risk questions still reach you under **Just do it**, permission prompts and destructive-command approvals are unchanged, **Stop** still cancels open questions and held tool calls. On a question, **You decide** hands over just that one decision. Slash commands do the same: `/go`, `/discuss`, `/hint`, `/answer`, `/proceed`.

### Involvement adapts; it is not a quota

The agent is told to decide per decision, not per turn: bring one to you only when the answer changes what gets built, you haven't decided it already, and it can't settle it from the code; weigh how complex and ambiguous the task is and whether the work is mechanical; ask less when you delegate or give short go-aheads. Peer backs this with deterministic rules of its own:

- **A ceiling, not a target.** Peer declines questions beyond three in a turn (risk questions excluded), and tells the agent that this is a ceiling. The declined question shows in the transcript and the agent decides.
- **It follows your responses.** After your last two responses handed decisions back (**Just do it**, **You decide**, **Direct answer**), fewer kinds of questions reach you: trade-offs and go-aheads in Collaborate, concept checks and go-aheads in Learn, with one question at most. Answering in your own words, choosing an option, discussing, asking for a hint or proceeding after a discussion restores the default. With cross-session memory on (the default), the last two responses count across sessions too, from your recent history (the last 20 responses since your last reset), so a new session can start already narrowed. Turn memory off in settings and every session starts fresh, as before.
- **No repeats.** The decisions you made earlier in the session go to the agent with every message. If it asks a question you already answered in the same task (the same message and its Codex continuation; same wording, ignoring case and punctuation), Peer doesn't ask you again; the agent gets your earlier answer. In a new task the same words may be about a different decision, so they reach you. A question asked again after a hint is the hint loop, and risk questions are always asked.
- **Routine work in Learn.** When the work is purely mechanical (a rename, formatting, boilerplate that copies an existing pattern, tests or docs for behavior you already agreed to), the agent says so, and Peer unlocks code changes without asking you. A feature, a fix or a design choice is never routine. You see "Routine work, no question asked" in the transcript, with **Not routine, ask me** while that task runs: it locks code changes again, Peer refuses further routine claims in that task, and the agent has to ask you. Routine work can't unlock **Discuss first** or a hint turn.
- **What Peer remembers across sessions.** With cross-session memory on, Peer also preselects your recent habits in a new session: your last-used mode, and the last model you used on that session's runtime (the last-picked runtime already worked this way). An explicit choice when creating the session, and a default mode set through the API, always win. Peer remembers nothing else across sessions: not your answers, decisions, or topics. Everything is derived from history Peer already stores on your machine, only from after your last reset; settings has the on/off switch and **Reset what Peer remembers**.

## Decisions Peer detects itself

Whether the agent asks you something depends on the model, and models often don't. For a few consequential decisions, Peer doesn't wait to be asked: it recognizes them in the agent's tool call **before the call runs**, pauses the agent, and brings the decision to you. Today that is **changing a public API** (below) and **adding a new dependency**:

- an install command that names packages: `npm`/`pnpm`/`yarn`/`bun` add or install, `pip install`, `uv add`, `poetry add`, `cargo add`, `go get`;
- an edit, write or patch that adds an entry to a `package.json` dependency section or a `requirements*.txt` file.

How Peer involves you depends on the mode. **Collaborate** asks "Add it / Don't add it". **Learn** asks what you think the task needs it for, and the agent responds to your reasoning before it continues. **Just do it** (and the retired Focus) doesn't interrupt: the decision shows in the transcript as noted. A task sent with **Direct answer** asks with add it / don't add it rather than a reasoning question.

What you decide is applied:
- **Add it**, **You decide**, **Just do it**: the call runs (with **Just do it**, later dependencies in the task are noted, not asked).
- **Direct answer** (Learn): the call doesn't run yet; the agent explains why the task needs the package, and its retry runs without asking again.
- **Discuss first**: the call doesn't run; code changes stay locked while you discuss it, and Peer asks again if the agent retries after you proceed.
- **Don't add it**: the call doesn't run, and later attempts to add the same package in this session are rejected without asking you again.
- An answer in your own words: the call doesn't run yet; the agent gets your words, and if it then retries, the retry runs without asking again. Whether the agent follows your words is up to the agent.
- A hint (Learn): the held call does not run; the agent gives one, then Peer asks again when it retries. This is a hint about that dependency decision; the task-wide hint hold applies to the agent's own questions.

Peer doesn't ask about what you already decided. An option you picked, or a plan you approved that asks for the package, counts. So does an unambiguous request in your own message or answer: an English sentence that opens with the request ("Add `zod`", "Please use the pino library", "Replace moment with `dayjs`") and names the package so it can only be a package (as code or in quotes, followed by "package"/"library", or a package-shaped name like `date-fns`). Anything else is not approval, and Peer asks once: a plain word ("add debug logging", "add zod"), a statement ("we use httpx elsewhere"), a question ("why is lodash here?", "can we add lodash?"), a pasted command or log (a message with a fenced code block, a quoted line, or any line indented by four or more spaces or a tab infers nothing at all), any sentence with a negation, and any message with letters outside A–Z (Peer only recognizes English negations, so it infers nothing from other languages). This is still a heuristic: it is built to miss an approval (and ask) rather than invent one, but an unusual sentence that fits the request pattern could be misread. Neither does it ask about mechanical installs: `npm install` or `npm ci` without package names, packages the manifest already declares, global installs, `npx`-style one-off runs, or edits to scripts, versions and other fields. These questions don't count toward the agent's question ceiling.

**Limits.** Detection reads the tool call's arguments and the manifest on disk. Manifests are parsed, never executed: `package.json` and requirements files fully, `pyproject.toml` and `Pipfile` as TOML, `setup.cfg` as INI, and `setup.py` only where a declaration is a literal list or dict. Anything Peer cannot read with confidence (invalid syntax, `install_requires=read_reqs()`, `file:` includes) declares nothing, so Peer asks. It does not see a manifest changed indirectly (a script, a code generator, `node -e`), packages installed by a command it doesn't recognize, or Codex commands your own Codex rules allow without asking Peer. It checks the manifest where the command runs (`cd`, `--prefix` and similar, OpenCode's working directory, Codex's); Claude Code's shell keeps its directory between commands without reporting it, so there Peer assumes the workspace root unless the command itself changes directory. A missed detection means Peer doesn't ask; it never blocks anything on a guess. Consequential configuration changes are not detected yet.

**Public API changes.** Peer pauses before an edit, write or patch changes something other code relies on: an OpenAPI or Swagger spec (`openapi.yaml`, `api.swagger.json`), a `.proto` file, a GraphQL schema (`*.graphqls`, `schema.graphql`, or a `.graphql`/`.gql` file in a `schema/` or `schemas/` folder), or `exports` or `bin` in `package.json`. Creating, deleting or renaming a spec file counts. **Collaborate** asks "Change it / Don't change it". **Learn** asks why the task needs the API to change and what it could break. **Just do it** (and the retired Focus) notes it in the transcript. Your response applies as it does for a dependency, with one difference: it lasts for the task (your message and its continuations), per file or field, because approving one API change is not approving the next. **Don't change it** rejects further attempts in that task; a new message starts fresh, and Peer asks again. Your own words never count as approval here: if you ask for a change to `openapi.yaml`, Peer still asks once. One call that also adds a dependency asks about both, one at a time: the agent retries after each approval, and if it doesn't, nothing runs.

**Limits of API detection.** Spec files are recognized by name and location; Peer doesn't read them, so an OpenAPI spec named `docs/api.yaml` isn't recognized, and a comment fix in a recognized one still asks. Only `package.json` is parsed, and only `exports` and `bin` are compared (`main`, `types` and the like aren't). Files under `node_modules`, `vendor`, `third_party`, `dist`, `build`, `target`, `generated`, test folders, `fixtures` and `examples` don't count. **An API defined only in code**, such as an Express route with no spec file, isn't detected. Neither are **indirect changes**: a shell command, script or code generator that rewrites a spec. For these, it depends on the model asking.

**Approach gate (Collaborate, opt-in).** A session can turn on the **Approach gate** (session header, off by default). Peer then counts the distinct files a task's edit, write and patch calls target, from their arguments, before they run. The first five files edit freely; the call that would pass five is paused before it runs and Peer asks "Continue with the changes / Stop here". Continuing approves the rest of the task's edits; stopping denies that call and further edit calls in the task, and a new task asks again. **Just do it**, Proceed and Direct answer tasks are not interrupted, and detected dependency or contract decisions on the same call are asked first. Counting only sees file tools: changes a shell command makes name no files Peer can see and are not counted. This is a collaboration gate, not a safety boundary.

## Shared principles (all modes)

- No sycophancy. No agreeing just to please, and no manufactured disagreement.
- Challenge assumptions when there is a substantive reason, and give the reason.
- Respect the developer's expertise. Ask only questions whose answers change the outcome.
- Consequential decisions belong to the human; mechanical work does not need them.
- The developer can always take over the pace: **Just do it** or **Discuss first** in Collaborate, **Give me a hint** or **Direct answer** in Learn, **You decide** on any question.
- **Safety is separate from collaboration.** Destructive commands (`rm`, `git push`, `git reset --hard`, `sudo`, …) always ask for permission. Access outside the chosen workspace is denied on OpenCode and asks you on Claude Code and Codex; with **Auto approvals** on, Claude Code's classifier may approve it without asking. This holds in every mode and with every control; **Just do it** never bypasses it.

## What is enforced and what is guidance

Peer is explicit about this distinction.

**Enforced by Peer** (application state plus runtime hooks; the agent cannot bypass these):
- A checkpoint the agent opens **blocks the agent** until the developer responds. Checkpoints are stored, so they survive UI reconnects. If Peer or the runtime restarts, an open checkpoint becomes *interrupted*, and answering it resumes the work in the same conversation.
- While a checkpoint is open, **code changes are locked** in every mode.
- In **Learn**, code changes (edits and any non-read-only shell command) are **locked at the start of each new task** until the developer engages: answering or choosing in a checkpoint, **You decide**, **Just do it**, **Direct answer**, or simply replying. One exception: answering or choosing on a **confirm** checkpoint (a go-ahead on a plan) approves the plan but does not unlock, live or on a resumed turn; the explicit controls on it (**You decide**, **Just do it**, **Direct answer**, Proceed) still do. A hint or a wish to discuss doesn't unlock. The agent can also unlock it by declaring the work routine (see above). Reading and exploring the code stays allowed.
- **Discuss first** locks code changes until the developer proceeds, across follow-up messages; on a question mid-turn it locks them again for the rest of the turn. **Give me a hint** locks them for its turn.
- **The controls' scope**: **Just do it** and **Direct answer** change the rules for the rest of the task (including a Codex continuation); the session's mode never changes.
- **Which questions reach the developer** is decided by policy: per-mode categories, a per-turn ceiling, the controls in effect, the developer's recent responses in this session, and repeats of answered questions. Declined questions are recorded and shown in the transcript.
- **Decisions Peer detects** (new dependencies and public API changes, and a Collaborate task passing the approach-gate threshold when that gate is on, see above) hold the tool call before it runs until you respond, on every code-changing runtime (OpenCode, Claude Code and Codex). Gemini CLI is read-only in Peer, so it cannot make such a change. Stop cancels the held call (it doesn't run); after a restart, answering resumes the work with your decision recorded. On Claude Code, the command may still show Claude Code's own permission prompt afterwards: Peer doesn't override your Claude Code permission rules. On Codex, which only tells the model "declined", Peer adds your response to the running turn.
- The safety permission rules above.

**Per runtime**, the same rules are wired into each agent's own control points:

| | OpenCode (bundled) | Claude Code | Codex | Gemini CLI |
|---|---|---|---|---|
| Gate on tool calls | Peer plugin, `tool.execute.before` | Peer `PreToolUse` hook (subagents included) | Peer is Codex's approver (approval policy `untrusted`): commands and file changes it doesn't consider safe come to Peer, which declines them while the gate is locked. Turns that start gated also run in Codex's **read-only sandbox**, so the OS blocks writes too. Codex fixes the sandbox for a whole turn, so when you engage mid-turn Peer ends that turn and continues the work in a new turn with write access | No per-call gate. Every turn runs with the CLI's read-only `--approval-mode plan`, so proposed changes are not applied |
| Checkpoints | plugin tool `peer_checkpoint` | in-process MCP tool `mcp__peer__checkpoint` | client-side ("dynamic") tool `peer_checkpoint` | None. The model asks in reply text (`QUESTION:`), which is guidance, not a blocking checkpoint |
| Destructive commands | OpenCode permission rules (ask) | hook forces an approval → Peer permission card | Peer sends them to the developer as a permission card | Cannot run. Peer keeps Gemini read-only until individual commands can go through this gate |
| Other approvals | OpenCode's own rules | Claude Code's own permission rules and modes (edits inside the workspace are pre-approved, like in the other runtimes); its prompts become Peer permission cards. "Always allow" keeps what Claude Code grants for its session for the whole Peer session, and the card shows what it saves. **Auto approvals** (per session, off by default): Claude Code's auto mode, whose classifier settles prompts and asks only when unsure | Peer approves plain in-workspace commands and edits; network access, sandbox escalation, writes outside the workspace and permission requests go to the developer | None |
| Per-turn policy | `system` prompt per message | sent as a tagged block with each message (a resumed Claude Code session keeps the system prompt of its first query, so a per-turn `append` would never change) | sent as a tagged block with each message (Codex only takes instructions per thread) | prepended as a tagged block to each headless prompt |
| Runtime's own question tool | disabled | `AskUserQuestion` disabled | `request_user_input` refused | None; questions are reply text |

Known gaps:
- **Gemini CLI** is read-only in Peer. Peer cannot approve individual Gemini commands, so it disables writable turns instead of running them under the CLI's `yolo` approvals. Gemini has no Peer checkpoint tool, detected-decision gate or permission cards; its questions are reply text, not blocking checkpoints, and controls that depend on those mechanisms are guidance there.
- **Codex MCP tools** (from your `~/.codex` config) run without asking Codex's client, so Peer cannot block one beforehand. If one that isn't marked read-only starts while code changes are locked, Peer stops the turn and says why. That is detection after the fact, not prevention. On OpenCode and Claude Code, MCP tools go through the gate like any other tool.
- Hooks from your own Claude Code settings run as you configured them.
- Codex's dynamic tools (used for checkpoints) are part of its experimental app-server API.
- **Codex's sandbox has no network**, which also blocks tests that open a local port (`listen EPERM`). Peer tells Codex to rerun such tests with escalated permissions, which reach you as a permission card. That is guidance: a model can skip the tests instead, and small models sometimes do. When a command fails this way and is not rerun successfully in the same turn, Peer marks the turn "Not verified" in the transcript, so you see it instead of trusting the summary. It does the same when Codex changes code (with its edit tool or through shell commands; Peer compares snapshots of the workspace) and runs no tests after its last change. A test run counts only when Peer let it run and its output shows test results. That is detection after the fact, built on heuristics: it recognizes common socket errors (`listen EPERM`, `bind: operation not permitted`) and common test runners (`npm test`, `node --test`, `pytest`, `go test`, ...), and changes that only touch docs don't count. Codex's experimental network proxy can allow local binding, but Peer does not depend on it.

**Guidance** (per-turn instructions the agent receives; good models follow them, but nothing forces them):
- Whether Collaborate actually proposes an approach before a significant change (the gate is open in Collaborate), and whether it challenges a wrong assumption.
- The quality of questions. The Learn gate guarantees the developer engages before code changes; it cannot force the agent to ask a *good* question. A one-click "go-ahead" checkpoint no longer opens the gate (see above), but whether the agent then asks a hypothesis question that teaches something is still its judgment.
- **Routine work in Learn** is the agent's judgment. Peer shows it, and limits what it can unlock, but can't tell whether a task really is mechanical.
- What the agent does with a control's instruction: how good a hint is, how direct an answer is, how much it explores while discussing.
- Tone, depth of explanation, and how hints are phrased.
