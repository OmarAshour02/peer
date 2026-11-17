// capturePage() can fail transiently on headless Linux (xvfb) with Chromium's "UnknownVizError":
// the compositor didn't produce a frame. It's a CI-host glitch, not a Peer failure, so the smoke
// test retries that error a few times. Every other error is thrown at once.

export const isTransientCaptureError = (err: unknown): boolean => /UnknownVizError/.test(String(err instanceof Error ? `${err.name}: ${err.message}` : err));

export async function captureWithRetry<T>(
  capture: () => Promise<T>,
  { attempts = 3, delayMs = 500, wait = (ms: number) => new Promise<void>((r) => setTimeout(r, ms)) } = {},
): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await capture();
    } catch (err) {
      if (attempt >= attempts || !isTransientCaptureError(err)) throw err;
      await wait(delayMs);
    }
  }
}
