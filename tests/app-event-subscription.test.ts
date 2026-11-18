// @vitest-environment jsdom
import { StrictMode, act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";

const open: number[] = [];
let next = 0;
vi.mock("../src/renderer/api", () => ({
  resolveConfig: async () => ({ apiBase: "http://test", token: "t" }),
  PeerApi: class {
    events() {
      const id = ++next;
      open.push(id);
      return () => open.splice(open.indexOf(id), 1);
    }
    // Everything else the store asks for at start-up: never answers, so the app stays loading.
    constructor() {
      return new Proxy(this, { get: (t, k) => (k in t ? (t as Record<PropertyKey, unknown>)[k] : () => new Promise(() => {})) });
    }
  },
}));

const { App } = await import("../src/renderer/App.js");

it("keeps one event stream open when StrictMode mounts the app twice, so deltas apply once", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("matchMedia", () => ({ matches: false, addEventListener() {}, removeEventListener() {} }));
  const root = createRoot(document.createElement("div"));
  await act(async () => root.render(createElement(StrictMode, null, createElement(App))));
  await act(async () => new Promise((r) => setTimeout(r, 0)));
  expect(open).toHaveLength(1);
  await act(async () => root.unmount());
  expect(open).toHaveLength(0);
});
