// @vitest-environment jsdom
// The transcript while an agent thinks: the live "Thinking" line shows what it is on, before the
// answer's first word; once the answer arrives the line settles to "Thought".
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PeerMessage, SessionSnapshot } from "../src/shared/types.js";
import { Transcript } from "../src/renderer/components/Transcript.js";
import { usePeer } from "../src/renderer/store.js";

let host: HTMLDivElement;
let root: Root;

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("matchMedia", () => ({ matches: true, addEventListener() {}, removeEventListener() {} }));
  host = document.createElement("div");
  root = createRoot(host);
});

afterEach(async () => {
  await act(async () => root.unmount());
  vi.unstubAllGlobals();
});

const snapshot = (status: SessionSnapshot["status"]): SessionSnapshot =>
  ({
    session: { id: "s1", mode: "learn" },
    status,
    gate: { kind: "open" },
    turn: null,
    checkpoints: [],
    permissions: [],
    lastError: null,
    undo: { available: false, reason: null },
  }) as unknown as SessionSnapshot;

async function show(messages: PeerMessage[], status: SessionSnapshot["status"]) {
  await act(async () => {
    usePeer.setState({ snapshot: snapshot(status), messages });
    root.render(createElement(Transcript));
  });
}

const user: PeerMessage = { id: "u1", role: "user", createdAt: 1, parts: [{ type: "text", id: "u1:t", text: "Explain tries" }] };
const summary = "**Recalling tries**\n\nPrefix sharing.\n\n**Choosing an example**\n\ncar and cat";

describe("thinking in the transcript", () => {
  it("shows the current reasoning step while the reply has no text yet", async () => {
    await show([user, { id: "a1", role: "assistant", createdAt: 2, parts: [{ type: "reasoning", id: "r1", text: summary }] }], "busy");
    const line = [...host.querySelectorAll("button")].find((b) => b.textContent?.includes("Thinking"));
    expect(line?.textContent).toContain("Thinking· Choosing an example");
  });

  it("settles to a folded 'Thought' once the answer is being written", async () => {
    await show(
      [
        user,
        {
          id: "a1",
          role: "assistant",
          createdAt: 2,
          parts: [
            { type: "reasoning", id: "r1", text: summary },
            { type: "text", id: "m1", text: "A trie stores strings by prefix." },
          ],
        },
      ],
      "busy",
    );
    const buttons = [...host.querySelectorAll("button")].map((b) => b.textContent ?? "");
    expect(buttons.some((t) => t.includes("Thought"))).toBe(true);
    expect(buttons.some((t) => t.includes("Choosing an example"))).toBe(false);
    expect(host.textContent).toContain("A trie stores strings by prefix.");
  });

  it("shows a stored error once when the reply repeated it across text parts", async () => {
    await show(
      [
        user,
        {
          id: "a1",
          role: "assistant",
          createdAt: 2,
          completedAt: 3,
          error: "Claude Code returned an error result: You've hit your 5-hour limit",
          parts: [
            { type: "text", id: "p1", text: "You've hit your " },
            { type: "text", id: "p2", text: "5-hour limit" },
          ],
        },
      ],
      "idle",
    );
    expect(host.textContent!.split("5-hour limit")).toHaveLength(2);
    expect(host.textContent).not.toContain("returned an error result");
  });
});
