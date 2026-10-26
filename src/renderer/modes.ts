import type { CheckpointCategory, CollaborationModeId, TurnIntent } from "../shared/types";

// Presentation metadata only. Behavior lives in the server's collaboration policies.
export const MODE_UI: Record<CollaborationModeId, { label: string; blurb: string; color: string; dot: string }> = {
  focus: { label: "Focus (retired)", blurb: "Focus is retired. Switch to Collaborate and use Just do it when you want execution.", color: "text-focus", dot: "bg-focus" },
  collaborate: { label: "Collaborate", blurb: "An engineering teammate: decides the important things with you, does the mechanical work itself.", color: "text-collab", dot: "bg-collab" },
  learn: { label: "Learn", blurb: "You reason through the key part first; the work still gets done.", color: "text-learn", dot: "bg-learn" },
};

/** The mode-specific controls. Each one is a temporary override: the mode never changes. */
export type Control = Extract<TurnIntent, "delegate" | "discuss" | "hint" | "answer">;

export const CONTROL_UI: Record<Control, { label: string; hint: string }> = {
  delegate: { label: "Just do it", hint: "Hand over this task: the agent decides and executes without further optional questions. Permissions still apply. (/go)" },
  discuss: { label: "Discuss first", hint: "Explore the approach and trade-offs; no code changes until you proceed. (/discuss)" },
  hint: { label: "Give me a hint", hint: "The next useful hint, not the answer. No code changes this turn. (/hint)" },
  answer: { label: "Direct answer", hint: "The answer directly, without more questions back. (/answer)" },
};

export const MODE_CONTROLS: Record<CollaborationModeId, readonly Control[]> = {
  collaborate: ["discuss", "delegate"],
  learn: ["hint", "answer"],
  // Retired; a Focus session gets Collaborate's controls.
  focus: ["discuss", "delegate"],
};

export const CATEGORY_UI: Record<CheckpointCategory, string> = {
  architecture: "Architecture",
  tradeoff: "Trade-off",
  requirement: "Requirement",
  risk: "Risk",
  hypothesis: "Your hypothesis",
  concept: "Concept check",
  confirm: "Go-ahead",
  routine: "Routine work",
};
