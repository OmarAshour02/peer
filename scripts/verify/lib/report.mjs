// Human-readable rendering of a verification report, and the response template the implementer
// fills in before a re-review.
import { needsResponse, SEVERITIES } from "./verdict.mjs";

const esc = (s) => String(s ?? "").replace(/\|/g, "\\|").replace(/\n+/g, " ");
const loc = (f) => (f.file ? `\`${f.file}${f.line ? `:${f.line}` : ""}\`` : "n/a");

export function renderMarkdown(r) {
  const out = [];
  const icon = { PASS: "PASS", FAIL: "FAIL", NEEDS_MANUAL_REVIEW: "NEEDS MANUAL REVIEW" }[r.verdict];
  out.push(`# Verification ${r.runId}: ${icon}`);
  out.push("");
  if (r.escalate) out.push("> **Escalate to a human.** The automatic repair-cycle limit is reached and disagreements remain.\n");
  out.push("> A human makes the final decision. This report is evidence, not approval. Nothing was merged or pushed.");
  out.push("");
  out.push("## Verdict");
  out.push("");
  for (const reason of r.reasons) out.push(`- ${reason}`);
  if (r.reviewer?.verdict) out.push(`- Reviewer's own verdict: ${r.reviewer.verdict}`);
  out.push("");

  out.push("## Scope");
  out.push("");
  const s = r.scope;
  out.push(`- Repository: \`${s.repo}\` (branch ${s.branch ?? "detached"}, HEAD ${s.head?.slice(0, 12) ?? "none"})`);
  out.push(`- Base: ${s.base.sha ? `\`${s.base.sha.slice(0, 12)}\`` : "empty tree"} (${s.base.reason})`);
  out.push(`- Change: ${s.files.length} file(s), +${s.numstat.added} / -${s.numstat.removed}`);
  out.push(`- Checkout fingerprint: \`${s.fingerprint.slice(0, 16)}\``);
  out.push(`- Cycle: ${r.chain.cycle} of ${r.chain.maxRepairCycles} repair cycles${r.chain.parent ? ` (re-review of ${r.chain.parent})` : ""}`);
  out.push(`- Task: ${r.inputs.task ? `\`${r.inputs.task.path}\`` : "**none given**"}; implementer claims: ${r.inputs.claims ? `\`${r.inputs.claims.path}\`` : "none given"}`);
  out.push("");

  out.push("## Deterministic checks (run by the harness)");
  out.push("");
  out.push("| Check | Command | Result | Time |");
  out.push("|---|---|---|---|");
  for (const c of r.checks) out.push(`| ${c.name}${c.required ? "" : " (optional)"} | \`${esc(c.command.join(" "))}\` | ${c.status}${c.exitCode !== null && c.exitCode !== undefined ? ` (exit ${c.exitCode})` : ""}${c.reason ? `: ${esc(c.reason)}` : ""} | ${c.durationMs ? `${(c.durationMs / 1000).toFixed(1)}s` : ""} |`);
  out.push("");

  out.push("## Reviewer");
  out.push("");
  if (!r.reviewer) out.push("Independent review did not run.");
  else {
    const v = r.reviewer;
    out.push(`- Codex CLI ${v.version}, model \`${v.model}\` (${v.displayName}), reasoning effort \`${v.effort}\``);
    out.push(`- Sandbox: ${v.sandbox}; network: off; user config, MCP servers and plugins: not loaded`);
    if (v.applied) out.push(v.applied.confirmed ? `- Applied settings (from Codex's session record, ${v.applied.turns} turn(s)): ${v.applied.errors.length ? `**MISMATCH**: ${v.applied.errors.join("; ")}` : "model, effort, sandbox and network match the request"}` : "- Applied settings: **unconfirmed** (no session record found)");
    if (v.durationMs) out.push(`- Duration: ${(v.durationMs / 1000).toFixed(0)}s${v.timedOut ? " (timed out)" : ""}; exit ${v.exitCode}`);
    if (v.usage) out.push(`- Tokens: ${v.usage.input_tokens ?? "?"} in (${v.usage.cached_input_tokens ?? 0} cached), ${v.usage.output_tokens ?? "?"} out`);
    if (v.error) out.push(`- Error: ${v.error}`);
  }
  out.push("");

  const review = r.review;
  if (review) {
    out.push("## Findings");
    out.push("");
    if (review.findings.length === 0) out.push("No findings. That is not proof of correctness; see the unverified assumptions below.");
    else {
      out.push("| ID | Severity | Category | Location | Title | Confidence |");
      out.push("|---|---|---|---|---|---|");
      const sorted = [...review.findings].sort((a, b) => SEVERITIES.indexOf(a.severity) - SEVERITIES.indexOf(b.severity));
      for (const f of sorted) out.push(`| ${f.id} | ${f.severity} | ${f.category} | ${loc(f)} | ${esc(f.title)} | ${f.confidence} |`);
      out.push("");
      for (const f of sorted) {
        out.push(`### ${f.id} (${f.severity}): ${f.title}`);
        out.push("");
        out.push(`Location: ${loc(f)}`);
        out.push("");
        out.push(f.description);
        out.push("");
        out.push(`**Evidence.** ${f.evidence}`);
        if (f.reproduction) out.push(`\n**Reproduction.** ${f.reproduction}`);
        if (f.suggested_fix) out.push(`\n**Suggested fix.** ${f.suggested_fix}`);
        out.push("");
      }
    }
    out.push("");

    if (review.prior_findings_review.length > 0) {
      out.push("## Previous findings");
      out.push("");
      out.push("| ID | Status | Evidence |");
      out.push("|---|---|---|");
      for (const p of review.prior_findings_review) out.push(`| ${p.id} | ${p.status} | ${esc(p.evidence)} |`);
      out.push("");
    }

    if (review.collaboration_checks.length > 0) {
      out.push("## Collaboration behavior");
      out.push("");
      out.push("| Question | Status | Evidence |");
      out.push("|---|---|---|");
      for (const c of review.collaboration_checks) out.push(`| ${esc(c.question)} | ${c.status} | ${esc(c.evidence)} |`);
      out.push("");
    }

    if (review.claims_checked.length > 0) {
      out.push("## Implementer claims");
      out.push("");
      out.push("| Claim | Status | Evidence |");
      out.push("|---|---|---|");
      for (const c of review.claims_checked) out.push(`| ${esc(c.claim)} | ${c.status} | ${esc(c.evidence)} |`);
      out.push("");
    }

    out.push("## Checks the reviewer ran");
    out.push("");
    out.push("Cross-checked against Codex's event log. \"Not in log\" means Codex reported it but never ran it.");
    out.push("");
    out.push("| Command | Purpose | Reported exit | Observed |");
    out.push("|---|---|---|---|");
    for (const t of r.evidence.testsCrossCheck) out.push(`| \`${esc(t.command)}\` | ${esc(t.purpose)} | ${t.exit_code ?? "?"} | ${t.observed ? `exit ${t.observedExitCode ?? "?"}` : "**not in log**"} |`);
    out.push("");
    out.push(`Commands in the event log: ${r.evidence.commandsRun.length}. Full list: \`codex/commands.json\`.`);
    if (r.evidence.scratchPatch) out.push(`The reviewer wrote probe files in its snapshot: \`${r.evidence.scratchPatch}\`.`);
    out.push("");

    out.push("## Test coverage");
    out.push("");
    out.push(review.coverage_assessment);
    out.push("");
    out.push("## Unverified assumptions");
    out.push("");
    if (review.unverified_assumptions.length === 0) out.push("None reported.");
    for (const a of review.unverified_assumptions) out.push(`- ${a}`);
    out.push("");
    out.push(`Reviewer's rationale: ${review.verdict_rationale}`);
    out.push("");
  }

  out.push("## Next steps");
  out.push("");
  if (r.escalate) out.push(`- Read \`escalation.md\` and decide the open points. No further automatic cycles will run.`);
  else if (r.verdict === "PASS") out.push("- Human review and approval. Merge only on an explicit human decision.");
  else if (review && review.findings.some(needsResponse)) {
    out.push("- The implementer evaluates every finding independently, fixes confirmed defects, and records each decision in `responses.json` (template: `responses.template.json`). A rejection needs evidence.");
    out.push(`- Rerun the checks, then: \`npm run verify:peer -- --rereview ${r.runId}\``);
  } else out.push("- Resolve the reasons above, then run `npm run verify:peer` again.");
  out.push("");
  return out.join("\n");
}

export function responsesTemplate(findings) {
  return findings
    .filter(needsResponse)
    .map((f) => ({ id: f.id, severity: f.severity, title: f.title, disposition: "fixed | rejected | deferred", rationale: "", evidence: "" }));
}

export function renderEscalation(r, responses) {
  const out = [`# Escalation: ${r.runId}`, "", "The automatic repair loop stopped. These points need a human decision.", ""];
  const review = r.review;
  const open = new Set(r.unresolved ?? []);
  for (const f of review?.findings ?? []) if (f.severity === "critical" || f.severity === "high") open.add(f.id);
  if (open.size === 0) out.push("No individual findings are open; see the verdict reasons in report.md.");
  const prior = r.priorFindings ?? [];
  for (const id of open) {
    const f = review?.findings.find((x) => x.id === id) ?? prior.find((x) => x.id === id);
    const resp = responses?.find((x) => x.id === id);
    const status = review?.prior_findings_review.find((p) => p.id === id);
    out.push(`## ${id}${f ? ` (${f.severity}): ${f.title}` : ""}`, "");
    if (f) out.push(`Reviewer: ${f.description}`, "", `Evidence: ${f.evidence}`, "");
    if (resp) out.push(`Implementer (${resp.disposition}): ${resp.rationale}`, "", resp.evidence ? `Implementer evidence: ${resp.evidence}` : "", "");
    if (status) out.push(`Reviewer on re-review (${status.status}): ${status.evidence}`, "");
  }
  return out.join("\n");
}
