import type { SessionActivityState } from "../../shared/types";
import { usePeer } from "../store";

/** Each state differs in shape as well as colour: a solid dot, a ring, a square. */
const ACTIVITY_UI: Record<SessionActivityState, { label: string; dot: string }> = {
  waiting: { label: "Waiting for you", dot: "rounded-full bg-accent" },
  working: { label: "Working", dot: "rounded-full border border-muted animate-pulse motion-reduce:animate-none" },
  interrupted: { label: "Question interrupted: answering resumes it", dot: "rounded-[1px] bg-warn" },
};

/**
 * What a session needs from the developer, as a mark beside its title: waiting for your answer
 * (green), working (pulsing), or a question a restart interrupted (amber). Named for screen readers.
 */
export function ActivityMark({ sessionId }: { sessionId: string }) {
  const state = usePeer((st) => st.activity[sessionId]?.state);
  if (!state) return null;
  const ui = ACTIVITY_UI[state];
  return (
    <span className="flex shrink-0 items-center" title={ui.label}>
      <span aria-hidden="true" className={`h-1.5 w-1.5 ${ui.dot}`} />
      <span className="sr-only">{ui.label}</span>
    </span>
  );
}
