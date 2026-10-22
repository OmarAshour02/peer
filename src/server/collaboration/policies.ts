import type { CheckpointCategory, CollaborationModeId, GateKind, TurnIntent } from "../../shared/types.js";

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
  /** Mode-specific behavioral guidance for the agent. */
  guidance: readonly string[];
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
  focus: {
    mode: "focus",
    label: "Focus",
    tagline: "Execute with minimal interruption.",
    askFor: ["architecture", "requirement", "risk"],
    checkpointBudget: 1,
    defaultGate: "open",
    hints: false,
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
    tagline: "Work like an experienced engineering teammate.",
    askFor: ["architecture", "tradeoff", "requirement", "risk", "confirm"],
    checkpointBudget: 3,
    defaultGate: "open",
    hints: false,
    guidance: [
      "Behave like an experienced engineer pairing with a peer.",
      "Before significant implementation (new modules, data model changes, new dependencies, cross-cutting changes), explore the code, then propose an approach and agree on it with the developer through a checkpoint before editing.",
      "When there are real alternatives, present them with concrete trade-offs and say which you would pick and why.",
      "Respectfully challenge questionable assumptions in the request or the existing code when it matters for the outcome.",
      "Proceed independently on mechanical or routine work (renames, boilerplate, wiring, obvious fixes) without asking.",
      "Once a decision is agreed, carry it out without re-asking.",
    ],
  },
  learn: {
    mode: "learn",
    label: "Learn",
    tagline: "Build understanding while still getting the work done.",
    askFor: ["architecture", "tradeoff", "requirement", "risk", "hypothesis", "concept", "confirm"],
    checkpointBudget: 4,
    defaultGate: "engage",
    hints: true,
    guidance: [
      "The developer is prioritizing their own understanding and skill. You remain a fully capable coding agent.",
      "Before giving a complete solution to a meaningful problem, invite the developer to form a hypothesis or make the key decision. Ask one focused question grounded in this codebase, not a generic quiz.",
      "When diagnosing errors, help the developer reason about the cause (what the error says, where to look) before fixing it for them.",
      "Explain concepts through the real code in this repository: point to concrete files, functions, and lines.",
      "Offer progressive hints: each hint should move the developer one step closer without giving the answer away.",
      "Automate boilerplate, repetitive edits, and mechanical work without turning them into lessons.",
      "If the developer wants to move on, move on. Never force a lengthy lesson.",
      "After implementing, briefly connect what was done to the concept discussed.",
    ],
  },
};

export function getPolicy(mode: CollaborationModeId): CollaborationPolicy {
  return POLICIES[mode];
}

/** The effective rules for one turn: the mode policy adjusted by the developer's explicit intent. */
export interface EffectivePolicy {
  policy: CollaborationPolicy;
  intent: TurnIntent;
  askFor: readonly CheckpointCategory[];
  checkpointBudget: number;
  gate: GateKind;
  intentGuidance: string | null;
}

export const INTENT_LABELS: Record<TurnIntent, string> = {
  default: "Default",
  delegate: "Just do it",
  discuss: "Discuss first",
  hint: "Hint",
  answer: "Direct answer",
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
): EffectivePolicy {
  const policy = getPolicy(mode);
  const base = { policy, intent };

  switch (intent) {
    case "delegate":
      return {
        ...base,
        askFor: ["risk"],
        checkpointBudget: 1,
        gate: "open",
        intentGuidance:
          "The developer delegated this task: do not ask about approach or preferences. Make sensible decisions, implement, verify, and summarize the decisions you made. Only stop for genuinely risky or irreversible steps.",
      };
    case "discuss":
      return {
        ...base,
        askFor: policy.askFor,
        checkpointBudget: Math.max(policy.checkpointBudget, 2),
        gate: "hold",
        intentGuidance:
          "The developer wants to discuss before any code changes. Explore the code as needed, then lay out the options, trade-offs, and your recommendation. Do not modify files in this turn.",
      };
    case "hint":
      return {
        ...base,
        askFor: policy.askFor,
        checkpointBudget: policy.checkpointBudget,
        gate: "hold",
        intentGuidance:
          "The developer asked for a hint. Give one concise hint that moves them a step forward without revealing the full solution. Do not modify files in this turn.",
      };
    case "answer":
      return {
        ...base,
        askFor: ["requirement", "risk"],
        checkpointBudget: 1,
        gate: "open",
        intentGuidance:
          "The developer asked for a direct answer. Give the complete answer or solution directly, without Socratic questions, then implement if the request calls for it.",
      };
    case "default":
      return {
        ...base,
        askFor: policy.askFor,
        checkpointBudget: policy.checkpointBudget,
        gate: policy.defaultGate === "engage" && previousTurnAwaitingEngagement ? "open" : policy.defaultGate,
        intentGuidance: null,
      };
  }
}
