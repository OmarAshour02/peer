import { createOpencodeClient, type Event as OcEvent, type OpencodeClient } from "@opencode-ai/sdk/v2";
import type { ModelRef, ModelsResponse, PeerMessage, PermissionReply, RuntimeStatus } from "../../../shared/types.js";
import type { AgentRuntimeAdapter, PromptInput, RuntimeEvent } from "../adapter.js";
import { CHECKPOINT_TOOL } from "../../collaboration/prompt.js";
import { OpenCodeProcess, type OpenCodeProcessOptions } from "./process.js";
import { errorMessage, mergeTurnDiffs, normalizeDiff, normalizeEvent, normalizeMessage, normalizePart, normalizePermission } from "./normalize.js";

const MAX_RESTARTS = 5;
const RESTART_WINDOW_MS = 2 * 60_000;

/**
 * OpenCode implementation of the runtime boundary. Peer owns the `opencode serve` process
 * (loopback only, random password, isolated storage) and talks to it with the official SDK.
 */
export class OpenCodeAdapter implements AgentRuntimeAdapter {
  readonly kind = "opencode" as const;
  readonly name = "OpenCode";
  readonly checkpointTool = CHECKPOINT_TOOL;
  private readonly process: OpenCodeProcess;
  private client: OpencodeClient | null = null;
  private current: RuntimeStatus = { state: "stopped" };
  private readonly listeners = new Set<(event: RuntimeEvent) => void>();
  private eventAbort: AbortController | null = null;
  private restarts: number[] = [];
  private stopped = false;

  constructor(private readonly opts: OpenCodeProcessOptions) {
    this.process = new OpenCodeProcess(opts);
  }

  status(): RuntimeStatus {
    return this.current;
  }

  onEvent(listener: (event: RuntimeEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private emit(event: RuntimeEvent) {
    for (const listener of this.listeners) {
      try {
        listener(event);
      } catch (err) {
        this.opts.log(`[peer] runtime listener failed: ${String(err)}`);
      }
    }
  }

  private setStatus(status: RuntimeStatus) {
    this.current = status;
    this.emit({ type: "runtime.status", status });
  }

  async start(): Promise<void> {
    this.stopped = false;
    this.setStatus({ state: "starting" });
    try {
      const { url, password } = await this.process.start((code, signal) => void this.handleCrash(code, signal));
      const authorization = `Basic ${Buffer.from(`opencode:${password}`).toString("base64")}`;
      this.client = createOpencodeClient({ baseUrl: url, headers: { Authorization: authorization } });
      const health = await this.client.global.health();
      this.subscribe();
      this.setStatus({ state: "ready", version: health.data?.version });
    } catch (err) {
      this.setStatus({ state: "error", error: err instanceof Error ? err.message : String(err) });
      throw err;
    }
  }

  async stop(): Promise<void> {
    this.stopped = true;
    this.eventAbort?.abort();
    this.eventAbort = null;
    await this.process.stop();
    this.client = null;
    this.setStatus({ state: "stopped" });
  }

  async restart(): Promise<void> {
    await this.stop();
    await this.start();
    this.emit({ type: "runtime.restarted" });
  }

  private async handleCrash(code: number | null, signal: NodeJS.Signals | null) {
    this.eventAbort?.abort();
    this.client = null;
    const now = Date.now();
    this.restarts = this.restarts.filter((t) => now - t < RESTART_WINDOW_MS);
    const message = `OpenCode runtime exited unexpectedly (code ${code}, signal ${signal}).`;
    this.opts.log(`[peer] ${message}`);
    if (this.stopped) return;
    if (this.restarts.length >= MAX_RESTARTS) {
      this.setStatus({ state: "error", error: `${message} Gave up after ${MAX_RESTARTS} restarts; use "Restart runtime".` });
      return;
    }
    this.restarts.push(now);
    this.setStatus({ state: "error", error: `${message} Restarting…` });
    await new Promise((r) => setTimeout(r, 500 * 2 ** (this.restarts.length - 1)));
    try {
      await this.start();
      this.emit({ type: "runtime.restarted" });
    } catch {
      // start() already reported the error
    }
  }

  /** One global SSE stream for all directories, reconnecting until stopped. */
  private subscribe() {
    const abort = new AbortController();
    this.eventAbort = abort;
    const loop = async () => {
      while (!abort.signal.aborted && this.client) {
        try {
          const sse = await this.client.global.event({ signal: abort.signal, sseMaxRetryAttempts: 1 });
          for await (const item of sse.stream) {
            const payload = (item as { payload?: OcEvent }).payload;
            if (!payload) continue;
            const event = normalizeEvent(payload);
            if (event) this.emit(event);
          }
        } catch (err) {
          if (abort.signal.aborted) return;
          this.opts.log(`[peer] runtime event stream error: ${String(err)}`);
        }
        if (!abort.signal.aborted) await new Promise((r) => setTimeout(r, 1000));
      }
    };
    void loop();
  }

  private sdk(): OpencodeClient {
    if (!this.client) throw new Error(this.current.error ?? "The OpenCode runtime is not running.");
    return this.client;
  }

  async listModels(directory: string): Promise<ModelsResponse> {
    const res = await this.sdk().config.providers({ directory }, { throwOnError: true });
    const providers = res.data.providers.map((p) => ({
      id: p.id,
      name: p.name,
      models: Object.entries(p.models).map(([id, m]) => ({ id, name: (m as { name?: string }).name ?? id })),
    }));
    const [providerId, modelId] = Object.entries(res.data.default)[0] ?? [];
    return { providers, default: providerId && modelId ? { providerId, modelId } : null };
  }

  async createSession(directory: string, input: { title?: string }) {
    // Without an explicit title OpenCode generates one from the first message.
    const res = await this.sdk().session.create({ directory, title: input.title }, { throwOnError: true });
    return { id: res.data.id, title: res.data.title };
  }

  async getMessages(directory: string, sessionId: string): Promise<PeerMessage[]> {
    const res = await this.sdk().session.messages({ sessionID: sessionId, directory }, { throwOnError: true });
    return res.data.map((m) => ({
      ...normalizeMessage(m.info),
      parts: m.parts.map(normalizePart).filter((p) => p !== null),
    }));
  }

  /**
   * Files changed in the session. OpenCode 1.19's session-level diff is not populated, but each
   * user message carries the diff of the turn it started, so aggregate those per file.
   */
  async getDiff(directory: string, sessionId: string) {
    const res = await this.sdk().session.messages({ sessionID: sessionId, directory }, { throwOnError: true });
    const turns = res.data.flatMap((m) => (m.info.role === "user" && m.info.summary?.diffs ? [normalizeDiff(m.info.summary.diffs)] : []));
    return mergeTurnDiffs(turns);
  }

  async getParentSessionId(directory: string, sessionId: string): Promise<string | null> {
    const res = await this.sdk().session.get({ sessionID: sessionId, directory }, { throwOnError: true });
    return res.data.parentID ?? null;
  }

  async prompt(directory: string, sessionId: string, input: PromptInput): Promise<void> {
    const res = await this.sdk().session.promptAsync({
      sessionID: sessionId,
      directory,
      system: input.system,
      tools: input.tools,
      model: input.model ? { providerID: input.model.providerId, modelID: input.model.modelId } : undefined,
      parts: [{ type: "text", text: input.text }],
    });
    if (res.error) throw new Error(`The runtime rejected the prompt: ${errorMessage(res.error)}`);
  }

  async abort(directory: string, sessionId: string): Promise<void> {
    await this.sdk().session.abort({ sessionID: sessionId, directory }, { throwOnError: true });
  }

  async listPermissions(directory: string) {
    const res = await this.sdk().permission.list({ directory }, { throwOnError: true });
    return res.data.map(normalizePermission);
  }

  async replyPermission(directory: string, requestId: string, reply: PermissionReply): Promise<void> {
    await this.sdk().permission.reply({ requestID: requestId, directory, reply }, { throwOnError: true });
  }

  async listToolIds(directory: string, model: ModelRef): Promise<string[]> {
    const res = await this.sdk().tool.list({ directory, provider: model.providerId, model: model.modelId }, { throwOnError: true });
    return res.data.map((t) => t.id);
  }
}
