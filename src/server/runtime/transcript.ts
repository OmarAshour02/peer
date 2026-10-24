import type { PeerMessage, PeerMessageInfo, PeerPart, RuntimeKind } from "../../shared/types.js";
import type { RuntimeEvent } from "./adapter.js";

/** The slice of the store an in-process adapter uses for its own persistence. */
export interface RuntimeStorage {
  getRuntimeState<T>(runtime: RuntimeKind, sessionId: string): T | null;
  setRuntimeState(runtime: RuntimeKind, sessionId: string, state: unknown): void;
  listTranscript(runtime: RuntimeKind, sessionId: string): PeerMessage[];
  saveTranscriptMessage(runtime: RuntimeKind, sessionId: string, message: PeerMessage): void;
  deleteTranscriptMessages(runtime: RuntimeKind, sessionId: string, messageIds: string[]): void;
}

/**
 * The normalized transcript of one runtime session, for runtimes whose native history Peer does
 * not read back (Claude Code, Codex). Every change is persisted and emitted as the same runtime
 * events OpenCode produces, so the service and UI treat all runtimes alike. Streaming deltas are
 * emitted immediately and persisted with the next part update.
 */
export class Transcript {
  private readonly messages = new Map<string, PeerMessage>();
  private lastCreatedAt = 0;

  constructor(
    private readonly kind: RuntimeKind,
    private readonly sessionId: string,
    private readonly storage: RuntimeStorage,
    private readonly emit: (event: RuntimeEvent) => void,
  ) {
    for (const m of storage.listTranscript(kind, sessionId)) {
      this.messages.set(m.id, m);
      this.lastCreatedAt = Math.max(this.lastCreatedAt, m.createdAt);
    }
  }

  list(): PeerMessage[] {
    return [...this.messages.values()];
  }

  has(messageId: string): boolean {
    return this.messages.has(messageId);
  }

  /** Forget every message created at or after `since` (an undone turn and anything after it). */
  dropSince(since: number): number {
    const dropped = [...this.messages.values()].filter((m) => m.createdAt >= since).map((m) => m.id);
    for (const id of dropped) this.messages.delete(id);
    this.storage.deleteTranscriptMessages(this.kind, this.sessionId, dropped);
    return dropped.length;
  }

  /** Strictly increasing timestamps keep the UI's createdAt ordering stable. */
  private now(): number {
    this.lastCreatedAt = Math.max(Date.now(), this.lastCreatedAt + 1);
    return this.lastCreatedAt;
  }

  addUserMessage(id: string, text: string) {
    const message: PeerMessage = { id, role: "user", createdAt: this.now(), parts: [] };
    this.messages.set(id, message);
    this.emitInfo(message);
    this.upsertPart(id, { type: "text", id: `${id}:text`, text });
  }

  startAssistantMessage(id: string, info: Partial<Pick<PeerMessageInfo, "providerId" | "modelId">> = {}) {
    if (this.messages.has(id)) return;
    const message: PeerMessage = { id, role: "assistant", createdAt: this.now(), parts: [], ...info };
    this.messages.set(id, message);
    this.save(message);
    this.emitInfo(message);
  }

  part(messageId: string, partId: string): PeerPart | undefined {
    return this.messages.get(messageId)?.parts.find((p) => p.id === partId);
  }

  upsertPart(messageId: string, part: PeerPart) {
    const message = this.messages.get(messageId);
    if (!message) return;
    const idx = message.parts.findIndex((p) => p.id === part.id);
    if (idx === -1) message.parts.push(part);
    else message.parts[idx] = part;
    this.save(message);
    this.emit({ type: "part.updated", sessionId: this.sessionId, messageId, part });
  }

  /** Append streamed text to a text/reasoning part, creating it on the first delta. */
  appendText(messageId: string, partId: string, type: "text" | "reasoning", delta: string) {
    const message = this.messages.get(messageId);
    if (!message || !delta) return;
    const part = message.parts.find((p) => p.id === partId);
    if (!part) {
      this.upsertPart(messageId, { type, id: partId, text: delta });
      return;
    }
    if (part.type !== "text" && part.type !== "reasoning") return;
    part.text += delta;
    this.emit({ type: "part.delta", sessionId: this.sessionId, messageId, partId, field: "text", delta });
  }

  completeMessage(messageId: string, error?: string, warning?: string) {
    const message = this.messages.get(messageId);
    if (!message || message.completedAt) return;
    message.completedAt = Date.now();
    if (error) message.error = error;
    if (warning) message.warning = warning;
    this.save(message);
    this.emitInfo(message);
  }

  /** Mark tool calls that never finished (stop, crash) so they don't spin forever. */
  failRunningTools(messageId: string, reason: string) {
    const message = this.messages.get(messageId);
    if (!message) return;
    for (const part of message.parts) {
      if (part.type === "tool" && (part.status === "running" || part.status === "pending")) {
        this.upsertPart(messageId, { ...part, status: "error", error: reason });
      }
    }
  }

  private save(message: PeerMessage) {
    this.storage.saveTranscriptMessage(this.kind, this.sessionId, message);
  }

  private emitInfo(message: PeerMessage) {
    const { parts: _parts, ...info } = message;
    this.emit({ type: "message.updated", sessionId: this.sessionId, message: info });
  }
}

/** First line of a prompt, shortened: the title for runtimes that don't name sessions themselves. */
export function titleFromPrompt(text: string): string {
  const line = text.trim().split("\n")[0]?.trim() ?? "";
  return line.length > 60 ? `${line.slice(0, 57).trimEnd()}…` : line || "Untitled session";
}
