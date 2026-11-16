// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SearchDialog } from "../src/renderer/components/SearchDialog.js";
import { usePeer } from "../src/renderer/store.js";
import type { PeerSession } from "../src/shared/types.js";

const session = (id: string, title: string): PeerSession => ({ id, title, workspaceId: "ws", runtime: "opencode" }) as PeerSession;
const wait = (ms: number) => act(async () => new Promise((r) => setTimeout(r, ms)));

let host: HTMLDivElement;
let root: Root;
let selectSession: ReturnType<typeof vi.fn<(id: string | null) => Promise<void>>>;

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  selectSession = vi.fn<(id: string | null) => Promise<void>>(async () => {});
  // The server answers slowly: an empty query lists "Old", a "Target" query finds "Target".
  const searchSessions = (q: string) =>
    new Promise<PeerSession[]>((r) => setTimeout(() => r(q ? [session("target", "Target")] : [session("old", "Old")]), 300));
  usePeer.setState({
    api: { searchSessions } as never,
    workspaces: [{ id: "ws", name: "Chats", general: true } as never],
    activeWorkspaceId: "ws",
    selectWorkspace: vi.fn<(id: string | null) => Promise<void>>(async () => {}),
    selectSession,
  });
});

afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  vi.unstubAllGlobals();
});

function type(input: HTMLInputElement, value: string) {
  const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
  set.call(input, value);
  input.dispatchEvent(new Event("input", { bubbles: true }));
}
const press = (input: HTMLInputElement, key: string) => input.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true }));

describe("search dialog", () => {
  it("Enter pressed before the new results arrive opens the new query's first match, never a stale one", async () => {
    const onClose = vi.fn();
    await act(async () => root.render(createElement(SearchDialog, { onClose })));
    await wait(500); // recent sessions ("Old") are on screen
    expect(host.textContent).toContain("Old");
    const input = host.querySelector("input")!;
    await act(async () => {
      type(input, "Target");
      press(input, "Enter");
    });
    expect(selectSession).not.toHaveBeenCalled();
    await wait(600);
    expect(selectSession).toHaveBeenCalledTimes(1);
    expect(selectSession).toHaveBeenCalledWith("target");
    expect(onClose).toHaveBeenCalled();
  });

  it("stale results can't be clicked while the new query is pending", async () => {
    await act(async () => root.render(createElement(SearchDialog, { onClose: () => {} })));
    await wait(500);
    const input = host.querySelector("input")!;
    await act(async () => type(input, "Target"));
    await act(async () => (host.querySelector('[role="option"]') as HTMLElement).click());
    expect(selectSession).not.toHaveBeenCalled();
    expect(host.querySelector('[role="listbox"]')?.getAttribute("aria-busy")).toBe("true");
  });
});
