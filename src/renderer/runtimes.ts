import type { RuntimeKind, RuntimeStatus } from "../shared/types";

/** UI labels for the coding-agent runtimes. */
export const RUNTIME_UI: Record<RuntimeKind, { label: string; short: string; setup: string }> = {
  opencode: { label: "OpenCode", short: "OpenCode", setup: "Connect one under Models & providers (or with `opencode auth login`)." },
  claude: { label: "Claude Code", short: "Claude", setup: "Install Claude Code and run `claude auth login`, then restart the runtime." },
  codex: { label: "Codex", short: "Codex", setup: "Install the Codex CLI and run `codex login`, then restart the runtime." },
  gemini: { label: "Gemini CLI", short: "Gemini", setup: "Install the Gemini CLI and sign in, then restart the runtime." },
};

export function statusDot(status: RuntimeStatus): string {
  if (status.state === "ready") return status.warning ? "bg-warn" : "bg-focus";
  return status.state === "error" || status.state === "unavailable" ? "bg-danger" : "bg-warn";
}
