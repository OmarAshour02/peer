import { describe, expect, it } from "vitest";
import { parseIntent } from "../src/server/collaboration/intent.js";
import { POLICIES, resolveEffectivePolicy } from "../src/server/collaboration/policies.js";
import { composeSystemPrompt } from "../src/server/collaboration/prompt.js";

describe("policy resolution", () => {
  it("gates only Learn by default", () => {
    expect(resolveEffectivePolicy("focus", "default", false).gate).toBe("open");
    expect(resolveEffectivePolicy("collaborate", "default", false).gate).toBe("open");
    expect(resolveEffectivePolicy("learn", "default", false).gate).toBe("engage");
  });

  it("treats a reply after an unengaged gated turn as engagement", () => {
    expect(resolveEffectivePolicy("learn", "default", true).gate).toBe("open");
  });

  it("Focus asks about fewer kinds of decision than Collaborate, which asks fewer than Learn", () => {
    const n = (m: keyof typeof POLICIES) => POLICIES[m].askFor.length;
    expect(n("focus")).toBeLessThan(n("collaborate"));
    expect(n("collaborate")).toBeLessThan(n("learn"));
    expect(POLICIES.focus.askFor).not.toContain("tradeoff");
    expect(POLICIES.collaborate.askFor).toContain("tradeoff");
    expect(POLICIES.learn.askFor).toContain("hypothesis");
  });

  it("risk is always a developer decision, in every mode and intent", () => {
    for (const mode of ["focus", "collaborate", "learn"] as const) {
      for (const intent of ["default", "delegate", "discuss", "hint", "answer"] as const) {
        expect(resolveEffectivePolicy(mode, intent, false).askFor).toContain("risk");
      }
    }
  });

  it("explicit intents override the mode", () => {
    expect(resolveEffectivePolicy("learn", "delegate", false)).toMatchObject({ gate: "open", askFor: ["risk"] });
    expect(resolveEffectivePolicy("focus", "discuss", false).gate).toBe("hold");
    expect(resolveEffectivePolicy("learn", "hint", false).gate).toBe("hold");
    expect(resolveEffectivePolicy("learn", "answer", false).gate).toBe("open");
  });

  it("composes a system prompt that reflects mode, gate and allowed categories", () => {
    const learn = composeSystemPrompt(resolveEffectivePolicy("learn", "default", false));
    expect(learn).toContain("Active mode: Learn");
    expect(learn).toContain("locked by Peer until the developer engages");
    expect(learn).toContain("- hypothesis:");
    const focus = composeSystemPrompt(resolveEffectivePolicy("focus", "default", false));
    expect(focus).toContain("Active mode: Focus");
    expect(focus).toContain("Code changes: allowed.");
    expect(focus).not.toContain("- tradeoff:");
    expect(focus).toContain("Never be sycophantic");
  });
});

describe("intent parsing", () => {
  it("parses leading slash commands", () => {
    expect(parseIntent("/go add tests")).toEqual({ intent: "delegate", text: "add tests" });
    expect(parseIntent("/HINT")).toEqual({ intent: "hint", text: "" });
    expect(parseIntent("/discuss caching")).toEqual({ intent: "discuss", text: "caching" });
  });
  it("leaves other text alone", () => {
    expect(parseIntent("fix /api/notes")).toEqual({ intent: "default", text: "fix /api/notes" });
    expect(parseIntent("/unknown thing")).toEqual({ intent: "default", text: "/unknown thing" });
  });
  it("an explicit UI intent wins over a slash command", () => {
    expect(parseIntent("/go do it", "discuss")).toEqual({ intent: "discuss", text: "do it" });
  });
});
