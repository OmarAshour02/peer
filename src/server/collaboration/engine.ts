import {
  CHECKPOINT_ACTIONS,
  CHECKPOINT_CATEGORIES,
  type Checkpoint,
  type CheckpointAction,
  type CheckpointCategory,
  type CheckpointOption,
  type CollaborationModeId,
  type DetectedDecision,
  type GateState,
  type PeerEvent,
  type PeerSession,
  type RuntimeKind,
  type SessionRunStatus,
  type Turn,
  type TurnIntent,
} from "../../shared/types.js";
import type { RuntimeEvent } from "../runtime/adapter.js";
import type { RuntimeSet } from "../runtime/set.js";
import type { Store } from "../store.js";
import { detectDecision, namesApproved, type Detection } from "./decisions.js";
import { parseIntent } from "./intent.js";
import { INTENT_LABELS, getPolicy, resolveEffectivePolicy } from "./policies.js";
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

export type SendResult =
  | { kind: "turn-started"; turn: Turn }
  | { kind: "checkpoint-answered"; checkpoint: Checkpoint };

const EMPTY_INTENT_TEXT: Record<TurnIntent, string> = {
  default: "Continue.",
  delegate: "Go ahead and do it.",
  discuss: "Let's discuss this before changing any code.",
  hint: "Can I have a hint?",
  answer: "Please give me the direct answer.",
};

/** Sent for the developer when Peer continues engaged work in a writable turn (sandboxFixedPerTurn). */
export const CONTINUATION_TEXT = "Code changes are now unlocked. Continue the task from where you stopped and implement what we agreed.";

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

  constructor(
    private readonly store: Store,
    private readonly runtimes: RuntimeSet,
    private readonly emit: (event: PeerEvent) => void,
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
      if (session) this.runStatus.set(session.id, event.status);
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
    return this.runStatus.get(sessionId) ?? "idle";
  }

  // ---------------------------------------------------------------------------
  // Sessions and turns

  setMode(sessionId: string, mode: CollaborationModeId): PeerSession {
    const before = this.requireSession(sessionId);
    if (before.mode === mode) return before;
    const session = this.store.updateSession(sessionId, { mode });
    this.store.logEvent(sessionId, "mode.changed", { from: before.mode, to: mode });
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
      if (!rawText.trim()) throw new EngineError("Answer cannot be empty");
      const action: CheckpointAction = explicitIntent === "delegate" ? "delegate" : explicitIntent === "hint" ? "hint" : "answer";
      const checkpoint = await this.resolveCheckpoint(pending.id, { action, text: rawText.trim() });
      return { kind: "checkpoint-answered", checkpoint };
    }
    if (this.statusOf(sessionId) !== "idle") {
      throw new EngineError("The agent is still working. Wait for it to finish or stop it first.", 409);
    }
    const { intent, text } = parseIntent(rawText, explicitIntent);
    const turn = await this.startTurn(session, text || EMPTY_INTENT_TEXT[intent], intent, false);
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
    setImmediate(() => {
      if (this.pendingContinuations.get(sessionId) !== turnId) return;
      this.pendingContinuations.delete(sessionId);
      if (this.store.latestTurn(sessionId)?.id !== turnId || this.statusOf(sessionId) !== "idle") return;
      const current = this.store.getSession(sessionId);
      if (!current) return;
      this.store.logEvent(sessionId, "turn.continued", { fromTurnId: turnId });
      this.startTurn(current, CONTINUATION_TEXT, "default", false, turnId).catch((err) => {
        this.store.logEvent(sessionId, "turn.continue_failed", { fromTurnId: turnId, error: err instanceof Error ? err.message : String(err) });
      });
    });
  }

  /** `continuedFrom`: the turn a continuation carries on; it shares that turn's checkpoint budget. */
  private async startTurn(session: PeerSession, text: string, intent: TurnIntent, isResume: boolean, continuedFrom: string | null = null): Promise<Turn> {
    this.finishActiveTurn(session.id);
    const previous = this.store.latestTurn(session.id);
    const isContinuation = continuedFrom !== null;
    // A developer reply after a gated turn in which they did not engage is the engagement. A
    // continuation carries on work the developer already engaged with.
    const awaitingEngagement = isResume || isContinuation || (previous !== null && previous.gate !== "open" && previous.engagedAt === null);
    let plan = resolveEffectivePolicy(session.mode, intent, awaitingEngagement);
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
    try {
      const runtime = this.runtimes.get(session.runtime);
      await runtime.prompt(this.directoryOf(session), session.runtimeSessionId, {
        text,
        system: composeSystemPrompt(plan, runtime.checkpointTool),
        gate: plan.gate,
        model: session.model,
        // Peer checkpoints replace the runtime's generic question tool.
        tools: { question: false },
      });
    } catch (err) {
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
    if (this.liveCheckpoint(sessionId)) {
      return { kind: turn.gate, locked: true, reason: "Waiting for your response to a checkpoint." };
    }
    if (turn.gate !== "open" && turn.engagedAt === null) {
      const label = getPolicy(turn.mode).label;
      const reason =
        turn.gate === "engage"
          ? `${label} mode: code changes unlock once you engage with this task.`
          : `"${INTENT_LABELS[turn.intent]}": no code changes this turn unless you skip ahead.`;
      return { kind: turn.gate, locked: true, reason };
    }
    return { kind: turn.gate, locked: false, reason: null };
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
    if (!gate.locked) return this.checkDecision(session, tool, args);

    this.store.logEvent(session.id, "gate.blocked", { tool, reason: gate.reason });
    const how = this.liveCheckpoint(session.id)
      ? "Wait for the developer's response to your open checkpoint."
      : `Engage the developer first: ask your question with the ${this.checkpointToolFor(session)} tool (or finish your turn with it). For purely mechanical work, ask for a go-ahead with a "confirm" checkpoint.`;
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
   * to make (today: a new dependency), hold it on a Peer-opened checkpoint. Decisions the developer
   * already made in this session are applied without asking again.
   */
  private checkDecision(session: PeerSession, tool: string, args: unknown): ToolCheck {
    let detected: Detection | null;
    try {
      detected = detectDecision(tool, args, this.directoryOf(session));
    } catch (err) {
      // A bug in detection must not block every call; it is recorded instead of silent.
      // (Manifest readers already turn their own failures into "not declared", i.e. ask.)
      this.store.logEvent(session.id, "decision.detect_failed", { tool, error: err instanceof Error ? err.message : String(err) });
      detected = null;
    }
    if (!detected) return { allow: true };

    const prior = this.priorDecisions(session.id, detected.subjects);
    const declined = detected.subjects.filter((s) => prior.get(s) === "declined");
    const undecided = detected.subjects.filter((s) => !prior.has(s));
    if (declined.length > 0 || undecided.length === 0) {
      this.store.logEvent(session.id, "decision.reused", { kind: detected.kind, subjects: detected.subjects, declined, tool });
    }
    if (declined.length > 0) {
      return {
        allow: false,
        explain: true,
        reason: `Peer collaboration: the developer already decided not to add ${list(declined)} in this session, so ${detected.action} was not run. Continue without ${declined.length > 1 ? "them" : "it"}. If you think they should reconsider, ask them with ${this.checkpointToolFor(session)}.`,
      };
    }
    if (undecided.length === 0) return { allow: true };

    const turn = this.activeTurn(session.id);
    const plan = resolveEffectivePolicy(turn?.mode ?? session.mode, turn?.intent ?? "default", false);
    const decision: DetectedDecision = { ...detected, subjects: undecided, style: plan.decisions.style };
    const base = { sessionId: session.id, turnId: turn?.id ?? null, runtimeCallId: null, source: "peer" as const, decision };

    if (!plan.decisions.ask.includes(detected.kind)) {
      const qualifier = plan.intent === "default" ? `${plan.policy.label} mode` : `"${INTENT_LABELS[plan.intent]}"`;
      const checkpoint = this.store.createCheckpoint({
        ...base,
        category: "architecture",
        question: `New ${undecided.length > 1 ? "dependencies" : "dependency"}: ${list(undecided)}`,
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
      if (old.status === "interrupted" && old.decision?.subjects.some((s) => undecided.includes(s))) {
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
   * What the developer already decided about each subject in this session, latest signal first:
   * answers to Peer's own checkpoints, and the developer's own words (messages, answers, chosen
   * options, approved plans) that name the subject. Subjects with no signal are absent.
   */
  private priorDecisions(sessionId: string, subjects: string[]): Map<string, "approved" | "declined"> {
    const signals: { at: number; subject: string; outcome: "approved" | "declined" }[] = [];
    const words: { at: number; text: string; choice: boolean }[] = [];
    for (const e of this.store.listEvents(sessionId)) {
      if (e.type === "turn.started" && !e.payload.resume && !e.payload.continuation && typeof e.payload.text === "string") words.push({ at: e.createdAt, text: e.payload.text, choice: false });
    }
    for (const cp of this.store.listCheckpoints(sessionId)) {
      const at = cp.resolvedAt ?? cp.createdAt;
      if (cp.decision) {
        const outcome = decisionOutcome(cp);
        if (outcome) for (const subject of cp.decision.subjects) signals.push({ at, subject, outcome });
      }
      for (const w of developerWords(cp)) words.push({ at, ...w });
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
    const plan = resolveEffectivePolicy(mode, intent, false);

    let declined: string | null = null;
    if (!plan.askFor.includes(input.category)) {
      const qualifier = intent === "default" ? "" : ` with "${INTENT_LABELS[intent]}"`;
      declined = `${plan.policy.label} mode${qualifier} leaves ${input.category} decisions to you`;
    } else if (input.category !== "risk" && turn && this.checkpointsUsed(turn.id) >= plan.checkpointBudget) {
      declined = `the developer-facing checkpoint budget for this turn (${plan.checkpointBudget}) is used up`;
    }

    if (declined) {
      const checkpoint = this.store.createCheckpoint({
        ...input,
        sessionId: session.id,
        turnId: turn?.id ?? null,
        runtimeCallId: callId,
        source: "agent",
        decision: null,
        status: "auto_resolved",
        resolution: { action: "policy", by: "policy", note: declined },
      });
      this.store.logEvent(session.id, "checkpoint.declined", { checkpointId: checkpoint.id, category: input.category, reason: declined });
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
    if (wasLive && turn && engages(turn, input.action)) this.store.markTurnEngaged(turn.id);
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
        await this.startTurn(session, resumeText, input.action === "hint" ? "hint" : "default", true);
      } catch (err) {
        this.emit({ type: "checkpoint.updated", checkpoint: this.store.updateCheckpoint(id, "interrupted", null) });
        throw err;
      }
    }
    this.emit({ type: "gate.updated", sessionId: cp.sessionId, gate: this.gateFor(cp.sessionId) });
    return resolved;
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
    const unlocked =
      turn && turn.gate !== "open" && turn.engagedAt !== null
        ? fixedSandbox
          ? " Code changes are now unlocked, but this turn's sandbox stays read-only: do not try to edit files now. Say in one or two sentences what you will do, then end your turn. Peer starts a new turn with write access right away."
          : " Code changes are now unlocked."
        : "";
    if (!r) return "The checkpoint has no response yet.";
    if (cp.decision) {
      const decision = heldCallDecision(cp, this.hintNumber(cp));
      return decision.allow
        ? `Peer asked the developer about ${what(cp.decision)}, and they approved. Go ahead (run ${cp.decision.action} again); Peer will not ask about it again.`
        : decision.reason;
    }
    switch (r.action) {
      case "policy":
        return `Peer did not ask the developer: ${r.note}. Decide yourself${rec}, mention the decision and why in your final summary, and continue.`;
      case "answer":
        return `The developer answered: "${r.text}". Take this into account and continue.${unlocked}`;
      case "choose":
        return `The developer chose "${r.option}"${r.text ? ` and added: "${r.text}"` : ""}. Proceed with it.${unlocked}`;
      case "delegate":
        return `The developer delegated this decision to you${r.text ? ` and added: "${r.text}"` : ""}. Make the call yourself${rec}, state your choice in one sentence, and continue.${unlocked}`;
      case "skip":
        return `The developer chose to skip this discussion and wants you to proceed with the implementation${r.text ? ` (note: "${r.text}")` : ""}. Use your recommended approach and briefly explain the key idea as you go.${unlocked}`;
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
    const turn = this.store.getTurn(turnId);
    const turnIds = turn?.continuedFrom ? [turnId, turn.continuedFrom] : [turnId];
    return turnIds
      .flatMap((id) => this.store.listCheckpointsForTurn(id))
      .filter((c) => c.source === "agent" && c.category !== "risk" && c.status !== "auto_resolved" && c.resolution?.action !== "hint").length;
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

function engages(turn: Turn, action: CheckpointAction): boolean {
  if (turn.gate === "engage") return action !== "hint";
  if (turn.gate === "hold") return action === "skip";
  return false;
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
  return `adding ${list(d.subjects)}`;
}

/** The question Peer asks for a held call, per style. */
function decisionQuestion(d: DetectedDecision): { category: CheckpointCategory; question: string; context: string; options: CheckpointOption[] } {
  const plural = d.subjects.length > 1;
  const detected = `The agent is about to run ${d.action}. Peer detected this itself and paused it before it runs.`;
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
  switch (decisionOutcome(cp)) {
    case "declined":
      return deny(`${paused}. They decided against it${r.text ? ` and said: "${r.text}"` : ""}. It was not run. Continue without ${d.subjects.length > 1 ? "them" : "it"}; Peer rejects further attempts in this session unless the developer asks for ${d.subjects.length > 1 ? "them" : "it"}.`);
    case "approved":
      // Their words go to the agent first; the retry then runs without asking again.
      if (!r.text || r.action === "policy") return { allow: true };
      if (d.style === "reasoning" && r.action === "answer") {
        return deny(`${paused} first (Learn mode). It was not run yet. Their reasoning: "${r.text}". Before you continue, respond to it in a few sentences: what it gets right and what it misses, grounded in this codebase. Then continue; if ${what(d)} is still right, run it again (Peer will not ask about it again).`);
      }
      return deny(`${paused}. It was not run yet. They said: "${r.text}". Act on that. If it approves ${what(d)}, run it again; Peer will not ask about it again.`);
    default:
      // A hint: answer it, then try again, and Peer asks again.
      return deny(`${paused}; they asked for a hint (hint ${hint}${r.text ? `; they added: "${r.text}"` : ""}). It was not run. In your reply, give one short hint that helps them reason about whether ${list(d.subjects)} ${d.subjects.length > 1 ? "are" : "is"} needed here, without giving the answer away. Then run it again; Peer will ask them again.`);
  }
}

/** The decision a resolved Peer-opened checkpoint records. Free-text answers count as approval: the agent gets the text first. */
function decisionOutcome(cp: Checkpoint): "approved" | "declined" | null {
  const r = cp.resolution;
  if (!r) return null;
  if (r.action === "policy") return "approved";
  if (r.action === "choose") return r.option === DECISION_DECLINE ? "declined" : "approved";
  if (r.action === "answer" || r.action === "delegate" || r.action === "skip") return "approved";
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
  const accepted = r.action === "delegate" || r.action === "skip" || (r.action === "choose" && (r.option === cp.recommendation || cp.options.length === 1));
  if (accepted && cp.recommendation && r.action !== "choose") words.push({ text: cp.recommendation, choice: true });
  if (accepted && cp.category === "confirm") words.push({ text: cp.question, choice: false }, { text: cp.context ?? "", choice: false });
  return words;
}
