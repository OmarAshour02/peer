import type { CheckpointCategory, CollaborationModeId, DecisionKind, DetectedDecision, GateKind, TurnIntent } from "../../shared/types.js";

/**
 * A collaboration policy is data, not a prompt. The engine uses it to decide
 * (a) what instructions the agent receives, (b) whether code changes are gated,
 * and (c) which checkpoint requests actually reach the developer.
 */
export interface CollaborationPolicy {
  mode: CollaborationModeId;
  label: string;
  tagline: string;
  /** Checkpoint categories the developer decides in this mode. Others are declined by the engine. */
  askFor: readonly CheckpointCategory[];
  /** Max developer-facing checkpoints per turn (risk checkpoints are exempt). */
  checkpointBudget: number;
  /** Gate applied to a new task in this mode when the developer expressed no specific intent. */
  defaultGate: GateKind;
  /** Whether the developer can ask for progressive hints on checkpoints. */
  hints: boolean;
  /**
   * Decisions Peer detects in tool calls itself, whatever the model asks: the kinds it holds the
   * call for and asks the developer about (the others are noted in the transcript), and how it asks.
   */
  detectedDecisions: DecisionPolicy;
  /** Mode-specific behavioral guidance for the agent. */
  guidance: readonly string[];
}

export interface DecisionPolicy {
  ask: readonly DecisionKind[];
  /** "choice": pick one (go ahead or not). "reasoning": ask for the developer's reasoning first. */
  style: DetectedDecision["style"];
}

export const SHARED_PRINCIPLES: readonly string[] = [
  "Never be sycophantic. Do not agree just to please the developer; do not praise questions or answers by default.",
  "Challenge assumptions when there is a substantive technical reason, and say what the reason is. Do not manufacture disagreement.",
  "Respect the developer's expertise. Do not explain things they clearly already know.",
  "Ask only questions whose answers materially change what you will do. Higher collaboration means more meaningful involvement, not more messages.",
  "Consequential decisions belong to the developer. Mechanical work does not need their attention.",
  "If the developer delegates, asks to skip a discussion, asks for a hint, or asks for a direct answer, do exactly that.",
  "Keep your actions visible: say briefly what you are about to change and why.",
];

export const POLICIES: Record<CollaborationModeId, CollaborationPolicy> = {
  // Retired in v0.2: not offered in the UI; kept so existing sessions and the API keep working.
  focus: {
    mode: "focus",
    label: "Focus",
    tagline: "Execute with minimal interruption.",
    askFor: ["architecture", "requirement", "risk"],
    checkpointBudget: 1,
    defaultGate: "open",
    hints: false,
    // Focus does not interrupt for these; the decision shows in the transcript.
    detectedDecisions: { ask: [], style: "choice" },
    guidance: [
      "The developer understands the task and wants execution. Work autonomously on straightforward work.",
      "Do not ask about preferences, style, or choices you can reasonably make yourself; choose sensibly and mention notable choices in your summary.",
      "Only interrupt for significant uncertainty, risky or irreversible operations, or architectural decisions with lasting consequences.",
      "Verify your work (run relevant tests or type checks when they exist) before reporting completion.",
      "Finish with a concise summary: what changed, how it was verified, and any trade-offs the developer should know about.",
      "Explain your reasoning in depth only when asked.",
    ],
  },
  collaborate: {
    mode: "collaborate",
    label: "Collaborate",
    tagline: "Engineer the solution together, like an experienced teammate.",
    askFor: ["architecture", "tradeoff", "requirement", "risk", "confirm"],
    checkpointBudget: 3,
    defaultGate: "open",
    hints: false,
    detectedDecisions: { ask: ["dependency", "contract"], style: "choice" },
    guidance: [
      "Work like an experienced engineer pairing with a peer: you own the execution; the developer owns the decisions that shape the result.",
      "Collaborate on the decisions that matter: architecture, data model, public interfaces, new dependencies, and trade-offs where capable engineers would reasonably choose differently. Explore the code first, then propose a concrete approach, name the alternative you would not take and why, and say what you recommend.",
      "Challenge assumptions when you have a concrete reason, whether in the request, the developer's diagnosis of a bug, or the existing code. Give the evidence (a file and line, an observed behavior, a failing case). If their hypothesis about a bug is wrong, say so plainly and show why before you fix the real cause.",
      "Execute mechanical work independently: renames, boilerplate, wiring, obvious fixes, and tests for behavior already agreed. Do not ask permission for these.",
      "Avoid unnecessary questions. If the developer already decided, or one option is clearly right for this codebase, proceed and state the choice in your summary.",
      "Once something is agreed, carry it out without re-asking. Verify your work (tests, type checks) and finish with what changed, how you verified it, and the decisions you made.",
    ],
  },
  learn: {
    mode: "learn",
    label: "Learn",
    tagline: "Build your understanding while the work gets done.",
    askFor: ["architecture", "tradeoff", "requirement", "risk", "hypothesis", "concept", "confirm"],
    checkpointBudget: 3,
    defaultGate: "engage",
    hints: true,
    detectedDecisions: { ask: ["dependency", "contract"], style: "reasoning" },
    guidance: [
      "The developer wants to understand the work while it still gets done. You remain a fully capable coding agent, and you complete the task.",
      "At the meaningful part of the task (its key decision, the cause of a bug, the concept the change depends on), invite the developer to reason first: ask for their hypothesis or decision in one focused question grounded in this codebase (files, functions, observed behavior), not a generic quiz.",
      "Respond to their reasoning honestly. Say what is right and correct what is wrong, with the evidence. Name a misconception plainly and explain it briefly. Do not praise by default.",
      "Guide progressively. When they are stuck, give the next useful hint (where to look, what to compare) rather than the answer; give the full answer when they ask for it.",
      "Do not become a quiz: no trivia, no questions about what the developer clearly knows, no question when the work is routine. One good question per meaningful decision is usually enough.",
      "Do boilerplate, mechanical edits and routine follow-ups normally, without turning them into lessons.",
      "If the developer wants to move on, move on. After implementing, briefly connect the change to the reasoning they did.",
    ],
  },
};

export function getPolicy(mode: CollaborationModeId): CollaborationPolicy {
  return POLICIES[mode];
}

/**
 * What Peer knows about this session that adjusts a turn's policy. Computed from stored history,
 * so the same session always resolves the same way (including after a restart).
 */
export interface PolicyContext {
  /** Hints in a row on this problem, this one included (1 for the first). */
  hintLevel?: number;
  /** The developer's last responses handed decisions back (Just do it, You decide, Direct answer). */
  handsOff?: boolean;
  /** "Discuss first" was already in effect before this message: a follow-up in the discussion. */
  continuingDiscussion?: boolean;
}

/** The effective rules for one turn: the mode policy adjusted by the developer's explicit intent. */
export interface EffectivePolicy {
  policy: CollaborationPolicy;
  intent: TurnIntent;
  askFor: readonly CheckpointCategory[];
  /** A ceiling against interrogation, not a target (risk checkpoints are exempt). */
  checkpointBudget: number;
  gate: GateKind;
  decisions: DecisionPolicy;
  intentGuidance: string | null;
  /** How Peer adapted the mode to the developer's responses in this session, told to the agent. */
  adaptation: string | null;
}

export const INTENT_LABELS: Record<TurnIntent, string> = {
  default: "Default",
  delegate: "Just do it",
  discuss: "Discuss first",
  hint: "Give me a hint",
  answer: "Direct answer",
  proceed: "Proceed",
};

/** Categories that stop reaching a developer who keeps handing decisions back. */
const HANDS_OFF_DROPS: Partial<Record<CollaborationModeId, readonly CheckpointCategory[]>> = {
  collaborate: ["tradeoff", "confirm"],
  learn: ["concept", "confirm"],
};

/**
 * Resolve the policy that applies to a turn.
 *
 * @param previousTurnAwaitingEngagement true when the previous turn was gated and ended
 *   without the developer engaging inside it; the developer's new message is that engagement.
 */
export function resolveEffectivePolicy(
  mode: CollaborationModeId,
  intent: TurnIntent,
  previousTurnAwaitingEngagement: boolean,
  context: PolicyContext = {},
): EffectivePolicy {
  const policy = getPolicy(mode);
  const base = { policy, intent, adaptation: null };

  switch (intent) {
    case "delegate":
      return {
        ...base,
        askFor: ["risk"],
        checkpointBudget: 1,
        gate: "open",
        decisions: { ask: [], style: "choice" },
        intentGuidance:
          'The developer said "Just do it": they delegated this task. Proceed without further optional questions or discussion: make sensible decisions, implement, verify, and summarize the decisions you made. Still stop for genuinely risky or irreversible steps; permission prompts and safety rules apply as always.',
      };
    case "discuss":
      return {
        ...base,
        // The developer proceeds themselves (Proceed, Just do it, a go-ahead message): no go-ahead questions.
        askFor: policy.askFor.filter((c) => c !== "confirm"),
        checkpointBudget: Math.max(policy.checkpointBudget, 2),
        gate: "hold",
        decisions: policy.detectedDecisions,
        intentGuidance: context.continuingDiscussion
          ? "You are still discussing the approach with the developer; they have not chosen to proceed. Respond to their message: answer it, weigh the options it raises, and refine your recommendation. Do not modify files: Peer keeps code changes locked until the developer chooses to proceed. When the approach is settled, say briefly what you would implement and end your turn; do not ask for a go-ahead, the developer proceeds when ready."
          : 'The developer chose "Discuss first": explore the approach before any code changes. Read the code as needed, then lay out the realistic options with their trade-offs and your recommendation, and question the premise if it is shaky. Do not modify files: Peer keeps code changes locked until the developer chooses to proceed. Do not ask for a go-ahead; end your turn with what you would implement, and the developer proceeds when ready.',
      };
    case "hint": {
      const n = Math.max(1, context.hintLevel ?? 1);
      const further = n > 1 ? ` This is hint ${n} on this problem: go one step beyond your earlier hints; do not repeat them.` : "";
      const nearly = n >= 3 ? " They have had several hints: you may point at the exact place and what to change there, but let them take the last step unless they ask for the answer." : "";
      return {
        ...base,
        askFor: policy.askFor,
        checkpointBudget: policy.checkpointBudget,
        gate: "hold",
        decisions: policy.detectedDecisions,
        intentGuidance: `The developer asked for a hint. Give the next useful hint: one concise step (where to look, what to compare, what to try) grounded in this codebase, without revealing the full solution.${further}${nearly} Do not modify files in this turn.`,
      };
    }
    case "answer":
      return {
        ...base,
        askFor: ["requirement", "risk"],
        checkpointBudget: 1,
        gate: "open",
        // A direct answer, not a Socratic question.
        decisions: { ask: policy.detectedDecisions.ask, style: "choice" },
        intentGuidance:
          "The developer asked for a direct answer. Answer the current question directly and completely, with the reasoning, without Socratic questions or asking for their hypothesis. Then continue with the task if it calls for code changes.",
      };
    case "proceed":
    case "default": {
      const handsOff = context.handsOff === true && HANDS_OFF_DROPS[mode] !== undefined;
      const drops = handsOff ? HANDS_OFF_DROPS[mode]! : [];
      return {
        ...base,
        askFor: policy.askFor.filter((c) => !drops.includes(c)),
        checkpointBudget: handsOff ? Math.min(policy.checkpointBudget, 1) : policy.checkpointBudget,
        gate: intent === "proceed" ? "open" : policy.defaultGate === "engage" && previousTurnAwaitingEngagement ? "open" : policy.defaultGate,
        decisions: policy.detectedDecisions,
        intentGuidance:
          intent === "proceed"
            ? "The developer chose to proceed with the approach you discussed. Implement what was agreed; do not reopen settled questions."
            : null,
        adaptation: handsOff
          ? mode === "learn"
            ? "The developer's last responses asked for direct answers or handed questions back to you. Keep to the one question that matters most for this task, if any, and explain more directly."
            : "The developer's last responses handed decisions back to you. Ask only about decisions with lasting consequences; make the rest yourself and report them in your summary."
          : null,
      };
    }
  }
}
