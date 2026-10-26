import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { CheckpointCard } from "../src/renderer/components/Interactions.js";
import type { Checkpoint } from "../src/shared/types.js";

describe("checkpoint card controls", () => {
  for (const source of ["agent", "peer"] as const) {
    for (const status of ["pending", "interrupted"] as const) {
      it(`shows both Collaborate controls for a ${status} ${source} question`, () => {
        const checkpoint: Checkpoint = {
          id: "cp-controls", sessionId: "session", turnId: null, category: "tradeoff",
          question: "Which approach?", context: null, options: [], recommendation: null,
          status, createdAt: 1, resolvedAt: null, resolution: null, source, decision: null,
        };
        const html = renderToStaticMarkup(createElement(CheckpointCard, { checkpoint, mode: "collaborate" }));
        expect(html).toContain(">Discuss first</button>");
        expect(html).toContain(">Just do it</button>");
        expect(html).not.toContain(">Give me a hint</button>");
        const learn = renderToStaticMarkup(createElement(CheckpointCard, { checkpoint, mode: "learn" }));
        expect(learn).toContain(">Give me a hint</button>");
        expect(learn).toContain(">Direct answer</button>");
        expect(learn).not.toContain(">Discuss first</button>");
      });
    }
  }
});
