// @vitest-environment jsdom
// The learning map view: a topic opens its chats, a chat opens its session, and the open map
// follows what settings do (clearing, switching tagging off).
import { act, createElement, Fragment } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { LearningMapView } from "../src/renderer/components/LearningMap.js";
import { RuntimeSettingsDialog } from "../src/renderer/components/RuntimeSettingsDialog.js";
import { LearningMapButton } from "../src/renderer/components/Sidebar.js";
import { usePeer } from "../src/renderer/store.js";
import { DEFAULT_RUNTIME_SETTINGS, type LearningMap } from "../src/shared/types.js";

let root: Root;
let host: HTMLDivElement;
let map: LearningMap;
let tagging: boolean;
const empty: LearningMap = { topics: [], links: [], sessions: {} };
let selectSession: ReturnType<typeof vi.fn>;
let selectWorkspace: ReturnType<typeof vi.fn>;

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      disconnect() {}
    },
  );
  vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockReturnValue(800);
  vi.spyOn(HTMLElement.prototype, "clientHeight", "get").mockReturnValue(600);
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  tagging = true;
  map = {
    topics: [{ id: "t", name: "Caching", level: "engaged", mentions: 1, firstSeenAt: 1, lastSeenAt: 1, sessions: [{ sessionId: "s", mentions: 1, level: "engaged", lastAt: 1 }] }],
    links: [],
    sessions: { s: { id: "s", workspaceId: "w2", title: "Caching chat", runtime: "opencode", workspaceName: "Project", general: false } as never },
  };
  selectSession = vi.fn(async () => {});
  selectWorkspace = vi.fn(async () => {});
  usePeer.setState({
    learningMapVersion: 0,
    activeWorkspaceId: "w1",
    selectSession: selectSession as never,
    selectWorkspace: selectWorkspace as never,
    api: {
      learningMap: async () => map,
      clearLearningMap: async () => {
        map = empty;
        return empty;
      },
      preferences: async () => ({ learningMap: tagging, runtimeSettings: DEFAULT_RUNTIME_SETTINGS, crossSessionMemory: true, memoryResetAt: 0 }),
      setPreferences: async (p: { learningMap?: boolean }) => {
        if (p.learningMap !== undefined) tagging = p.learningMap;
        return { learningMap: tagging, runtimeSettings: DEFAULT_RUNTIME_SETTINGS, crossSessionMemory: true, memoryResetAt: 0 };
      },
    } as never,
  });
});

afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

const button = (text: string) => [...host.querySelectorAll("button")].find((b) => b.textContent?.trim() === text || b.textContent?.includes(text));

it("a topic shows its chats, and a chat opens its session in its project", async () => {
  await act(async () => root.render(createElement(LearningMapView, { sidebarOpen: true })));
  const star = host.querySelector('[role="button"][aria-label^="Caching:"]')!;
  expect(star).not.toBeNull();
  await act(async () => star.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true })));
  expect(host.textContent).toContain("Topic · Engaged");
  await act(async () => button("Caching chat")!.click());
  expect(selectWorkspace).toHaveBeenCalledWith("w2");
  expect(selectSession).toHaveBeenCalledWith("s");
});

it("clearing the map in settings empties the map that is already open", async () => {
  vi.spyOn(window, "confirm").mockReturnValue(true);
  await act(async () => root.render(createElement(Fragment, null, createElement(LearningMapView, { sidebarOpen: true }), createElement(RuntimeSettingsDialog))));
  expect(host.textContent).toContain("1 topic");
  await act(async () => button("Clear the map")!.click());
  expect(host.textContent).toContain("Cleared.");
  expect(host.textContent).toContain("0 topics");
  expect(host.textContent).not.toContain("Caching");
});

it("switching tagging off in settings shows on the open map", async () => {
  await act(async () => root.render(createElement(Fragment, null, createElement(LearningMapView, { sidebarOpen: true }), createElement(RuntimeSettingsDialog))));
  expect(host.textContent).not.toContain("tagging is off");
  await act(async () => button("Topic tagging: on")!.click());
  expect(host.textContent).toContain("tagging is off");
});

it("an answer from before a clear never brings removed topics back", async () => {
  vi.spyOn(window, "confirm").mockReturnValue(true);
  // The first request (from opening the map) is slow and resolves after the clear's reload.
  let releaseFirst!: () => void;
  const before = map;
  const api = usePeer.getState().api as unknown as { learningMap: () => Promise<LearningMap> };
  const fresh = api.learningMap;
  let calls = 0;
  api.learningMap = () => (++calls === 1 ? new Promise((r) => (releaseFirst = () => r(before))) : fresh());
  await act(async () => root.render(createElement(Fragment, null, createElement(LearningMapView, { sidebarOpen: true }), createElement(RuntimeSettingsDialog))));
  await act(async () => button("Clear the map")!.click());
  expect(host.textContent).toContain("0 topics");
  await act(async () => releaseFirst());
  expect(host.textContent).toContain("0 topics");
  expect(host.textContent).not.toContain("Caching");
});

it("the sidebar icon opens and closes the map and shows whether it is open", async () => {
  usePeer.setState({ learningMapOpen: false });
  await act(async () => root.render(createElement(LearningMapButton)));
  const icon = host.querySelector<HTMLButtonElement>('button[aria-label="Learning map"]')!;
  expect(icon.getAttribute("aria-pressed")).toBe("false");
  expect(icon.title).toMatch(/\((⌘|Ctrl\+)G\)/);
  await act(async () => icon.click());
  expect(usePeer.getState().learningMapOpen).toBe(true);
  expect(icon.getAttribute("aria-pressed")).toBe("true");
  await act(async () => icon.click());
  expect(usePeer.getState().learningMapOpen).toBe(false);
});

it("reloads when Peer reports new topics, however long the read took", async () => {
  await act(async () => root.render(createElement(LearningMapView, { sidebarOpen: true })));
  expect(host.textContent).toContain("1 topic");
  map = { ...map, topics: [...map.topics, { ...map.topics[0]!, id: "t2", name: "Eviction" }] };
  await act(async () => usePeer.getState().handleEvent({ type: "learningMap.updated" }));
  expect(host.textContent).toContain("2 topics");
});

it("reloads after the event stream reconnects (updates sent meanwhile are not replayed)", async () => {
  await act(async () => root.render(createElement(LearningMapView, { sidebarOpen: true })));
  expect(host.textContent).toContain("1 topic");
  map = { ...map, topics: [...map.topics, { ...map.topics[0]!, id: "t2", name: "Eviction" }] };
  const api = usePeer.getState().api as unknown as Record<string, unknown>;
  Object.assign(api, { health: async () => ({ runtimes: [] }), models: async () => ({ providers: [], default: null }) });
  await act(async () => usePeer.getState().reconnected());
  expect(host.textContent).toContain("2 topics");
});
