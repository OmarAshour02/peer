import { describe, expect, it } from "vitest";
import { isFreshPart, usePeer } from "../src/renderer/store.js";

describe("which text parts reveal from their first character", () => {
  it("only parts that first arrive through a live event", () => {
    usePeer.setState({
      activeSessionId: "ps_1",
      snapshot: { session: { id: "ps_1" } } as never,
      messages: [{ id: "m1", role: "assistant", createdAt: 1, parts: [{ type: "text", id: "loaded", text: "From the snapshot" }] }],
    });
    const { handleEvent } = usePeer.getState();
    // An update to a part loaded with the session (e.g. a turn resumed after a reload).
    handleEvent({ type: "part.updated", sessionId: "ps_1", messageId: "m1", part: { type: "text", id: "loaded", text: "From the snapshot, and more" } });
    // A part the agent starts while you watch.
    handleEvent({ type: "part.updated", sessionId: "ps_1", messageId: "m1", part: { type: "text", id: "new", text: "Hi" } });
    expect(isFreshPart("loaded")).toBe(false);
    expect(isFreshPart("new")).toBe(true);
  });
});
