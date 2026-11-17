import { useEffect, useRef } from "react";
import { usePeer } from "./store";

/**
 * Window-wide shortcuts: ⌘K / Ctrl+K toggles search, ⌘G / Ctrl+G toggles the learning map.
 * They work from anywhere, a text field included; Alt and Shift combinations are left alone.
 */
export function useGlobalShortcuts(toggleSearch: () => void) {
  const search = useRef(toggleSearch);
  search.current = toggleSearch;
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!(e.metaKey || e.ctrlKey) || e.altKey || e.shiftKey) return;
      const key = e.key.toLowerCase();
      if (key === "k") {
        e.preventDefault();
        search.current();
      } else if (key === "g") {
        e.preventDefault();
        const { learningMapOpen, setLearningMapOpen } = usePeer.getState();
        setLearningMapOpen(!learningMapOpen);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);
}
