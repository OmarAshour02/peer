import { useEffect, useRef } from "react";
import { PRIMARY_MODES } from "../shared/types";
import { usePeer } from "./store";

/** What a window-wide shortcut does; pure, so the key map is testable without a DOM. */
export type ShortcutAction = "search" | "learningMap" | "newSession" | "focusComposer" | "toggleSidebar" | "cycleMode";

/**
 * The key map. ⌘ on macOS, Ctrl elsewhere; Alt combinations are left alone, and Shift only
 * where it is part of the shortcut (⌘⇧M), so the browser and OS keep theirs.
 */
export function shortcutFor(e: Pick<KeyboardEvent, "key" | "metaKey" | "ctrlKey" | "altKey" | "shiftKey">): ShortcutAction | null {
  if (!(e.metaKey || e.ctrlKey) || e.altKey) return null;
  const key = e.key.toLowerCase();
  if (e.shiftKey) return key === "m" ? "cycleMode" : null;
  switch (key) {
    case "k":
      return "search";
    case "g":
      return "learningMap";
    case "n":
      return "newSession";
    case "l":
      return "focusComposer";
    case "\\":
      return "toggleSidebar";
    default:
      return null;
  }
}

/** The shortcut list, for tooltips and the help line. */
export const SHORTCUTS: { keys: string; does: string }[] = [
  { keys: "⌘N", does: "New session (or chat)" },
  { keys: "⌘L", does: "Message box" },
  { keys: "Esc", does: "Stop the agent (in the message box)" },
  { keys: "⌘⇧M", does: "Switch mode" },
  { keys: "⌘K", does: "Search" },
  { keys: "⌘G", does: "Learning map" },
  { keys: "⌘\\", does: "Sidebar" },
];

/**
 * Window-wide shortcuts. They work from anywhere, a text field included, because none of them
 * collides with text editing.
 */
export function useGlobalShortcuts(handlers: { toggleSearch: () => void; toggleSidebar: () => void }) {
  const current = useRef(handlers);
  current.current = handlers;
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const action = shortcutFor(e);
      if (!action) return;
      e.preventDefault();
      const s = usePeer.getState();
      switch (action) {
        case "search":
          return current.current.toggleSearch();
        case "toggleSidebar":
          return current.current.toggleSidebar();
        case "learningMap":
          return s.setLearningMapOpen(!s.learningMapOpen);
        case "newSession":
          return void s.newSession();
        case "focusComposer":
          if (s.learningMapOpen) s.setLearningMapOpen(false);
          return s.focusComposer();
        case "cycleMode": {
          const session = s.snapshot?.session;
          if (!session || !s.api) return;
          const modes = PRIMARY_MODES;
          const next = modes[(modes.indexOf(session.mode as (typeof modes)[number]) + 1) % modes.length]!;
          void s.api.updateSession(session.id, { mode: next }).catch((err: Error) => s.setError(err.message));
          return;
        }
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);
}
