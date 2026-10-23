import { relative } from "node:path";
import type { PeerPart, ToolStatus } from "../../../shared/types.js";
import { CHECKPOINT_TOOL } from "../../collaboration/prompt.js";
import { unwrapShell } from "../../collaboration/safety.js";

// Codex app-server thread items -> Peer transcript parts. Only the fields Peer renders are typed.

export interface CodexItem {
  type: string;
  id: string;
  [key: string]: unknown;
}

const str = (v: unknown): string => (typeof v === "string" ? v : "");

function toolStatus(status: unknown): ToolStatus {
  switch (status) {
    case "completed":
      return "completed";
    case "failed":
    case "declined":
      return "error";
    default:
      return "running";
  }
}

// Codex's sandbox has no network, so opening or reaching a socket fails with EPERM:
// Node "listen EPERM: operation not permitted 127.0.0.1", Go "listen tcp ...: bind: operation not permitted".
const SANDBOX_NETWORK_BLOCK = [/\b(?:listen|bind|connect)\s+EPERM\b/, /\b(?:listen|bind|connect|socket)\b[^\n]*\boperation not permitted\b/i];

export function isSandboxNetworkBlock(output: string): boolean {
  return SANDBOX_NETWORK_BLOCK.some((re) => re.test(output));
}

// A heuristic for "this command runs tests", over common runners, matched where a command starts.
const TEST_COMMAND =
  /^(?:(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?test|npm\s+t|(?:npx\s+|(?:pnpm|yarn|bunx?)\s+(?:exec\s+)?)?(?:vitest|jest|mocha|ava|playwright\s+test)|node\s+(?:\S+\s+)*--test|(?:python3?\s+-m\s+)?(?:pytest|unittest)|(?:go|cargo|deno|dotnet|swift|mix|mvn|gradle|\.\/gradlew|make|rake)\s+test|(?:bundle\s+exec\s+)?rspec|phpunit)(?![\w-])/;

/** The simple commands in a shell command line, without quoted text, variable assignments and `env`/`time`/`timeout` prefixes. */
function simpleCommands(command: string): string[] {
  const unquoted = unwrapShell(command).replace(/'[^']*'|"(?:[^"\\]|\\.)*"/g, "''");
  return unquoted.split(/&&|\|\||[;|&\n]/).map((c) => c.trim().replace(/^[({]\s*/, "").replace(/^(?:(?:env|time|timeout\s+\S+)\s+|\w+=\S*\s+)+/, ""));
}

export function isTestCommand(command: string): boolean {
  return simpleCommands(command).some((c) => TEST_COMMAND.test(c));
}

// Output only a test run produces: results or a summary, passing or failing. A command that never
// started its runner (`cd` failed, runner missing, no test script, a skipped `||` branch) has none.
const TEST_RESULTS =
  /^(?:not )?ok \d+\b|^# (?:pass|fail|tests)\b|\bFAIL\b|\bPASS\b|\bAssertionError\b|\b\d+ (?:passed|failed|failing|passing)\b|^\s*Tests?:|\btest result:|^--- (?:FAIL|PASS):|^ok\s+\S+\s+[\d.]+s|^Ran \d+ tests? in\b/im;

const DOC_FILE = /\.(?:md|mdx|markdown|txt|rst)$/i;

export function isDocFile(path: string): boolean {
  return DOC_FILE.test(path);
}

export const UNTESTED_CHANGE_WARNING = "Not verified: Codex changed code in this turn and ran no tests after its last change.";

/**
 * Whether one Codex turn's work was tested: commands that failed because the sandbox blocked
 * network access and were not rerun successfully (e.g. with escalated permissions), and code
 * changes with no test run after them. Detection, not prevention: it tells the developer the work
 * may be untested instead of trusting the agent's summary. Changes made through shell commands
 * don't appear as items; the adapter finds those by comparing workspace snapshots.
 */
export class TestEvidence {
  /** Directory + command -> command. Only the same command in the same directory counts as a rerun. */
  private readonly blocked = new Map<string, string>();
  /** Code changed (through apply_patch) since the last test run in this turn. */
  private untestedChange = false;

  /** Feed every completed item of the turn, in order. Returns true for a test run that reached its tests. */
  observe(item: CodexItem): boolean {
    if (item.type === "fileChange") {
      const changes = Array.isArray(item.changes) ? (item.changes as { path?: unknown }[]) : [];
      if (item.status === "completed" && changes.some((c) => !isDocFile(str(c.path)))) this.untestedChange = true;
      return false;
    }
    if (item.type !== "commandExecution") return false;
    const command = unwrapShell(str(item.command)).trim();
    const key = `${str(item.cwd)}\0${command}`;
    const output = str(item.aggregatedOutput);
    // Sandbox errors win over the exit code: `npm test | tee log` exits 0 even when the tests could not run.
    const sandboxBlocked = isSandboxNetworkBlock(output);
    if (sandboxBlocked) this.blocked.set(key, command);
    else if (item.status === "completed" && item.exitCode === 0) this.blocked.delete(key);
    const reachedTests = typeof item.exitCode === "number" && !sandboxBlocked && isTestCommand(command) && TEST_RESULTS.test(output);
    if (reachedTests) this.untestedChange = false;
    return reachedTests;
  }

  warning(): string | undefined {
    if (this.blocked.size > 0) {
      const list = [...new Set(this.blocked.values())].map((c) => `\`${c.length > 80 ? `${c.slice(0, 77)}...` : c}\``).join(", ");
      return `Not verified: Codex's sandbox blocks network access and local ports, so ${list} failed and was not rerun successfully. Tests may not have run, whatever the summary says.`;
    }
    return this.untestedChange ? UNTESTED_CHANGE_WARNING : undefined;
  }
}

/** Peer part for a Codex item, or null for items Peer does not show (user input, plans, ...). */
export function normalizeItem(item: CodexItem, directory: string): PeerPart | null {
  switch (item.type) {
    case "agentMessage":
      return { type: "text", id: item.id, text: str(item.text) };
    case "reasoning": {
      const summary = Array.isArray(item.summary) ? item.summary.map(str).join("\n\n") : "";
      return summary ? { type: "reasoning", id: item.id, text: summary } : null;
    }
    case "commandExecution": {
      const status = toolStatus(item.status);
      const output = str(item.aggregatedOutput).slice(-20_000);
      const exit = typeof item.exitCode === "number" ? item.exitCode : null;
      return {
        type: "tool",
        id: item.id,
        tool: "bash",
        callId: item.id,
        status,
        input: { command: unwrapShell(str(item.command)) },
        output: output || undefined,
        error: item.status === "declined" ? "Declined" : status === "error" ? output || `Exited with ${exit}` : undefined,
      };
    }
    case "fileChange": {
      const changes = Array.isArray(item.changes) ? (item.changes as { path?: unknown; diff?: unknown }[]) : [];
      const files = changes.map((c) => relative(directory, str(c.path)) || str(c.path));
      const status = toolStatus(item.status);
      return {
        type: "tool",
        id: item.id,
        tool: "edit",
        callId: item.id,
        status,
        title: files.join(", "),
        input: { filePath: files.join(", ") },
        diff: changes.map((c) => str(c.diff)).filter(Boolean).join("\n") || undefined,
        error: item.status === "declined" ? "Declined" : status === "error" ? "The patch was not applied" : undefined,
      };
    }
    case "dynamicToolCall": {
      const contentItems = Array.isArray(item.contentItems) ? (item.contentItems as { text?: unknown }[]) : [];
      const args = item.arguments && typeof item.arguments === "object" ? (item.arguments as Record<string, unknown>) : {};
      const output = contentItems.map((c) => str(c.text)).join("\n");
      const status = toolStatus(item.status);
      return {
        type: "tool",
        id: item.id,
        tool: str(item.tool) || CHECKPOINT_TOOL,
        callId: item.id,
        status: item.success === false ? "error" : status,
        input: args,
        output: output || undefined,
        error: item.success === false ? output || "Failed" : undefined,
      };
    }
    case "mcpToolCall": {
      const args = item.arguments && typeof item.arguments === "object" ? (item.arguments as Record<string, unknown>) : {};
      const result = item.result as { content?: { text?: unknown }[] } | null;
      const error = (item.error as { message?: string } | null)?.message;
      return {
        type: "tool",
        id: item.id,
        tool: `${str(item.server)}_${str(item.tool)}`,
        callId: item.id,
        status: error ? "error" : toolStatus(item.status),
        title: `${str(item.server)}: ${str(item.tool)}`,
        input: args,
        output: result?.content?.map((c) => str(c.text)).join("\n") || undefined,
        error,
      };
    }
    case "webSearch":
      return { type: "tool", id: item.id, tool: "websearch", callId: item.id, status: "completed", title: str(item.query), input: { query: item.query } };
    default:
      return null;
  }
}
