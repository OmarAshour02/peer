import type { TurnIntent } from "../../shared/types.js";

const COMMANDS: Record<string, TurnIntent> = {
  "/go": "delegate",
  "/do": "delegate",
  "/delegate": "delegate",
  "/discuss": "discuss",
  "/hint": "hint",
  "/answer": "answer",
  "/proceed": "proceed",
};

/**
 * Extract an explicit intent from a leading slash command, e.g. "/go add a test".
 * An explicit intent from the UI wins over a slash command.
 */
export function parseIntent(text: string, explicit?: TurnIntent): { intent: TurnIntent; text: string } {
  const match = /^\s*(\/[a-z]+)(?:\s+|$)/i.exec(text);
  const command = match ? COMMANDS[match[1]!.toLowerCase()] : undefined;
  const stripped = command && match ? text.slice(match[0].length).trim() : text.trim();
  if (explicit && explicit !== "default") return { intent: explicit, text: stripped };
  return { intent: command ?? "default", text: stripped };
}

/** An optional acknowledgement, then a bare go-ahead, then an optional "please"/"now", and nothing else. */
const GO_AHEAD =
  /^(?:(?:ok|okay|alright|yes|yep|yeah|sure|great|perfect|agreed|sounds good|looks good|lgtm)[\s,.!]+)?(?:(?:please|then|so)\s+)?(?:go ahead|proceed|do it|go for it|ship it|implement it|build it|make the changes?|let'?s do it|let'?s go|let'?s proceed|start implementing|you can proceed|you can go ahead)(?:[\s,]+(?:please|now|then))*[\s.!]*$/i;

/**
 * Whether a message only tells the agent to go ahead ("Go ahead.", "OK, proceed", "lgtm, ship it").
 * During "Discuss first" such a message ends the discussion; any other message, including a
 * go-ahead with more to it ("go ahead and compare both"), keeps discussing.
 */
export function isGoAhead(text: string): boolean {
  return GO_AHEAD.test(text.trim());
}
