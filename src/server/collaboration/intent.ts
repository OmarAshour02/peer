import type { TurnIntent } from "../../shared/types.js";

const COMMANDS: Record<string, TurnIntent> = {
  "/go": "delegate",
  "/do": "delegate",
  "/delegate": "delegate",
  "/discuss": "discuss",
  "/hint": "hint",
  "/answer": "answer",
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
