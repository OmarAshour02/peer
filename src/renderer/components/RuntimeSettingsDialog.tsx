import { useEffect, useState } from "react";
import { CODEX_EFFORTS, DEFAULT_RUNTIME_SETTINGS, type RuntimeSettings } from "../../shared/types";
import { usePeer } from "../store";

/**
 * "Runtime settings": where Peer finds the agent CLIs, Claude Code's permission mode, and
 * Codex's reasoning effort. Paths apply when the runtime (re)starts; the permission mode and
 * effort apply to sessions as they start.
 */
export function RuntimeSettingsDialog() {
  const { api } = usePeer();
  const close = () => usePeer.getState().setSettingsOpen(false);
  const [form, setForm] = useState<RuntimeSettings>(DEFAULT_RUNTIME_SETTINGS);
  const [memoryOn, setMemoryOn] = useState(true);
  const [memoryResetAt, setMemoryResetAt] = useState(0);
  const [loaded, setLoaded] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!api) return;
    api
      .preferences()
      .then((p) => {
        setForm(p.runtimeSettings);
        setMemoryOn(p.crossSessionMemory);
        setMemoryResetAt(p.memoryResetAt);
        setLoaded(true);
      })
      .catch((err: Error) => setLoadError(err.message));
  }, [api]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && close();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  async function save() {
    if (!api) return;
    setSaving(true);
    setSaveError(null);
    setSaved(false);
    try {
      const prefs = await api.setPreferences({ runtimeSettings: form });
      setForm(prefs.runtimeSettings);
      setSaved(true);
    } catch (err) {
      setSaveError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  }

  const set = <K extends keyof RuntimeSettings>(key: K, value: RuntimeSettings[K]) => {
    setForm((f) => ({ ...f, [key]: value }));
    setSaved(false);
  };

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-black/50 p-8" onMouseDown={(e) => e.target === e.currentTarget && close()}>
      <div role="dialog" aria-label="Runtime settings" className="w-full max-w-xl rounded-lg border border-line bg-panel shadow-xl">
        <div className="flex items-center border-b border-line px-5 py-3">
          <div className="flex-1 text-[15px] font-semibold">Runtime settings</div>
          <button onClick={close} className="text-[12px] text-faint hover:text-fg">
            Close
          </button>
        </div>

        <div className="space-y-5 px-5 py-4">
          {!loaded ? (
            <div className="text-[12px] text-faint">{loadError ?? "Loading…"}</div>
          ) : (
            <>
              <section>
                <SectionTitle>CLI paths</SectionTitle>
                <p className="mb-2 text-[12px] text-faint">Where Peer finds each agent CLI. Empty means PATH. Applies when the runtime (re)starts.</p>
                <PathField label="Claude Code" value={form.claudeBin} placeholder="claude on PATH" onChange={(v) => set("claudeBin", v)} />
                <PathField label="Codex" value={form.codexBin} placeholder="codex on PATH" onChange={(v) => set("codexBin", v)} />
                <PathField label="Gemini CLI" value={form.geminiBin} placeholder="gemini on PATH" onChange={(v) => set("geminiBin", v)} />
              </section>

              <section>
                <SectionTitle>Claude Code permission mode</SectionTitle>
                <p className="mb-2 text-[12px] text-faint">The mode for turns without the session&apos;s auto-approvals on. Peers gate and safety approvals still apply.</p>
                <select
                  value={form.claudePermissionMode}
                  onChange={(e) => set("claudePermissionMode", e.target.value as RuntimeSettings["claudePermissionMode"])}
                  aria-label="Claude Code permission mode"
                  className="w-full rounded-md border border-line bg-bg px-2 py-1.5 text-[13px] outline-none focus:border-accent"
                >
                  <option value="acceptEdits">Accept edits (ask for the rest)</option>
                  <option value="auto">Auto (settle prompts, ask when unsure)</option>
                </select>
              </section>

              <section>
                <SectionTitle>Codex reasoning effort</SectionTitle>
                <p className="mb-2 text-[12px] text-faint">Sent on every Codex turn. Default leaves the account setting alone.</p>
                <select
                  value={form.codexEffort ?? ""}
                  onChange={(e) => set("codexEffort", e.target.value || null)}
                  aria-label="Codex reasoning effort"
                  className="w-full rounded-md border border-line bg-bg px-2 py-1.5 text-[13px] outline-none focus:border-accent"
                >
                  <option value="">Default</option>
                  {CODEX_EFFORTS.map((e) => (
                    <option key={e} value={e}>
                      {e[0]!.toUpperCase() + e.slice(1)}
                    </option>
                  ))}
                </select>
              </section>

              <section>
                <SectionTitle>Cross-session memory</SectionTitle>
                <p className="mb-2 text-[12px] text-faint">
                  Peer remembers, locally, how you tend to respond (whether you hand decisions back) and preselects your recent mode and model in new sessions. Derived from your stored history; nothing new is collected.
                  {memoryResetAt > 0 && <> Only history since your last reset counts.</>}
                </p>
                <div className="flex flex-wrap items-center gap-2">
                  <button
                    role="switch"
                    aria-checked={memoryOn}
                    onClick={() => {
                      if (!api) return;
                      const next = !memoryOn;
                      setMemoryOn(next);
                      api.setPreferences({ crossSessionMemory: next }).catch((err: Error) => setSaveError(err.message));
                    }}
                    className="rounded-md border border-line bg-raised px-3 py-1 text-[12px] hover:border-accent/60"
                  >
                    Memory: {memoryOn ? "on" : "off"}
                  </button>
                  <button
                    onClick={() => {
                      if (!api) return;
                      api
                        .setPreferences({ resetMemory: true })
                        .then((p) => setMemoryResetAt(p.memoryResetAt))
                        .catch((err: Error) => setSaveError(err.message));
                    }}
                    className="rounded-md border border-line bg-raised px-3 py-1 text-[12px] hover:border-accent/60"
                  >
                    Reset what Peer remembers
                  </button>
                </div>
              </section>

              {saveError && <div className="text-[12px] text-danger">{saveError}</div>}
              {saved && <div className="text-[12px] text-muted">Saved. Changed CLI paths apply when you restart that runtime.</div>}
              <div>
                <button
                  onClick={() => void save()}
                  disabled={saving}
                  className="rounded-md border border-line bg-raised px-4 py-1.5 text-[13px] hover:border-accent/60 disabled:opacity-50"
                >
                  {saving ? "Saving…" : "Save"}
                </button>
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

function SectionTitle({ children }: { children: React.ReactNode }) {
  return <h3 className="mb-1 text-[12px] font-medium uppercase tracking-wider text-faint">{children}</h3>;
}

function PathField({ label, value, placeholder, onChange }: { label: string; value: string | null; placeholder: string; onChange: (v: string | null) => void }) {
  return (
    <label className="mb-2 flex items-center gap-3 text-[13px]">
      <span className="w-24 shrink-0 text-muted">{label}</span>
      <input
        value={value ?? ""}
        onChange={(e) => onChange(e.target.value.trim() ? e.target.value : null)}
        placeholder={placeholder}
        spellCheck={false}
        aria-label={`${label} CLI path`}
        className="min-w-0 flex-1 rounded-md border border-line bg-bg px-2 py-1.5 font-mono text-[12px] outline-none focus:border-accent"
      />
    </label>
  );
}
