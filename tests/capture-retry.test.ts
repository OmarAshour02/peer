// The smoke test's screenshot retry: a transient "UnknownVizError" from capturePage() is retried
// (seen once on the linux-arm64 CI runner, run 44069875590); anything else fails at once.
import { describe, expect, it } from "vitest";
import { captureWithRetry, isTransientCaptureError } from "../electron/capture-retry.js";

const noWait = { wait: async () => {} };

function failing(times: number, err: unknown) {
  let calls = 0;
  return {
    get calls() {
      return calls;
    },
    capture: async () => {
      calls++;
      if (calls <= times) throw err;
      return "frame";
    },
  };
}

describe("captureWithRetry", () => {
  it("recognises Chromium's transient viz error, and nothing else", () => {
    expect(isTransientCaptureError(new Error("UnknownVizError"))).toBe(true);
    expect(isTransientCaptureError("Error: UnknownVizError")).toBe(true);
    expect(isTransientCaptureError(new Error("Object has been destroyed"))).toBe(false);
  });

  it("returns the frame after a transient failure", async () => {
    const c = failing(2, new Error("UnknownVizError"));
    await expect(captureWithRetry(c.capture, noWait)).resolves.toBe("frame");
    expect(c.calls).toBe(3);
  });

  it("gives up after the last attempt", async () => {
    const c = failing(5, new Error("UnknownVizError"));
    await expect(captureWithRetry(c.capture, noWait)).rejects.toThrow("UnknownVizError");
    expect(c.calls).toBe(3);
  });

  it("does not retry other errors", async () => {
    const c = failing(1, new Error("Object has been destroyed"));
    await expect(captureWithRetry(c.capture, noWait)).rejects.toThrow("destroyed");
    expect(c.calls).toBe(1);
  });
});
