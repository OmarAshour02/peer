import { useState } from "react";
import { usePeer } from "../store";
import { DiffView } from "./Transcript";

/** Files the agent changed in this session (from the runtime's snapshot diff). */
export function ChangesPanel() {
  const diff = usePeer((s) => s.diff);
  const [open, setOpen] = useState<string | null>(null);

  return (
    <aside className="flex w-80 shrink-0 flex-col border-l border-line bg-panel">
      <div className="px-4 pb-2 pt-4 text-[11px] font-medium uppercase tracking-wider text-faint">Changes</div>
      <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-4">
        {diff.length === 0 && <div className="px-2 text-[12px] text-faint">No file changes in this session yet.</div>}
        {diff.map((d) => (
          <div key={d.file} className="mb-1">
            <button
              onClick={() => setOpen(open === d.file ? null : d.file)}
              className="flex w-full items-center gap-2 rounded px-2 py-1 text-left text-[12px] hover:bg-raised/60"
              title={d.file}
            >
              <span className="min-w-0 flex-1 truncate font-mono text-fg/90">{d.file}</span>
              <span className="text-focus">+{d.additions}</span>
              <span className="text-danger">-{d.deletions}</span>
            </button>
            {open === d.file && d.patch && (
              <div className="mx-1 overflow-hidden rounded border border-line">
                <DiffView diff={d.patch} />
              </div>
            )}
          </div>
        ))}
      </div>
    </aside>
  );
}
