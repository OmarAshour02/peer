import {
  CHECKPOINT_ACTIONS,
  CHECKPOINT_CATEGORIES,
  NOTHING_TO_UNDO,
  type Checkpoint,
  type CheckpointAction,
  type CheckpointCategory,
  type CheckpointOption,
  type CollaborationModeId,
  type DetectedDecision,
  type GateKind,
  type GateState,
  type PeerEvent,
  type PeerSession,
  type RuntimeKind,
  type SessionRunStatus,
  type Turn,
  type TurnIntent,
  type UndoAvailability,
  type UndoResult,
} from "../../shared/types.js";
import { join, relative } from "node:path";
import type { RuntimeEvent } from "../runtime/adapter.js";
import { changedFiles, restoreFiles, snapshotWorkspace } from "../runtime/git-snapshot.js";
import type { RuntimeSet } from "../runtime/set.js";
import type { Store } from "../store.js";
import { detectContractChange, detectDecision, editTargetPaths, namesApproved, type Detection } from "./decisions.js";
import { isGoAhead, parseIntent } from "./intent.js";
import { INTENT_LABELS, getPolicy, resolveEffectivePolicy, type PolicyContext } from "./policies.js";
import { composeSystemPrompt } from "./prompt.js";
import { isReadOnlyTool } from "./tool-classification.js";

export class EngineError extends Error {
  constructor(
    message: string,
    readonly status: 400 | 404 | 409 = 400,
  ) {
    super(message);
  }
}

/** Arguments the agent passes to the checkpoint tool (validated here, not trusted). */
export interface CheckpointRequest {
  category?: unknown;
  question?: unknown;
  context?: unknown;
  options?: unknown;
  recommendation?: unknown;
}

/**
 * `explain`: the agent must be told the reason (runtimes that only report "declined" to the model,
 * like Codex, send it separately).
 */
export type ToolDecision = { allow: true } | { allow: false; reason: string; explain?: boolean };

/** evaluateTool's answer: a decision, or a checkpoint Peer opened that the call waits on. */
export type ToolCheck = ToolDecision | { wait: string };

/** Options of a Peer-opened "choice" checkpoint. */
export const DECISION_APPROVE = "Add it";
export const DECISION_DECLINE = "Don't add it";
export const CONTRACT_APPROVE = "Change it";
export const CONTRACT_DECLINE = "Don't change it";
export const APPROACH_APPROVE = "Continue with the changes";
export const APPROACH_DECLINE = "Stop here";
/** Distinct files a Collaborate task may edit before the approach gate asks the developer to agree. */
export const APPROACH_GATE_FILE_THRESHOLD = 5;

export type SendResult =
  | { kind: "turn-started"; turn: Turn }
  | { kind: "checkpoint-answered"; checkpoint: Checkpoint };

const EMPTY_INTENT_TEXT: Record<TurnIntent, string> = {
  default: "Continue.",
  delegate: "Go ahead and do it.",
  discuss: "Let's discuss this before changing any code.",
  hint: "Can I have a hint?",
  answer: "Please give me the direct answer.",
  proceed: "Go ahead with the approach we discussed.",
};

/** What a composer control (or slash command) means when it answers an open question. */
const ACTION_FOR_INTENT: Record<TurnIntent, CheckpointAction> = {
  default: "answer",
  delegate: "go",
  discuss: "discuss",
  hint: "hint",
  answer: "direct",
  proceed: "skip",
};

/** The intent a resumed turn carries after the developer answered an interrupted question with a control. */
const RESUME_INTENT: Partial<Record<CheckpointAction, TurnIntent>> = {
  hint: "hint",
  go: "delegate",
  direct: "answer",
  discuss: "discuss",
  skip: "proceed",
};

/** Sent for the developer when Peer continues engaged work in a writable turn (sandboxFixedPerTurn). */
export const CONTINUATION_TEXT = "Code changes are now unlocked. Continue the task from where you stopped and implement what we agreed.";

/** Told to an agent that still has undone turns in its context (Claude Code, Codex). */
export function undoneNote(turns: number): string {
  const which = turns === 1 ? "your previous turn" : `your previous ${turns} turns`;
  return `Undone by the developer: ${which}. Every file change from that work was reverted, so the workspace is back to how it was before it. Treat that work as discarded; do not assume any of it is still in place, and re-read files before relying on them.`;
}

export interface EngineOptions {
  /** Where per-session git snapshot indexes live. Without it, turns are not recorded and cannot be undone. */
  snapshotDir?: string;
}

/**
 * Decides how the developer and the agent work together on each turn:
 * which policy applies, whether code changes are gated, which questions reach the developer,
 * and how a checkpoint is resolved, resumed, or skipped.
 *
 * Enforcement lives here, in application state. Every runtime consults the engine before tool
 * calls and to open/await checkpoints: the OpenCode plugin through the HTTP bridge, the Claude
 * Code and Codex adapters in-process (RuntimeHooks).
 */
export class CollaborationEngine {
  /** Checkpoints whose agent run is alive and blocked on them. */
  private readonly live = new Set<string>();
  private readonly waiters = new Map<string, Set<() => void>>();
  private readonly runStatus = new Map<string, SessionRunStatus>();
  /** Child (subagent) runtime session id -> root runtime session id. */
  private readonly parentCache = new Map<string, string | null>();
  /** Turns that were stopped or failed. They never continue on their own. */
  private readonly stoppedTurns = new Set<string>();
  /** Session id -> turn whose continuation is scheduled. Stop cancels it. */
  private readonly pendingContinuations = new Map<string, string>();
  /** Session id -> its latest workspace snapshot; they share an index file, so they run one at a time. */
  private readonly snapshots = new Map<string, Promise<unknown>>();
  /** Sessions whose last turn is being undone; no turn starts meanwhile. */
  private readonly undoing = new Set<string>();
  /**
   * Session id -> the end of its last turn being recorded. The session counts as busy until then,
   * so nothing the developer does after Peer shows it idle can be mistaken for the agent's work.
   */
  private readonly finishing = new Map<string, Promise<void>>();

  constructor(
    private readonly store: Store,
    private readonly runtimes: RuntimeSet,
    private readonly emit: (event: PeerEvent) => void,
    private readonly opts: EngineOptions = {},
  ) {}

  // ---------------------------------------------------------------------------
  // Lifecycle

  /** On startup nothing is blocked on a checkpoint any more: mark them interrupted. */
  recover() {
    for (const cp of this.store.listCheckpointsByStatus("pending")) {
      this.store.updateCheckpoint(cp.id, "interrupted", null);
      this.store.logEvent(cp.sessionId, "checkpoint.interrupted", { checkpointId: cp.id });
    }
    this.store.db.prepare("UPDATE turns SET ended_at = ? WHERE ended_at IS NULL").run(Date.now());
  }

  /** A runtime process restarted: every in-flight run and checkpoint wait on it is gone. */
  handleRuntimeRestart(kind: RuntimeKind) {
    const affected = (sessionId: string) => this.store.getSession(sessionId)?.runtime === kind;
    for (const id of [...this.live]) {
      const cp = this.store.getCheckpoint(id);
      if (cp && !affected(cp.sessionId)) continue;
      this.live.delete(id);
      for (const wake of [...(this.waiters.get(id) ?? [])]) wake();
      if (cp?.status === "pending") this.emit({ type: "checkpoint.updated", checkpoint: this.store.updateCheckpoint(id, "interrupted", null) });
    }
    for (const cp of this.store.listCheckpointsByStatus("pending")) {
      if (!affected(cp.sessionId)) continue;
      this.emit({ type: "checkpoint.updated", checkpoint: this.store.updateCheckpoint(cp.id, "interrupted", null) });
      this.store.logEvent(cp.sessionId, "checkpoint.interrupted", { checkpointId: cp.id });
    }
    for (const [sessionId, status] of this.runStatus) {
      if (!affected(sessionId) || status === "idle") continue;
      this.runStatus.set(sessionId, "idle");
      this.finishActiveTurn(sessionId);
      this.emit({ type: "session.status", sessionId, status: "idle" });
    }
  }

  handleRuntimeEvent(event: RuntimeEvent) {
    if (event.type === "session.status") {
      const session = this.store.getSessionByRuntimeId(event.sessionId);
      // A turn ends with session.idle (OpenCode reports an idle status just before it); until
      // then the session stays busy, so no new turn can overlap it.
      if (session && !(event.status === "idle" && this.activeTurn(session.id))) this.runStatus.set(session.id, event.status);
    }
    if (event.type === "session.error") {
      const session = this.store.getSessionByRuntimeId(event.sessionId);
      const turn = session ? this.store.latestTurn(session.id) : null;
      if (turn && turn.endedAt === null) this.stoppedTurns.add(turn.id);
    }
    if (event.type === "session.idle") {
      const session = this.store.getSessionByRuntimeId(event.sessionId);
      if (!session) return;
      const ended = this.store.latestTurn(session.id);
      this.runStatus.set(session.id, "idle");
      this.finishActiveTurn(session.id);
      if (ended && ended.endedAt === null) this.continueUnlockedTurn(session.id, ended.id);
    }
    if (event.type === "session.updated" && event.parentId) {
      this.parentCache.set(event.sessionId, event.parentId);
    }
  }

  statusOf(sessionId: string): SessionRunStatus {
    if (this.finishing.has(sessionId)) return "busy";
    return this.runStatus.get(sessionId) ?? "idle";
  }

  /** Resolves once the session's last turn is fully recorded (report idle only after this). */
  settled(sessionId: string): Promise<void> {
    return this.finishing.get(sessionId) ?? Promise.resolve();
  }

  /** The session has a turn that has not ended (the runtime may already say it is idle). */
  hasActiveTurn(sessionId: string): boolean {
    return this.activeTurn(sessionId) !== null;
  }

  // ---------------------------------------------------------------------------
  // Sessions and turns

  /** A mode switch applies from the next message, and ends a "Discuss first" discussion (a temporary override). */
  setMode(sessionId: string, mode: CollaborationModeId): PeerSession {
    const before = this.requireSession(sessionId);
    if (before.mode === mode) return before;
    const session = this.store.updateSession(sessionId, { mode, discussing: false });
    this.store.logEvent(sessionId, "mode.changed", { from: before.mode, to: mode });
    if (before.discussing) this.store.logEvent(sessionId, "discussion.ended", { by: "mode.changed" });
    this.emit({ type: "session.updated", session });
    return session;
  }

  /** Start or end "Discuss first" for the session's next messages. Code already unlocked stays unlocked. */
  setDiscussing(sessionId: string, discussing: boolean, by: string): PeerSession {
    const before = this.requireSession(sessionId);
    if (before.discussing === discussing) return before;
    const session = this.store.updateSession(sessionId, { discussing });
    this.store.logEvent(sessionId, discussing ? "discussion.started" : "discussion.ended", { by });
    this.emit({ type: "session.updated", session });
    return session;
  }

  /**
   * Handle a developer message. If the agent is blocked on a checkpoint, the message answers it.
   * Otherwise a new turn is planned and started.
   */
  async sendMessage(sessionId: string, rawText: string, explicitIntent?: TurnIntent): Promise<SendResult> {
    const session = this.requireSession(sessionId);
    const pending = this.liveCheckpoint(sessionId);
    if (pending) {
      // A control (or slash command) answers the open question with its own action.
      const { intent, text } = parseIntent(rawText, explicitIntent);
      let action = ACTION_FOR_INTENT[intent];
      if (action === "answer" && !text) throw new EngineError("Answer cannot be empty");
      // While discussing, a reply that only says "go ahead" is the choice to proceed.
      const turn = pending.turnId ? this.store.getTurn(pending.turnId) : null;
      if (action === "answer" && turn && lockKind(turn) === "hold" && turn.engagedAt === null && isGoAhead(text)) action = "skip";
      const checkpoint = await this.resolveCheckpoint(pending.id, { action, text: text || undefined });
      return { kind: "checkpoint-answered", checkpoint };
    }
    if (this.statusOf(sessionId) !== "idle") {
      throw new EngineError("The agent is still working. Wait for it to finish or stop it first.", 409);
    }
    if (this.undoing.has(sessionId)) throw new EngineError("Peer is undoing the last turn. Send your message once it is done.", 409);
    let { intent, text } = parseIntent(rawText, explicitIntent);
    // "Discuss first" lasts until the developer proceeds: a plain follow-up keeps discussing.
    const wasDiscussing = session.discussing;
    if (wasDiscussing && intent === "default") intent = isGoAhead(text) ? "proceed" : "discuss";
    const discussing = intent === "discuss" || (wasDiscussing && intent === "hint");
    const turn = await this.startTurn(session, text || EMPTY_INTENT_TEXT[intent], intent, false, null, { continuingDiscussion: wasDiscussing && intent === "discuss" });
    this.setDiscussing(sessionId, discussing, `turn.${intent}`);
    return { kind: "turn-started", turn };
  }

  /**
   * A runtime whose sandbox is fixed per turn (Codex) keeps a turn that started gated read-only
   * even after the developer engaged in it. When such a turn ends normally, continue the same
   * task in a new turn, which starts with the gate open and therefore with write access.
   */
  private continueUnlockedTurn(sessionId: string, turnId: string) {
    const session = this.store.getSession(sessionId);
    const turn = this.store.getTurn(turnId);
    if (!session || !turn || this.stoppedTurns.delete(turnId)) return;
    if (turn.gate === "open" || turn.engagedAt === null) return;
    if (!this.runtimes.has(session.runtime) || !this.runtimes.get(session.runtime).sandboxFixedPerTurn) return;
    // Start after the idle event has reached subscribers, so the UI sees idle, then busy. If the
    // developer started a turn in between, their message takes over; if they pressed Stop, nothing runs.
    this.pendingContinuations.set(sessionId, turnId);
    // Once the ended turn is recorded and its idle has gone out (the service reports idle on the same promise).
    const later = (run: () => void) => {
      const recording = this.finishing.get(sessionId);
      if (recording) void recording.then(() => setImmediate(run));
      else setImmediate(run);
    };
    later(() => {
      if (this.pendingContinuations.get(sessionId) !== turnId) return;
      this.pendingContinuations.delete(sessionId);
      if (this.store.latestTurn(sessionId)?.id !== turnId || this.statusOf(sessionId) !== "idle") return;
      const current = this.store.getSession(sessionId);
      if (!current) return;
      this.store.logEvent(sessionId, "turn.continued", { fromTurnId: turnId });
      // "Just do it", "Direct answer" and Proceed last for the task, so its continuation keeps them.
      const ended = this.store.getTurn(turnId);
      const intent: TurnIntent = ended?.intent === "delegate" || ended?.intent === "answer" || ended?.intent === "proceed" ? ended.intent : "default";
      this.startTurn(current, CONTINUATION_TEXT, intent, false, turnId).catch((err) => {
        this.store.logEvent(sessionId, "turn.continue_failed", { fromTurnId: turnId, error: err instanceof Error ? err.message : String(err) });
      });
    });
  }

  /** `continuedFrom`: the turn a continuation carries on; it shares that turn's checkpoint budget. */
  private async startTurn(
    session: PeerSession,
    text: string,
    intent: TurnIntent,
    isResume: boolean,
    continuedFrom: string | null = null,
    extra: Pick<PolicyContext, "continuingDiscussion"> = {},
    awaitingEngagementOverride?: boolean,
  ): Promise<Turn> {
    this.finishActiveTurn(session.id);
    const previous = this.store.latestTurn(session.id);
    const isContinuation = continuedFrom !== null;
    // A developer reply after a gated turn in which they did not engage is the engagement. A
    // continuation carries on work the developer already engaged with. A resumed Learn task whose
    // only engagement was a go-ahead on a confirm checkpoint overrides this: it resumes locked.
    const awaitingEngagement = awaitingEngagementOverride ?? (isResume || isContinuation || (previous !== null && isLocked(previous)));
    const context: PolicyContext = { ...extra, hintLevel: intent === "hint" ? this.hintsInARow(session.id) + 1 : undefined, handsOff: this.handsOff(session.id) };
    let plan = resolveEffectivePolicy(session.mode, intent, awaitingEngagement, context);
    // Same task, same budget: the continuation is told what is left of it.
    if (continuedFrom) plan = { ...plan, checkpointBudget: Math.max(0, plan.checkpointBudget - this.checkpointsUsed(continuedFrom)) };
    const turn = this.store.createTurn({ sessionId: session.id, mode: session.mode, intent, gate: plan.gate, continuedFrom });
    this.store.logEvent(session.id, "turn.started", {
      turnId: turn.id,
      mode: session.mode,
      intent,
      gate: plan.gate,
      resume: isResume,
      continuation: isContinuation,
      text,
    });

    this.runStatus.set(session.id, "busy");
    this.emit({ type: "session.status", sessionId: session.id, status: "busy" });
    this.emit({ type: "gate.updated", sessionId: session.id, gate: this.gateFor(session.id) });
    // An agent that still remembers undone turns hears about them once, on its next turn.
    const untold = this.store.takeUndoneUntold(session.id);
    try {
      const runtime = this.runtimes.get(session.runtime);
      const directory = this.directoryOf(session);
      // The workspace before the agent touches it, so the turn can be undone.
      this.store.setTurnTree(turn.id, "start", await this.snapshot(session.id, directory));
      // Stopped while the snapshot ran: the runtime never hears of this turn.
      if (this.activeTurn(session.id)?.id !== turn.id) {
        if (untold > 0) this.store.addUndoneUntold(session.id, untold);
        this.store.markTurnsUndone([turn.id]);
        this.runStatus.set(session.id, "idle");
        this.emit({ type: "session.status", sessionId: session.id, status: "idle" });
        return turn;
      }
      const system = composeSystemPrompt(plan, runtime.checkpointTool, {
        decided: this.decidedSoFar(session.id),
        previousTurnLocked: previous !== null && (previous.gate !== "open" || previous.relockedAt !== null),
        approachGateThreshold: session.approachGate && session.mode === "collaborate" ? APPROACH_GATE_FILE_THRESHOLD : undefined,
      });
      await runtime.prompt(directory, session.runtimeSessionId, {
        text,
        system: untold > 0 ? `${system}\n\n${undoneNote(untold)}` : system,
        gate: plan.gate,
        model: session.model,
        network: this.store.getWorkspace(session.workspaceId)?.sandboxNetwork ?? false,
        autoApprovals: session.autoApprovals,
        // Peer checkpoints replace the runtime's generic question tool.
        tools: { question: false },
        // Codex reasoning effort from Runtime settings; other runtimes ignore it.
        effort: session.runtime === "codex" ? (this.store.getPreferences().runtimeSettings.codexEffort || undefined) : undefined,
      });
    } catch (err) {
      if (untold > 0) this.store.addUndoneUntold(session.id, untold);
      // It never ran, so there is nothing to undo.
      this.store.markTurnsUndone([turn.id]);
      this.store.endTurn(turn.id);
      this.runStatus.set(session.id, "idle");
      this.emit({ type: "session.status", sessionId: session.id, status: "idle" });
      throw err;
    }
    this.store.touchWorkspace(session.workspaceId);
    this.emit({ type: "session.updated", session: this.store.updateSession(session.id, {}) });
    return turn;
  }

  async abort(sessionId: string) {
    const session = this.requireSession(sessionId);
    this.pendingContinuations.delete(sessionId);
    const turn = this.store.latestTurn(sessionId);
    if (turn && turn.endedAt === null) this.stoppedTurns.add(turn.id);
    for (const cp of this.store.listCheckpoints(sessionId)) {
      if (cp.status === "pending") this.cancelCheckpoint(cp.id, "Stopped by the developer");
    }
    await this.runtimes.get(session.runtime).abort(this.directoryOf(session), session.runtimeSessionId);
    this.finishActiveTurn(sessionId);
  }

  private finishActiveTurn(sessionId: string) {
    const turn = this.store.latestTurn(sessionId);
    if (!turn || turn.endedAt !== null) return;
    this.store.endTurn(turn.id);
    this.recordTurnEnd(sessionId, turn.id);
    // A checkpoint cannot outlive its run.
    for (const cp of this.store.listCheckpointsForTurn(turn.id)) {
      if (cp.status === "pending" && !this.live.has(cp.id)) {
        this.emit({ type: "checkpoint.updated", checkpoint: this.store.updateCheckpoint(cp.id, "interrupted", null) });
      }
    }
    this.store.logEvent(sessionId, "turn.ended", { turnId: turn.id });
    this.emit({ type: "gate.updated", sessionId, gate: this.gateFor(sessionId) });
  }

  // ---------------------------------------------------------------------------
  // Gate

  gateFor(sessionId: string): GateState {
    const turn = this.store.latestTurn(sessionId);
    if (!turn || turn.endedAt !== null) return { kind: "open", locked: false, reason: null };
    const kind = lockKind(turn);
    if (this.liveCheckpoint(sessionId)) {
      return { kind, locked: true, reason: "Waiting for your response to a checkpoint." };
    }
    if (isLocked(turn)) {
      const label = getPolicy(turn.mode).label;
      const reason =
        kind === "engage"
          ? `${label} mode: code changes unlock once you engage with this task.`
          : turn.intent === "discuss"
            ? "Discussing: no code changes until you choose to proceed."
            : `"${INTENT_LABELS[turn.intent]}": no code changes this turn unless you proceed.`;
      return { kind, locked: true, reason };
    }
    return { kind, locked: false, reason: null };
  }

  /**
   * Called before every tool execution. Returns `{ wait }` when Peer holds the call on a checkpoint
   * for a decision it detected; the caller then waits with waitForToolDecision (or uses checkTool).
   */
  async evaluateTool(runtimeSessionId: string, tool: string, args: unknown): Promise<ToolCheck> {
    if (isReadOnlyTool(tool, args)) return { allow: true };
    const session = await this.sessionForRuntime(runtimeSessionId);
    // Peer owns its runtime: a session it cannot map (e.g. deleted mid-run) gets no write access.
    if (!session) return { allow: false, reason: `Peer collaboration gate: "${tool}" was not run because this session is not an active Peer session.` };
    const gate = this.gateFor(session.id);
    if (!gate.locked) {
      const decision = this.checkDecision(session, tool, args, this.approachPending(session, tool, args));
      if ("wait" in decision || !decision.allow) return decision;
      return this.checkApproach(session, tool, args);
    }

    this.store.logEvent(session.id, "gate.blocked", { tool, reason: gate.reason });
    const active = this.activeTurn(session.id);
    if (active && !this.liveCheckpoint(session.id) && this.routineContested(active.id)) {
      // Told once with the denial (Codex hears it through turn/steer).
      return {
        allow: false,
        explain: true,
        reason: `Peer collaboration gate: "${tool}" was not run. The developer said this task is not routine work: ask them your question with ${this.checkpointToolFor(session)} before changing code. Reading and exploring the code is still allowed.`,
      };
    }
    const how = this.liveCheckpoint(session.id)
      ? "Wait for the developer's response to your open checkpoint."
      : lockKind(this.store.latestTurn(session.id)!) === "engage"
        ? `Engage the developer first: ask your question with the ${this.checkpointToolFor(session)} tool (or finish your turn with it). If the work is routine and needs nothing from them, say so with ${this.checkpointToolFor(session)} category "routine" instead of asking.`
        : `The developer wants no code changes until they choose to proceed; continue the discussion, or finish your turn.`;
    return {
      allow: false,
      reason: `Peer collaboration gate: "${tool}" was not run. ${gate.reason} ${how} Reading and exploring the code is still allowed. Do not try to work around this gate.`,
    };
  }

  /**
   * In-process form of the gate (RuntimeHooks.checkTool): evaluateTool, and if Peer holds the call on
   * a checkpoint, wait for the developer. The signal (the agent run stopping) cancels the checkpoint.
   */
  async checkTool(runtimeSessionId: string, tool: string, args: unknown, signal?: AbortSignal): Promise<ToolDecision> {
    const check = await this.evaluateTool(runtimeSessionId, tool, args);
    if (!("wait" in check)) return check;
    const id = check.wait;
    const onAbort = () => this.cancelCheckpoint(id, "The agent run was stopped");
    if (signal?.aborted) onAbort();
    signal?.addEventListener("abort", onAbort, { once: true });
    try {
      for (;;) {
        const decision = await this.waitForToolDecision(id, 60_000);
        if (decision) return decision;
      }
    } finally {
      signal?.removeEventListener("abort", onAbort);
    }
  }

  /** Wait for the developer on a held tool call. Null if the timeout elapsed first (wait again). */
  async waitForToolDecision(checkpointId: string, timeoutMs: number): Promise<ToolDecision | null> {
    try {
      if ((await this.waitForCheckpoint(checkpointId, timeoutMs)) === null) return null;
    } catch (err) {
      if (!(err instanceof EngineError) || err.status !== 409) throw err;
    }
    const cp = this.store.getCheckpoint(checkpointId);
    if (!cp?.decision) throw new EngineError(`Checkpoint ${checkpointId} does not hold a tool call`, 404);
    return heldCallDecision(cp, this.hintNumber(cp));
  }

  // ---------------------------------------------------------------------------
  // Decisions Peer detects itself

  /**
   * Model-independent checkpoints: if the tool call carries a decision the mode wants the developer
   * to make (a new dependency, a public API change), hold it on a Peer-opened checkpoint. Decisions
   * the developer already made are applied without asking again. A call that carries several asks
   * about one at a time: the agent retries after each approval.
   */
  private checkDecision(session: PeerSession, tool: string, args: unknown, approachPending = false): ToolCheck {
    const detected: Detection[] = [];
    for (const detect of [detectDecision, detectContractChange]) {
      try {
        const found = detect(tool, args, this.directoryOf(session));
        if (found) detected.push(found);
      } catch (err) {
        // A bug in detection must not block every call; it is recorded instead of silent.
        // (Manifest readers already turn their own failures into "not declared", i.e. ask.)
        this.store.logEvent(session.id, "decision.detect_failed", { tool, error: err instanceof Error ? err.message : String(err) });
      }
    }
    for (const [i, found] of detected.entries()) {
      // A held decision whose call also has files to account for approves into a retry, so the
      // retry passes the (now decided) check and reaches the approach gate's counting.
      const check = this.checkDetected(session, tool, found, i < detected.length - 1 || approachPending);
      if ("wait" in check || !check.allow) return check;
    }
    return { allow: true };
  }

  /** Whether the approach gate is in play for this call and has not already been agreed in this task. */
  private approachPending(session: PeerSession, tool: string, args: unknown): boolean {
    const turn = this.activeTurn(session.id);
    if (!turn || !this.approachActive(session, turn)) return false;
    if (editTargetPaths(tool, args, this.directoryOf(session)).length === 0) return false;
    return this.approachState(session.id, new Set(this.taskTurnIds(turn.id))) !== "agreed";
  }

  /** Whether the approach gate applies to this turn at all (Collaborate, opted in, ordinary task). */
  private approachActive(session: PeerSession, turn: Turn): boolean {
    return turn.mode === "collaborate" && session.approachGate && turn.intent === "default";
  }

  /**
   * Collaborate approach gate (per-session opt-in): count the distinct files this task's
   * edit/write/patch calls target, from their arguments, before they run. The call that would
   * pass the threshold is held on a Peer checkpoint; agreement (or a stop) then applies to the
   * rest of the task. Shell-driven changes name no files Peer can see and are not counted.
   */
  private checkApproach(session: PeerSession, tool: string, args: unknown): ToolCheck {
    const directory = this.directoryOf(session);
    const paths = editTargetPaths(tool, args, directory);
    if (paths.length === 0) return { allow: true };
    const turn = this.activeTurn(session.id);
    const record = () => {
      if (turn) this.store.logEvent(session.id, "tool.edit_files", { turnId: turn.id, paths });
    };
    if (!turn || !this.approachActive(session, turn)) {
      record();
      return { allow: true };
    }
    const task = new Set(this.taskTurnIds(turn.id));
    const state = this.approachState(session.id, task);
    if (state === "agreed") {
      record();
      return { allow: true };
    }
    if (state === "declined") {
      return {
        allow: false,
        explain: true,
        reason: `Peer collaboration: the developer stopped this task's changes at ${APPROACH_GATE_FILE_THRESHOLD} files and did not agree to continue, so "${tool}" was not run. Continue without further edits in this task, and summarize what is done; the developer can ask for more changes in their next message.`,
      };
    }
    const seen = new Set<string>();
    for (const e of this.store.listEvents(session.id)) {
      if (e.type !== "tool.edit_files" || typeof e.payload.turnId !== "string" || !task.has(e.payload.turnId) || !Array.isArray(e.payload.paths)) continue;
      for (const p of e.payload.paths) if (typeof p === "string") seen.add(p);
    }
    const wouldBe = new Set([...seen, ...paths]);
    if (wouldBe.size <= APPROACH_GATE_FILE_THRESHOLD) {
      record();
      return { allow: true };
    }
    // An earlier approach question about this task that lost its run is replaced by this one.
    for (const old of this.store.listCheckpoints(session.id)) {
      if (old.status === "interrupted" && old.decision?.kind === "approach" && old.turnId !== null && task.has(old.turnId)) {
        const cancelled = this.store.updateCheckpoint(old.id, "cancelled", { action: "cancelled", by: "system", note: "Asked again when the agent retried" });
        this.emit({ type: "checkpoint.updated", checkpoint: cancelled });
      }
    }
    const files = [...wouldBe].map((p) => relative(directory, p) || p).sort();
    const decision: DetectedDecision = {
      kind: "approach",
      subjects: files.slice(0, 20),
      ecosystem: "workspace",
      action: `an edit to ${paths.map((p) => `\`${relative(directory, p) || p}\``).join(", ")}`,
      style: "choice",
    };
    const checkpoint = this.store.createCheckpoint({
      sessionId: session.id,
      turnId: turn.id,
      runtimeCallId: null,
      source: "peer",
      decision,
      ...approachQuestion(files),
      recommendation: null,
      status: "pending",
      resolution: null,
    });
    this.live.add(checkpoint.id);
    this.store.logEvent(session.id, "checkpoint.opened", { checkpointId: checkpoint.id, category: checkpoint.category, question: checkpoint.question, source: "peer", tool });
    this.emit({ type: "checkpoint.updated", checkpoint });
    this.emit({ type: "gate.updated", sessionId: session.id, gate: this.gateFor(session.id) });
    return { wait: checkpoint.id };
  }

  /** The developer's latest word on this task's approach gate: agreed, declined, or not asked yet. */
  private approachState(sessionId: string, task: Set<string>): "agreed" | "declined" | null {
    let state: "agreed" | "declined" | null = null;
    for (const cp of this.store.listCheckpoints(sessionId)) {
      if (cp.decision?.kind !== "approach" || cp.turnId === null || !task.has(cp.turnId) || cp.status !== "resolved") continue;
      const outcome = decisionOutcome(cp);
      if (outcome) state = outcome === "approved" ? "agreed" : "declined";
    }
    return state;
  }

  private checkDetected(session: PeerSession, tool: string, detected: Detection, more: boolean): ToolCheck {
    const prior = this.priorDecisions(session.id, detected);
    const declined = detected.subjects.filter((s) => prior.get(s) === "declined");
    const undecided = detected.subjects.filter((s) => !prior.has(s));
    if (declined.length > 0 || undecided.length === 0) {
      this.store.logEvent(session.id, "decision.reused", { kind: detected.kind, subjects: detected.subjects, declined, tool });
    }
    if (declined.length > 0) {
      return {
        allow: false,
        explain: true,
        reason:
          detected.kind === "contract"
            ? `Peer collaboration: the developer already decided not to change ${list(declined)} in this task, so ${detected.action} was not run. Continue without changing ${declined.length > 1 ? "them" : "it"}. If you think they should reconsider, say why in your reply; they can ask for the change in their next message.`
            : `Peer collaboration: the developer already decided not to add ${list(declined)} in this session, so ${detected.action} was not run. Continue without ${declined.length > 1 ? "them" : "it"}. If you think they should reconsider, ask them with ${this.checkpointToolFor(session)}.`,
      };
    }
    if (undecided.length === 0) return { allow: true };

    const turn = this.activeTurn(session.id);
    const plan = resolveEffectivePolicy(turn?.mode ?? session.mode, turn?.intent ?? "default", false);
    const decision: DetectedDecision = { ...detected, subjects: undecided, style: plan.decisions.style, ...(more ? { more } : {}) };
    const base = { sessionId: session.id, turnId: turn?.id ?? null, runtimeCallId: null, source: "peer" as const, decision };

    if (!plan.decisions.ask.includes(detected.kind)) {
      const qualifier = plan.intent === "default" ? `${plan.policy.label} mode` : `"${INTENT_LABELS[plan.intent]}"`;
      const checkpoint = this.store.createCheckpoint({
        ...base,
        category: "architecture",
        question: detected.kind === "contract" ? `Public API change: ${list(undecided)}` : `New ${undecided.length > 1 ? "dependencies" : "dependency"}: ${list(undecided)}`,
        context: `The agent ran ${detected.action}.`,
        options: [],
        recommendation: null,
        status: "auto_resolved",
        resolution: { action: "policy", by: "policy", note: `${qualifier} notes this without interrupting you` },
      });
      this.store.logEvent(session.id, "decision.noted", { checkpointId: checkpoint.id, kind: detected.kind, subjects: undecided, tool });
      this.emit({ type: "checkpoint.updated", checkpoint });
      return { allow: true };
    }

    // An earlier question about the same decision that lost its run is replaced by this one.
    for (const old of this.store.listCheckpoints(session.id)) {
      if (old.status === "interrupted" && old.decision?.kind === detected.kind && old.decision.subjects.some((s) => undecided.includes(s))) {
        const cancelled = this.store.updateCheckpoint(old.id, "cancelled", { action: "cancelled", by: "system", note: "Asked again when the agent retried" });
        this.emit({ type: "checkpoint.updated", checkpoint: cancelled });
      }
    }
    const checkpoint = this.store.createCheckpoint({ ...base, ...decisionQuestion(decision), recommendation: null, status: "pending", resolution: null });
    this.live.add(checkpoint.id);
    this.store.logEvent(session.id, "checkpoint.opened", { checkpointId: checkpoint.id, category: checkpoint.category, question: checkpoint.question, source: "peer", subjects: undecided, tool });
    this.emit({ type: "checkpoint.updated", checkpoint });
    this.emit({ type: "gate.updated", sessionId: session.id, gate: this.gateFor(session.id) });
    return { wait: checkpoint.id };
  }

  /**
   * What the developer already decided about each subject, latest signal first. A dependency: in
   * this session, from answers to Peer's own checkpoints and the developer's own words (messages,
   * answers, chosen options, approved plans) that name the subject. A contract: in this task, from
   * answers to Peer's own checkpoints only, since approving one API change is not approving the next
   * and prose can't tell them apart. Subjects with no signal are absent.
   */
  private priorDecisions(sessionId: string, { kind, subjects }: Detection): Map<string, "approved" | "declined"> {
    const signals: { at: number; subject: string; outcome: "approved" | "declined" }[] = [];
    const words: { at: number; text: string; choice: boolean }[] = [];
    const turn = this.activeTurn(sessionId);
    const task = new Set(kind === "contract" && turn ? this.taskTurnIds(turn.id) : []);
    if (kind === "dependency") {
      for (const e of this.store.listEvents(sessionId)) {
        if (e.type === "turn.started" && !e.payload.resume && !e.payload.continuation && typeof e.payload.text === "string") words.push({ at: e.createdAt, text: e.payload.text, choice: false });
      }
    }
    for (const cp of this.store.listCheckpoints(sessionId)) {
      const at = cp.resolvedAt ?? cp.createdAt;
      if (cp.decision?.kind === kind && (kind === "dependency" || (cp.turnId !== null && task.has(cp.turnId)))) {
        const outcome = decisionOutcome(cp);
        if (outcome) for (const subject of cp.decision.subjects) signals.push({ at, subject, outcome });
      }
      if (kind === "dependency") for (const w of developerWords(cp)) words.push({ at, ...w });
    }
    for (const subject of subjects) {
      for (const w of words) if (namesApproved(w.text, subject, w.choice)) signals.push({ at: w.at, subject, outcome: "approved" });
    }
    const latest = new Map<string, { at: number; outcome: "approved" | "declined" }>();
    for (const s of signals) {
      const seen = latest.get(s.subject);
      if (!seen || s.at >= seen.at) latest.set(s.subject, s);
    }
    return new Map([...latest].filter(([subject]) => subjects.includes(subject)).map(([subject, s]) => [subject, s.outcome]));
  }

  // ---------------------------------------------------------------------------
  // Checkpoints

  /**
   * The agent asks for a checkpoint. The engine either opens it for the developer (the agent
   * then blocks in waitForCheckpoint) or declines it according to policy and returns the
   * instruction to give the agent immediately.
   */
  async requestCheckpoint(
    runtimeSessionId: string,
    callId: string | null,
    request: CheckpointRequest,
  ): Promise<{ checkpoint: Checkpoint | null; output: string | null }> {
    const session = await this.sessionForRuntime(runtimeSessionId);
    if (!session) {
      return { checkpoint: null, output: "Peer checkpoints are only available in Peer sessions. Decide yourself and continue." };
    }
    const input = normalizeCheckpointRequest(request);
    const turn = this.activeTurn(session.id);
    const mode = turn?.mode ?? session.mode;
    const intent = turn?.intent ?? "default";
    const handsOff = this.handsOff(session.id);
    const plan = resolveEffectivePolicy(mode, intent, false, { handsOff });
    const record = (resolution: Checkpoint["resolution"]) =>
      this.store.createCheckpoint({
        ...input,
        sessionId: session.id,
        turnId: turn?.id ?? null,
        runtimeCallId: callId,
        source: "agent",
        decision: null,
        status: "auto_resolved",
        resolution,
      });

    // Not a question: the agent says the work is routine. Never asked; in Learn it unlocks code changes,
    // unless the developer already said this task is not routine.
    if (input.category === "routine") {
      const contested = turn !== null && this.routineContested(turn.id);
      const unlocks = turn !== null && !contested && lockKind(turn) === "engage" && isLocked(turn);
      if (unlocks) this.store.markTurnEngaged(turn.id);
      const checkpoint = record({
        action: "policy",
        by: "policy",
        note: contested ? "routine work: refused, the developer said this task is not routine" : unlocks ? "routine work: no question asked, code changes unlocked" : "routine work: no question asked",
      });
      this.store.logEvent(session.id, "checkpoint.routine", { checkpointId: checkpoint.id, question: input.question, unlocked: unlocks });
      this.emit({ type: "checkpoint.updated", checkpoint });
      if (unlocks) this.emit({ type: "gate.updated", sessionId: session.id, gate: this.gateFor(session.id) });
      return { checkpoint, output: this.agentOutput(checkpoint) };
    }

    // The same question, already answered by the developer in this task, is not asked again.
    const earlier = input.category === "risk" || !turn ? null : this.answeredBefore(turn, input.question);
    let declined: string | null = null;
    if (earlier) {
      declined = "the developer already answered this question in this task";
    } else if (!plan.askFor.includes(input.category)) {
      const qualifier = intent === "default" ? "" : ` with "${INTENT_LABELS[intent]}"`;
      declined =
        handsOff && plan.policy.askFor.includes(input.category) && intent === "default"
          ? `the developer handed their last decisions back, so Peer leaves ${input.category} decisions to you for now`
          : `${plan.policy.label} mode${qualifier} leaves ${input.category} decisions to you`;
    } else if (input.category !== "risk" && turn && this.checkpointsUsed(turn.id) >= plan.checkpointBudget) {
      declined = `this turn already reached Peer's ceiling of ${plan.checkpointBudget} question${plan.checkpointBudget === 1 ? "" : "s"}`;
    }

    if (declined) {
      const checkpoint = record({ action: "policy", by: "policy", note: declined, ...(earlier ? { repeatOf: earlier.id } : {}) });
      this.store.logEvent(session.id, "checkpoint.declined", { checkpointId: checkpoint.id, category: input.category, reason: declined, repeatOf: earlier?.id });
      this.emit({ type: "checkpoint.updated", checkpoint });
      return { checkpoint, output: this.agentOutput(checkpoint) };
    }

    const checkpoint = this.store.createCheckpoint({
      ...input,
      sessionId: session.id,
      turnId: turn?.id ?? null,
      runtimeCallId: callId,
      source: "agent",
      decision: null,
      status: "pending",
      resolution: null,
    });
    this.live.add(checkpoint.id);
    this.store.logEvent(session.id, "checkpoint.opened", { checkpointId: checkpoint.id, category: input.category, question: input.question });
    this.emit({ type: "checkpoint.updated", checkpoint });
    this.emit({ type: "gate.updated", sessionId: session.id, gate: this.gateFor(session.id) });
    return { checkpoint, output: null };
  }

  /**
   * In-process form of the checkpoint tool (RuntimeHooks.checkpoint): open the checkpoint and block
   * until the developer responds. Rejects if it is cancelled, interrupted, or the signal aborts.
   */
  async runCheckpoint(runtimeSessionId: string, callId: string | null, request: CheckpointRequest, signal: AbortSignal): Promise<string> {
    const { checkpoint, output } = await this.requestCheckpoint(runtimeSessionId, callId, request);
    if (output !== null || !checkpoint) return output ?? "";
    const onAbort = () => this.cancelCheckpoint(checkpoint.id, "The agent run was stopped");
    if (signal.aborted) onAbort();
    signal.addEventListener("abort", onAbort, { once: true });
    try {
      for (;;) {
        const result = await this.waitForCheckpoint(checkpoint.id, 60_000);
        if (result !== null) return result;
      }
    } finally {
      signal.removeEventListener("abort", onAbort);
    }
  }

  /**
   * Wait until the developer resolves a checkpoint. Returns the agent-facing output, or null if
   * the timeout elapsed first (the plugin then waits again). Throws if it was cancelled.
   */
  async waitForCheckpoint(id: string, timeoutMs: number): Promise<string | null> {
    const ready = () => {
      const cp = this.store.getCheckpoint(id);
      if (!cp) throw new EngineError(`Unknown checkpoint ${id}`, 404);
      if (cp.status === "cancelled" || cp.status === "interrupted") throw new EngineError("Checkpoint was cancelled", 409);
      return cp.status === "pending" ? null : this.agentOutput(cp);
    };
    const now = ready();
    if (now !== null) return now;

    await new Promise<void>((resolve) => {
      const set = this.waiters.get(id) ?? new Set();
      const wake = () => {
        clearTimeout(timer);
        set.delete(wake);
        resolve();
      };
      const timer = setTimeout(wake, timeoutMs);
      set.add(wake);
      this.waiters.set(id, set);
    });
    return ready();
  }

  async resolveCheckpoint(
    id: string,
    input: { action: CheckpointAction; text?: string; option?: string },
  ): Promise<Checkpoint> {
    const cp = this.store.getCheckpoint(id);
    if (!cp) throw new EngineError(`Unknown checkpoint ${id}`, 404);
    if (cp.status !== "pending" && cp.status !== "interrupted") throw new EngineError("Checkpoint is already resolved", 409);
    if (!CHECKPOINT_ACTIONS.includes(input.action)) throw new EngineError(`Unknown action ${String(input.action)}`);
    const text = input.text?.trim() || undefined;
    if (input.action === "answer" && !text) throw new EngineError("An answer needs text");
    if (input.action === "choose" && !cp.options.some((o) => o.label === input.option)) throw new EngineError("Unknown option");

    const wasLive = this.live.has(id);
    if (!wasLive && this.statusOf(cp.sessionId) !== "idle") {
      throw new EngineError("The agent is busy; answer again when it is idle.", 409);
    }
    const resolved = this.store.updateCheckpoint(id, "resolved", {
      action: input.action,
      by: "human",
      text,
      option: input.action === "choose" ? input.option : undefined,
    });
    this.live.delete(id);

    const turn = cp.turnId ? this.store.getTurn(cp.turnId) : null;
    // A hint on a Peer-held dependency call only denies that call and asks again on retry.
    // Agent questions use the task-wide hint hold; keep the dependency reasoning loop intact.
    if (wasLive && turn) this.applyControl(turn, input.action, cp.decision !== null, cp.category);
    else this.applyDiscussion(cp.sessionId, input.action);
    this.store.logEvent(cp.sessionId, "checkpoint.resolved", {
      checkpointId: id,
      category: cp.category,
      action: input.action,
      text,
      option: input.option,
    });
    this.emit({ type: "checkpoint.updated", checkpoint: resolved });

    if (wasLive) {
      for (const wake of [...(this.waiters.get(id) ?? [])]) wake();
      this.waiters.delete(id);
    } else {
      // The run that asked is gone (stop, crash, or restart): resume with a new turn.
      // If the resume cannot start, keep the checkpoint answerable rather than losing the response.
      const session = this.requireSession(cp.sessionId);
      const resumeText = cp.decision
        ? `Resuming after an interruption. Before ${cp.decision.action} ran, Peer paused it to ask me about it.\n\n${this.agentOutput(resolved)}`
        : `Resuming after an interruption. Earlier you asked me (via ${this.checkpointToolFor(session)}): "${cp.question}"\n\n${this.agentOutput(resolved)}`;
      try {
        // This is the same task. Ordinary answers must retain an existing override; only an
        // explicit control replaces it. A mode switch or End discussion can retire the hold.
        const inherited = session.discussing ? "discuss"
          : turn?.mode === session.mode && !this.modeChangedSince(turn) && (turn.intent === "delegate" || turn.intent === "answer" || (turn.intent === "hint" && isLocked(turn))) ? turn.intent
          : "default";
        // A go-ahead on a confirm checkpoint in Learn is not engagement, live or resumed. Only
        // when the task is still awaiting engagement: engagement already earned in it (an answer,
        // routine work, You decide) survives the restart.
        const confirmResumeLocked =
          session.mode === "learn" && cp.source === "agent" && cp.category === "confirm" && (input.action === "answer" || input.action === "choose") && !RESUME_INTENT[input.action] && inherited === "default" && !session.discussing && turn !== null && isLocked(turn)
            ? false
            : undefined;
        await this.startTurn(session, resumeText, RESUME_INTENT[input.action] ?? inherited, true, turn?.id ?? null, {}, confirmResumeLocked);
      } catch (err) {
        this.emit({ type: "checkpoint.updated", checkpoint: this.store.updateCheckpoint(id, "interrupted", null) });
        throw err;
      }
    }
    this.emit({ type: "gate.updated", sessionId: cp.sessionId, gate: this.gateFor(cp.sessionId) });
    return resolved;
  }

  /**
   * What a response does to the rest of the turn: engaging unlocks code changes; "Just do it" and
   * "Direct answer" change the turn's intent (so later questions are declined accordingly); "Discuss
   * first" or a hint locks code changes again until the developer proceeds; Proceed retires them.
   */
  private applyControl(turn: Turn, action: CheckpointAction, heldDependency = false, category?: CheckpointCategory) {
    if (engages(turn, action, category)) this.store.markTurnEngaged(turn.id);
    if (action === "skip" && (turn.intent === "discuss" || turn.intent === "hint")) this.store.setTurnIntent(turn.id, "proceed");
    if (action === "go") this.store.setTurnIntent(turn.id, "delegate");
    if (action === "direct") this.store.setTurnIntent(turn.id, "answer");
    if (action === "discuss" || (action === "hint" && !heldDependency)) {
      this.store.setTurnIntent(turn.id, action);
      this.store.relockTurn(turn.id);
    }
    this.applyDiscussion(turn.sessionId, action);
  }

  /** "Discuss first" continues into the next messages; proceeding in any form ends it. */
  private applyDiscussion(sessionId: string, action: CheckpointAction) {
    if (action === "discuss") this.setDiscussing(sessionId, true, "checkpoint.discuss");
    else if (action === "skip" || action === "go" || action === "direct") this.setDiscussing(sessionId, false, `checkpoint.${action}`);
  }

  /**
   * The developer says work the agent declared routine is not routine ("Not routine, ask me"):
   * Learn's lock closes again for the rest of the turn, and further routine declarations in it are
   * refused. Only while that turn runs; changes already made stay (Undo takes them back).
   */
  contestRoutine(checkpointId: string): Checkpoint {
    const cp = this.store.getCheckpoint(checkpointId);
    if (!cp) throw new EngineError(`Unknown checkpoint ${checkpointId}`, 404);
    if (cp.category !== "routine" || !cp.resolution?.note?.includes("unlocked")) throw new EngineError("Only routine work that unlocked code changes can be contested.", 409);
    const turn = cp.turnId ? this.store.getTurn(cp.turnId) : null;
    if (!turn || turn.endedAt !== null || this.activeTurn(cp.sessionId)?.id !== turn.id) throw new EngineError("That task is no longer running; your next message starts a new one.", 409);
    this.store.clearEngagement(turn.id);
    const updated = this.store.updateCheckpoint(cp.id, "auto_resolved", { ...cp.resolution, note: "routine work: the developer said it is not routine; code changes locked again" });
    this.store.logEvent(cp.sessionId, "checkpoint.routine_contested", { checkpointId: cp.id, turnId: turn.id });
    this.emit({ type: "checkpoint.updated", checkpoint: updated });
    this.emit({ type: "gate.updated", sessionId: cp.sessionId, gate: this.gateFor(cp.sessionId) });
    return updated;
  }

  private routineContested(turnId: string): boolean {
    const turn = this.store.getTurn(turnId);
    if (!turn) return false;
    const task = new Set(this.taskTurnIds(turnId));
    return this.store.listEvents(turn.sessionId).some((e) => e.type === "checkpoint.routine_contested" && task.has(String(e.payload.turnId)));
  }

  cancelCheckpoint(id: string, note: string) {
    const cp = this.store.getCheckpoint(id);
    if (!cp || cp.status !== "pending") return;
    this.live.delete(id);
    const cancelled = this.store.updateCheckpoint(id, "cancelled", { action: "cancelled", by: "system", note });
    for (const wake of [...(this.waiters.get(id) ?? [])]) wake();
    this.waiters.delete(id);
    this.store.logEvent(cp.sessionId, "checkpoint.cancelled", { checkpointId: id, note });
    this.emit({ type: "checkpoint.updated", checkpoint: cancelled });
    this.emit({ type: "gate.updated", sessionId: cp.sessionId, gate: this.gateFor(cp.sessionId) });
  }

  /** What the agent is told when the checkpoint tool returns. A pure function of stored state. */
  agentOutput(cp: Checkpoint): string {
    const r = cp.resolution;
    const rec = cp.recommendation ? ` (you recommended "${cp.recommendation}")` : "";
    const turn = cp.turnId ? this.store.getTurn(cp.turnId) : null;
    const session = this.store.getSession(cp.sessionId);
    const fixedSandbox = session !== null && this.runtimes.has(session.runtime) && this.runtimes.get(session.runtime).sandboxFixedPerTurn === true;
    const wasLocked = turn !== null && (turn.gate !== "open" || turn.relockedAt !== null);
    const unlocked =
      turn && wasLocked && turn.engagedAt !== null
        ? fixedSandbox && turn.gate !== "open"
          ? " Code changes are now unlocked, but this turn's sandbox stays read-only: do not try to edit files now. Say in one or two sentences what you will do, then end your turn. Peer starts a new turn with write access right away."
          : " Code changes are now unlocked."
        : "";
    const added = r?.text ? ` and added: "${r.text}"` : "";
    // A go-ahead on a plan in Learn approves the plan but is not the engagement that unlocks.
    const confirmHeld =
      !cp.decision && cp.category === "confirm" && turn?.mode === "learn" && turn !== null && isLocked(turn) && (r?.action === "answer" || r?.action === "choose")
        ? ` Code changes stay locked: in Learn mode a go-ahead on a plan does not count as engaging with the task. Ask the developer a hypothesis or concept question about the key part of this task with ${session ? this.checkpointToolFor(session) : "the checkpoint tool"} before changing code.`
        : "";
    if (!r) return "The checkpoint has no response yet.";
    if (cp.decision) {
      const decision = heldCallDecision(cp, this.hintNumber(cp));
      return decision.allow
        ? `Peer asked the developer about ${what(cp.decision)}, and they approved. Go ahead (run ${cp.decision.action} again); Peer will not ask about it again.`
        : decision.reason;
    }
    switch (r.action) {
      case "policy": {
        if (cp.category === "routine") {
          if (r.note?.includes("refused")) return `Peer did not accept this: the developer said this task is not routine. Ask them your question with ${session ? this.checkpointToolFor(session) : "the checkpoint tool"} before changing code.`;
          if (unlocked) return `Peer recorded this as routine work without asking the developer.${unlocked}`;
          return turn && isLocked(turn)
            ? "Peer recorded this, but code changes stay locked this turn: the developer asked for a hint or to discuss first, which routine work does not override. Do not attempt edits."
            : "Peer recorded this as routine work without asking the developer. Continue.";
        }
        if (r.repeatOf) {
          const earlier = this.store.getCheckpoint(r.repeatOf);
          const said = earlier ? describeResponse(earlier) : "they answered it";
          return `Peer did not ask again: the developer already answered this question in this task (${said}). Build on that answer and continue.`;
        }
        if (turn?.intent === "discuss" && cp.category === "confirm") {
          return "Peer did not ask the developer for a go-ahead: while discussing, they choose when to proceed (Proceed, Just do it, or a message saying go ahead). Do not modify files; end your turn with a short summary of what you would implement.";
        }
        if (turn?.intent === "answer" && (cp.category === "hypothesis" || cp.category === "concept")) {
          return `Peer did not ask the developer: ${r.note}. They want the direct answer, not a question: answer it yourself in your reply, directly and with the reasoning, then continue.`;
        }
        return `Peer did not ask the developer: ${r.note}. Decide yourself${rec}, mention the decision and why in your final summary, and continue.`;
      }
      case "answer":
        return `The developer answered: "${r.text}". Take this into account and continue.${unlocked}${confirmHeld}`;
      case "choose":
        return `The developer chose "${r.option}"${added}. Proceed with it.${unlocked}${confirmHeld}`;
      case "delegate":
        return `The developer delegated this decision to you${added}. Make the call yourself${rec}, state your choice in one sentence, and continue.${unlocked}`;
      case "skip":
        return `The developer chose to skip this discussion and wants you to proceed with the implementation${r.text ? ` (note: "${r.text}")` : ""}. Use your recommended approach and briefly explain the key idea as you go.${unlocked}`;
      case "go":
        return `The developer said "Just do it"${added}: proceed with the rest of this task without further optional questions or discussion. Use your recommended approach${rec}, make the remaining decisions yourself, and summarize them at the end. Risky or irreversible steps still need the developer.${unlocked}`;
      case "direct":
        return `The developer asked for the direct answer${added}. Answer your question yourself in your reply, directly and completely with the reasoning; do not ask it again or quiz them. Then continue the task.${unlocked}`;
      case "discuss":
        return `The developer wants to discuss this before any further code changes${r.text ? `: "${r.text}"` : ""}. Respond to that: lay out the options, their trade-offs and your recommendation. Code changes are locked until they choose to proceed; do not attempt edits.`;
      case "hint": {
        const n = this.hintNumber(cp);
        const tool = session ? this.checkpointToolFor(session) : "the checkpoint tool";
        return `The developer asked for a hint (hint ${n}${r.text ? `; they added: "${r.text}"` : ""}). Reply with one short hint that moves them one step closer without revealing the full answer, then ask again with ${tool} (category "hypothesis" or "concept").`;
      }
      case "cancelled":
        return `The checkpoint was cancelled: ${r.note}.`;
    }
  }

  // ---------------------------------------------------------------------------
  // Undo

  /**
   * A git tree of the workspace now, or null outside git (or without a snapshot dir). Snapshots of
   * one session run one after another, so an undo can wait for the end of the last turn.
   */
  private snapshot(sessionId: string, directory: string): Promise<string | null> {
    const dir = this.opts.snapshotDir;
    if (!dir) return Promise.resolve(null);
    const next = (this.snapshots.get(sessionId) ?? Promise.resolve()).then(() => snapshotWorkspace(directory, join(dir, `${sessionId}.index`)));
    this.snapshots.set(sessionId, next.catch(() => null));
    return next;
  }

  /** Record how the workspace looked when a turn ended (what undo compares later edits against). */
  private recordTurnEnd(sessionId: string, turnId: string) {
    const session = this.store.getSession(sessionId);
    if (!session || !this.store.turnTrees(turnId).start) return;
    let directory: string;
    try {
      directory = this.directoryOf(session);
    } catch {
      return;
    }
    // Peer may be shutting down (store closed) by the time the snapshot is done; then it is simply not recorded.
    const done: Promise<void> = this.snapshot(sessionId, directory)
      .then((tree) => this.store.setTurnTree(turnId, "end", tree))
      .catch(() => {})
      .finally(() => {
        if (this.finishing.get(sessionId) === done) this.finishing.delete(sessionId);
      });
    this.finishing.set(sessionId, done);
  }

  /** The turns one undo takes back: the latest kept turn, and the turns a continuation carried on. */
  private undoChain(sessionId: string): Turn[] {
    const latest = this.store.latestKeptTurn(sessionId);
    if (!latest) return [];
    const chain = [latest];
    for (let t = latest; t.continuedFrom; ) {
      const prev = this.store.getTurn(t.continuedFrom);
      if (!prev || prev.undoneAt !== null) break;
      chain.push(prev);
      t = prev;
    }
    return chain;
  }

  undoAvailability(sessionId: string): UndoAvailability {
    const no = (reason: string) => ({ available: false, reason });
    if (this.statusOf(sessionId) !== "idle" || this.activeTurn(sessionId)) return no("Wait for the agent to finish this turn.");
    if (this.undoing.has(sessionId)) return no("Undoing…");
    const chain = this.undoChain(sessionId);
    if (chain.length === 0) return no(NOTHING_TO_UNDO);
    if (!this.opts.snapshotDir || !this.store.turnTrees(chain.at(-1)!.id).start) return no("Undo needs the project to be a git repository when the turn starts.");
    return { available: true, reason: null };
  }

  /**
   * Undo the session's last turn: every file that changed while it ran goes back to how it was
   * before it, and the turn leaves the conversation (or, if the runtime keeps it, the agent is told
   * on its next turn). Refuses, changing nothing, when one of those files changed again since.
   */
  async undoLastTurn(sessionId: string): Promise<UndoResult> {
    const session = this.requireSession(sessionId);
    const availability = this.undoAvailability(sessionId);
    if (!availability.available) throw new EngineError(availability.reason ?? "Nothing to undo.", 409);
    this.undoing.add(sessionId);
    try {
      const chain = this.undoChain(sessionId);
      const first = chain.at(-1)!;
      const latest = chain[0]!;
      const directory = this.directoryOf(session);
      const now = await this.snapshot(sessionId, directory); // also waits for the turn's end snapshot
      const start = this.store.turnTrees(first.id).start;
      const end = this.store.turnTrees(latest.id).end;
      if (!start || !now) throw new EngineError("Undo needs the project to be a git repository.", 409);
      if (!end) throw new EngineError("Peer has no record of how this turn ended (Peer or the runtime restarted during it), so it cannot tell the agent's changes from later ones.", 409);
      // Only the workspace folder, which may be part of a larger repository: the agent works only in
      // there, and changes elsewhere in the repository are the developer's.
      const files = await changedFiles(directory, start, end, { insideDirectory: true });
      const changedSince = new Set(await changedFiles(directory, end, now, { insideDirectory: true }));
      const conflicts = files.filter((f) => changedSince.has(f));
      if (conflicts.length > 0) {
        const list = conflicts.slice(0, 5).join(", ") + (conflicts.length > 5 ? ` and ${conflicts.length - 5} more` : "");
        throw new EngineError(`Nothing was undone: ${list} changed after the turn ended, and undoing would overwrite that.`, 409);
      }
      const indexFile = join(this.opts.snapshotDir!, `${sessionId}.index`);
      try {
        await restoreFiles(directory, start, files, indexFile);
      } catch (err) {
        // Put back what was there before the undo started, so a failed undo changes nothing.
        await restoreFiles(directory, now, files, indexFile).catch(() => {});
        throw new EngineError(`Undo failed and nothing was changed: ${err instanceof Error ? err.message : String(err)}`, 409);
      }
      let forgotten = false;
      try {
        forgotten = await this.runtimes.get(session.runtime).forgetTurns(directory, session.runtimeSessionId, first.startedAt);
      } catch (err) {
        this.store.logEvent(sessionId, "turn.forget_failed", { error: err instanceof Error ? err.message : String(err) });
      }
      const turnIds = chain.map((t) => t.id);
      this.store.markTurnsUndone(turnIds);
      if (!forgotten) this.store.addUndoneUntold(sessionId, chain.length);
      this.store.logEvent(sessionId, "turn.undone", { turnIds, files, forgotten });
      return { files, turns: chain.length, forgotten };
    } finally {
      this.undoing.delete(sessionId);
    }
  }

  // ---------------------------------------------------------------------------
  // Helpers

  private requireSession(id: string): PeerSession {
    const session = this.store.getSession(id);
    if (!session) throw new EngineError(`Unknown session ${id}`, 404);
    return session;
  }

  private checkpointToolFor(session: PeerSession): string {
    return this.runtimes.has(session.runtime) ? this.runtimes.get(session.runtime).checkpointTool : "the checkpoint tool";
  }

  directoryOf(session: PeerSession): string {
    const ws = this.store.getWorkspace(session.workspaceId);
    if (!ws) throw new EngineError(`Workspace for session ${session.id} is gone`, 404);
    return ws.path;
  }

  private activeTurn(sessionId: string): Turn | null {
    const turn = this.store.latestTurn(sessionId);
    return turn && turn.endedAt === null ? turn : null;
  }

  /** Mode switches retire overrides even when the developer switches away and back. */
  private modeChangedSince(turn: Turn): boolean {
    let started = false;
    for (const event of this.store.listEvents(turn.sessionId)) {
      if (event.type === "turn.started" && event.payload.turnId === turn.id) started = true;
      else if (started && event.type === "mode.changed") return true;
    }
    return false;
  }

  liveCheckpoint(sessionId: string): Checkpoint | null {
    for (const id of this.live) {
      const cp = this.store.getCheckpoint(id);
      if (cp?.sessionId === sessionId && cp.status === "pending") return cp;
    }
    return null;
  }

  /**
   * Developer-facing checkpoints used in a turn, including the turn a continuation carries on (one
   * task, one budget, on every runtime). Risk and hint follow-ups are free, and so are the
   * checkpoints Peer opens itself: they are not the agent's questions.
   */
  private checkpointsUsed(turnId: string): number {
    return this.taskTurnIds(turnId)
      .flatMap((id) => this.store.listCheckpointsForTurn(id))
      .filter((c) => c.source === "agent" && c.category !== "risk" && c.status !== "auto_resolved" && c.resolution?.action !== "hint").length;
  }

  /** All turns carrying on the same task, including repeated recovery and sandbox continuations. */
  private taskTurnIds(turnId: string): string[] {
    const ids = new Set<string>();
    for (let id: string | null = turnId; id && !ids.has(id); id = this.store.getTurn(id)?.continuedFrom ?? null) ids.add(id);
    return [...ids];
  }

  /** Checkpoints the developer answered themselves, outside undone turns, oldest first. */
  private answeredByDeveloper(sessionId: string): Checkpoint[] {
    const undone = (turnId: string | null) => turnId !== null && (this.store.getTurn(turnId)?.undoneAt ?? null) !== null;
    return this.store
      .listCheckpoints(sessionId)
      .filter((c) => c.status === "resolved" && c.resolution?.by === "human" && !undone(c.turnId))
      .sort((a, b) => (a.resolvedAt ?? 0) - (b.resolvedAt ?? 0));
  }

  /**
   * An earlier question in this task (the turn, and the turn a continuation carries on) with the
   * same wording that the developer answered, not with a hint or "discuss first". Only within the
   * task: generic wording ("Ready to implement?") recurs across tasks for different decisions.
   */
  private answeredBefore(turn: Turn, question: string): Checkpoint | null {
    const q = normalizeQuestion(question);
    if (!q) return null;
    const task = new Set(this.taskTurnIds(turn.id));
    const matches = this.answeredByDeveloper(turn.sessionId).filter(
      (c) => c.turnId !== null && task.has(c.turnId) && c.source === "agent" && c.resolution?.action !== "hint" && c.resolution?.action !== "discuss" && normalizeQuestion(c.question) === q,
    );
    return matches.at(-1) ?? null;
  }

  /** Decisions the developer made earlier in the session, for the agent (the last six). */
  private decidedSoFar(sessionId: string): string[] {
    const lines: string[] = [];
    for (const cp of this.answeredByDeveloper(sessionId)) {
      const action = cp.resolution?.action;
      if (action === "hint" || action === "discuss") continue;
      if (cp.decision) {
        const outcome = decisionOutcome(cp);
        if (outcome && cp.decision.kind === "contract") lines.push(`Changing ${list(cp.decision.subjects)}: ${outcome} for that task only; Peer asks again in a new task.`);
        else if (outcome && cp.decision.kind === "approach") lines.push(`This task's changes growing past ${APPROACH_GATE_FILE_THRESHOLD} files: ${outcome} for that task only; Peer asks again in a new task.`);
        else if (outcome) lines.push(`Adding ${list(cp.decision.subjects)}: ${outcome === "approved" ? "approved" : "declined (do not add it)"}.`);
        continue;
      }
      lines.push(`"${clip(cp.question, 160)}": ${describeResponse(cp)}.`);
    }
    return lines.slice(-6);
  }

  /** Turns in a row, newest first, that the developer started with "Give me a hint". */
  private hintsInARow(sessionId: string): number {
    let n = 0;
    for (const turn of this.store.listTurns(sessionId)) {
      if (turn.undoneAt !== null || turn.continuedFrom !== null) continue;
      if (turn.intent !== "hint") break;
      n++;
    }
    return n;
  }

  /**
   * Whether the developer's last two responses in this session handed decisions back: a task sent
   * with "Just do it" or "Direct answer", or a question answered with Just do it, You decide or
   * Direct answer. Answering in their own words, choosing an option, discussing, asking for a hint
   * or proceeding after a discussion counts as engaging and resets it. Peer's own dependency questions do not count.
   */
  private handsOff(sessionId: string): boolean {
    const undone = (turnId: unknown) => typeof turnId === "string" && (this.store.getTurn(turnId)?.undoneAt ?? null) !== null;
    const signals: boolean[] = [];
    // The event log is in order, so the latest two responses are the last two signals.
    for (const e of this.store.listEvents(sessionId)) {
      if (e.type === "turn.started") {
        if (e.payload.resume || e.payload.continuation || undone(e.payload.turnId)) continue;
        const intent = e.payload.intent as TurnIntent;
        if (intent === "delegate" || intent === "answer") signals.push(true);
        else if (intent === "discuss" || intent === "hint" || intent === "proceed") signals.push(false);
      } else if (e.type === "checkpoint.resolved") {
        const cp = typeof e.payload.checkpointId === "string" ? this.store.getCheckpoint(e.payload.checkpointId) : null;
        if (!cp || cp.source !== "agent" || undone(cp.turnId)) continue;
        const action = e.payload.action as CheckpointAction;
        signals.push(action === "go" || action === "delegate" || action === "direct");
      }
    }
    const last = signals.slice(-2);
    return last.length === 2 && last.every(Boolean);
  }

  private hintNumber(cp: Checkpoint): number {
    if (!cp.turnId) return 1;
    const hints = this.store
      .listCheckpointsForTurn(cp.turnId)
      .filter((c) => c.resolution?.action === "hint" && c.createdAt <= cp.createdAt);
    return Math.max(1, hints.length);
  }

  /** Map a runtime session (including subagent child sessions) to its Peer session. */
  async sessionForRuntime(runtimeSessionId: string): Promise<PeerSession | null> {
    let id = runtimeSessionId;
    for (let depth = 0; depth < 8; depth++) {
      const session = this.store.getSessionByRuntimeId(id);
      if (session) return session;
      let parent = this.parentCache.get(id);
      if (parent === undefined) {
        parent = await this.findParent(id);
        this.parentCache.set(id, parent);
      }
      if (!parent) return null;
      id = parent;
    }
    return null;
  }

  private async findParent(runtimeSessionId: string): Promise<string | null> {
    // We don't know the child's runtime or directory; try each (there are few).
    for (const runtime of this.runtimes.all()) {
      for (const ws of this.store.listWorkspaces()) {
        try {
          const parent = await runtime.getParentSessionId(ws.path, runtimeSessionId);
          if (parent) return parent;
        } catch {
          // not in this runtime/workspace
        }
      }
    }
    return null;
  }
}

/** The lock a turn is under: its start gate, or "hold" after a mid-turn discussion or hint. */
function lockKind(turn: Turn): GateKind {
  return turn.relockedAt !== null ? "hold" : turn.gate;
}

/** Code changes are locked until the developer engages (or proceeds, for a "hold" lock). */
function isLocked(turn: Turn): boolean {
  return (turn.gate !== "open" || turn.relockedAt !== null) && turn.engagedAt === null;
}

/**
 * Whether a response releases the turn's lock. Learn's "engage" lock opens on any engagement but a
 * hint or a wish to discuss; a "hold" (Discuss first, Hint) opens only when the developer proceeds.
 * In Learn, an ordinary answer to a "confirm" checkpoint (a go-ahead on a plan) is not engagement:
 * it approves the plan but does not unlock. Explicit controls on that checkpoint (You decide,
 * Just do it, Direct answer, Proceed) still unlock, as they do on any checkpoint.
 */
function engages(turn: Turn, action: CheckpointAction, category?: CheckpointCategory): boolean {
  switch (lockKind(turn)) {
    case "engage":
      if (turn.mode === "learn" && category === "confirm" && (action === "answer" || action === "choose")) return false;
      return action !== "hint" && action !== "discuss";
    case "hold":
      return action === "skip" || action === "go" || action === "direct";
    case "open":
      return false;
  }
}

/** A comparable form of a question: case, punctuation and spacing do not make it a new one. */
function normalizeQuestion(q: string): string {
  return q.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();
}

function clip(text: string, max: number): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

/** How the developer responded to a question, in a few words for the agent. */
function describeResponse(cp: Checkpoint): string {
  const r = cp.resolution;
  const text = r?.text ? clip(r.text, 200) : "";
  switch (r?.action) {
    case "choose":
      return `they chose "${r.option}"${text ? ` and added "${text}"` : ""}`;
    case "answer":
      return `they answered "${text}"`;
    case "delegate":
      return "they left it to you";
    case "skip":
      return "they said to proceed with your recommendation";
    case "go":
      return 'they said "Just do it"';
    case "direct":
      return "they asked for the direct answer";
    case "discuss":
      return "they wanted to discuss it first";
    case "hint":
      return "they asked for a hint";
    default:
      return "they answered it";
  }
}

function normalizeCheckpointRequest(req: CheckpointRequest): {
  category: CheckpointCategory;
  question: string;
  context: string | null;
  options: CheckpointOption[];
  recommendation: string | null;
} {
  const category = CHECKPOINT_CATEGORIES.includes(req.category as CheckpointCategory) ? (req.category as CheckpointCategory) : "confirm";
  const question = typeof req.question === "string" && req.question.trim() ? req.question.trim() : "How should I proceed?";
  const context = typeof req.context === "string" && req.context.trim() ? req.context.trim() : null;
  const options: CheckpointOption[] = Array.isArray(req.options)
    ? req.options
        .map((o): CheckpointOption | null => {
          if (typeof o === "string") return { label: o };
          if (o && typeof o === "object" && typeof (o as CheckpointOption).label === "string") {
            const { label, description } = o as CheckpointOption;
            return { label, description: typeof description === "string" ? description : undefined };
          }
          return null;
        })
        .filter((o): o is CheckpointOption => o !== null)
        .slice(0, 6)
    : [];
  const recommendation = typeof req.recommendation === "string" && req.recommendation.trim() ? req.recommendation.trim() : null;
  return { category, question, context, options, recommendation };
}

// ---------------------------------------------------------------------------
// Peer-opened checkpoints for detected decisions

function list(subjects: string[]): string {
  return subjects.map((s) => `\`${s}\``).join(", ");
}

function what(d: DetectedDecision): string {
  if (d.kind === "approach") return `continuing this task's changes past ${APPROACH_GATE_FILE_THRESHOLD} files`;
  return `${d.kind === "contract" ? "changing" : "adding"} ${list(d.subjects)}`;
}

/** "whether `x` is needed here", the thing the developer weighs. */
function whetherNeeded(d: DetectedDecision): string {
  if (d.kind === "approach") return "whether this task's changes should keep growing";
  const plural = d.subjects.length > 1;
  return d.kind === "contract" ? `whether ${list(d.subjects)} ${plural ? "need" : "needs"} to change here` : `whether ${list(d.subjects)} ${plural ? "are" : "is"} needed here`;
}

/** The question Peer asks when a Collaborate task's edits pass the approach-gate threshold. */
function approachQuestion(files: string[]): { category: CheckpointCategory; question: string; context: string; options: CheckpointOption[] } {
  return {
    category: "confirm",
    question: `This task's changes have grown to ${files.length} files. Continue with the changes?`,
    context: `Peer paused the next edit before it runs (approach gate). Files so far: ${files.slice(0, 10).join(", ")}${files.length > 10 ? `, and ${files.length - 10} more` : ""}. Continuing approves the rest of this task's edits; stopping ends its edits here.`,
    options: [
      { label: APPROACH_APPROVE, description: "The agent continues editing in this task" },
      { label: APPROACH_DECLINE, description: "The agent finishes without further edits in this task" },
    ],
  };
}

/** The question Peer asks for a held call, per style. */
function decisionQuestion(d: DetectedDecision): { category: CheckpointCategory; question: string; context: string; options: CheckpointOption[] } {
  if (d.kind === "approach") return approachQuestion(d.subjects);
  const plural = d.subjects.length > 1;
  const detected = `The agent is about to run ${d.action}. Peer detected this itself and paused it before it runs.`;
  if (d.kind === "contract") {
    if (d.style === "reasoning") {
      return {
        category: "hypothesis",
        question: `Before the agent changes ${list(d.subjects)}: why do you think this task needs the public API to change, and what could the change break?`,
        context: `${detected} Answer in your own words and the agent will respond to your reasoning before it continues, or choose "You decide" to let it go ahead.`,
        options: [],
      };
    }
    return {
      category: "architecture",
      question: `Change the public API: ${list(d.subjects)}?`,
      context: `${detected} Other code and people may rely on this contract, so a change can break them.`,
      options: [
        { label: CONTRACT_APPROVE, description: "Run it as planned" },
        { label: CONTRACT_DECLINE, description: "The agent continues without changing it" },
      ],
    };
  }
  if (d.style === "reasoning") {
    return {
      category: "hypothesis",
      question: `Before the agent adds ${list(d.subjects)}: what do you think this task needs ${plural ? "them" : "it"} for, and is that worth a new dependency here?`,
      context: `${detected} Answer in your own words and the agent will respond to your reasoning before it continues, or choose "You decide" to let it go ahead.`,
      options: [],
    };
  }
  return {
    category: "architecture",
    question: `Add ${plural ? "new dependencies" : "a new dependency"}: ${list(d.subjects)}?`,
    context: `${detected} A dependency is a lasting choice (maintenance, security updates, install size).`,
    options: [
      { label: DECISION_APPROVE, description: "Run it as planned" },
      { label: DECISION_DECLINE, description: "The agent continues without it" },
    ],
  };
}

/** Whether the developer's response lets the held call run, and what the agent is told if not. */
function heldCallDecision(cp: Checkpoint, hint: number): ToolDecision {
  const d = cp.decision!;
  const r = cp.resolution;
  const paused = `Peer paused ${d.action} to ask the developer about ${what(d)}`;
  const deny = (reason: string): ToolDecision => ({ allow: false, explain: true, reason: `Peer collaboration: ${reason}` });
  if (!r || r.action === "cancelled") return deny(`${paused}, and the question was cancelled${r?.note ? ` (${r.note})` : ""}. It was not run.`);
  const them = d.subjects.length > 1 ? "them" : "it";
  if (r.action === "discuss") {
    return deny(`${paused}; the developer wants to discuss it before any code changes${r.text ? ` ("${r.text}")` : ""}. It was not run. Discuss ${whetherNeeded(d)}, and the alternatives; code changes stay locked until they choose to proceed.`);
  }
  const contract = d.kind === "contract";
  switch (decisionOutcome(cp)) {
    case "declined":
      if (d.kind === "approach") {
        return deny(`${paused}. They did not agree to continue${r.text ? ` and said: "${r.text}"` : ""}. It was not run. Finish this task without further edits and summarize what is done; Peer rejects further edit calls in this task, and the developer can ask for more changes in their next message.`);
      }
      return deny(
        contract
          ? `${paused}. They decided against it${r.text ? ` and said: "${r.text}"` : ""}. It was not run. Continue without changing ${them}; Peer rejects further attempts in this task, and the developer can ask for the change in a later message.`
          : `${paused}. They decided against it${r.text ? ` and said: "${r.text}"` : ""}. It was not run. Continue without ${them}; Peer rejects further attempts in this session unless the developer asks for ${them}.`,
      );
    case "approved":
      // Learn's "Direct answer": the agent explains the decision itself, then the retry runs.
      if (r.action === "direct") {
        const explain = contract ? `why this task needs to change ${list(d.subjects)} and what the alternative would be` : `why this task needs ${list(d.subjects)} and what the alternative without ${them} would be`;
        return deny(`${paused} first. It was not run yet. They asked for the direct answer${r.text ? ` and added: "${r.text}"` : ""}: in two or three sentences, explain ${explain}. Then run it again; Peer will not ask about it again.`);
      }
      // Their words go to the agent first; the retry then runs without asking again.
      if (!r.text || r.action === "policy") {
        if (!d.more) return { allow: true };
        // Letting the call run here would carry its other decision past the developer unasked.
        return deny(`${paused}, and they approved it. It was not run yet: the same call carries another decision Peer has to ask about. Run it again; Peer will not ask about this one again.`);
      }
      if (d.style === "reasoning" && r.action === "answer") {
        return deny(`${paused} first (Learn mode). It was not run yet. Their reasoning: "${r.text}". Before you continue, respond to it in a few sentences: what it gets right and what it misses, grounded in this codebase. Then continue; if ${what(d)} is still right, run it again (Peer will not ask about it again).`);
      }
      return deny(`${paused}. It was not run yet. They said: "${r.text}". Act on that. If it approves ${what(d)}, run it again; Peer will not ask about it again.`);
    default:
      // A hint: answer it, then try again, and Peer asks again.
      return deny(`${paused}; they asked for a hint (hint ${hint}${r.text ? `; they added: "${r.text}"` : ""}). It was not run. In your reply, give one short hint that helps them reason about ${whetherNeeded(d)}, without giving the answer away. Then run it again; Peer will ask them again.`);
  }
}

/** The decision a resolved Peer-opened checkpoint records. Free-text answers count as approval: the agent gets the text first. */
function decisionOutcome(cp: Checkpoint): "approved" | "declined" | null {
  const r = cp.resolution;
  if (!r) return null;
  if (r.action === "policy") return "approved";
  if (r.action === "choose") return r.option === DECISION_DECLINE || r.option === CONTRACT_DECLINE || r.option === APPROACH_DECLINE ? "declined" : "approved";
  if (r.action === "answer" || r.action === "delegate" || r.action === "skip" || r.action === "go" || r.action === "direct") return "approved";
  return null;
}

/**
 * The developer's own words in an agent-opened checkpoint: their answer, the option they chose, and
 * what they accepted (the recommendation when they delegated or skipped or picked it, and the plan
 * of a confirm checkpoint they approved).
 */
function developerWords(cp: Checkpoint): { text: string; choice: boolean }[] {
  const r = cp.resolution;
  // A Peer checkpoint's outcome is the decision; its text must not count again ("too heavy" on a decline).
  if (!r || r.by !== "human" || cp.source === "peer") return [];
  const words = r.text ? [{ text: r.text, choice: false }] : [];
  // Option labels are explicit choices; the rest is prose that has to ask for the package.
  if (r.action === "choose" && r.option) words.push({ text: r.option, choice: true });
  const accepted = r.action === "delegate" || r.action === "skip" || r.action === "go" || (r.action === "choose" && (r.option === cp.recommendation || cp.options.length === 1));
  if (accepted && cp.recommendation && r.action !== "choose") words.push({ text: cp.recommendation, choice: true });
  if (accepted && cp.category === "confirm") words.push({ text: cp.question, choice: false }, { text: cp.context ?? "", choice: false });
  return words;
}
