import type { QueuedMessage, TurnIntent } from "../shared/types";

// The composer's queued message: pure helpers, testable without a DOM.

/** The slash command that carries an intent, so a returned message keeps its control as text. */
const INTENT_COMMAND: Partial<Record<TurnIntent, string>> = {
  delegate: "/go",
  discuss: "/discuss",
  hint: "/hint",
  answer: "/answer",
  proceed: "/proceed",
};

/** A queued message as composer text: its control comes back as the slash command that means it. */
export function queuedAsDraft(queued: Pick<QueuedMessage, "text" | "intent">): string {
  const command = INTENT_COMMAND[queued.intent];
  const text = queued.text.trim();
  return command ? `${command}${text ? ` ${text}` : ""}` : text;
}

/**
 * A message that left the queue unsent goes back into the composer. Whatever the developer was
 * already writing stays, after it; nothing they typed is ever replaced.
 */
export function withReturnedDraft(draft: string, returned: Pick<QueuedMessage, "text" | "intent">): string {
  const back = queuedAsDraft(returned);
  if (!back) return draft;
  return draft.trim() ? `${back}\n\n${draft}` : back;
}

/** The control a queued message carries, as the composer names it (none for a plain message). */
export function queuedControlLabel(intent: TurnIntent): string | null {
  switch (intent) {
    case "delegate":
      return "Just do it";
    case "discuss":
      return "Discuss first";
    case "hint":
      return "Give me a hint";
    case "answer":
      return "Direct answer";
    case "proceed":
      return "Proceed";
    default:
      return null;
  }
}
