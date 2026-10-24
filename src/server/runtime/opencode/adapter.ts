import { createOpencodeClient, type Event as OcEvent, type OpencodeClient } from "@opencode-ai/sdk/v2";
import type { ModelRef, ModelsResponse, PeerMessage, PermissionReply, RuntimeStatus } from "../../../shared/types.js";
import { ProviderError, type AgentRuntimeAdapter, type PromptInput, type ProviderConnections, type RuntimeEvent } from "../adapter.js";
import { CHECKPOINT_TOOL } from "../../collaboration/prompt.js";
import { credentialIds, importedIds, markConnectedInPeer, markDisconnectedInPeer, runtimeAuthFile } from "./credentials.js";
import { OpenCodeProcess, type OpenCodeProcessOptions } from "./process.js";
import { LocalServers } from "./local.js";
import { ProviderReload, toCatalog, type OcAuthMethods, type OcProviderList } from "./providers.js";
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
  /** Directories the runtime has an instance for; checked for running sessions before a provider reload. */
  private readonly directories = new Set<string>();
  private readonly reload: ProviderReload;
  private readonly local: LocalServers;

  constructor(private readonly opts: OpenCodeProcessOptions) {
    this.process = new OpenCodeProcess(opts);
    this.local = new LocalServers(opts.rootDir);
    this.reload = new ProviderReload({
      anyBusy: () => this.anyBusy(),
      dispose: async () => {
        await this.sdk().global.dispose({ throwOnError: true });
      },
      onChange: (reloadPending) => this.emit({ type: "providers.updated", reloadPending }),
      log: opts.log,
    });
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
      void this.refreshLocal();
    } catch (err) {
      this.setStatus({ state: "error", error: err instanceof Error ? err.message : String(err) });
      throw err;
    }
  }

  async stop(): Promise<void> {
    this.stopped = true;
    this.reload.reset();
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
    this.reload.reset();
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
            if (!event) continue;
            this.emit(event);
            if (event.type === "session.idle" || (event.type === "session.status" && event.status === "idle")) this.reload.poke();
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
    this.directories.add(directory);
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
    this.directories.add(directory);
    // Without an explicit title OpenCode generates one from the first message.
    const res = await this.sdk().session.create({ directory, title: input.title }, { throwOnError: true });
    return { id: res.data.id, title: res.data.title };
  }

  /**
   * Messages, without those an undo reverted: OpenCode keeps them until the next prompt (so a
   * revert can be taken back), but to the agent and the developer they are gone.
   */
  private async keptMessages(directory: string, sessionId: string) {
    const [messages, session] = await Promise.all([
      this.sdk().session.messages({ sessionID: sessionId, directory }, { throwOnError: true }),
      this.sdk().session.get({ sessionID: sessionId, directory }, { throwOnError: true }),
    ]);
    const revertedFrom = session.data.revert?.messageID;
    const cut = revertedFrom ? messages.data.findIndex((m) => m.info.id === revertedFrom) : -1;
    return cut === -1 ? messages.data : messages.data.slice(0, cut);
  }

  async getMessages(directory: string, sessionId: string): Promise<PeerMessage[]> {
    return (await this.keptMessages(directory, sessionId)).map((m) => ({
      ...normalizeMessage(m.info),
      parts: m.parts.map(normalizePart).filter((p) => p !== null),
    }));
  }

  /**
   * Files changed in the session. OpenCode 1.19's session-level diff is not populated, but each
   * user message carries the diff of the turn it started, so aggregate those per file.
   */
  async getDiff(directory: string, sessionId: string) {
    const messages = await this.keptMessages(directory, sessionId);
    const turns = messages.flatMap((m) => (m.info.role === "user" && m.info.summary?.diffs ? [normalizeDiff(m.info.summary.diffs)] : []));
    return mergeTurnDiffs(turns);
  }

  /** OpenCode's own revert: the turns leave the conversation (and their file changes are undone again, to the same state). */
  async forgetTurns(directory: string, sessionId: string, since: number): Promise<boolean> {
    const first = (await this.keptMessages(directory, sessionId)).find((m) => m.info.role === "user" && m.info.time.created >= since);
    if (!first) return true;
    await this.sdk().session.revert({ sessionID: sessionId, directory, messageID: first.info.id }, { throwOnError: true });
    return true;
  }

  async getParentSessionId(directory: string, sessionId: string): Promise<string | null> {
    const res = await this.sdk().session.get({ sessionID: sessionId, directory }, { throwOnError: true });
    return res.data.parentID ?? null;
  }

  async prompt(directory: string, sessionId: string, input: PromptInput): Promise<void> {
    this.directories.add(directory);
    // A provider reload would abort this turn, so none runs until the runtime reports it busy.
    const release = await this.reload.hold();
    try {
      const res = await this.sdk().session.promptAsync({
        sessionID: sessionId,
        directory,
        system: input.system,
        tools: input.tools,
        model: input.model ? { providerID: input.model.providerId, modelID: input.model.modelId } : undefined,
        parts: [{ type: "text", text: input.text }],
      });
      if (res.error) throw new Error(`The runtime rejected the prompt: ${errorMessage(res.error)}`);
    } finally {
      release();
    }
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

  /** Ask local servers for their current models; reload providers if an added server's list changed. */
  private async refreshLocal() {
    try {
      const { servers, changed } = await this.local.refresh(this.opts.env);
      if (changed) void this.reload.request();
      return servers;
    } catch (err) {
      this.opts.log(`[peer] checking local model servers failed: ${String(err)}`);
      return [];
    }
  }

  private async anyBusy(): Promise<boolean> {
    for (const directory of this.directories) {
      const res = await this.sdk().session.status({ directory }, { throwOnError: true });
      if (Object.values(res.data).some((status) => status.type !== "idle")) return true;
    }
    return false;
  }

  /** Known provider ids only, so a request cannot write arbitrary entries into the credential file. */
  private async requireProvider(providerId: string): Promise<OcProviderList["all"][number]> {
    const res = await this.sdk().provider.list({}, { throwOnError: true });
    const provider = (res.data as OcProviderList).all.find((p) => p.id === providerId);
    if (!provider) throw new ProviderError(`Unknown provider "${providerId}"`);
    return provider;
  }

  readonly providers: ProviderConnections = {
    catalog: async () => {
      const [list, methods, local] = await Promise.all([
        this.sdk().provider.list({}, { throwOnError: true }),
        this.sdk().provider.auth({}, { throwOnError: true }),
        this.refreshLocal(),
      ]);
      return toCatalog(
        list.data as OcProviderList,
        methods.data as OcAuthMethods,
        credentialIds(runtimeAuthFile(this.opts.rootDir)),
        importedIds(runtimeAuthFile(this.opts.rootDir)),
        this.reload.isPending,
        local,
      );
    },
    setKey: async (providerId, key, inputs) => {
      await this.requireProvider(providerId);
      const metadata = Object.keys(inputs).length > 0 ? inputs : undefined;
      await this.sdk().auth.set({ providerID: providerId, auth: { type: "api", key, metadata } }, { throwOnError: true });
      markConnectedInPeer(runtimeAuthFile(this.opts.rootDir), providerId);
      await this.reload.request();
    },
    startOAuth: async (providerId, method, inputs) => {
      await this.requireProvider(providerId);
      const res = await this.sdk().provider.oauth.authorize({ providerID: providerId, method, inputs }, { throwOnError: true });
      return { url: res.data.url, mode: res.data.method, instructions: res.data.instructions };
    },
    finishOAuth: async (providerId, method, code) => {
      await this.requireProvider(providerId);
      const res = await this.sdk().provider.oauth.callback({ providerID: providerId, method, code }, { throwOnError: true });
      if (res.data !== true) throw new ProviderError("The provider did not complete the login.");
      markConnectedInPeer(runtimeAuthFile(this.opts.rootDir), providerId);
      await this.reload.request();
    },
    disconnect: async (providerId) => {
      if (importedIds(runtimeAuthFile(this.opts.rootDir)).has(providerId)) {
        throw new ProviderError("This provider comes from your own OpenCode login, which Peer imports on every start. Remove it there first (`opencode auth logout`), then restart the runtime.");
      }
      if (!credentialIds(runtimeAuthFile(this.opts.rootDir)).has(providerId)) {
        throw new ProviderError("Only providers connected in Peer can be disconnected here.");
      }
      await this.sdk().auth.remove({ providerID: providerId }, { throwOnError: true });
      markDisconnectedInPeer(runtimeAuthFile(this.opts.rootDir), providerId);
      await this.reload.request();
    },
    addLocal: async (input) => {
      await this.local.add(input);
      await this.reload.request();
    },
    removeLocal: async (id) => {
      this.local.remove(id);
      await this.reload.request();
    },
  };
}
