// The final verdict is decided here, by fixed rules, not by the reviewer alone. The reviewer's
// verdict can only be made stricter: a PASS needs passing checks, stated requirements, an intact
// checkout and independent checks that the event log shows actually ran.

export const VERDICTS = ["PASS", "NEEDS_MANUAL_REVIEW", "FAIL"];
export const EXIT_CODES = { PASS: 0, FAIL: 1, NEEDS_MANUAL_REVIEW: 2, USAGE: 3, ESCALATE: 4 };
export const SEVERITIES = ["critical", "high", "medium", "low", "info"];

const worse = (a, b) => (VERDICTS.indexOf(a) >= VERDICTS.indexOf(b) ? a : b);

/** Findings the implementer must address (fix or reject with evidence) before a re-review. */
export const needsResponse = (f) => ["critical", "high", "medium"].includes(f.severity);

/**
 * @param {{
 *   checks: { name: string, required: boolean, status: "passed"|"failed"|"skipped" }[],
 *   hasTask: boolean,
 *   tamperedPaths: string[],
 *   reviewSkipped?: string | null,
 *   codex: null | { ok: boolean, error?: string, output?: any, observedTests?: { observed: boolean, observedExitCode: number|null }[], commandsRun?: number, applied?: { confirmed: boolean, errors: string[] } },
 *   isLastCycle?: boolean,
 * }} input
 * @returns {{ verdict: string, reviewerVerdict: string|null, reasons: string[], escalate: boolean, unresolved: string[] }}
 */
export function decide({ checks, hasTask, tamperedPaths, reviewSkipped = null, codex, isLastCycle = false }) {
  let verdict = "PASS";
  const reasons = [];
  const raise = (to, why) => {
    verdict = worse(verdict, to);
    reasons.push(why);
  };

  for (const c of checks) {
    if (c.required && c.status === "failed") raise("FAIL", `Deterministic check "${c.name}" failed.`);
    if (c.required && c.status === "skipped") raise("NEEDS_MANUAL_REVIEW", `Required check "${c.name}" did not run.`);
  }
  if (tamperedPaths.length > 0) {
    raise("FAIL", `The reviewer run changed the developer's checkout (${tamperedPaths.slice(0, 5).join(", ")}${tamperedPaths.length > 5 ? ", …" : ""}). This review is void.`);
  }
  if (!hasTask) raise("NEEDS_MANUAL_REVIEW", "No task requirements were given, so the change could not be verified against them.");

  let reviewerVerdict = null;
  const unresolved = [];
  if (codex?.applied?.errors?.length > 0) {
    raise("FAIL", `The review did not run as configured, so it is void: ${codex.applied.errors.join("; ")}.`);
  } else if (codex && !reviewSkipped && codex.applied && !codex.applied.confirmed) {
    raise("NEEDS_MANUAL_REVIEW", "Could not find Codex's session record, so the model and sandbox actually used are unconfirmed.");
  }
  if (reviewSkipped) raise("NEEDS_MANUAL_REVIEW", `Independent review did not run: ${reviewSkipped}`);
  else if (!codex || !codex.ok) raise("NEEDS_MANUAL_REVIEW", `Independent review failed: ${codex?.error ?? "no result"}`);
  else {
    const out = codex.output;
    reviewerVerdict = out.verdict;
    if (out.verdict === "FAIL") raise("FAIL", "The reviewer's verdict is FAIL.");
    if (out.verdict === "NEEDS_MANUAL_REVIEW") raise("NEEDS_MANUAL_REVIEW", "The reviewer asked for manual review.");

    const blocking = out.findings.filter((f) => f.severity === "critical" || f.severity === "high");
    if (blocking.length > 0) raise("FAIL", `${blocking.length} critical/high finding(s): ${blocking.map((f) => f.id).join(", ")}.`);

    const violated = out.collaboration_checks.filter((c) => c.status === "violated");
    if (violated.length > 0) raise("FAIL", `${violated.length} collaboration check(s) violated.`);

    const observed = codex.observedTests ?? [];
    if (observed.some((t) => !t.observed)) {
      reasons.push(`${observed.filter((t) => !t.observed).length} check(s) the reviewer reported are not in its command log (treated as not run).`);
    }
    if (!observed.some((t) => t.observed) && (codex.commandsRun ?? 0) === 0) {
      raise("NEEDS_MANUAL_REVIEW", "The reviewer ran no commands, so nothing was independently checked.");
    } else if (!observed.some((t) => t.observed)) {
      raise("NEEDS_MANUAL_REVIEW", "None of the checks the reviewer reported appear in its command log.");
    }
    if (observed.some((t) => t.observed && t.observedExitCode !== 0 && t.observedExitCode !== null) && out.verdict === "PASS") {
      reasons.push("Some reviewer checks exited non-zero; read them before trusting PASS (probes that demonstrate a bug are expected to fail).");
    }

    for (const p of out.prior_findings_review ?? []) {
      if (p.status === "not_resolved" || p.status === "rejection_disputed") unresolved.push(p.id);
    }
    if (unresolved.length > 0) raise("NEEDS_MANUAL_REVIEW", `Prior finding(s) still open: ${unresolved.join(", ")}.`);
  }

  const escalate = isLastCycle && (verdict !== "PASS" || unresolved.length > 0);
  if (escalate) reasons.push("The repair-cycle limit is reached. Escalate the remaining disagreements to a human.");
  if (verdict === "PASS") reasons.push("PASS is not approval: a human makes the final decision.");
  return { verdict, reviewerVerdict, reasons, escalate, unresolved };
}

/** Validate the implementer's responses to a review before a re-review is allowed. */
export function validateResponses(findings, responses) {
  const errors = [];
  if (!Array.isArray(responses)) return ["responses.json must be a JSON array"];
  const byId = new Map();
  for (const [i, r] of responses.entries()) {
    if (!r || typeof r !== "object") {
      errors.push(`entry ${i} is not an object`);
      continue;
    }
    if (typeof r.id !== "string" || !findings.some((f) => f.id === r.id)) errors.push(`entry ${i}: unknown finding id ${JSON.stringify(r.id)}`);
    if (!["fixed", "rejected", "deferred"].includes(r.disposition)) errors.push(`entry ${i} (${r.id}): disposition must be fixed, rejected or deferred`);
    if (typeof r.rationale !== "string" || r.rationale.trim().length < 10) errors.push(`entry ${i} (${r.id}): rationale must explain the decision`);
    if (r.disposition === "rejected" && (typeof r.evidence !== "string" || r.evidence.trim().length < 10)) errors.push(`entry ${i} (${r.id}): a rejection needs evidence`);
    if (r.disposition === "deferred" && findings.find((f) => f.id === r.id && (f.severity === "critical" || f.severity === "high"))) {
      errors.push(`entry ${i} (${r.id}): a critical/high finding cannot be deferred; fix it or reject it with evidence`);
    }
    byId.set(r.id, r);
  }
  for (const f of findings.filter(needsResponse)) if (!byId.has(f.id)) errors.push(`missing response for ${f.id} (${f.severity}): ${f.title}`);
  return errors;
}
