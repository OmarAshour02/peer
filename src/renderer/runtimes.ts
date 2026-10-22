import type { RuntimeKind, RuntimeStatus } from "../shared/types";

/** UI labels for the coding-agent runtimes. */
export const RUNTIME_UI: Record<RuntimeKind, { label: string; short: string; setup: string }> = {
  opencode: { label: "OpenCode", short: "OpenCode", setup: "Configure a provider with `opencode auth login` (or your OpenCode config), then restart the runtime." },
  claude: { label: "Claude Code", short: "Claude", setup: "Install Claude Code and run `claude auth login`, then restart the runtime." },
  codex: { label: "Codex", short: "Codex", setup: "Install the Codex CLI and run `codex login`, then restart the runtime." },
};

export function statusDot(status: RuntimeStatus): string {
  return status.state === "ready" ? "bg-focus" : status.state === "error" || status.state === "unavailable" ? "bg-danger" : "bg-warn";
}
