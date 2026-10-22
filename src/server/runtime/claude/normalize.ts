// Map Claude Code tool calls onto Peer's normalized tool vocabulary (the OpenCode names the
// collaboration gate and the UI already understand).

/** Claude Code tool name -> Peer tool name. Unlisted tools keep their (lowercased) name. */
const TOOL_NAMES: Record<string, string> = {
  Read: "read",
  Glob: "glob",
  Grep: "grep",
  LS: "list",
  WebFetch: "webfetch",
  WebSearch: "websearch",
  TodoWrite: "todowrite",
  TaskCreate: "todowrite",
  TaskUpdate: "todowrite",
  TaskList: "todowrite",
  TaskGet: "todowrite",
  Skill: "skill",
  LSP: "lsp",
  // Subagents: their own tool calls go through the same hooks, so the call itself is read-only.
  Agent: "task",
  Task: "task",
  // Loads deferred tool schemas; runs nothing.
  ToolSearch: "read",
  ListMcpResourcesTool: "read",
  ReadMcpResourceTool: "read",
  Bash: "bash",
  Edit: "edit",
  MultiEdit: "edit",
  NotebookEdit: "edit",
  Write: "write",
};

export const CLAUDE_CHECKPOINT_TOOL = "mcp__peer__checkpoint";

export function peerToolName(claudeTool: string): string {
  if (claudeTool === CLAUDE_CHECKPOINT_TOOL) return "peer_checkpoint";
  return TOOL_NAMES[claudeTool] ?? claudeTool.toLowerCase();
}

/** Tool input in Peer's shape (camelCase `filePath`, etc.) so tool cards render the same everywhere. */
export function peerToolInput(claudeTool: string, input: unknown): Record<string, unknown> {
  const i = input && typeof input === "object" ? { ...(input as Record<string, unknown>) } : {};
  if (typeof i.file_path === "string") i.filePath = i.file_path;
  if (typeof i.notebook_path === "string") i.filePath = i.notebook_path;
  if (claudeTool === "Agent" || claudeTool === "Task") i.description ??= i.prompt;
  return i;
}

interface StructuredHunk {
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
  lines: string[];
}

/**
 * Unified diff for an Edit/Write result. Claude Code reports `structuredPatch` hunks (and the full
 * content for newly created files) in the tool result.
 */
export function toolResultDiff(result: unknown): string | undefined {
  if (!result || typeof result !== "object") return undefined;
  const r = result as { filePath?: unknown; structuredPatch?: unknown; type?: unknown; content?: unknown };
  const file = typeof r.filePath === "string" ? r.filePath : "file";
  const hunks = Array.isArray(r.structuredPatch) ? (r.structuredPatch as StructuredHunk[]) : [];
  if (hunks.length > 0) {
    const body = hunks.map((h) => [`@@ -${h.oldStart},${h.oldLines} +${h.newStart},${h.newLines} @@`, ...h.lines].join("\n"));
    return [`--- a/${file}`, `+++ b/${file}`, ...body].join("\n");
  }
  if (r.type === "create" && typeof r.content === "string") {
    const lines = r.content.replace(/\n$/, "").split("\n");
    return [`--- /dev/null`, `+++ b/${file}`, `@@ -0,0 +1,${lines.length} @@`, ...lines.map((l) => `+${l}`)].join("\n");
  }
  return undefined;
}

/** Plain text of a tool_result content block (string or text blocks). */
export function toolResultText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((b) => (b && typeof b === "object" && (b as { type?: unknown }).type === "text" ? String((b as { text?: unknown }).text ?? "") : ""))
    .filter(Boolean)
    .join("\n");
}
