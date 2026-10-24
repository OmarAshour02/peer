import type { ModelRef, PeerMessage, PermissionReply, RuntimeKind, RuntimeStatus } from "../src/shared/types.js";
import type { AgentRuntimeAdapter, PromptInput, RuntimeEvent } from "../src/server/runtime/adapter.js";

/** In-memory runtime that records prompts. Lets tests drive the engine without a model. */
export class FakeRuntime implements AgentRuntimeAdapter {
  readonly name: string;
  readonly checkpointTool: string;
  /** Set to behave like Codex, whose sandbox is fixed for the whole turn. */
  sandboxFixedPerTurn = false;
  prompts: { directory: string; sessionId: string; input: PromptInput }[] = [];
  aborted: string[] = [];
  /** `forgetTurns` calls, and what the fake answers (true: the runtime drops the turns itself). */
  forgotten: { sessionId: string; since: number }[] = [];
  forgets = false;
  parents = new Map<string, string>();
  private listeners = new Set<(e: RuntimeEvent) => void>();
  private n = 0;

  constructor(
    readonly kind: RuntimeKind = "opencode",
    private readonly current: RuntimeStatus = { state: "ready", version: "fake" },
  ) {
    this.name = `fake-${kind}`;
    this.checkpointTool = kind === "claude" ? "mcp__peer__checkpoint" : "peer_checkpoint";
  }

  async start() {}
  async stop() {}
  async restart() {
    this.emit({ type: "runtime.restarted" });
  }
  status(): RuntimeStatus {
    return this.current;
  }
  async listModels() {
    return { providers: [], default: null };
  }
  async createSession() {
    return { id: `${this.kind}_${++this.n}`, title: "New session" };
  }
  async getMessages(): Promise<PeerMessage[]> {
    return [];
  }
  async getDiff() {
    return [];
  }
  async getParentSessionId(_dir: string, sessionId: string) {
    return this.parents.get(sessionId) ?? null;
  }
  async prompt(directory: string, sessionId: string, input: PromptInput) {
    this.prompts.push({ directory, sessionId, input });
  }
  async abort(_dir: string, sessionId: string) {
    this.aborted.push(sessionId);
  }
  async listPermissions() {
    return [];
  }
  async replyPermission(_d: string, _id: string, _r: PermissionReply) {}
  async listToolIds(_d: string, _m: ModelRef) {
    return [];
  }
  async forgetTurns(_d: string, sessionId: string, since: number) {
    this.forgotten.push({ sessionId, since });
    return this.forgets;
  }
  onEvent(listener: (e: RuntimeEvent) => void) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
  emit(e: RuntimeEvent) {
    for (const l of this.listeners) l(e);
  }
  lastPrompt() {
    return this.prompts.at(-1)!;
  }
}
