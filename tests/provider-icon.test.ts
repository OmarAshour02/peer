// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ProviderIcon } from "../src/renderer/components/ProviderIcon.js";

describe("provider marks", () => {
  it("every runtime has its own mark in its own colours, hidden from assistive tech", () => {
    const mark = (r: "claude" | "codex" | "gemini" | "opencode") => renderToStaticMarkup(createElement(ProviderIcon, { runtime: r }));
    const marks = [mark("claude"), mark("codex"), mark("gemini"), mark("opencode")];
    for (const m of marks) expect(m).toContain('aria-hidden="true"');
    expect(new Set(marks).size).toBe(4);
    expect(mark("claude")).toContain('fill="#D97757"');
    expect(mark("gemini")).toMatch(/<linearGradient id="(gemini-[^"]+)"[\s\S]*fill="url\(#\1\)"/);
    // Monochrome brands follow the theme's foreground.
    expect(mark("codex")).toContain('fill="currentColor"');
    expect(mark("opencode")).toContain('fill="currentColor"');
  });

  it("a session row shows its runtime's mark, in its own colours, in place of the dot", async () => {
    const { Sidebar } = await import("../src/renderer/components/Sidebar.js");
    const { usePeer } = await import("../src/renderer/store.js");
    const ws = { id: "w1", name: "Downloads", path: "/tmp/Downloads", sandboxNetwork: false } as never;
    const session = (id: string, runtime: string, mode: string) =>
      ({ id, workspaceId: "w1", title: `${runtime} ${mode}`, runtime, mode, createdAt: 1, updatedAt: 1 }) as never;
    usePeer.setState({
      connected: true,
      api: { sessions: async () => [] } as never,
      workspaces: [ws],
      activeWorkspaceId: "w1",
      sessions: [session("s1", "claude", "collaborate"), session("s2", "codex", "learn")],
      runtimes: [],
    });
    const host = document.createElement("div");
    const root = createRoot(host);
    await act(async () => root.render(createElement(Sidebar)));
    const html = host.innerHTML;
    await act(async () => root.unmount());
    expect(html).toContain('title="Claude Code · Collaborate"');
    expect(html).toContain('title="Codex · Learn"');
    expect(html).toMatch(/class="flex shrink-0 text-fg" title="Claude Code · Collaborate"><svg/);
    expect(html).toContain('fill="#D97757"');
    // The mark replaces the provider's name: no "Claude"/"Codex" text label on the row.
    expect(html).not.toMatch(/text-\[10px\] text-faint[^>]*>(Claude|Codex)</);
    expect(html).not.toContain("rounded-full bg-collab");
  });

  it("the new-session runtime menu lists only runtimes that are available", async () => {
    const { Sidebar } = await import("../src/renderer/components/Sidebar.js");
    const { usePeer } = await import("../src/renderer/store.js");
    const rt = (kind: string, state: string) => ({ kind, status: { state } }) as never;
    usePeer.setState({
      connected: true,
      api: { sessions: async () => [] } as never,
      workspaces: [{ id: "w1", name: "Downloads", path: "/tmp/Downloads", sandboxNetwork: false } as never],
      activeWorkspaceId: "w1",
      sessions: [],
      newRuntime: "opencode",
      runtimes: [rt("opencode", "ready"), rt("claude", "ready"), rt("codex", "starting"), rt("gemini", "unavailable")],
    });
    const host = document.createElement("div");
    const root = createRoot(host);
    await act(async () => root.render(createElement(Sidebar)));
    const options = () => [...host.querySelectorAll('select[aria-label="Agent runtime for new sessions"] option')].map((o) => o.textContent);
    expect(options()).toEqual(["OpenCode", "Claude Code", "Codex"]);
    // Every runtime down: the current pick stays listed so the menu never shows a value it lacks.
    await act(async () =>
      usePeer.setState({ runtimes: [rt("opencode", "unavailable"), rt("claude", "unavailable"), rt("codex", "unavailable"), rt("gemini", "unavailable")] }),
    );
    expect(options()).toEqual(["OpenCode"]);
    await act(async () => root.unmount());
  });
});
