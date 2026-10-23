import { useEffect, useMemo, useState } from "react";
import type { OAuthStart, ProviderAuthPrompt, ProviderCatalog, ProviderEntry, ProviderSource, RuntimeInfo, RuntimeKind } from "../../shared/types";
import { RUNTIME_UI, statusDot } from "../runtimes";
import { runtimeInfo, usePeer } from "../store";

const SOURCE_UI: Record<ProviderSource, string> = {
  peer: "Connected in Peer",
  "opencode-login": "From your OpenCode login",
  environment: "From an environment variable",
  config: "From your OpenCode config",
  "built-in": "Built in, no key needed",
};

/** Providers shown before the developer searches. */
const SUGGESTED = 8;

/**
 * "Models & providers": which agent CLIs are already signed in, which OpenCode providers are
 * connected and where from, and connecting new ones (API key or browser login).
 */
export function ProvidersDialog() {
  const { api, runtimes, providersVersion } = usePeer();
  const close = () => usePeer.getState().setProvidersOpen(false);
  const opencode = runtimeInfo({ runtimes }, "opencode");
  const [catalog, setCatalog] = useState<ProviderCatalog | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [connecting, setConnecting] = useState<ProviderEntry | null>(null);

  const ready = opencode.status.state === "ready";
  useEffect(() => {
    if (!api || !ready) return;
    api
      .providers("opencode")
      .then((c) => {
        setCatalog(c);
        setLoadError(null);
      })
      .catch((err: Error) => setLoadError(err.message));
  }, [api, ready, providersVersion]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && close();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const connected = catalog?.providers.filter((p) => p.connected) ?? [];
  const candidates = useMemo(() => {
    const rest = catalog?.providers.filter((p) => !p.connected) ?? [];
    const q = query.trim().toLowerCase();
    if (!q) return rest.slice(0, SUGGESTED);
    return rest.filter((p) => p.name.toLowerCase().includes(q) || p.id.includes(q)).slice(0, 30);
  }, [catalog, query]);

  async function disconnect(p: ProviderEntry) {
    if (!api) return;
    setActionError(null);
    try {
      setCatalog(await api.disconnectProvider("opencode", p.id));
    } catch (err) {
      setActionError(err instanceof Error ? err.message : String(err));
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-black/50 p-8" onMouseDown={(e) => e.target === e.currentTarget && close()}>
      <div role="dialog" aria-label="Models and providers" className="w-full max-w-xl rounded-lg border border-line bg-panel shadow-xl">
        <div className="flex items-center border-b border-line px-5 py-3">
          <div className="flex-1 text-[15px] font-semibold">Models &amp; providers</div>
          <button onClick={close} className="text-[12px] text-faint hover:text-fg">
            Close
          </button>
        </div>

        <div className="space-y-5 px-5 py-4">
          <section>
            <SectionTitle>Agents</SectionTitle>
            <p className="mb-2 text-[12px] text-faint">Claude Code and Codex use the login of their own CLI. Peer only checks it; your credentials stay with them.</p>
            {runtimes.map((r) => (
              <RuntimeRow key={r.kind} runtime={r} connectedCount={r.kind === "opencode" ? connected.length : undefined} />
            ))}
          </section>

          <section>
            <SectionTitle>OpenCode providers</SectionTitle>
            {!ready ? (
              <div className="text-[12px] text-faint">OpenCode is not running.</div>
            ) : loadError ? (
              <div className="text-[12px] text-danger">{loadError}</div>
            ) : !catalog ? (
              <div className="text-[12px] text-faint">Loading…</div>
            ) : (
              <>
                {catalog.reloadPending && (
                  <div className="mb-2 rounded border border-warn/40 bg-warn/5 px-3 py-1.5 text-[12px] text-warn">
                    The model list updates when the running OpenCode session finishes (reloading now would stop it).
                  </div>
                )}
                {connected.map((p) => (
                  <div key={p.id} className="flex items-center gap-3 border-b border-line/60 py-1.5 text-[13px] last:border-0">
                    <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-focus" />
                    <span className="min-w-0 flex-1 truncate">{p.name}</span>
                    <span className="text-[11px] text-faint">
                      {p.source ? SOURCE_UI[p.source] : ""} · {p.modelCount} models
                    </span>
                    {p.source === "peer" && (
                      <button onClick={() => void disconnect(p)} className="text-[11px] text-faint hover:text-danger">
                        Disconnect
                      </button>
                    )}
                  </div>
                ))}
                {actionError && <div className="mt-2 text-[12px] text-danger">{actionError}</div>}
              </>
            )}
          </section>

          {ready && catalog && (
            <section>
              <SectionTitle>Connect a provider</SectionTitle>
              {connecting ? (
                <ConnectForm
                  provider={connecting}
                  subscription={subscriptionFor(connecting, runtimes)}
                  onDone={(c) => {
                    if (c) setCatalog(c);
                    setConnecting(null);
                  }}
                />
              ) : (
                <>
                  <input
                    value={query}
                    onChange={(e) => setQuery(e.target.value)}
                    placeholder={`Search ${catalog.providers.length - connected.length} providers (OpenAI, Gemini, OpenRouter, Groq…)`}
                    className="mb-2 w-full rounded-md border border-line bg-bg px-2.5 py-1.5 text-[13px] outline-none focus:border-accent"
                  />
                  {candidates.map((p) => {
                    const sub = subscriptionFor(p, runtimes);
                    return (
                      <button
                        key={p.id}
                        onClick={() => setConnecting(p)}
                        className="flex w-full items-center gap-3 rounded px-2 py-1.5 text-left text-[13px] hover:bg-raised"
                      >
                        <span className="min-w-0 flex-1 truncate">{p.name}</span>
                        <span className={`text-[11px] ${sub ? "text-focus" : "text-faint"}`}>
                          {sub ? `Your ${sub.account} via ${RUNTIME_UI[sub.runtime].label}` : p.methods.some((m) => m.type === "oauth") ? "Sign in or API key" : "API key"}
                        </span>
                      </button>
                    );
                  })}
                  {candidates.length === 0 && <div className="px-2 text-[12px] text-faint">No provider matches.</div>}
                </>
              )}
            </section>
          )}
        </div>
      </div>
    </div>
  );
}

function SectionTitle({ children }: { children: React.ReactNode }) {
  return <div className="mb-1.5 text-[11px] font-medium uppercase tracking-wider text-faint">{children}</div>;
}

function RuntimeRow({ runtime: r, connectedCount }: { runtime: RuntimeInfo; connectedCount?: number }) {
  const api = usePeer((s) => s.api);
  const ui = RUNTIME_UI[r.kind];
  const { state } = r.status;
  const detail =
    state === "ready"
      ? r.kind === "opencode"
        ? `Built in${connectedCount !== undefined ? ` · ${connectedCount} provider${connectedCount === 1 ? "" : "s"} connected` : ""}`
        : `Signed in${r.status.account ? ` · ${r.status.account}` : ""}`
      : state === "starting"
        ? "Checking…"
        : (r.status.error ?? state);
  return (
    <div className="flex items-start gap-3 py-1.5 text-[13px]">
      <span className={`mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full ${statusDot(r.status)}`} />
      <span className="w-24 shrink-0">{ui.label}</span>
      <span className={`min-w-0 flex-1 text-[12px] ${state === "ready" ? "text-muted" : "text-faint"}`}>{detail}</span>
      {(state === "unavailable" || state === "error") && (
        // Only offered when the runtime is down, so no session is interrupted.
        <button onClick={() => api && void api.restartRuntime(r.kind).catch(() => {})} className="shrink-0 text-[11px] text-accent hover:underline">
          Check again
        </button>
      )}
    </div>
  );
}

/** Providers whose models the developer can already use through an agent they are signed in to. */
const SUBSCRIPTION_RUNTIME: Record<string, RuntimeKind> = { anthropic: "claude", openai: "codex" };

interface Subscription {
  runtime: RuntimeKind;
  /** "Claude Pro", "ChatGPT", ... */
  account: string;
}

function subscriptionFor(p: ProviderEntry, runtimes: RuntimeInfo[]): Subscription | null {
  const kind = SUBSCRIPTION_RUNTIME[p.id];
  const runtime = kind && runtimes.find((r) => r.kind === kind && r.status.state === "ready");
  return runtime ? { runtime: runtime.kind, account: runtime.status.account ?? `${RUNTIME_UI[runtime.kind].label} login` } : null;
}

function visible(prompt: ProviderAuthPrompt, answers: Record<string, string>): boolean {
  if (!prompt.when) return true;
  const value = answers[prompt.when.key] ?? "";
  return prompt.when.op === "eq" ? value === prompt.when.value : value !== prompt.when.value;
}

function ConnectForm({
  provider,
  subscription,
  onDone,
}: {
  provider: ProviderEntry;
  subscription: Subscription | null;
  onDone: (catalog: ProviderCatalog | null) => void;
}) {
  const api = usePeer((s) => s.api);
  const newRuntime = usePeer((s) => s.newRuntime);
  const [methodIndex, setMethodIndex] = useState(0);
  const [answers, setAnswers] = useState<Record<string, string>>({});
  const [key, setKey] = useState("");
  const [code, setCode] = useState("");
  const [oauth, setOauth] = useState<OAuthStart | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const method = provider.methods[methodIndex] ?? provider.methods[0]!;
  const prompts = method.prompts.filter((p) => visible(p, answers));
  const inputs = Object.fromEntries(prompts.map((p) => [p.key, answers[p.key] ?? p.options?.[0]?.value ?? ""]));

  async function run(fn: () => Promise<void>) {
    setBusy(true);
    setError(null);
    try {
      await fn();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  const saveKey = () => run(async () => onDone(await api!.setProviderKey("opencode", provider.id, key, inputs)));
  const finish = (pasted?: string) => run(async () => onDone(await api!.finishOAuth("opencode", provider.id, methodIndex, pasted)));
  const startOAuth = () =>
    run(async () => {
      const start = await api!.startOAuth("opencode", provider.id, methodIndex, inputs);
      setOauth(start);
      window.open(start.url, "_blank", "noopener");
      // "auto" logins complete through the runtime's own local callback; wait for it.
      if (start.mode === "auto") await api!.finishOAuth("opencode", provider.id, methodIndex).then(onDone);
    });

  return (
    <div className="rounded-md border border-line bg-raised/40 px-3 py-3 text-[13px]">
      <div className="mb-2 flex items-center">
        <div className="flex-1 font-medium">{provider.name}</div>
        <button onClick={() => onDone(null)} className="text-[11px] text-faint hover:text-fg">
          Back
        </button>
      </div>
      {subscription && (
        // The developer's subscription already covers this provider's models, through its own agent.
        <div className="mb-3 rounded-md border border-focus/40 bg-focus/5 px-3 py-2.5">
          <div className="text-[13px] text-fg">
            Use your {subscription.account}, no API key needed
          </div>
          <p className="mt-0.5 text-[12px] text-muted">
            {RUNTIME_UI[subscription.runtime].label} sessions run on your {subscription.account} login.
          </p>
          {newRuntime === subscription.runtime ? (
            <p className="mt-1.5 text-[12px] text-focus">New sessions already use {RUNTIME_UI[subscription.runtime].label}.</p>
          ) : (
            <button
              onClick={() => {
                usePeer.getState().setNewRuntime(subscription.runtime);
                usePeer.getState().setProvidersOpen(false);
              }}
              className="mt-2 rounded-md bg-accent px-3 py-1 text-[12px] font-medium text-bg"
            >
              Start new sessions with {RUNTIME_UI[subscription.runtime].label}
            </button>
          )}
          <p className="mt-2 text-[11px] text-faint">Or connect {provider.name} below to use its models in OpenCode sessions.</p>
        </div>
      )}

      {provider.methods.length > 1 && !oauth && (
        <div className="mb-2 flex flex-wrap gap-1.5">
          {provider.methods.map((m, i) => (
            <button
              key={m.label}
              onClick={() => setMethodIndex(i)}
              className={`rounded border px-2 py-0.5 text-[12px] ${i === methodIndex ? "border-accent text-accent" : "border-line text-muted hover:text-fg"}`}
            >
              {m.label}
            </button>
          ))}
        </div>
      )}

      {!oauth &&
        prompts.map((p) => (
          <label key={p.key} className="mb-2 block text-[12px] text-muted">
            {p.message}
            {p.type === "select" ? (
              <select
                value={inputs[p.key]}
                onChange={(e) => setAnswers({ ...answers, [p.key]: e.target.value })}
                className="mt-1 block w-full rounded border border-line bg-bg px-2 py-1 text-[13px] text-fg outline-none"
              >
                {p.options?.map((o) => (
                  <option key={o.value} value={o.value}>
                    {o.label}
                    {o.hint ? ` (${o.hint})` : ""}
                  </option>
                ))}
              </select>
            ) : (
              <input
                value={answers[p.key] ?? ""}
                placeholder={p.placeholder}
                onChange={(e) => setAnswers({ ...answers, [p.key]: e.target.value })}
                className="mt-1 block w-full rounded border border-line bg-bg px-2 py-1 text-[13px] text-fg outline-none focus:border-accent"
              />
            )}
          </label>
        ))}

      {method.type === "api" ? (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            if (key.trim()) void saveKey();
          }}
        >
          <input
            type="password"
            autoFocus
            autoComplete="off"
            value={key}
            onChange={(e) => setKey(e.target.value)}
            placeholder={provider.env[0] ? `API key (the value of ${provider.env[0]})` : "API key"}
            className="block w-full rounded border border-line bg-bg px-2 py-1.5 font-mono text-[12px] outline-none focus:border-accent"
          />
          <div className="mt-2 flex items-center gap-3">
            <button disabled={busy || !key.trim()} className="rounded-md bg-accent px-3 py-1 text-[12px] font-medium text-bg disabled:opacity-40">
              {busy ? "Connecting…" : "Connect"}
            </button>
            <span className="text-[11px] text-faint">Stored in Peer's own OpenCode data on this machine.</span>
          </div>
        </form>
      ) : !oauth ? (
        <button onClick={() => void startOAuth()} disabled={busy} className="rounded-md bg-accent px-3 py-1 text-[12px] font-medium text-bg disabled:opacity-40">
          Continue in browser
        </button>
      ) : (
        <div className="space-y-2">
          {oauth.instructions && <p className="text-[12px] text-muted">{oauth.instructions}</p>}
          <p className="text-[12px] text-faint">
            If the browser didn't open,{" "}
            <a href={oauth.url} target="_blank" rel="noopener noreferrer" className="text-accent hover:underline">
              open the login page
            </a>
            .
          </p>
          {oauth.mode === "code" ? (
            <form
              onSubmit={(e) => {
                e.preventDefault();
                if (code.trim()) void finish(code);
              }}
              className="flex gap-2"
            >
              <input
                autoFocus
                value={code}
                onChange={(e) => setCode(e.target.value)}
                placeholder="Paste the code from the login page"
                className="min-w-0 flex-1 rounded border border-line bg-bg px-2 py-1 font-mono text-[12px] outline-none focus:border-accent"
              />
              <button disabled={busy || !code.trim()} className="rounded-md bg-accent px-3 py-1 text-[12px] font-medium text-bg disabled:opacity-40">
                Finish
              </button>
            </form>
          ) : (
            busy && <p className="text-[12px] text-muted">Waiting for you to finish in the browser…</p>
          )}
        </div>
      )}
      {error && <div className="mt-2 text-[12px] text-danger">{error}</div>}
    </div>
  );
}
