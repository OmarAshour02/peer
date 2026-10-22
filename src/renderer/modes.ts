import type { CheckpointCategory, CollaborationModeId, TurnIntent } from "../shared/types";

// Presentation metadata only. Behavior lives in the server's collaboration policies.
export const MODE_UI: Record<CollaborationModeId, { label: string; blurb: string; color: string; dot: string }> = {
  focus: { label: "Focus", blurb: "Executes autonomously; interrupts only for risk and architecture.", color: "text-focus", dot: "bg-focus" },
  collaborate: { label: "Collaborate", blurb: "Discusses approach and trade-offs on meaningful decisions.", color: "text-collab", dot: "bg-collab" },
  learn: { label: "Learn", blurb: "You reason first; code changes unlock once you engage.", color: "text-learn", dot: "bg-learn" },
};

export const INTENT_UI: Record<Exclude<TurnIntent, "default">, { label: string; hint: string }> = {
  delegate: { label: "Just do it", hint: "/go: skip discussion; the agent decides and executes" },
  discuss: { label: "Discuss first", hint: "/discuss: no code changes this turn" },
  hint: { label: "Hint", hint: "/hint: a nudge, not the answer" },
  answer: { label: "Direct answer", hint: "/answer: the full answer, no Socratic questions" },
};

export const CATEGORY_UI: Record<CheckpointCategory, string> = {
  architecture: "Architecture",
  tradeoff: "Trade-off",
  requirement: "Requirement",
  risk: "Risk",
  hypothesis: "Your hypothesis",
  concept: "Concept check",
  confirm: "Go-ahead",
};
