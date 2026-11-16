import { useState } from "react";
import { usePeer } from "../store";
import { DiffView } from "./Transcript";

/** Files the agent changed in this session (from the runtime's snapshot diff). */
export function ChangesPanel({ onClose }: { onClose: () => void }) {
  const diff = usePeer((s) => s.diff);
  const [open, setOpen] = useState<string | null>(null);

  return (
    <aside className="flex w-80 shrink-0 flex-col border-l border-line/70 bg-panel max-[1100px]:absolute max-[1100px]:inset-y-0 max-[1100px]:right-0 max-[1100px]:z-20 max-[1100px]:max-w-[85%] max-[1100px]:shadow-card">
      <div className="flex items-center justify-between px-4 pb-2 pt-3">
        <span className="text-[11px] font-medium uppercase tracking-wider text-faint">Changes</span>
        <span className="flex items-center gap-2">
          {diff.length > 0 && (
            <span className="text-[11px] text-faint">
              {diff.length} file{diff.length === 1 ? "" : "s"}
            </span>
          )}
          <button
            onClick={onClose}
            aria-label="Close the changes panel"
            title="Close"
            className="-mr-1.5 flex h-6 w-6 items-center justify-center rounded-md text-[14px] leading-none text-faint hover:bg-raised hover:text-fg"
          >
            ×
          </button>
        </span>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-4">
        {diff.length === 0 && <div className="px-2 text-[12px] text-faint">No file changes in this session yet.</div>}
        {diff.map((d) => {
          const base = d.file.split("/").pop() ?? d.file;
          const isOpen = open === d.file;
          return (
            <div key={d.file} className="mb-1">
              <button
                onClick={() => setOpen(isOpen ? null : d.file)}
                aria-expanded={isOpen}
                className={`flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left text-[12px] hover:bg-raised/60 ${isOpen ? "bg-raised" : ""}`}
                title={d.file}
              >
                <span className="min-w-0 flex-1 truncate font-mono text-fg/90">{base}</span>
                <span className="shrink-0 text-focus">+{d.additions}</span>
                <span className="shrink-0 text-danger">-{d.deletions}</span>
              </button>
              {isOpen && d.patch && (
                <div className="mx-1 mt-1 overflow-hidden rounded-lg border border-line/60">
                  <DiffView diff={d.patch} />
                </div>
              )}
            </div>
          );
        })}
      </div>
    </aside>
  );
}
