import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PeerEvent, ProviderCatalog } from "../src/shared/types.js";
import { createApp } from "../src/server/app.js";
import { EventHub } from "../src/server/hub.js";
import { ProviderError, type ProviderConnections } from "../src/server/runtime/adapter.js";
import { claudeAccount } from "../src/server/runtime/claude/adapter.js";
import { codexAccount } from "../src/server/runtime/codex/adapter.js";
import { credentialIds, importedIds, importUserCredentials, markConnectedInPeer, markDisconnectedInPeer, runtimeAuthFile, userAuthFile } from "../src/server/runtime/opencode/credentials.js";
import { OpenCodeAdapter } from "../src/server/runtime/opencode/adapter.js";
import { usePeer } from "../src/renderer/store.js";
import type { PeerApi } from "../src/renderer/api.js";
import { OpenCodeProcess } from "../src/server/runtime/opencode/process.js";
import { ProviderReload, toCatalog, type OcProviderList } from "../src/server/runtime/opencode/providers.js";
import { RuntimeSet } from "../src/server/runtime/set.js";
import { PeerService } from "../src/server/service.js";
import { Store } from "../src/server/store.js";
import { FakeRuntime } from "./helpers.js";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "peer-providers-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const api = (key: string) => ({ type: "api", key });
const write = (file: string, data: unknown) => {
  mkdirSync(join(file, ".."), { recursive: true });
  writeFileSync(file, JSON.stringify(data));
};
const read = (file: string) => JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;

describe("OpenCode credentials", () => {
  it("imports the developer's OpenCode logins, which win, and keeps providers connected in Peer", () => {
    const user = join(dir, "user", "auth.json");
    const runtime = runtimeAuthFile(join(dir, "rt"));
    write(user, { openai: api("sk-user"), broken: { type: "api" }, future: { type: "v2-thing", token: "x" } });
    write(runtime, { openai: api("sk-old"), groq: api("gsk-peer") });

    importUserCredentials(user, runtime);

    expect(read(runtime)).toEqual({ openai: api("sk-user"), groq: api("gsk-peer") });
    expect(statSync(runtime).mode & 0o777).toBe(0o600);
    expect(credentialIds(runtime)).toEqual(new Set(["openai", "groq"]));
    // Entries another OpenCode version wrote, which the pinned runtime can't read, are skipped.
    expect(credentialIds(user)).toEqual(new Set(["openai"]));
  });

  it("removes an imported login again once the developer logs out of it, and keeps Peer's own", () => {
    const user = join(dir, "user", "auth.json");
    const runtime = runtimeAuthFile(join(dir, "rt"));
    write(user, { groq: api("gsk-cli"), openai: api("sk-cli") });
    write(runtime, { mistral: api("peer-key") });
    importUserCredentials(user, runtime);
    expect(importedIds(runtime)).toEqual(new Set(["groq", "openai"]));

    // Connecting openai in Peer makes it Peer's; logging out of both in the CLI removes only groq.
    markConnectedInPeer(runtime, "openai");
    write(user, {});
    importUserCredentials(user, runtime);
    expect(credentialIds(runtime)).toEqual(new Set(["mistral", "openai"]));
    expect(importedIds(runtime)).toEqual(new Set());
  });

  it("keeps a key connected in Peer across restarts while the developer's own login still has that provider", () => {
    const user = join(dir, "user", "auth.json");
    const runtime = runtimeAuthFile(join(dir, "rt"));
    write(user, { openai: api("sk-cli") });
    importUserCredentials(user, runtime);
    // The developer connects openai in Peer (the runtime writes the new key), then restarts.
    write(runtime, { openai: api("sk-peer") });
    markConnectedInPeer(runtime, "openai");
    importUserCredentials(user, runtime);
    expect(read(runtime)).toEqual({ openai: api("sk-peer") });
    expect(importedIds(runtime)).toEqual(new Set());

    // Disconnected in Peer: their own login applies again on the next start.
    write(runtime, {});
    markDisconnectedInPeer(runtime, "openai");
    importUserCredentials(user, runtime);
    expect(read(runtime)).toEqual({ openai: api("sk-cli") });
    expect(importedIds(runtime)).toEqual(new Set(["openai"]));
  });

  it("refuses to disconnect an imported login in Peer", async () => {
    const env = { HOME: join(dir, "home") };
    const rootDir = join(dir, "rt");
    write(userAuthFile(env), { groq: api("gsk-cli") });
    importUserCredentials(userAuthFile(env), runtimeAuthFile(rootDir));
    const remove = vi.fn(async () => ({ data: true }));
    const adapter = new OpenCodeAdapter({ binary: "", rootDir, pluginFile: "", env, bridgeUrl: "", bridgeToken: "", log: () => {} });
    (adapter as unknown as { client: unknown }).client = { auth: { remove }, global: { dispose: async () => ({}) } };
    await expect(adapter.providers.disconnect("groq")).rejects.toThrow(/your own OpenCode login/);

    // After a CLI logout and a restart it is gone, so there is nothing left to disconnect.
    write(userAuthFile(env), {});
    importUserCredentials(userAuthFile(env), runtimeAuthFile(rootDir));
    await expect(adapter.providers.disconnect("groq")).rejects.toThrow(/Only providers connected in Peer/);
    expect(remove).not.toHaveBeenCalled();
  });

  it("leaves the runtime's file alone without a usable user login", () => {
    const runtime = runtimeAuthFile(join(dir, "rt"));
    importUserCredentials(join(dir, "missing.json"), runtime);
    expect(credentialIds(runtime)).toEqual(new Set());
    write(join(dir, "bad.json"), "not an object");
    importUserCredentials(join(dir, "bad.json"), runtime);
    expect(credentialIds(runtime)).toEqual(new Set());
  });

  it("finds the developer's login under XDG_DATA_HOME or ~/.local/share", () => {
    expect(userAuthFile({ HOME: "/h" })).toBe("/h/.local/share/opencode/auth.json");
    expect(userAuthFile({ HOME: "/h", XDG_DATA_HOME: "/x" })).toBe("/x/opencode/auth.json");
  });

  it("starts the runtime without OPENCODE_AUTH_CONTENT, which would hide keys saved through its API", async () => {
    const home = join(dir, "home");
    write(join(home, ".local", "share", "opencode", "auth.json"), { anthropic: api("sk-ant") });
    const envFile = join(dir, "env.txt");
    const bin = join(dir, "fake-opencode");
    writeFileSync(bin, `#!/bin/sh\nenv > "${envFile}"\necho "opencode server listening on http://127.0.0.1:4999"\nexec sleep 30\n`);
    chmodSync(bin, 0o755);
    const rootDir = join(dir, "rt");
    const proc = new OpenCodeProcess({
      binary: bin,
      rootDir,
      pluginFile: bin,
      env: { PATH: process.env.PATH, HOME: home, OPENCODE_AUTH_CONTENT: '{"x":{"type":"api","key":"k"}}' },
      bridgeUrl: "http://127.0.0.1:1",
      bridgeToken: "t",
      log: () => {},
    });
    try {
      await proc.start(() => {});
      const env = readFileSync(envFile, "utf8");
      expect(env).not.toContain("OPENCODE_AUTH_CONTENT");
      expect(env).toContain(`XDG_DATA_HOME=${join(rootDir, "data")}`);
      expect(read(runtimeAuthFile(rootDir))).toEqual({ anthropic: api("sk-ant") });
    } finally {
      await proc.stop();
    }
  });
});

describe("provider catalog", () => {
  const list: OcProviderList = {
    all: [
      { id: "zeta", name: "Zeta AI", source: "custom", env: ["ZETA_KEY"], models: { a: {} } },
      { id: "openai", name: "OpenAI", source: "api", env: ["OPENAI_API_KEY"], models: { a: {}, b: {} }, key: "sk-secret", options: { apiKey: "sk-secret" } } as OcProviderList["all"][number],
      { id: "groq", name: "Groq", source: "api", env: [], models: {} },
      { id: "anthropic", name: "Anthropic", source: "env", env: ["ANTHROPIC_API_KEY"], models: {} },
      { id: "local", name: "Local", source: "config", env: [], models: {} },
      { id: "opencode", name: "OpenCode", source: "custom", env: [], models: {} },
    ],
    connected: ["openai", "groq", "anthropic", "local", "opencode"],
  };
  const methods = { openai: [{ type: "oauth" as const, label: "ChatGPT" }, { type: "api" as const, label: "Manually enter API Key" }] };

  it("never carries a credential", () => {
    const json = JSON.stringify(toCatalog(list, methods, new Set(["openai"]), new Set(), false));
    expect(json).not.toContain("sk-secret");
    expect(json).not.toContain("options");
  });

  it("says where each connection comes from", () => {
    const catalog = toCatalog(list, methods, new Set(["openai", "groq"]), new Set(["openai"]), true);
    const source = Object.fromEntries(catalog.providers.map((p) => [p.id, p.source]));
    expect(source).toEqual({ openai: "opencode-login", groq: "peer", anthropic: "environment", local: "config", opencode: "built-in", zeta: undefined });
    expect(catalog.reloadPending).toBe(true);
  });

  it("lists connected providers first, then popular ones, with OpenCode's login methods or an API key", () => {
    const catalog = toCatalog(list, methods, new Set(), new Set(), false);
    expect(catalog.providers.map((p) => p.id)).toEqual(["anthropic", "openai", "opencode", "groq", "local", "zeta"]);
    const openai = catalog.providers.find((p) => p.id === "openai")!;
    expect(openai.methods.map((m) => [m.type, m.prompts])).toEqual([["oauth", []], ["api", []]]);
    expect(catalog.providers.find((p) => p.id === "zeta")!.methods).toEqual([{ type: "api", label: "API key", prompts: [] }]);
    expect(openai.modelCount).toBe(2);
  });
});

describe("provider reload", () => {
  function setup(busy = false) {
    const state = { busy, disposed: 0, changes: [] as boolean[] };
    const reload = new ProviderReload({
      anyBusy: async () => state.busy,
      dispose: async () => {
        state.disposed++;
      },
      onChange: (pending) => state.changes.push(pending),
      log: () => {},
      retryMs: 60_000,
    });
    return { state, reload };
  }

  it("reloads right away when no session is running", async () => {
    const { state, reload } = setup();
    expect(await reload.request()).toBe(true);
    expect(state.disposed).toBe(1);
    expect(state.changes).toEqual([false]);
    expect(reload.isPending).toBe(false);
  });

  it("waits for running sessions, and reloads once they are idle", async () => {
    const { state, reload } = setup(true);
    expect(await reload.request()).toBe(false);
    expect(await reload.request()).toBe(false);
    expect(state.disposed).toBe(0);
    expect(state.changes).toEqual([true]); // announced once
    expect(reload.isPending).toBe(true);

    state.busy = false;
    reload.poke();
    await reload.hold().then((release) => release());
    expect(state.disposed).toBe(1);
    expect(state.changes).toEqual([true, false]);
  });

  it("never reloads between a prompt being sent and the runtime reporting it busy", async () => {
    const { state, reload } = setup();
    const release = await reload.hold();
    expect(await reload.request()).toBe(false);
    expect(state.disposed).toBe(0);
    state.busy = true; // the runtime now reports the turn
    release();
    await reload.hold().then((r) => r());
    expect(state.disposed).toBe(0);
  });

  it("holds new prompts while a reload runs", async () => {
    let finish!: () => void;
    const order: string[] = [];
    const reload = new ProviderReload({
      anyBusy: async () => false,
      dispose: () => new Promise<void>((resolve) => (finish = resolve)).then(() => void order.push("disposed")),
      onChange: () => {},
      log: () => {},
    });
    const reloading = reload.request();
    const held = reload.hold().then((release) => {
      order.push("prompt");
      release();
    });
    await new Promise((r) => setTimeout(r, 10));
    expect(order).toEqual([]);
    finish();
    await Promise.all([reloading, held]);
    expect(order).toEqual(["disposed", "prompt"]);
  });

  it("forgets a waiting reload when the runtime stops (it reads credentials on start)", async () => {
    const { reload } = setup(true);
    await reload.request();
    reload.reset();
    expect(reload.isPending).toBe(false);
  });
});

describe("agent CLI logins", () => {
  it("names how Claude Code is signed in, without the email", () => {
    expect(claudeAccount({ loggedIn: true, authMethod: "claude.ai", subscriptionType: "pro" }, true)).toBe("Claude Pro");
    expect(claudeAccount({ loggedIn: true, authMethod: "claude.ai" }, true)).toBe("Claude account");
    expect(claudeAccount({ loggedIn: true, authMethod: "console" }, true)).toBe("Anthropic API key");
    expect(claudeAccount({ apiProvider: "bedrock" }, true)).toBe("Amazon Bedrock");
    expect(claudeAccount({}, false)).toBe("ANTHROPIC_API_KEY");
  });

  it("names how Codex is signed in, never echoing a key", () => {
    expect(codexAccount("Logged in using ChatGPT\n")).toBe("ChatGPT");
    expect(codexAccount("Logged in using an API key - sk-proj-***abcd\n")).toBe("OpenAI API key");
    expect(codexAccount("")).toBeUndefined();
  });
});

describe("provider API", () => {
  const catalog: ProviderCatalog = { providers: [], local: [], reloadPending: false };
  let store: Store;
  let calls: unknown[][];
  let events: PeerEvent[];
  let opencode: FakeRuntime & { providers?: ProviderConnections };
  let request: (method: string, path: string, body?: unknown) => Promise<{ status: number; body: Record<string, unknown> }>;

  beforeEach(() => {
    store = new Store(":memory:");
    calls = [];
    events = [];
    opencode = new FakeRuntime("opencode");
    opencode.providers = {
      catalog: async () => catalog,
      setKey: async (...args) => void calls.push(["setKey", ...args]),
      startOAuth: async (...args) => {
        calls.push(["startOAuth", ...args]);
        return { url: "https://login.example", mode: "code", instructions: "Paste the code" };
      },
      finishOAuth: async (...args) => void calls.push(["finishOAuth", ...args]),
      addLocal: async (...args) => void calls.push(["addLocal", ...args]),
      removeLocal: async (...args) => void calls.push(["removeLocal", ...args]),
      disconnect: async (id) => {
        throw new ProviderError(`Only providers connected in Peer can be disconnected here (${id}).`);
      },
    };
    const hub = new EventHub();
    hub.subscribe((e) => events.push(e));
    const service = new PeerService(store, new RuntimeSet([opencode, new FakeRuntime("claude")]), hub);
    const app = createApp({ service, hub, apiToken: "token", bridgeToken: "bridge", allowedOrigins: [] });
    request = async (method, path, body) => {
      const res = await app.request(`/api${path}`, {
        method,
        headers: { authorization: "Bearer token", "content-type": "application/json" },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      return { status: res.status, body: (await res.json()) as Record<string, unknown> };
    };
  });
  afterEach(() => store.close());

  it("connects with a key and returns the catalog, not the key", async () => {
    const res = await request("POST", "/runtimes/opencode/providers/groq/key", { key: "  gsk-1  ", inputs: { accountId: "a1" } });
    expect(res.status).toBe(200);
    expect(res.body).toEqual(catalog);
    expect(calls).toEqual([["setKey", "groq", "gsk-1", { accountId: "a1" }]]);
  });

  it("validates input before anything reaches the runtime", async () => {
    expect((await request("POST", "/runtimes/opencode/providers/groq/key", { key: " " })).status).toBe(400);
    expect((await request("POST", "/runtimes/opencode/providers/groq/key", { key: "k", inputs: { a: 1 } })).status).toBe(400);
    expect((await request("POST", "/runtimes/opencode/providers/openai/oauth", { method: -1 })).status).toBe(400);
    expect((await request("POST", "/runtimes/opencode/providers/openai/oauth/callback", { method: 0, code: 5 })).status).toBe(400);
    expect(calls).toEqual([]);
  });

  it("runs a browser login in two steps", async () => {
    const start = await request("POST", "/runtimes/opencode/providers/openai/oauth", { method: 1 });
    expect(start.body).toEqual({ url: "https://login.example", mode: "code", instructions: "Paste the code" });
    await request("POST", "/runtimes/opencode/providers/openai/oauth/callback", { method: 1, code: " abc " });
    expect(calls).toEqual([
      ["startOAuth", "openai", 1, {}],
      ["finishOAuth", "openai", 1, "abc"],
    ]);
  });

  it("reports provider errors as the developer's to fix, and runtimes without provider management", async () => {
    const res = await request("DELETE", "/runtimes/opencode/providers/anthropic");
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/Only providers connected in Peer/);
    const claude = await request("GET", "/runtimes/claude/providers");
    expect(claude.status).toBe(404);
    expect(claude.body.error).toMatch(/manages its own login/);
  });

  it("tells the UI when a runtime's providers change", () => {
    opencode.emit({ type: "providers.updated", reloadPending: true });
    expect(events).toContainEqual({ type: "providers.updated", runtime: "opencode", reloadPending: true });
  });
});

describe("UI after missed events", () => {
  it("reloads models and provider state when the event stream reconnects", async () => {
    const newModels = { providers: [{ id: "groq", name: "Groq", models: [] }], default: null };
    const models = vi.fn(async () => newModels);
    const runtimes = [{ kind: "opencode" as const, name: "OpenCode", status: { state: "ready" as const } }];
    usePeer.setState({
      api: { health: async () => ({ runtime: runtimes[0]!.status, runtimes }), models } as unknown as PeerApi,
      activeWorkspaceId: "w",
      activeSessionId: null,
      modelsFor: "opencode",
      models: { providers: [{ id: "old", name: "Old", models: [] }], default: null },
      runtimes,
      providersVersion: 3,
    });
    await usePeer.getState().reconnected();
    expect(models).toHaveBeenCalledWith("w", "opencode");
    expect(usePeer.getState().models).toEqual(newModels);
    expect(usePeer.getState().providersVersion).toBe(4);
  });

  it("new sessions follow the best ready runtime until the developer picks one", () => {
    const ready = { state: "ready" as const };
    usePeer.setState({
      api: null,
      snapshot: { session: { runtime: "opencode" } } as never,
      runtimeChosen: null,
      newRuntime: "opencode",
      runtimes: [
        { kind: "opencode", name: "OpenCode", status: ready },
        { kind: "claude", name: "Claude Code", status: { state: "starting" } },
      ],
    });
    usePeer.getState().handleEvent({ type: "runtime.status", runtime: "claude", status: { ...ready, account: "Claude Pro" } });
    expect(usePeer.getState().newRuntime).toBe("claude");

    usePeer.setState({ runtimeChosen: "opencode", newRuntime: "opencode" });
    usePeer.getState().handleEvent({ type: "runtime.status", runtime: "claude", status: ready });
    expect(usePeer.getState().newRuntime).toBe("opencode");
  });

  it("reloads models when a runtime comes back after a restart", async () => {
    const models = vi.fn(async () => ({ providers: [], default: null }));
    usePeer.setState({
      api: { models } as unknown as PeerApi,
      activeWorkspaceId: "w",
      modelsFor: "opencode",
      models: { providers: [{ id: "old", name: "Old", models: [] }], default: null },
      runtimes: [{ kind: "opencode", name: "OpenCode", status: { state: "starting" } }],
    });
    usePeer.getState().handleEvent({ type: "runtime.status", runtime: "opencode", status: { state: "ready" } });
    await vi.waitFor(() => expect(models).toHaveBeenCalled());
  });
});
