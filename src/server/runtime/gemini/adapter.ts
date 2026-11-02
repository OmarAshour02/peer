import { randomUUID } from "node:crypto";
import { spawn, type ChildProcess } from "node:child_process";
import { join } from "node:path";
import type { ModelsResponse, PeerMessage, PermissionReply, RuntimeStatus } from "../../../shared/types.js";
import type { AgentRuntimeAdapter, PromptInput, RuntimeEvent, RuntimeSettingsProvider } from "../adapter.js";
import { findExecutable, runCli } from "../cli.js";
import { diffSinceSnapshot, snapshotWorkspace } from "../git-snapshot.js";
import { Transcript, titleFromPrompt, type RuntimeStorage } from "../transcript.js";

/**
 * Peer cannot approve individual Gemini commands, so every Gemini turn runs in the CLI's
 * read-only approval mode. Edits are proposed, not applied.
 */
export const GEMINI_APPROVAL = "plan";
export const GEMINI_LOCKED_APPROVAL = GEMINI_APPROVAL;

/** Gemini is read-only in Peer until its commands can go through Peer's permission gate. */
export const GEMINI_WARNING =
  "Peer runs Gemini CLI read-only (approval-mode plan) because it cannot approve individual Gemini commands. Gemini can explore and propose changes, but cannot apply them in Peer yet.";

const GEMINI_NOTE =
  "There is no peer_checkpoint tool in this runtime. If you need the developer, write your question at the end of your reply starting with 'QUESTION:' and stop; otherwise proceed on your own judgment.";
const GEMINI_LOCKED_NOTE =
  "You are running read-only (approval-mode plan): explore and propose, but do not change files. If changing code is the right next step, say so at the end of your reply and stop.";

export interface GeminiAdapterOptions {
  env: NodeJS.ProcessEnv;
  storage: RuntimeStorage;
  dataDir: string;
  /** Explicit path to the `gemini` executable (PEER_GEMINI_BIN); otherwise found on PATH. */
  binary?: string;
  log: (line: string) => void;
  /** Live runtime settings; `geminiBin` there overrides `binary` (a restart picks it up). */
  settings?: RuntimeSettingsProvider;
}

interface SessionState {
  /** The exact Gemini CLI conversation this Peer session continues. */
  cliSessionId?: string;
  /** Workspace git tree when the session first ran, for the Changes panel. */
  baseline?: string | null;
  titled?: boolean;
}

/**
 * CLI arguments for one turn. The first turn starts a CLI conversation; later turns resume
 * this Peer session's exact CLI conversation, never whichever one was most recent.
 */
export function geminiArgs(input: PromptInput, cliSessionId: string | null): string[] {
  return [
    ...(cliSessionId ? ["--resume", cliSessionId] : []),
    "--approval-mode",
    GEMINI_APPROVAL,
    "--output-format",
    "stream-json",
    "-p",
    geminiTurnPrompt(input),
  ];
}

/** The prompt for one turn: the collaboration policy plus what this runtime needs to know. */
export function geminiTurnPrompt(input: PromptInput): string {
  return `<peer_collaboration_policy>\n${input.system}\n\n${GEMINI_LOCKED_NOTE}\n\n${GEMINI_NOTE}\n</peer_collaboration_policy>\n\n${input.text}`;
}

interface GeminiEvent {
  sessionId?: string;
  text?: string;
  error?: string;
}

/** One `stream-json` event. Returns null for a plain-text line (older CLIs / test fakes). */
export function parseGeminiEvent(line: string): GeminiEvent | null {
  let event: Record<string, unknown>;
  try {
    const parsed: unknown = JSON.parse(line);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    event = parsed as Record<string, unknown>;
  } catch {
    return null;
  }
  if (event.type === "init") return typeof event.session_id === "string" ? { sessionId: event.session_id } : {};
  if (event.type === "message") {
    if ((event.role === undefined || event.role === "assistant") && typeof event.content === "string") return { text: event.content };
    return {};
  }
  if (event.type === "error") {
    const detail = typeof event.message === "string" ? event.message : typeof event.error === "string" ? event.error : "Gemini CLI reported an error";
    return { error: detail };
  }
  return {};
}

interface Run {
  child: ChildProcess;
  messageId: string;
  stdoutBuffer: string;
  streamError?: string;
  aborted?: boolean;
  finished?: boolean;
  closed: Promise<void>;
  resolveClosed: () => void;
}

/**
 * Gemini CLI through headless `gemini -p` (one process per turn,
 * `--resume <session_id>` continues that Peer session's CLI conversation). Peer cannot
 * approve individual Gemini commands, so every turn runs read-only (`plan`) and edits are
 * proposed, not applied. There is no checkpoint tool and no permission surface; the model
 * asks in its reply text instead.
 */
export class GeminiAdapter implements AgentRuntimeAdapter {
  readonly kind = "gemini" as const;
  readonly name = "Gemini CLI";
  readonly checkpointTool = "peer_checkpoint";

  private binary: string | null = null;
  private current: RuntimeStatus = { state: "stopped" };
  private version: string | undefined;
  private readonly listeners = new Set<(event: RuntimeEvent) => void>();
  private readonly runs = new Map<string, Run>();
  private readonly transcripts = new Map<string, Transcript>();

  constructor(private readonly opts: GeminiAdapterOptions) {}

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
        this.opts.log(`[gemini] listener failed: ${String(err)}`);
      }
    }
  }

  private setStatus(status: RuntimeStatus) {
    this.current = status;
    this.emit({ type: "runtime.status", status });
  }

  async start(): Promise<void> {
    this.setStatus({ state: "starting" });
    this.binary = findExecutable("gemini", this.opts.env, this.opts.settings?.().geminiBin ?? this.opts.binary ?? undefined);
    if (!this.binary) {
      this.setStatus({ state: "unavailable", error: "Gemini CLI is not installed (no `gemini` on PATH). Install it and sign in, then restart this runtime." });
      return;
    }
    const version = await runCli(this.binary, ["--version"], this.opts.env);
    if (version.code !== 0) {
      this.setStatus({ state: "unavailable", error: `\`gemini --version\` failed: ${(version.stderr || version.stdout).trim().slice(0, 300)}` });
      return;
    }
    this.version = version.stdout.trim().split("\n")[0]?.trim() || undefined;
    this.setStatus({ state: "ready", version: this.version, warning: GEMINI_WARNING });
  }

  async stop(): Promise<void> {
    const runs = [...this.runs.values()];
    for (const run of runs) run.child.kill("SIGTERM");
    await Promise.all(runs.map((run) => run.closed));
    this.setStatus({ state: "stopped" });
  }

  async restart(): Promise<void> {
    await this.stop();
    await this.start();
    this.emit({ type: "runtime.restarted" });
  }

  private bin(): string {
    if (this.current.state !== "ready" || !this.binary) throw new Error(this.current.error ?? "Gemini CLI is not available.");
    return this.binary;
  }

  private transcript(sessionId: string): Transcript {
    let t = this.transcripts.get(sessionId);
    if (!t) {
      t = new Transcript(this.kind, sessionId, this.opts.storage, (e) => this.emit(e));
      this.transcripts.set(sessionId, t);
    }
    return t;
  }

  private state(sessionId: string): SessionState {
    return this.opts.storage.getRuntimeState<SessionState>(this.kind, sessionId) ?? {};
  }

  private saveState(sessionId: string, patch: SessionState) {
    this.opts.storage.setRuntimeState(this.kind, sessionId, { ...this.state(sessionId), ...patch });
  }

  private indexFile(sessionId: string) {
    return join(this.opts.dataDir, "snapshots", this.kind, `${sessionId}.index`);
  }

  async listModels(): Promise<ModelsResponse> {
    return {
      providers: [{ id: "gemini", name: "Gemini CLI", models: [{ id: "default", name: "Default (your Gemini CLI setting)" }] }],
      default: { providerId: "gemini", modelId: "default" },
    };
  }

  async createSession(_directory: string, _input: { title?: string }) {
    const id = randomUUID();
    this.opts.storage.setRuntimeState(this.kind, id, {});
    return { id, title: "New session" };
  }

  async getMessages(_directory: string, sessionId: string): Promise<PeerMessage[]> {
    return this.transcript(sessionId).list();
  }

  async getDiff(directory: string, sessionId: string) {
    const base = this.state(sessionId).baseline;
    return base ? diffSinceSnapshot(directory, base, this.indexFile(sessionId)) : [];
  }

  /**
   * Undo drops the turns from Peer's transcript. The CLI session keeps them, so the agent
   * still remembers that work and is told on its next turn that it was undone.
   */
  async forgetTurns(_directory: string, sessionId: string, since: number): Promise<boolean> {
    if (this.runs.has(sessionId)) throw new Error("The agent is still working on this session.");
    this.transcript(sessionId).dropSince(since);
    return false;
  }

  async getParentSessionId(): Promise<string | null> {
    return null;
  }

  async listPermissions(_directory: string) {
    return [];
  }

  async replyPermission(_directory: string, _requestId: string, _reply: PermissionReply): Promise<void> {
    throw new Error("Gemini CLI runs headless and never asks for approval");
  }

  async listToolIds(): Promise<string[]> {
    return [];
  }

  async prompt(directory: string, sessionId: string, input: PromptInput): Promise<void> {
    const binary = this.bin();
    if (this.runs.has(sessionId)) throw new Error("Gemini CLI is still working on this session.");
    const state = this.state(sessionId);
    if (state.baseline === undefined) this.saveState(sessionId, { baseline: await snapshotWorkspace(directory, this.indexFile(sessionId)) });
    if (!state.titled) {
      this.emit({ type: "session.updated", sessionId, title: titleFromPrompt(input.text), parentId: null });
      this.saveState(sessionId, { titled: true });
    }

    const transcript = this.transcript(sessionId);
    transcript.addUserMessage(`user_${randomUUID()}`, input.text);
    const messageId = `turn_${randomUUID()}`;
    transcript.startAssistantMessage(messageId, input.model ?? undefined);
    this.emit({ type: "session.status", sessionId, status: "busy" });

    const child = spawn(binary, geminiArgs(input, state.cliSessionId ?? null), { cwd: directory, env: this.opts.env, stdio: ["ignore", "pipe", "pipe"] });
    let resolveClosed!: () => void;
    const closed = new Promise<void>((resolve) => {
      resolveClosed = resolve;
    });
    const run: Run = { child, messageId, stdoutBuffer: "", closed, resolveClosed };
    this.runs.set(sessionId, run);
    const partId = `${messageId}:text`;
    const handleLine = (line: string) => {
      if (run.finished || !line.trim()) return;
      const event = parseGeminiEvent(line);
      if (!event) {
        transcript.appendText(messageId, partId, "text", line);
        return;
      }
      if (event.sessionId) this.saveState(sessionId, { cliSessionId: event.sessionId });
      if (event.text) transcript.appendText(messageId, partId, "text", event.text);
      if (event.error) {
        run.streamError = event.error;
        this.opts.log(`[gemini] ${event.error.slice(0, 500)}`);
      }
    };
    let stderr = "";
    child.stdout?.on("data", (d) => {
      run.stdoutBuffer += String(d);
      const lines = run.stdoutBuffer.split("\n");
      run.stdoutBuffer = lines.pop() ?? "";
      for (const line of lines) handleLine(line);
    });
    child.stderr?.on("data", (d) => {
      stderr += String(d);
      this.opts.log(`[gemini] ${String(d).trimEnd().slice(0, 500)}`);
    });
    child.on("error", (err) => this.finishRun(sessionId, run, `Gemini CLI failed to start: ${err.message}`));
    child.on("close", (code) => {
      if (run.stdoutBuffer) handleLine(run.stdoutBuffer);
      if (run.aborted) this.finishRun(sessionId, run, "Stopped");
      else if (code === 0) this.finishRun(sessionId, run, run.streamError);
      else {
        const detail = stderr.trim().slice(-500) || run.streamError || `exited with code ${code}`;
        this.finishRun(sessionId, run, `Gemini CLI failed: ${detail}`);
      }
    });
  }

  async abort(_directory: string, sessionId: string): Promise<void> {
    const run = this.runs.get(sessionId);
    if (!run) return;
    run.aborted = true;
    run.child.kill("SIGTERM");
    const exited = await Promise.race([
      run.closed.then(() => true),
      new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 5000)),
    ]);
    if (!exited) {
      run.child.kill("SIGKILL");
      await run.closed;
    }
  }

  private finishRun(sessionId: string, run: Run, error?: string) {
    if (run.finished || this.runs.get(sessionId) !== run) return;
    run.finished = true;
    this.runs.delete(sessionId);
    const transcript = this.transcript(sessionId);
    if (error) transcript.failRunningTools(run.messageId, error);
    transcript.completeMessage(run.messageId, error);
    if (error) this.emit({ type: "session.error", sessionId, error });
    this.emit({ type: "session.idle", sessionId });
    run.resolveClosed();
  }
}
