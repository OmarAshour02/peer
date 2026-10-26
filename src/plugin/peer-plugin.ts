// Peer's OpenCode plugin. It runs inside the OpenCode runtime process (bundled to a single
// file by scripts/build.mjs and installed into Peer's private OpenCode config dir).
//
// It is deliberately thin: every decision is made by Peer's collaboration engine, reached over
// a loopback bridge with a per-launch token. The plugin only enforces what the engine decides:
//   - `peer_checkpoint` blocks the agent until the developer responds (or policy declines).
//   - `tool.execute.before` rejects mutating tools while the engine's gate is locked.
import type { Plugin } from "@opencode-ai/plugin";
import { tool } from "@opencode-ai/plugin/tool";
import { isReadOnlyTool } from "../server/collaboration/tool-classification.js";
import { CHECKPOINT_CATEGORIES } from "../shared/types.js";

const BRIDGE_URL = process.env.PEER_BRIDGE_URL;
const BRIDGE_TOKEN = process.env.PEER_BRIDGE_TOKEN;
const WAIT_MS = 25_000;

async function bridge<T>(path: string, body: unknown, signal?: AbortSignal): Promise<T> {
  const res = await fetch(`${BRIDGE_URL}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-peer-bridge-token": BRIDGE_TOKEN ?? "" },
    body: JSON.stringify(body),
    signal,
  });
  if (!res.ok) throw new Error(`Peer bridge ${path} failed: ${res.status} ${await res.text()}`);
  return (await res.json()) as T;
}

/** Exit with Peer: never leave an orphaned agent runtime behind if Peer dies abruptly. */
function watchParent() {
  const parent = Number(process.env.PEER_PARENT_PID);
  if (!parent) return;
  const timer = setInterval(() => {
    try {
      process.kill(parent, 0);
    } catch {
      process.exit(0);
    }
  }, 2000);
  (timer as { unref?: () => void }).unref?.();
}

const CHECKPOINT_DESCRIPTION = `Bring a decision or question to the developer and wait for their response.
Use it for decisions that are genuinely the developer's to make (see the collaboration policy in your instructions for which categories apply this turn).
Ask one focused question. When there are discrete choices, give 2-4 short options and name the one you recommend.
The tool returns the developer's response or instructions from Peer (for example, that the policy leaves this decision to you, that they delegated it, or that they want a hint). Follow them.`;

export const PeerCollaboration: Plugin = async () => {
  if (!BRIDGE_URL || !BRIDGE_TOKEN) return {};
  watchParent();

  return {
    tool: {
      peer_checkpoint: tool({
        description: CHECKPOINT_DESCRIPTION,
        args: {
          category: tool.schema
            .enum(CHECKPOINT_CATEGORIES)
            .describe("Kind of decision"),
          question: tool.schema.string().describe("The question, one or two sentences"),
          context: tool.schema.string().optional().describe("Why this matters / what you found in the code"),
          options: tool.schema
            .array(tool.schema.object({ label: tool.schema.string(), description: tool.schema.string().optional() }))
            .optional()
            .describe("Discrete choices, if any"),
          recommendation: tool.schema.string().optional().describe("Label of the option you recommend"),
        },
        async execute(args, ctx) {
          ctx.metadata({ title: args.question.slice(0, 80) });
          const opened = await bridge<{ checkpointId: string | null; output: string | null }>(
            "/bridge/checkpoints",
            { sessionId: ctx.sessionID, callId: null, request: args },
            ctx.abort,
          );
          if (opened.output !== null || !opened.checkpointId) return opened.output ?? "Continue.";

          const id = opened.checkpointId;
          const onAbort = () => void bridge(`/bridge/checkpoints/${id}/cancel`, {}).catch(() => {});
          ctx.abort.addEventListener("abort", onAbort, { once: true });
          try {
            for (;;) {
              const res = await bridge<{ status: "pending" | "resolved" | "cancelled"; output?: string }>(
                `/bridge/checkpoints/${id}/wait`,
                { timeoutMs: WAIT_MS },
                ctx.abort,
              );
              if (res.status === "resolved") return res.output ?? "Continue.";
              if (res.status === "cancelled") return "The checkpoint was cancelled. Stop and wait for the developer.";
            }
          } finally {
            ctx.abort.removeEventListener("abort", onAbort);
          }
        },
      }),
    },

    "tool.execute.before": async (input, output) => {
      if (input.tool === "peer_checkpoint" || isReadOnlyTool(input.tool, output.args)) return;
      type Check = { allow: boolean; reason?: string } | { wait: string };
      let decision: Check;
      try {
        decision = await bridge<Check>("/bridge/tool-check", { sessionId: input.sessionID, tool: input.tool, args: output.args });
        // Peer holds the call on a checkpoint until the developer responds (Stop cancels it).
        while ("wait" in decision) decision = await bridge<Check>(`/bridge/tool-check/${decision.wait}/wait`, { timeoutMs: WAIT_MS });
      } catch (err) {
        // Fail closed: if Peer cannot be reached, do not let a mutating tool run unchecked.
        throw new Error(`Peer collaboration gate unavailable (${String(err)}); "${input.tool}" was not run.`);
      }
      if (!decision.allow) throw new Error(decision.reason ?? "Blocked by Peer collaboration gate.");
    },
  };
};
