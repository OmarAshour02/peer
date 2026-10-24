import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createApp } from "../src/server/app.js";
import { EventHub } from "../src/server/hub.js";
import type { ProviderConnections } from "../src/server/runtime/adapter.js";
import { OpenCodeAdapter } from "../src/server/runtime/opencode/adapter.js";
import { fetchModels, LocalServers, localServersFile, normalizeBaseUrl, ollamaBaseUrl, peerConfigFile } from "../src/server/runtime/opencode/local.js";
import { OpenCodeProcess } from "../src/server/runtime/opencode/process.js";
import { toCatalog } from "../src/server/runtime/opencode/providers.js";
import { RuntimeSet } from "../src/server/runtime/set.js";
import { PeerService } from "../src/server/service.js";
import { Store } from "../src/server/store.js";
import { FakeRuntime } from "./helpers.js";

let dir: string;
let server: Server;
let base: string;
/** What the fake server lists at /v1/models; null answers 404. */
let models: string[] | null;
let requests: { url: string; authorization?: string }[];

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "peer-local-"));
  models = ["qwen3-coder:30b", "nomic-embed-text", "llama3.2"];
  requests = [];
  server = createServer((req, res) => {
    requests.push({ url: req.url ?? "", authorization: req.headers.authorization });
    if (req.url !== "/v1/models" || models === null) {
      res.statusCode = 404;
      return res.end("{}");
    }
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ object: "list", data: models.map((id) => ({ id, object: "model" })) }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`;
});

afterEach(async () => {
  await new Promise((resolve) => server.close(resolve));
  rmSync(dir, { recursive: true, force: true });
});

const json = (file: string) => JSON.parse(readFileSync(file, "utf8"));
/** An address nothing listens on. */
const closedPort = async () => {
  const s = createServer();
  await new Promise<void>((resolve) => s.listen(0, "127.0.0.1", resolve));
  const port = (s.address() as AddressInfo).port;
  await new Promise((resolve) => s.close(resolve));
  return `http://127.0.0.1:${port}/v1`;
};

describe("local server addresses", () => {
  it("accepts http(s) addresses only, adding /v1 to a bare server address", () => {
    expect(normalizeBaseUrl("http://localhost:11434")).toBe("http://localhost:11434/v1");
    expect(normalizeBaseUrl(" http://127.0.0.1:8080/v1/ ")).toBe("http://127.0.0.1:8080/v1");
    expect(normalizeBaseUrl("https://gpu-box.lan/openai/v1?x=1#y")).toBe("https://gpu-box.lan/openai/v1");
    expect(() => normalizeBaseUrl("file:///etc/passwd")).toThrow(/http/);
    expect(() => normalizeBaseUrl("localhost:11434")).toThrow(/http/);
    expect(() => normalizeBaseUrl("http://user:pw@localhost:1234")).toThrow(/credentials/);
    expect(() => normalizeBaseUrl("not a url")).toThrow(/address/);
  });

  it("finds Ollama where OLLAMA_HOST points", () => {
    expect(ollamaBaseUrl({})).toBe("http://127.0.0.1:11434/v1");
    expect(ollamaBaseUrl({ OLLAMA_HOST: "0.0.0.0" })).toBe("http://127.0.0.1:11434/v1");
    expect(ollamaBaseUrl({ OLLAMA_HOST: "0.0.0.0:9999" })).toBe("http://127.0.0.1:9999/v1");
    expect(ollamaBaseUrl({ OLLAMA_HOST: "https://ollama.lan" })).toBe("https://ollama.lan/v1");
  });

  it("lists a server's models without embedding models, and null when it does not answer", async () => {
    expect(await fetchModels(base)).toEqual(["llama3.2", "qwen3-coder:30b"]);
    models = null;
    expect(await fetchModels(base)).toBeNull();
    expect(await fetchModels(await closedPort())).toBeNull();
    expect(requests.every((r) => r.authorization === undefined)).toBe(true);
  });
});

describe("added local servers", () => {
  it("adds a server as an OpenCode provider with its models, and removes it", async () => {
    const local = new LocalServers(dir);
    const added = await local.add({ baseUrl: base.replace("/v1", ""), name: "Ollama", kind: "ollama" });
    expect(added).toMatchObject({ id: "local-ollama", baseUrl: base, models: ["llama3.2", "qwen3-coder:30b"] });
    expect(json(peerConfigFile(dir))).toEqual({
      provider: {
        "local-ollama": {
          npm: "@ai-sdk/openai-compatible",
          name: "Ollama (local)",
          options: { baseURL: base },
          models: { "llama3.2": { name: "llama3.2", tool_call: true }, "qwen3-coder:30b": { name: "qwen3-coder:30b", tool_call: true } },
        },
      },
    });
    await expect(local.add({ baseUrl: base })).rejects.toThrow(/already added/);
    expect(new LocalServers(dir).list()).toHaveLength(1); // persisted

    local.remove("local-ollama");
    expect(local.list()).toEqual([]);
    expect(json(peerConfigFile(dir))).toEqual({ provider: {} });
    expect(() => local.remove("local-ollama")).toThrow(/not added/);
  });

  it("only adds servers that answer with models", async () => {
    const local = new LocalServers(dir);
    await expect(local.add({ baseUrl: await closedPort() })).rejects.toThrow(/Nothing answered/);
    models = ["text-embedding-3"];
    await expect(local.add({ baseUrl: base })).rejects.toThrow(/no models/);
    expect(existsSync(localServersFile(dir))).toBe(false);
  });

  it("keeps ids unique and names default to the host", async () => {
    const local = new LocalServers(dir);
    const a = await local.add({ baseUrl: base, name: "Box" });
    server.close();
    const other = createServer((_req, res) => res.end(JSON.stringify({ data: [{ id: "m" }] })));
    await new Promise<void>((resolve) => other.listen(0, "127.0.0.1", resolve));
    try {
      const otherBase = `http://127.0.0.1:${(other.address() as AddressInfo).port}/v1`;
      const b = await local.add({ baseUrl: otherBase, name: "Box" });
      expect([a.id, b.id]).toEqual(["local-box", "local-box-2"]);
      const c = await local.add({ baseUrl: otherBase.replace("127.0.0.1", "localhost") });
      expect(c.name).toBe(new URL(otherBase.replace("127.0.0.1", "localhost")).host);
    } finally {
      await new Promise((resolve) => other.close(resolve));
      server = createServer(); // afterEach closes it
      server.listen(0);
    }
  });

  it("refreshes model lists, keeping the last known ones while a server is down", async () => {
    const local = new LocalServers(dir);
    await local.add({ baseUrl: base, name: "Ollama", kind: "ollama" });
    const env = { OLLAMA_HOST: base.replace("/v1", "") }; // the preset points at the added server: listed once

    models = ["llama3.2", "qwen3-coder:30b", "devstral"];
    const fresh = await local.refresh(env);
    expect(fresh.changed).toBe(true);
    expect(fresh.servers.filter((s) => s.kind === "ollama")).toEqual([
      { id: "local-ollama", name: "Ollama", kind: "ollama", baseUrl: base, added: true, running: true, models: ["devstral", "llama3.2", "qwen3-coder:30b"] },
    ]);
    expect(Object.keys(json(peerConfigFile(dir)).provider["local-ollama"].models)).toContain("devstral");
    expect((await local.refresh(env)).changed).toBe(false);

    models = null;
    const down = await local.refresh(env);
    expect(down.changed).toBe(false);
    expect(down.servers[0]).toMatchObject({ running: false, models: ["devstral", "llama3.2", "qwen3-coder:30b"] });
  });

  it("offers running presets that are not added yet", async () => {
    const env = { OLLAMA_HOST: base.replace("/v1", "") };
    const { servers } = await new LocalServers(dir).refresh(env);
    expect(servers.find((s) => s.kind === "ollama")).toEqual({ id: null, name: "Ollama", kind: "ollama", baseUrl: base, added: false, running: true, models: ["llama3.2", "qwen3-coder:30b"] });
    expect(servers.find((s) => s.kind === "lmstudio")).toMatchObject({ added: false, baseUrl: "http://127.0.0.1:1234/v1" });
  });
});

describe("local servers in the runtime", () => {
  it("writes the local providers into the config dir before OpenCode starts", async () => {
    await new LocalServers(dir).add({ baseUrl: base, name: "LM Studio", kind: "lmstudio" });
    rmSync(peerConfigFile(dir));
    const seen = join(dir, "seen.json");
    const bin = join(dir, "fake-opencode");
    writeFileSync(bin, `#!/bin/sh\ncp "$OPENCODE_CONFIG_DIR/opencode.json" "${seen}"\necho "opencode server listening on http://127.0.0.1:4999"\nexec sleep 30\n`);
    chmodSync(bin, 0o755);
    const proc = new OpenCodeProcess({ binary: bin, rootDir: dir, pluginFile: bin, env: { PATH: process.env.PATH, HOME: join(dir, "home") }, bridgeUrl: "http://127.0.0.1:1", bridgeToken: "t", log: () => {} });
    try {
      await proc.start(() => {});
      expect(Object.keys(json(seen).provider)).toEqual(["local-lm-studio"]);
    } finally {
      await proc.stop();
    }
  });

  it("adding or removing a server reloads the runtime's providers", async () => {
    const dispose = vi.fn(async () => ({ data: true }));
    const adapter = new OpenCodeAdapter({ binary: "", rootDir: dir, pluginFile: "", env: {}, bridgeUrl: "", bridgeToken: "", log: () => {} });
    (adapter as unknown as { client: unknown }).client = { global: { dispose } };
    await adapter.providers.addLocal({ baseUrl: base, name: "Ollama" });
    expect(dispose).toHaveBeenCalledTimes(1);
    await adapter.providers.removeLocal("local-ollama");
    expect(dispose).toHaveBeenCalledTimes(2);
  });

  it("lists added local servers apart from cloud providers", () => {
    const catalog = toCatalog(
      { all: [{ id: "local-ollama", name: "Ollama (local)", source: "config", env: [], models: { m: {} } }, { id: "groq", name: "Groq", source: "api", env: [], models: {} }], connected: ["local-ollama"] },
      {},
      new Set(),
      new Set(),
      false,
      [{ id: "local-ollama", name: "Ollama", kind: "ollama", baseUrl: base, added: true, running: true, models: ["m"] }],
    );
    expect(catalog.providers.map((p) => p.id)).toEqual(["groq"]);
    expect(catalog.local).toHaveLength(1);
  });

  it("validates local server requests over the API", async () => {
    const calls: unknown[] = [];
    const opencode = new FakeRuntime("opencode") as FakeRuntime & { providers?: ProviderConnections };
    opencode.providers = {
      catalog: async () => ({ providers: [], local: [], reloadPending: false }),
      setKey: async () => {},
      startOAuth: async () => ({ url: "", mode: "auto", instructions: "" }),
      finishOAuth: async () => {},
      disconnect: async () => {},
      addLocal: async (input) => void calls.push(["add", input]),
      removeLocal: async (id) => void calls.push(["remove", id]),
    };
    const store = new Store(":memory:");
    const hub = new EventHub();
    const app = createApp({ service: new PeerService(store, new RuntimeSet([opencode]), hub), hub, apiToken: "token", bridgeToken: "b", allowedOrigins: [] });
    const send = (method: string, path: string, body?: unknown) =>
      app.request(`/api${path}`, { method, headers: { authorization: "Bearer token", "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
    expect((await send("POST", "/runtimes/opencode/local-servers", {})).status).toBe(400);
    expect((await send("POST", "/runtimes/opencode/local-servers", { baseUrl: base, kind: "vllm" })).status).toBe(400);
    expect((await send("POST", "/runtimes/opencode/local-servers", { baseUrl: base, name: "Box", kind: "custom" })).status).toBe(200);
    expect((await send("DELETE", "/runtimes/opencode/local-servers/local-box")).status).toBe(200);
    expect((await send("POST", "/runtimes/claude/local-servers", { baseUrl: base })).status).toBe(404);
    expect(calls).toEqual([
      ["add", { baseUrl: base, name: "Box", kind: "custom" }],
      ["remove", "local-box"],
    ]);
    store.close();
  });
});
