// @vitest-environment jsdom
// The chat workspace's collaboration UI: queuing the next message, the checkpoint card as the one
// place to answer, held calls in their own line, the keyboard shortcuts, and modal dialogs.
import { act, createElement, StrictMode, useRef } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ChangesButton, SessionControls } from "../src/renderer/App.js";
import { afterSubmit, Composer } from "../src/renderer/components/Composer.js";
import { SessionRow } from "../src/renderer/components/Sidebar.js";
import { ActivityMark } from "../src/renderer/components/ActivityMark.js";
import { CheckpointCard, DELEGATE_ONE } from "../src/renderer/components/Interactions.js";
import { Transcript } from "../src/renderer/components/Transcript.js";
import { useModalDialog } from "../src/renderer/dialog.js";
import { shortcutFor } from "../src/renderer/shortcuts.js";
import { sessionHasDraft, usePeer } from "../src/renderer/store.js";
import { heldReason } from "../src/renderer/turn-layout.js";
import type { Checkpoint, PeerMessage, PeerSession, SessionSnapshot } from "../src/shared/types.js";

let root: Root;
let host: HTMLDivElement;
let api: Record<string, ReturnType<typeof vi.fn>>;

const session = {
  id: "s1",
  workspaceId: "w1",
  runtime: "opencode",
  runtimeSessionId: "r1",
  title: "Session",
  mode: "collaborate",
  model: null,
  autoApprovals: false,
  approachGate: false,
  effort: null,
  yolo: false,
  discussing: false,
  createdAt: 1,
  updatedAt: 1,
} as unknown as PeerSession;

function snapshot(patch: Partial<SessionSnapshot> = {}): SessionSnapshot {
  return {
    session,
    status: "idle",
    gate: { kind: "open", locked: false, reason: null },
    turn: null,
    checkpoints: [],
    permissions: [],
    lastError: null,
    undo: { available: false, reason: "Nothing to undo yet." },
    queued: null,
    ...patch,
  } as SessionSnapshot;
}

function checkpoint(patch: Partial<Checkpoint> = {}): Checkpoint {
  return {
    id: "cp1",
    sessionId: "s1",
    turnId: null,
    category: "tradeoff",
    question: "Which store?",
    context: null,
    options: [{ label: "Redis" }, { label: "SQLite", description: "One file" }],
    recommendation: "SQLite",
    status: "pending",
    createdAt: 1,
    resolvedAt: null,
    resolution: null,
    source: "agent",
    decision: null,
    ...patch,
  };
}

const render = (el: React.ReactElement) => act(async () => root.render(el));
const key = (target: Element, init: KeyboardEventInit) =>
  act(async () => void target.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, cancelable: true, ...init })));
const type = (input: HTMLTextAreaElement, value: string) =>
  act(async () => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
const buttons = () => [...host.querySelectorAll("button")];
const button = (label: string) => buttons().find((b) => b.textContent?.trim() === label);

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      disconnect() {}
    },
  );
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  api = {
    send: vi.fn(async () => ({})),
    queue: vi.fn(async () => ({ queued: null, sent: false })),
    unqueue: vi.fn(async () => ({ returned: { text: "queued text", intent: "default", queuedAt: 1 } })),
    abort: vi.fn(async () => ({})),
    resolveCheckpoint: vi.fn(async () => ({})),
    updateSession: vi.fn(async () => session),
    effortDefault: vi.fn(async () => ({ default: null, cap: null })),
  };
  usePeer.setState({
    api: api as never,
    snapshot: snapshot(),
    messages: [],
    models: null,
    runtimes: [{ kind: "opencode", name: "OpenCode", status: { state: "ready" } }] as never,
    returnedDrafts: {},
    drafts: {},
    sendingIn: {},
    workspaces: [],
    diff: [],
    activeWorkspaceId: "w1",
  });
});

afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
});

describe("composer while the agent works", () => {
  it("stays writable and queues the message instead of sending it", async () => {
    usePeer.setState({ snapshot: snapshot({ status: "busy" }), messages: [{ id: "m", role: "user", createdAt: 1, parts: [] }] as PeerMessage[] });
    await render(createElement(Composer));
    const input = host.querySelector("textarea")!;
    expect(input.disabled).toBe(false);
    expect(input.placeholder).toMatch(/sends when this turn ends/);
    expect(button("Queue")).toBeTruthy();
    expect(button("Send")).toBeUndefined();
    await type(input, "Also add a test");
    await key(input, { key: "Enter" });
    expect(api.queue).toHaveBeenCalledWith("s1", "Also add a test", "default");
    expect(api.send).not.toHaveBeenCalled();
  });

  it("Esc in the message box stops the agent", async () => {
    usePeer.setState({ snapshot: snapshot({ status: "busy" }) });
    await render(createElement(Composer));
    await key(host.querySelector("textarea")!, { key: "Escape" });
    expect(api.abort).toHaveBeenCalledWith("s1");
  });

  it("shows the queued message with Edit and Remove; Edit brings it back to the box", async () => {
    usePeer.setState({ snapshot: snapshot({ status: "busy", queued: { text: "queued text", intent: "delegate", queuedAt: 1 } }) });
    await render(createElement(Composer));
    const strip = host.querySelector('[aria-label="Queued message"]')!;
    expect(strip.textContent).toContain("Queued · Just do it");
    expect(strip.textContent).toContain("queued text");
    expect(button("Replace queued")).toBeTruthy();
    await act(async () => button("Edit")!.click());
    expect(api.unqueue).toHaveBeenCalledWith("s1");
    expect(host.querySelector("textarea")!.value).toBe("queued text");
  });

  it("takes back a message that came back unsent, keeping what was typed", async () => {
    await render(createElement(Composer));
    await act(async () => usePeer.setState({ returnedDrafts: { s1: "/go ship it" } }));
    expect(host.querySelector("textarea")!.value).toBe("/go ship it");
    expect(usePeer.getState().returnedDrafts).toEqual({});
  });

  it("takes a returned message once, even when effects run twice (StrictMode, F5)", async () => {
    usePeer.setState({ returnedDrafts: { s1: "returned message" } });
    await render(createElement(StrictMode, null, createElement(Composer)));
    expect(host.querySelector("textarea")!.value).toBe("returned message");
    expect(usePeer.getState().returnedDrafts).toEqual({});
  });

  it("keeps messages returned to other sessions until their composer opens (F3)", async () => {
    usePeer.setState({ activeSessionId: "s1" });
    await render(createElement(Composer));
    for (const [sessionId, text] of [["s2", "for two"], ["s3", "for three"], ["s2", "again two"]] as const) {
      await act(async () => usePeer.getState().handleEvent({ type: "session.queued", sessionId, queued: null, returned: { text, intent: "default", queuedAt: 1 } }));
    }
    expect(usePeer.getState().returnedDrafts).toEqual({ s2: "for two\n\nagain two", s3: "for three" });
    expect(host.querySelector("textarea")!.value).toBe("");
  });

  it("keeps text typed while a queue request is in flight (F2)", async () => {
    let finish!: () => void;
    api.queue = vi.fn(() => new Promise<unknown>((r) => (finish = () => r({ queued: null, sent: false })))) as never;
    usePeer.setState({ api: api as never, snapshot: snapshot({ status: "busy" }) });
    await render(createElement(Composer));
    const input = host.querySelector("textarea")!;
    await type(input, "first");
    await key(input, { key: "Enter" });
    await type(input, "first and a second thought");
    await act(async () => finish());
    expect(host.querySelector("textarea")!.value).toBe("and a second thought");
    expect(afterSubmit("other", "first")).toBe("other");
    expect(afterSubmit("first", "first")).toBe("");
  });

  it("Esc with a question open goes to the question instead of cancelling it", async () => {
    usePeer.setState({ snapshot: snapshot({ status: "busy", checkpoints: [checkpoint()] }) });
    await render(createElement("div", null, createElement(CheckpointCard, { checkpoint: checkpoint(), mode: "collaborate" }), createElement(Composer)));
    const input = host.querySelector("textarea[aria-label='Message the agent']") as HTMLTextAreaElement;
    input.focus();
    await key(input, { key: "Escape" });
    expect(api.abort).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(host.querySelector("[data-checkpoint-pending]"));
    // Stopping is still one click away, as a decision.
    expect(button("Stop")).toBeTruthy();
  });

  it("controls go with a message: Just do it and Discuss first need text", async () => {
    usePeer.setState({ messages: [{ id: "m", role: "user", createdAt: 1, parts: [] }] as PeerMessage[] });
    await render(createElement(Composer));
    expect(button("Just do it")!.disabled).toBe(true);
    expect(button("Discuss first")!.disabled).toBe(true);
    await type(host.querySelector("textarea")!, "add retries");
    expect(button("Just do it")!.disabled).toBe(false);
    await act(async () => button("Just do it")!.click());
    expect(api.send).toHaveBeenCalledWith("s1", "add retries", "delegate");
  });

  it("points to the open question instead of answering it from here", async () => {
    usePeer.setState({ snapshot: snapshot({ status: "busy", checkpoints: [checkpoint()] }) });
    await render(createElement(Composer));
    expect(host.textContent).toContain("waiting for your answer to the question above");
    expect(button("Go to the question")).toBeTruthy();
    expect(button("Answer")).toBeUndefined();
  });

  it("the mode radio group moves with the arrow keys", async () => {
    await render(createElement(Composer));
    const collab = host.querySelector<HTMLButtonElement>('[role="radio"][aria-checked="true"]')!;
    expect(collab.tabIndex).toBe(0);
    await key(collab, { key: "ArrowRight" });
    expect(api.updateSession).toHaveBeenCalledWith("s1", { mode: "learn" });
  });
});

describe("checkpoint card", () => {
  it("number keys and arrows move to an option; only choosing it answers", async () => {
    await render(createElement(CheckpointCard, { checkpoint: checkpoint(), mode: "collaborate" }));
    const card = host.querySelector<HTMLElement>("[data-checkpoint-pending]")!;
    expect(document.activeElement).toBe(card);
    const [redis, sqlite] = [...host.querySelectorAll<HTMLButtonElement>("[data-option]")];
    await key(card, { key: "2" });
    expect(document.activeElement).toBe(sqlite);
    await key(sqlite!, { key: "ArrowUp" });
    expect(document.activeElement).toBe(redis);
    // A stray digit never answers: nothing is resolved until the option is chosen (Enter clicks it).
    expect(api.resolveCheckpoint).not.toHaveBeenCalled();
    expect(host.textContent).toContain("Enter to choose");
    await act(async () => redis!.click());
    expect(api.resolveCheckpoint).toHaveBeenCalledWith("cp1", "choose", { option: "Redis", text: undefined });
  });

  it("names who decides: Just do it for the task, the agent for this one call", async () => {
    await render(createElement(CheckpointCard, { checkpoint: checkpoint(), mode: "collaborate" }));
    expect(button("Just do it")).toBeTruthy();
    expect(button(DELEGATE_ONE)).toBeTruthy();
    expect(button("You decide")).toBeUndefined();
    expect(host.querySelector(".checkpoint-question")!.className).toContain("text-[15px]");
  });

  it("does not take focus from text the developer is writing", async () => {
    const other = document.createElement("textarea");
    other.value = "half a thought";
    document.body.appendChild(other);
    other.focus();
    await render(createElement(CheckpointCard, { checkpoint: checkpoint(), mode: "collaborate" }));
    expect(document.activeElement).toBe(other);
    other.remove();
  });

  it("an answered question folds to the question and the choice", async () => {
    const answered = checkpoint({ status: "resolved", resolution: { action: "choose", option: "SQLite" } as never });
    await render(createElement(CheckpointCard, { checkpoint: answered, mode: "collaborate" }));
    expect(host.textContent).toContain("You: chose “SQLite”");
    expect(host.textContent).not.toContain("One file");
    await act(async () => button("Show the 2 options")!.click());
    expect(host.textContent).toContain("One file");
    expect(host.textContent).toContain("your choice");
  });
});

describe("held calls", () => {
  const gateError =
    'Peer collaboration gate: "bash" was not run. Learn mode: code changes unlock once you engage with this task. Engage the developer first: ask your question. Reading and exploring the code is still allowed. Do not try to work around this gate.';

  it("say why in the developer's terms, without the instructions to the agent", () => {
    expect(heldReason(gateError)).toBe("Learn mode: code changes unlock once you engage with this task.");
    expect(heldReason('Peer collaboration gate: "edit" was not run. Waiting for your response to a checkpoint. Wait for the developer\'s response to your open checkpoint.')).toBe(
      "Waiting for your response to a checkpoint.",
    );
    expect(heldReason('Peer collaboration gate: "edit" was not run. The developer said this task is not routine work: ask them')).toMatch(/not routine/);
    expect(heldReason(undefined)).toBe("Code changes are locked for this turn.");
  });

  it("show on their own line in the transcript, never folded into a group", async () => {
    const tool = (id: string, status: "completed" | "error", error?: string) => ({ type: "tool", id, tool: "bash", callId: id, status, input: { command: `cmd-${id}` }, error });
    usePeer.setState({
      messages: [
        { id: "u", role: "user", createdAt: 1, parts: [{ type: "text", id: "ut", text: "Go" }] },
        { id: "a", role: "assistant", createdAt: 2, completedAt: 3, parts: [tool("t1", "completed"), tool("t2", "error", gateError), tool("t3", "completed")] },
      ] as PeerMessage[],
    });
    await render(createElement(Transcript));
    expect(host.textContent).toContain("Peer held");
    expect(host.textContent).toContain("cmd-t2");
    expect(host.textContent).toContain("Learn mode: code changes unlock once you engage with this task.");
    expect(host.textContent).not.toContain("blocked");
    // Opening a finished session announces nothing.
    expect(host.querySelector('[role="status"]')!.textContent).toBe("");
  });

  it("announce the run's status as it changes, and its end", async () => {
    usePeer.setState({ messages: [{ id: "u", role: "user", createdAt: 1, parts: [{ type: "text", id: "ut", text: "Go" }] }] as PeerMessage[] });
    await render(createElement(Transcript));
    const live = () => host.querySelector('[role="status"]')!.textContent;
    expect(live()).toBe("");
    await act(async () => usePeer.setState({ snapshot: snapshot({ status: "busy" }) }));
    expect(live()).toBe("Working…");
    await act(async () => usePeer.setState({ snapshot: snapshot({ status: "busy", checkpoints: [checkpoint()] }) }));
    expect(live()).toBe("The agent is waiting for your answer: Which store?");
    await act(async () => usePeer.setState({ snapshot: snapshot({ status: "idle" }) }));
    expect(live()).toBe("The agent finished this turn.");
  });
});

describe("keyboard", () => {
  it("maps ⌘/Ctrl shortcuts and leaves Alt and stray Shift combinations alone", () => {
    const k = (key: string, mods: Partial<KeyboardEvent> = {}) => shortcutFor({ key, metaKey: true, ctrlKey: false, altKey: false, shiftKey: false, ...mods });
    expect(k("n")).toBe("newSession");
    expect(k("l")).toBe("focusComposer");
    expect(k("\\")).toBe("toggleSidebar");
    expect(k("M", { shiftKey: true })).toBe("cycleMode");
    expect(k("k")).toBe("search");
    expect(k("n", { shiftKey: true })).toBeNull();
    expect(k("n", { altKey: true })).toBeNull();
    expect(shortcutFor({ key: "n", metaKey: false, ctrlKey: true, altKey: false, shiftKey: false })).toBe("newSession");
    expect(shortcutFor({ key: "n", metaKey: false, ctrlKey: false, altKey: false, shiftKey: false })).toBeNull();
  });

  it("a modal dialog takes focus, keeps Tab inside, closes on Escape and gives focus back", async () => {
    const opener = document.createElement("button");
    document.body.appendChild(opener);
    opener.focus();
    const onClose = vi.fn();
    function Dialog() {
      const ref = useRef<HTMLDivElement>(null);
      useModalDialog(ref, onClose);
      return createElement("div", { ref, role: "dialog" }, createElement("button", null, "First"), createElement("button", null, "Last"));
    }
    // jsdom has no layout: every element counts as visible.
    vi.spyOn(HTMLElement.prototype, "getClientRects").mockReturnValue([{}] as unknown as DOMRectList);
    await render(createElement(Dialog));
    const [first, last] = [...host.querySelectorAll("button")];
    expect(document.activeElement).toBe(first);
    last!.focus();
    await key(last!, { key: "Tab" });
    expect(document.activeElement).toBe(first);
    await key(first!, { key: "Tab", shiftKey: true });
    expect(document.activeElement).toBe(last);
    await key(last!, { key: "Escape" });
    expect(onClose).toHaveBeenCalledTimes(1);
    await act(async () => root.render(createElement("div")));
    expect(document.activeElement).toBe(opener);
    opener.remove();
  });
});

describe("opening a session", () => {
  it("puts the keyboard in the message box, or on a waiting question's card", async () => {
    await render(createElement(Composer));
    expect(document.activeElement).toBe(host.querySelector("textarea"));
    await act(async () => root.unmount());
    root = createRoot(host);
    usePeer.setState({ snapshot: snapshot({ status: "busy", checkpoints: [checkpoint()] }), messages: [] });
    await render(createElement("div", null, createElement(Transcript), createElement(Composer)));
    expect(document.activeElement).toBe(host.querySelector("[data-checkpoint-pending]"));
  });
});

describe("session list keyboard", () => {
  const row = (id: string, title: string) => ({ ...session, id, title });
  it("is one Tab stop: arrows move, F2 renames, Delete removes, the open session is aria-current", async () => {
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(false);
    await render(
      createElement(
        "div",
        null,
        createElement(SessionRow, { session: row("a", "Alpha"), active: false, tabbable: false }),
        createElement(SessionRow, { session: row("b", "Beta"), active: true, tabbable: true }),
        createElement(SessionRow, { session: row("c", "Gamma"), active: false, tabbable: false }),
      ),
    );
    const rows = [...host.querySelectorAll<HTMLButtonElement>("[data-session-row]")];
    expect(rows.map((r) => r.tabIndex)).toEqual([-1, 0, -1]);
    expect(rows[1]!.getAttribute("aria-current")).toBe("page");
    // Rename and delete buttons stay out of the tab order.
    expect([...host.querySelectorAll<HTMLButtonElement>("button[aria-label^='Rename'], button[aria-label^='Delete']")].every((b) => b.tabIndex === -1)).toBe(true);
    rows[1]!.focus();
    await key(rows[1]!, { key: "ArrowDown" });
    expect(document.activeElement).toBe(rows[2]);
    await key(rows[2]!, { key: "ArrowUp" });
    expect(document.activeElement).toBe(rows[1]);
    await key(rows[1]!, { key: "Delete" });
    expect(confirm).toHaveBeenCalledWith(expect.stringContaining('Delete "Beta"'));
    await key(rows[1]!, { key: "F2" });
    expect(host.querySelector<HTMLInputElement>('input[aria-label="Session name"]')!.value).toBe("Beta");
    confirm.mockRestore();
  });
});

describe("session header", () => {
  it("one Permissions menu says what is relaxed, explains each switch, and toggles it", async () => {
    await render(createElement(SessionControls, { session: { ...session, runtime: "claude" } as PeerSession, workspace: undefined }));
    const trigger = host.querySelector<HTMLButtonElement>("[aria-haspopup=menu]")!;
    expect(trigger.textContent).toContain("Permissions: ask");
    await act(async () => trigger.click());
    const items = [...host.querySelectorAll<HTMLButtonElement>("[role=menuitemcheckbox]")];
    expect(items.map((i) => i.textContent)).toEqual([expect.stringContaining("Auto approvals"), expect.stringContaining("YOLO"), expect.stringContaining("Approach gate")]);
    expect(items[1]!.textContent).toContain("destructive commands included");
    expect(document.activeElement).toBe(items[0]);
    await key(items[0]!, { key: "ArrowDown" });
    expect(document.activeElement).toBe(items[1]);
    await act(async () => items[1]!.click());
    expect(api.updateSession).toHaveBeenCalledWith("s1", { yolo: true });
    await key(items[1]!, { key: "Escape" });
    expect(host.querySelector("[role=menu]")).toBeNull();
    expect(document.activeElement).toBe(trigger);
  });

  it("the button turns into a warning when YOLO or a relaxed switch is on", async () => {
    await render(createElement(SessionControls, { session: { ...session, runtime: "claude", yolo: true } as PeerSession, workspace: undefined }));
    expect(host.querySelector("[aria-haspopup=menu]")!.textContent).toContain("YOLO on");
    await render(createElement(SessionControls, { session: { ...session, runtime: "claude", autoApprovals: true } as PeerSession, workspace: undefined }));
    expect(host.querySelector("[aria-haspopup=menu]")!.textContent).toContain("Auto approvals on");
  });

  it("Changes shows the file count, and is not shown in a general chat", async () => {
    usePeer.setState({ diff: [{ file: "a.ts" }, { file: "b.ts" }] as never, workspaces: [{ id: "w1", general: false }] as never });
    await render(createElement(ChangesButton, { open: false, onToggle: () => {} }));
    expect(host.textContent).toBe("Changes2");
    await act(async () => usePeer.setState({ workspaces: [{ id: "w1", general: true }] as never }));
    expect(host.querySelector("button")).toBeNull();
  });
});

describe("undo", () => {
  it("sits on the last turn and asks in place, not with a system dialog", async () => {
    const confirm = vi.spyOn(window, "confirm");
    api.undoTurn = vi.fn(async () => ({}));
    usePeer.setState({
      api: api as never,
      snapshot: snapshot({ undo: { available: true, reason: null } }),
      messages: [
        { id: "u", role: "user", createdAt: 1, parts: [{ type: "text", id: "ut", text: "Go" }] },
        { id: "a", role: "assistant", createdAt: 2, completedAt: 3, parts: [{ type: "text", id: "at", text: "Done." }] },
      ] as PeerMessage[],
    });
    await render(createElement(Transcript));
    await act(async () => button("Undo this turn")!.click());
    expect(host.textContent).toContain("Revert the files this turn changed");
    expect(document.activeElement).toBe(button("Undo turn"));
    await act(async () => button("Undo turn")!.click());
    expect(api.undoTurn).toHaveBeenCalledWith("s1");
    expect(confirm).not.toHaveBeenCalled();
    confirm.mockRestore();
  });
});

describe("session activity", () => {
  it("marks a session waiting, working or interrupted, named for screen readers", async () => {
    usePeer.setState({
      activity: {
        a: { sessionId: "a", workspaceId: "w1", state: "waiting" },
        b: { sessionId: "b", workspaceId: "w1", state: "working" },
        c: { sessionId: "c", workspaceId: "w1", state: "interrupted" },
      },
    });
    await render(createElement("div", null, ...["a", "b", "c", "d"].map((id) => createElement("p", { key: id, id }, createElement(ActivityMark, { sessionId: id })))));
    const text = (id: string) => host.querySelector(`#${id}`)!.textContent;
    expect(text("a")).toBe("Waiting for you");
    expect(text("b")).toBe("Working");
    expect(text("c")).toContain("interrupted");
    expect(text("d")).toBe("");
  });

  it("an older activity answer arriving late never replaces a newer one", async () => {
    const answers: ((v: unknown) => void)[] = [];
    api.activity = vi.fn(() => new Promise((r) => answers.push(r))) as never;
    usePeer.setState({ api: api as never, activity: {} });
    const older = usePeer.getState().loadActivity();
    const newer = usePeer.getState().loadActivity();
    answers[1]!([{ sessionId: "s9", workspaceId: "w1", state: "waiting" }]);
    await newer;
    answers[0]!([]);
    await older;
    expect(usePeer.getState().activity.s9?.state).toBe("waiting");
  });

  it("reloads once per burst of status, question and permission events from any session", async () => {
    vi.useFakeTimers();
    api.activity = vi.fn(async () => [{ sessionId: "other", workspaceId: "w2", state: "waiting" }]);
    usePeer.setState({ api: api as never, activity: {} });
    const { handleEvent } = usePeer.getState();
    handleEvent({ type: "session.status", sessionId: "other", status: "busy" });
    handleEvent({ type: "checkpoint.updated", checkpoint: checkpoint({ sessionId: "other" }) });
    handleEvent({ type: "permission.replied", sessionId: "other", requestId: "r" });
    await vi.advanceTimersByTimeAsync(200);
    vi.useRealTimers();
    expect(api.activity).toHaveBeenCalledTimes(1);
    expect(usePeer.getState().activity).toEqual({ other: { sessionId: "other", workspaceId: "w2", state: "waiting" } });
  });
});

describe("leaving an unused session", () => {
  it("asks the server to discard it, and drops it from the list when it did", async () => {
    api.discardIfUnused = vi.fn(async () => ({ deleted: true }));
    api.snapshot = vi.fn(async () => snapshot());
    api.messages = vi.fn(async () => []);
    api.setPreferences = vi.fn(async () => ({}));
    api.diff = vi.fn(async () => []);
    usePeer.setState({ api: api as never, activeSessionId: "s1", snapshot: snapshot(), messages: [], drafts: {}, sendingIn: {}, sessions: [session, { ...session, id: "s2" }], modelsFor: "opencode" });
    await act(async () => usePeer.getState().selectSession("s2"));
    expect(api.discardIfUnused).toHaveBeenCalledWith("s1");
    expect(usePeer.getState().sessions.map((x) => x.id)).toEqual(["s2"]);
  });

  it("keeps it when something is typed, or it has messages", async () => {
    api.discardIfUnused = vi.fn(async () => ({ deleted: true }));
    api.snapshot = vi.fn(async () => snapshot());
    api.messages = vi.fn(async () => []);
    api.setPreferences = vi.fn(async () => ({}));
    api.diff = vi.fn(async () => []);
    usePeer.setState({ api: api as never, activeSessionId: "s1", snapshot: snapshot(), messages: [], drafts: { s1: "half a thought" }, sendingIn: {}, modelsFor: "opencode" });
    await act(async () => usePeer.getState().selectSession("s2"));
    usePeer.setState({ activeSessionId: "s1", snapshot: snapshot(), drafts: {}, messages: [{ id: "m", role: "user", createdAt: 1, parts: [] }] as PeerMessage[] });
    await act(async () => usePeer.getState().selectSession("s2"));
    expect(api.discardIfUnused).not.toHaveBeenCalled();
  });

  it("the draft lives per session, outside the composer, and survives it unmounting (the learning map) (F2)", async () => {
    usePeer.setState({ drafts: {}, sendingIn: {} });
    await render(createElement(Composer));
    await type(host.querySelector("textarea")!, "half a thought");
    expect(sessionHasDraft(usePeer.getState(), "s1")).toBe(true);
    // The learning map replaces the conversation: the composer unmounts.
    await act(async () => root.render(createElement("div")));
    expect(sessionHasDraft(usePeer.getState(), "s1")).toBe(true);
    // Back on the session, the text is still there.
    await render(createElement(Composer));
    expect(host.querySelector("textarea")!.value).toBe("half a thought");
  });

  it("asks the server about a session left before it finished loading (F1)", async () => {
    api.discardIfUnused = vi.fn(async () => ({ deleted: true }));
    api.snapshot = vi.fn(async () => snapshot());
    api.messages = vi.fn(async () => []);
    api.setPreferences = vi.fn(async () => ({}));
    api.diff = vi.fn(async () => []);
    usePeer.setState({ api: api as never, activeSessionId: "s1", snapshot: null, messages: [], drafts: {}, sendingIn: {}, sessions: [session, { ...session, id: "s2" }], modelsFor: "opencode" });
    await act(async () => usePeer.getState().selectSession("s2"));
    expect(api.discardIfUnused).toHaveBeenCalledWith("s1");
  });
});
