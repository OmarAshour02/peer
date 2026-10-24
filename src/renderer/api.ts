import type {
  Checkpoint,
  CheckpointAction,
  CollaborationModeId,
  FileDiff,
  LocalServerKind,
  ModelRef,
  ModelsResponse,
  OAuthStart,
  PeerEvent,
  PeerMessage,
  PeerSession,
  PermissionReply,
  Preferences,
  ProviderCatalog,
  RuntimeInfo,
  RuntimeKind,
  RuntimeStatus,
  SessionSnapshot,
  TurnIntent,
  UndoResult,
  Workspace,
} from "../shared/types";

declare global {
  interface Window {
    peerDesktop?: {
      getConfig(): Promise<{ apiBase: string; token: string }>;
      pickDirectory(): Promise<string | null>;
      platform: string;
    };
  }
}

export interface ApiConfig {
  apiBase: string;
  token: string;
}

function storage(): Storage | null {
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

/**
 * Desktop: the Electron preload provides the loopback API address and token.
 * Browser (headless server / dev): the launch link carries `?api=` and `#token=`; they are
 * remembered locally so reloads and server restarts keep working.
 */
export async function resolveConfig(): Promise<ApiConfig | null> {
  if (window.peerDesktop) return window.peerDesktop.getConfig();
  const hashToken = new URLSearchParams(location.hash.slice(1)).get("token");
  const queryApi = new URLSearchParams(location.search).get("api");
  const store = storage();
  if (hashToken) store?.setItem("peer.token", hashToken);
  if (queryApi) store?.setItem("peer.api", queryApi);
  if (hashToken || queryApi) history.replaceState(null, "", location.pathname);
  const token = hashToken ?? store?.getItem("peer.token");
  const apiBase = queryApi ?? store?.getItem("peer.api") ?? location.origin;
  return token ? { apiBase, token } : null;
}

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

export class PeerApi {
  constructor(readonly config: ApiConfig) {}

  private async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    const res = await fetch(`${this.config.apiBase}/api${path}`, {
      method,
      headers: { authorization: `Bearer ${this.config.token}`, ...(body !== undefined ? { "content-type": "application/json" } : {}) },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    const text = await res.text();
    const data = text ? JSON.parse(text) : null;
    if (!res.ok) throw new ApiError(data?.error ?? `${res.status} ${res.statusText}`, res.status);
    return data as T;
  }

  health = () => this.request<{ runtime: RuntimeStatus; runtimes: RuntimeInfo[] }>("GET", "/health");
  restartRuntime = (kind: RuntimeKind) => this.request<RuntimeInfo>("POST", `/runtimes/${kind}/restart`);
  providers = (kind: RuntimeKind) => this.request<ProviderCatalog>("GET", `/runtimes/${kind}/providers`);
  setProviderKey = (kind: RuntimeKind, providerId: string, key: string, inputs: Record<string, string>) =>
    this.request<ProviderCatalog>("POST", `/runtimes/${kind}/providers/${encodeURIComponent(providerId)}/key`, { key, inputs });
  startOAuth = (kind: RuntimeKind, providerId: string, method: number, inputs: Record<string, string>) =>
    this.request<OAuthStart>("POST", `/runtimes/${kind}/providers/${encodeURIComponent(providerId)}/oauth`, { method, inputs });
  finishOAuth = (kind: RuntimeKind, providerId: string, method: number, code?: string) =>
    this.request<ProviderCatalog>("POST", `/runtimes/${kind}/providers/${encodeURIComponent(providerId)}/oauth/callback`, { method, code });
  disconnectProvider = (kind: RuntimeKind, providerId: string) =>
    this.request<ProviderCatalog>("DELETE", `/runtimes/${kind}/providers/${encodeURIComponent(providerId)}`);
  addLocalServer = (kind: RuntimeKind, input: { baseUrl: string; name?: string; kind?: LocalServerKind }) =>
    this.request<ProviderCatalog>("POST", `/runtimes/${kind}/local-servers`, input);
  removeLocalServer = (kind: RuntimeKind, id: string) => this.request<ProviderCatalog>("DELETE", `/runtimes/${kind}/local-servers/${encodeURIComponent(id)}`);
  preferences = () => this.request<Preferences>("GET", "/preferences");
  setPreferences = (prefs: Partial<Preferences>) => this.request<Preferences>("PATCH", "/preferences", prefs);
  workspaces = () => this.request<Workspace[]>("GET", "/workspaces");
  addWorkspace = (path: string) => this.request<Workspace>("POST", "/workspaces", { path });
  removeWorkspace = (id: string) => this.request("DELETE", `/workspaces/${id}`);
  updateWorkspace = (id: string, patch: { sandboxNetwork?: boolean }) => this.request<Workspace>("PATCH", `/workspaces/${id}`, patch);
  sessions = (workspaceId: string) => this.request<PeerSession[]>("GET", `/workspaces/${workspaceId}/sessions`);
  createSession = (workspaceId: string, input: { mode?: CollaborationModeId; runtime?: RuntimeKind } = {}) =>
    this.request<PeerSession>("POST", `/workspaces/${workspaceId}/sessions`, input);
  models = (workspaceId: string, runtime: RuntimeKind) =>
    this.request<ModelsResponse>("GET", `/workspaces/${workspaceId}/models?runtime=${encodeURIComponent(runtime)}`);
  snapshot = (sessionId: string) => this.request<SessionSnapshot>("GET", `/sessions/${sessionId}`);
  messages = (sessionId: string) => this.request<PeerMessage[]>("GET", `/sessions/${sessionId}/messages`);
  diff = (sessionId: string) => this.request<FileDiff[]>("GET", `/sessions/${sessionId}/diff`);
  updateSession = (sessionId: string, patch: { mode?: CollaborationModeId; model?: ModelRef | null; title?: string }) =>
    this.request<PeerSession>("PATCH", `/sessions/${sessionId}`, patch);
  undoTurn = (sessionId: string) => this.request<UndoResult>("POST", `/sessions/${sessionId}/undo`);
  deleteSession = (sessionId: string) => this.request("DELETE", `/sessions/${sessionId}`);
  send = (sessionId: string, text: string, intent: TurnIntent) => this.request("POST", `/sessions/${sessionId}/messages`, { text, intent });
  abort = (sessionId: string) => this.request("POST", `/sessions/${sessionId}/abort`);
  resolveCheckpoint = (id: string, action: CheckpointAction, extra: { text?: string; option?: string } = {}) =>
    this.request<Checkpoint>("POST", `/checkpoints/${id}/resolve`, { action, ...extra });
  replyPermission = (id: string, reply: PermissionReply) => this.request("POST", `/permissions/${id}/reply`, { reply });

  /** Subscribe to server events. EventSource reconnects on its own; `onOpen` fires on every (re)connect. */
  events(onEvent: (e: PeerEvent) => void, onOpen: () => void, onError: () => void): () => void {
    const source = new EventSource(`${this.config.apiBase}/api/events?token=${encodeURIComponent(this.config.token)}`);
    source.addEventListener("peer", (msg) => onEvent(JSON.parse((msg as MessageEvent).data) as PeerEvent));
    source.addEventListener("open", onOpen);
    source.addEventListener("error", onError);
    return () => source.close();
  }
}
