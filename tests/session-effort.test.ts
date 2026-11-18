// Reasoning effort per session: picked in the composer from the levels the model takes, stored
// with the session, and sent on each turn ahead of the Runtime settings default.
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../src/server/app.js";
import { EventHub } from "../src/server/hub.js";
import { codexModelOption } from "../src/server/runtime/codex/adapter.js";
import { RuntimeSet } from "../src/server/runtime/set.js";
import { PeerService } from "../src/server/service.js";
import { Store } from "../src/server/store.js";
import { DEFAULT_RUNTIME_SETTINGS, type ModelsResponse } from "../src/shared/types.js";
import { effortLabel, effortOptions, modelEfforts, stepEffort, stopAt } from "../src/renderer/effort.js";
import { FakeRuntime } from "./helpers.js";

let dir: string;
let store: Store;

beforeEach(() => {
  dir = realpathSync(mkdtempSync(join(tmpdir(), "peer-effort-")));
  store = new Store(":memory:");
});
afterEach(() => {
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

function setup(kind: "codex" | "claude" | "opencode") {
  const runtime = new FakeRuntime(kind);
  const service = new PeerService(store, new RuntimeSet([runtime]), new EventHub());
  const app = createApp({ service, hub: new EventHub(), apiToken: "token", bridgeToken: "bridge", allowedOrigins: [] });
  const patch = (id: string, body: unknown) =>
    app.request(`/api/sessions/${id}`, { method: "PATCH", headers: { authorization: "Bearer token", "content-type": "application/json" }, body: JSON.stringify(body) });
  const ws = service.addWorkspace(dir);
  return { runtime, service, patch, ws };
}

describe("session effort", () => {
  it("is null for a new session and persists what the developer picks", async () => {
    const { service, patch, ws } = setup("codex");
    const s = await service.createSession(ws.id, { mode: "collaborate", runtime: "codex" });
    expect(s.effort).toBeNull();
    const res = await patch(s.id, { effort: "medium" });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ effort: "medium" });
    expect(store.getSession(s.id)!.effort).toBe("medium");
    // Back to the default.
    expect((await patch(s.id, { effort: null })).status).toBe(200);
    expect(store.getSession(s.id)!.effort).toBeNull();
  });

  it("refuses a value that isn't an effort level, and runtimes that take none", async () => {
    const { service, patch, ws } = setup("codex");
    const s = await service.createSession(ws.id, { mode: "collaborate", runtime: "codex" });
    for (const bad of ["Max Effort!", 3, "", "x".repeat(40)]) expect((await patch(s.id, { effort: bad })).status).toBe(400);
    const other = setup("opencode");
    const o = await other.service.createSession(other.ws.id, { mode: "collaborate", runtime: "opencode" });
    expect((await other.patch(o.id, { effort: "high" })).status).toBe(400);
    // Clearing it is always fine.
    expect((await other.patch(o.id, { effort: null })).status).toBe(200);
  });

  it("goes to the runtime on each turn, ahead of the Runtime settings default", async () => {
    const { runtime, service, ws } = setup("codex");
    store.setPreferences({ runtimeSettings: { ...DEFAULT_RUNTIME_SETTINGS, codexEffort: "high" } });
    const s = await service.createSession(ws.id, { mode: "collaborate", runtime: "codex" });
    await service.send(s.id, "first");
    expect(runtime.lastPrompt().input.effort).toBe("high");
    runtime.emit({ type: "session.idle", sessionId: s.runtimeSessionId });
    await new Promise((r) => setTimeout(r, 5));
    service.updateSession(s.id, { effort: "low" });
    await service.send(s.id, "second");
    expect(runtime.lastPrompt().input.effort).toBe("low");
  });

  it("survives a restart of an older database (the column is added by migration)", () => {
    const file = join(dir, "peer.db");
    const first = new Store(file);
    const ws = first.upsertWorkspace(dir, "w");
    const s = first.createSession({ workspaceId: ws.id, runtime: "claude", runtimeSessionId: "r", title: "t", mode: "learn", model: null });
    first.updateSession(s.id, { effort: "xhigh" });
    first.close();
    const second = new Store(file);
    expect(second.getSession(s.id)!.effort).toBe("xhigh");
    second.close();
  });
});

describe("effort levels per model", () => {
  it("Codex lists the levels each model supports", () => {
    expect(
      codexModelOption({
        id: "gpt-6-astra",
        displayName: "GPT-6-Astra",
        hidden: false,
        isDefault: true,
        supportedReasoningEfforts: [{ reasoningEffort: "low" }, { reasoningEffort: "medium" }, { reasoningEffort: "high" }, { reasoningEffort: "max" }, { reasoningEffort: 7 }],
      }),
    ).toEqual({ id: "gpt-6-astra", name: "GPT-6-Astra", efforts: ["low", "medium", "high", "max"] });
    expect(codexModelOption({ id: "m", displayName: "", hidden: false, isDefault: false })).toEqual({ id: "m", name: "m" });
  });

  it("the picker offers the session model's levels (or the default model's), and keeps a stored pick visible", () => {
    const models: ModelsResponse = {
      providers: [{ id: "codex", name: "Codex", models: [{ id: "a", name: "A", efforts: ["low", "high"] }, { id: "b", name: "B" }] }],
      default: { providerId: "codex", modelId: "a" },
    };
    expect(modelEfforts(models, null)).toEqual(["low", "high"]);
    expect(modelEfforts(models, { providerId: "codex", modelId: "b" })).toEqual([]);
    expect(modelEfforts(null, null)).toEqual([]);
    expect(effortOptions(["low", "high"], "max")).toEqual(["low", "high", "max"]);
    expect(effortOptions(["low", "high"], "low")).toEqual(["low", "high"]);
    expect(effortLabel("xhigh")).toBe("Extra high");
    expect(effortLabel("medium")).toBe("Medium");
  });

  it("the slider snaps to the nearest level and moves one level per arrow key", () => {
    expect(stopAt(0, 6)).toBe(0);
    expect(stopAt(0.49, 6)).toBe(2);
    expect(stopAt(1.3, 6)).toBe(5);
    expect(stopAt(-1, 6)).toBe(0);
    expect(stopAt(0.7, 1)).toBe(0);
    expect(stepEffort(2, "ArrowRight", 6)).toBe(3);
    expect(stepEffort(5, "ArrowRight", 6)).toBe(5);
    expect(stepEffort(0, "ArrowLeft", 6)).toBe(0);
    expect(stepEffort(3, "Home", 6)).toBe(0);
    expect(stepEffort(3, "End", 6)).toBe(5);
    expect(stepEffort(null, "ArrowRight", 6)).toBe(2);
    expect(stepEffort(2, "a", 6)).toBeNull();
    expect(stepEffort(null, "End", 0)).toBeNull();
  });
});

describe("the default effort a session runs at", () => {
  it("comes from Runtime settings first, and is served per session", async () => {
    const { runtime, service, ws } = setup("codex");
    const app = createApp({ service, hub: new EventHub(), apiToken: "token", bridgeToken: "bridge", allowedOrigins: [] });
    const s = await service.createSession(ws.id, { mode: "collaborate", runtime: "codex" });
    store.setPreferences({ runtimeSettings: { ...DEFAULT_RUNTIME_SETTINGS, codexEffort: "low" } });
    const res = await app.request(`/api/sessions/${s.id}/effort-default`, { headers: { authorization: "Bearer token" } });
    expect(await res.json()).toEqual({ default: { level: "low", source: "settings" }, cap: null });
    // Without settings and with no Codex config, the model's own default.
    store.setPreferences({ runtimeSettings: { ...DEFAULT_RUNTIME_SETTINGS, codexEffort: "" } });
    (runtime as unknown as { listModels: () => Promise<ModelsResponse> }).listModels = async () => ({
      providers: [{ id: "codex", name: "Codex", models: [{ id: "m", name: "M", efforts: ["low", "medium"], defaultEffort: "medium" }] }],
      default: { providerId: "codex", modelId: "m" },
    });
    const codexHome = process.env.CODEX_HOME;
    process.env.CODEX_HOME = join(dir, "no-codex-config");
    try {
      expect((await service.effortDefault(s.id)).default).toEqual({ level: "medium", source: "model" });
      mkdirSync(process.env.CODEX_HOME, { recursive: true });
      writeFileSync(join(process.env.CODEX_HOME, "config.toml"), 'model_reasoning_effort = "high"\n');
      expect((await service.effortDefault(s.id)).default).toEqual({ level: "high", source: "cli" });
    } finally {
      if (codexHome === undefined) delete process.env.CODEX_HOME;
      else process.env.CODEX_HOME = codexHome;
    }
    // Runtimes without effort have none.
    const other = setup("opencode");
    const o = await other.service.createSession(other.ws.id, { mode: "collaborate", runtime: "opencode" });
    expect(await other.service.effortDefault(o.id)).toEqual({ default: null, cap: null });
  });
});
