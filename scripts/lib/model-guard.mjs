// Guards for scripts that spend real model quota through the Peer API: the runtime is ready, the
// requested model exists on it, and the session Peer created really uses that model. Each check
// fails before the first prompt is sent.
import { UsageError, formatModelRef } from "./args.mjs";

/**
 * @param {(path: string, init?: object) => Promise<any>} api  Peer API caller
 * @returns {Promise<{ runtime: string, runtimeName: string, runtimeVersion: string|null, model: { providerId: string, modelId: string }|null, modelName: string|null, usingDefault: boolean }>}
 */
export async function resolveRuntimeModel(api, workspaceId, runtime, model, { allowDefault = false } = {}) {
  const health = await api("/health");
  const info = health.runtimes.find((r) => r.kind === runtime);
  if (!info) throw new UsageError(`Peer has no runtime "${runtime}". Known: ${health.runtimes.map((r) => r.kind).join(", ")}`);
  if (info.status.state !== "ready") throw new UsageError(`Runtime ${runtime} is not ready (${info.status.state}${info.status.error ? `: ${info.status.error}` : ""})`);

  const models = await api(`/workspaces/${workspaceId}/models?runtime=${encodeURIComponent(runtime)}`);
  const available = models.providers.flatMap((p) => p.models.map((m) => ({ providerId: p.id, modelId: m.id, name: m.name })));
  if (!model) {
    if (!allowDefault) {
      throw new UsageError(
        `No --model given for ${runtime}. Real-model runs need an explicit model so a dropped flag can never fall back to an expensive default. ` +
          `Pass --model provider/model (default here would be ${formatModelRef(models.default)}), or --allow-default-model to accept it.`,
      );
    }
    return { runtime, runtimeName: info.name, runtimeVersion: info.status.version ?? null, model: models.default, modelName: null, usingDefault: true };
  }
  const hit = available.find((m) => m.providerId === model.providerId && m.modelId === model.modelId);
  if (!hit) {
    const list = available.map((m) => `${m.providerId}/${m.modelId}`);
    throw new UsageError(`Model ${formatModelRef(model)} is not available on ${runtime}. Available: ${list.slice(0, 40).join(", ")}${list.length > 40 ? ", …" : ""}`);
  }
  return { runtime, runtimeName: info.name, runtimeVersion: info.status.version ?? null, model, modelName: hit.name, usingDefault: false };
}

/** The session Peer created must carry the model we asked for; otherwise the runtime default would run. */
export function assertSessionModel(session, model) {
  if (!model) return;
  const got = session?.model;
  if (!got || got.providerId !== model.providerId || got.modelId !== model.modelId) {
    throw new Error(`Peer created session ${session?.id} with model ${formatModelRef(got)}, not the requested ${formatModelRef(model)}. Stopping before any prompt is sent.`);
  }
}
