import type {
  Event as OcEvent,
  Message as OcMessage,
  Part as OcPart,
  PermissionRequest as OcPermissionRequest,
  SnapshotFileDiff,
} from "@opencode-ai/sdk/v2";
import type { FileDiff, PeerMessageInfo, PeerPart, PermissionRequest } from "../../../shared/types.js";
import type { RuntimeEvent } from "../adapter.js";

export function normalizePart(part: OcPart): PeerPart | null {
  switch (part.type) {
    case "text":
      return { type: "text", id: part.id, text: part.text, synthetic: part.synthetic };
    case "reasoning":
      return { type: "reasoning", id: part.id, text: part.text };
    case "tool": {
      const s = part.state;
      const metadata = ("metadata" in s ? s.metadata : undefined) ?? {};
      const diff = typeof metadata.diff === "string" ? metadata.diff : undefined;
      return {
        type: "tool",
        id: part.id,
        tool: part.tool,
        callId: part.callID,
        status: s.status,
        title: "title" in s ? s.title : undefined,
        input: (s.input ?? {}) as Record<string, unknown>,
        output: s.status === "completed" ? s.output : undefined,
        error: s.status === "error" ? s.error : undefined,
        diff,
      };
    }
    case "patch":
      return { type: "patch", id: part.id, files: part.files };
    case "step-finish":
      return { type: "step-finish", id: part.id, tokens: { input: part.tokens.input, output: part.tokens.output }, cost: part.cost };
    case "file":
      return { type: "file", id: part.id, filename: part.filename ?? "file", mime: part.mime };
    default:
      return null;
  }
}

export function normalizeMessage(info: OcMessage): PeerMessageInfo {
  if (info.role === "user") {
    return { id: info.id, role: "user", createdAt: info.time.created, providerId: info.model.providerID, modelId: info.model.modelID };
  }
  return {
    id: info.id,
    role: "assistant",
    createdAt: info.time.created,
    completedAt: info.time.completed,
    error: info.error ? errorMessage(info.error) : undefined,
    providerId: info.providerID,
    modelId: info.modelID,
  };
}

export function normalizePermission(req: OcPermissionRequest): PermissionRequest {
  return { id: req.id, sessionId: req.sessionID, permission: req.permission, patterns: req.patterns, metadata: req.metadata };
}

export function normalizeDiff(diff: SnapshotFileDiff[]): FileDiff[] {
  return diff.map((d) => ({ file: d.file ?? "(unknown)", additions: d.additions, deletions: d.deletions, status: d.status, patch: d.patch }));
}

/** Combine per-turn diffs into one entry per file (counts summed, patches in turn order). */
export function mergeTurnDiffs(turns: FileDiff[][]): FileDiff[] {
  const byFile = new Map<string, FileDiff>();
  for (const turn of turns) {
    for (const d of turn) {
      const prev = byFile.get(d.file);
      byFile.set(
        d.file,
        prev
          ? {
              file: d.file,
              additions: prev.additions + d.additions,
              deletions: prev.deletions + d.deletions,
              status: prev.status === "added" && d.status !== "deleted" ? "added" : d.status,
              patch: [prev.patch, d.patch].filter(Boolean).join("\n") || undefined,
            }
          : d,
      );
    }
  }
  return [...byFile.values()];
}

export function errorMessage(error: unknown): string {
  if (!error || typeof error !== "object") return String(error ?? "Unknown error");
  const e = error as { name?: string; data?: { message?: string; providerID?: string } };
  if (e.name === "ProviderAuthError") {
    return `Provider "${e.data?.providerID}" is not authenticated: ${e.data?.message ?? ""}. Run \`opencode auth login\` and restart the runtime.`;
  }
  if (e.name === "MessageAbortedError") return "Stopped.";
  return e.data?.message || e.name || "Unknown error";
}

export function normalizeEvent(event: OcEvent): RuntimeEvent | null {
  switch (event.type) {
    case "session.created":
    case "session.updated": {
      const info = event.properties.info;
      return { type: "session.updated", sessionId: info.id, title: info.title, parentId: info.parentID ?? null };
    }
    case "session.status": {
      const { sessionID, status } = event.properties;
      return { type: "session.status", sessionId: sessionID, status: status.type, message: status.type === "retry" ? status.message : undefined };
    }
    case "session.idle":
      return { type: "session.idle", sessionId: event.properties.sessionID };
    case "session.error":
      if (!event.properties.sessionID) return null;
      return { type: "session.error", sessionId: event.properties.sessionID, error: errorMessage(event.properties.error) };
    case "session.diff":
      return { type: "session.diff", sessionId: event.properties.sessionID, diff: normalizeDiff(event.properties.diff) };
    case "message.updated":
      return { type: "message.updated", sessionId: event.properties.sessionID, message: normalizeMessage(event.properties.info) };
    case "message.part.updated": {
      const part = normalizePart(event.properties.part);
      if (!part) return null;
      return { type: "part.updated", sessionId: event.properties.sessionID, messageId: event.properties.part.messageID, part };
    }
    case "message.part.delta": {
      const p = event.properties;
      return { type: "part.delta", sessionId: p.sessionID, messageId: p.messageID, partId: p.partID, field: p.field, delta: p.delta };
    }
    case "permission.asked":
      return { type: "permission.asked", request: normalizePermission(event.properties) };
    case "permission.replied":
      return { type: "permission.replied", sessionId: event.properties.sessionID, requestId: event.properties.requestID };
    default:
      return null;
  }
}
