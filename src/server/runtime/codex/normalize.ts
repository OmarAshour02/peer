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
