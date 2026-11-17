import { describe, expect, it } from "vitest";
import { revealStep, type RevealState } from "../src/renderer/components/StreamingMarkdown.js";

function run(text: string, ms: number, live: boolean, from: RevealState = { shown: 0, carry: 0 }, frame = 16) {
  let s = from;
  for (let t = 0; t < ms; t += frame) s = revealStep(text, s, frame, live);
  return s;
}

describe("streaming reveal", () => {
  it("reveals a burst progressively instead of all at once", () => {
    const text = "The quick brown fox jumps over the lazy dog. ".repeat(10);
    const first = revealStep(text, { shown: 0, carry: 0 }, 16, true);
    expect(first.shown).toBeGreaterThan(0);
    expect(first.shown).toBeLessThan(text.length / 4);
  });

  it("trails a steady live stream by about half a second", () => {
    // 200 chars/s arriving in 50 ms chunks for 3 s.
    let text = "";
    let state: RevealState = { shown: 0, carry: 0 };
    for (let t = 0; t < 3000; t += 16) {
      if (t % 48 === 0) text += "abcd efgh ".slice(0, 10);
      state = revealStep(text, state, 16, true);
    }
    const lagSeconds = (text.length - state.shown) / 200;
    expect(lagSeconds).toBeLessThan(0.6);
  });

  it("plays a large burst out in about two seconds, not instantly and not slowly", () => {
    const text = "word ".repeat(400);
    expect(run(text, 300, true).shown).toBeLessThan(text.length);
    expect(run(text, 2600, true).shown).toBe(text.length);
  });

  it("finishes the remainder faster once the reply is complete", () => {
    const text = "word ".repeat(400);
    expect(run(text, 1300, false).shown).toBe(text.length);
  });

  it("keeps a minimum pace for short text", () => {
    const text = "Short answer here.";
    expect(run(text, 250, true).shown).toBe(text.length);
  });

  it("ends steps on word boundaries, so words appear whole", () => {
    const text = "alpha beta gamma delta epsilon zeta eta theta iota kappa lambda mu";
    let s: RevealState = { shown: 0, carry: 0 };
    while (s.shown < text.length) {
      s = revealStep(text, s, 16, true);
      // Either the next character starts a gap, or the last one shown ended a word.
      if (s.shown < text.length) expect(`${text[s.shown - 1]}${text[s.shown]}`).toMatch(/\s/);
    }
  });

  it("clamps to a shorter replacement text", () => {
    expect(revealStep("abc", { shown: 10, carry: 0.5 }, 16, true)).toEqual({ shown: 3, carry: 0 });
  });
});
