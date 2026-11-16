import type { UiTheme } from "../shared/types";

/**
 * Display theme: dark is home (DESIGN.md). The persisted choice lives in server preferences
 * (independent of the desktop app's ephemeral origin); the server stamps it onto the served
 * page, and this module mirrors it into the document for instant switching.
 */
export type Theme = UiTheme;

const KEY = "peer-theme";
const PENDING_KEY = "peer-theme-pending";

/**
 * Theme writes are serialized and generation-tracked: a completion or failure from an older
 * choice can never queue, clear, or overwrite a newer one.
 */
let generation = 0;
let writeChain: Promise<void> = Promise.resolve();

export function beginThemeChoice(): number {
  return ++generation;
}

export function isLatestThemeChoice(gen: number): boolean {
  return gen === generation;
}

export function enqueueThemeWrite(write: () => Promise<void>): Promise<void> {
  writeChain = writeChain.then(write, write);
  return writeChain;
}

/** Write back a queued offline choice through the same serialized chain. */
export function syncPendingTheme(write: (theme: Theme) => Promise<void>): Promise<void> {
  return enqueueThemeWrite(async () => {
    const pending = pendingTheme();
    if (!pending) return;
    try {
      await write(pending);
      clearPendingTheme(pending);
    } catch {
      // Still queued for the next init or reconnect.
    }
  });
}

/** A theme chosen while the server was unreachable, waiting to be written back. */
export function pendingTheme(): Theme | null {
  try {
    const v = window.localStorage.getItem(PENDING_KEY);
    return v === "light" || v === "dark" ? v : null;
  } catch {
    return null;
  }
}

export function markPendingTheme(theme: Theme): void {
  try {
    window.localStorage.setItem(PENDING_KEY, theme);
  } catch {
    // Nothing durable to mark in; the choice lasts this run.
  }
}

/** Clear the pending marker — only when it still holds the theme the completed write carried, so an older write finishing late cannot erase a newer unsynced choice. */
export function clearPendingTheme(written?: Theme): void {
  try {
    if (written !== undefined && window.localStorage.getItem(PENDING_KEY) !== written) return;
    window.localStorage.removeItem(PENDING_KEY);
  } catch {
    // Already clear.
  }
}

export function currentTheme(): Theme {
  // Match the pre-paint bootstrap exactly: a queued offline choice wins, then a
  // server-stamped page (either theme) is authoritative; the mirror only speaks for
  // unstamped dev serving.
  const pending = pendingTheme();
  if (pending) return pending;
  if (typeof document !== "undefined") {
    if (document.documentElement.dataset.theme === "light") return "light";
    if (document.documentElement.dataset.theme === "dark") return "dark";
  }
  try {
    return window.localStorage.getItem(KEY) === "light" ? "light" : "dark";
  } catch {
    return "dark";
  }
}

export function applyTheme(theme: Theme): void {
  if (typeof document !== "undefined") {
    if (theme === "light") document.documentElement.dataset.theme = "light";
    else delete document.documentElement.dataset.theme;
  }
  if (typeof window !== "undefined") window.peerDesktop?.setTheme?.(theme);
  try {
    window.localStorage.setItem(KEY, theme);
  } catch {
    // The server preference is the durable copy; local storage only speeds up dev serving.
  }
}
