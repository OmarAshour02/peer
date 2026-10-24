import type { CheckpointCategory, DecisionKind } from "../../shared/types.js";
import { SHARED_PRINCIPLES, type EffectivePolicy } from "./policies.js";

/** Default checkpoint tool name; runtimes that namespace tools (Claude Code's MCP) report their own. */
export const CHECKPOINT_TOOL = "peer_checkpoint";

const DECISION_DESCRIPTIONS: Record<DecisionKind, string> = {
  dependency: "adding a new dependency (an install command or a manifest edit)",
};

const CATEGORY_DESCRIPTIONS: Record<CheckpointCategory, string> = {
  architecture: "structural decisions with lasting consequences (data model, new dependency, public API)",
  tradeoff: "choosing between viable alternatives where the developer's preference matters",
  requirement: "ambiguity in what is wanted that materially changes the result",
  risk: "risky or irreversible steps, or significant uncertainty",
  hypothesis: "asking the developer to predict or diagnose before you tell them",
  concept: "checking understanding of a concept this task depends on",
  confirm: "a go-ahead on a concrete plan",
};

function gateInstruction(plan: EffectivePolicy, tool: string): string {
  switch (plan.gate) {
    case "open":
      return "Code changes: allowed.";
    case "engage":
      return `Code changes: locked by Peer until the developer engages on this task (answers a ${tool} question, delegates, or skips). Reading and exploring the code is allowed. Attempted edits will be rejected; do not try to work around this. Purely mechanical work can be unlocked with a one-option "confirm" checkpoint.`;
    case "hold":
      return "Code changes: locked by Peer for this turn. Reading and exploring the code is allowed; do not attempt edits.";
  }
}

/**
 * Compose the per-turn system instructions. They are sent with every prompt so the active
 * policy always applies, regardless of conversation history or which skills are loaded.
 */
export function composeSystemPrompt(plan: EffectivePolicy, tool: string = CHECKPOINT_TOOL): string {
  const { policy } = plan;
  const categories = plan.askFor.map((c) => `- ${c}: ${CATEGORY_DESCRIPTIONS[c]}`).join("\n");

  return [
    "# Peer collaboration policy",
    "You are the coding agent inside Peer, a workspace that automates tedious work, collaborates on meaningful work, and preserves the thinking that helps developers grow.",
    "",
    `## Active mode: ${policy.label}. ${policy.tagline}`,
    ...policy.guidance.map((g) => `- ${g}`),
    "",
    "## Shared principles (all modes)",
    ...SHARED_PRINCIPLES.map((p) => `- ${p}`),
    "",
    "## This turn",
    plan.intentGuidance ? `- Developer intent: ${plan.intentGuidance}` : "- Developer intent: none beyond the message itself.",
    `- ${gateInstruction(plan, tool)}`,
    "",
    "## Checkpoints",
    `To bring a decision or question to the developer, call the \`${tool}\` tool. It pauses your work until the developer responds, then returns their response. Do not use any other question or ask-user tool (such as \`question\` or \`AskUserQuestion\`) and do not end your turn just to ask something you could ask with a checkpoint.`,
    `- Categories the developer decides in this turn (others are declined by Peer and you decide yourself):\n${categories}`,
    `- At most ${plan.checkpointBudget} checkpoint(s) this turn (risk checkpoints excluded). Ask one focused question per checkpoint.`,
    "- Give 2-4 short options when there are discrete choices, and name the one you recommend. Use context to say why the decision matters.",
    "- The developer may answer, pick an option, delegate the decision back to you, skip the discussion, or ask for a hint. Follow the instructions in the tool result.",
    ...(plan.decisions.ask.length > 0
      ? [
          `- Peer itself pauses some actions before they run and asks the developer: ${plan.decisions.ask.map((k) => DECISION_DESCRIPTIONS[k]).join("; ")}. It does not ask again about one the developer already approved or asked for. If Peer rejects such a call with the developer's response, follow that response.`,
        ]
      : []),
    "",
    "## Safety",
    "Destructive commands and access outside the workspace are governed by separate permission rules in every mode; the developer approves them explicitly. Never try to bypass a denied permission.",
  ].join("\n");
}
