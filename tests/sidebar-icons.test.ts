// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { describe, expect, it, vi } from "vitest";
import { Sidebar } from "../src/renderer/components/Sidebar.js";
import { usePeer } from "../src/renderer/store.js";

describe("sidebar icons", () => {
  it("share one stroke weight, and settings is a drawn icon like its neighbours", async () => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    usePeer.setState({ connected: true, runtimes: [], workspaces: [{ id: "c", name: "Chats", general: true, path: "/c" } as never], activeWorkspaceId: "c", sessions: [] });
    const host = document.createElement("div");
    const root = createRoot(host);
    await act(async () => root.render(createElement(Sidebar, { onClose: () => {}, onSearch: () => {} })));
    const strokes = new Set([...host.querySelectorAll("svg[stroke-width]")].map((s) => s.getAttribute("stroke-width")));
    expect([...strokes]).toEqual(["1.6"]);
    const settings = host.querySelector('button[aria-label="Runtime settings"]')!;
    expect(settings.querySelector("svg")).not.toBeNull();
    expect(settings.textContent).not.toContain("⚙");
    for (const label of ["Search chats and sessions", "Runtime settings", "Close sidebar"]) expect(host.querySelector(`button[aria-label="${label}"]`)).not.toBeNull();
    await act(async () => root.unmount());
    vi.unstubAllGlobals();
  });
});
