#!/usr/bin/env node
// ARMADA review→merge pipeline — the actual Workflow behind crows-nest §4.
//
// This is the script that the orchestration cheatsheet calls for: the
// review→merge stages run as a DETERMINISTIC graph, not as prose the model
// re-derives each tick. Determinism (and "only the OUTPUT enters the lookout's
// context") comes from a bundled script, not from telling the model to behave.
//
//   parallel review fan-out → consolidate → address → verify
//     → bounded address↔review loop → make-mergeable → gated merge
//
// The fan-out uses `agent()` with explicit STRUCTURED-OUTPUT schemas, so each
// stage returns machine-readable data; the merge gate is computed by
// merge-gate.mjs from that data (never eyeballed). The lookout keeps only the
// terminal result.
//
// Two ways this file is used:
//
//   1. As a Workflow module — a host that provides `agent()` and `sh()` imports
//      `runReviewMergePipeline(ctx, deps)` and awaits the terminal result. This
//      is the parallel-reviewers + dedupe + gated-merge orchestration, encoded
//      once. Reference it from a skill via:
//        ${CLAUDE_PLUGIN_ROOT}/scripts/review-merge-pipeline.mjs
//      (plugins are copied into a cache, so relative paths break — always use
//      the CLAUDE_PLUGIN_ROOT prefix.)
//
//   2. Standalone, to print the stage graph + the structured-output schemas it
//      drives (so the schemas live in one place, runnable):
//        node scripts/review-merge-pipeline.mjs --schemas
//        node scripts/review-merge-pipeline.mjs --plan
//
// Dependency-free (Node built-ins only), matching scripts/validate-skills.mjs.

import { spawnSync } from 'child_process';
import { fileURLToPath } from 'url';
import path from 'path';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const MERGE_GATE = path.join(HERE, 'merge-gate.mjs');

// ---------------------------------------------------------------------------
// Structured-output schemas for the agent() fan-out. Each reviewer/builder
// agent is asked to return EXACTLY one of these — the data the pipeline acts
// on. Keeping them here (one source of truth, runnable) is what makes the
// fan-out deterministic rather than free-text the consolidator must re-parse.
// ---------------------------------------------------------------------------

export const FINDING_SCHEMA = {
  type: 'object',
  required: ['severity', 'title', 'detail'],
  properties: {
    severity: { enum: ['blocking', 'major', 'minor', 'nit'] },
    file: { type: 'string' },
    line: { type: 'integer' },
    title: { type: 'string', description: 'short imperative headline — the dedupe key with file' },
    detail: { type: 'string' },
  },
};

// muster returns this consolidated header + findings (muster SKILL.md §4).
export const REVIEW_SCHEMA = {
  type: 'object',
  required: ['pr', 'summary', 'findings'],
  properties: {
    pr: { type: 'integer' },
    summary: {
      type: 'object',
      required: ['blocking'],
      properties: {
        blocking: { type: 'integer' },
        major: { type: 'integer' },
        minor: { type: 'integer' },
        nit: { type: 'integer' },
      },
    },
    degraded: { type: 'boolean', description: 'true if one/both lenses failed — never a green light' },
    lenses: { type: 'array', items: { type: 'string' } },
    findings: { type: 'array', items: FINDING_SCHEMA },
  },
};

// shipwright address-review mode returns this (shipwright address-review §11g).
export const ADDRESS_SCHEMA = {
  type: 'object',
  required: ['pr', 'headSha', 'validation'],
  properties: {
    pr: { type: 'integer' },
    headSha: { type: 'string' },
    addressed: { type: 'array' },
    declined: { type: 'array' },
    validation: { enum: ['pass', 'fail'] },
    blockingDisagreement: { type: 'boolean' },
  },
};

// shipwright rebase mode returns this (shipwright rebase mode §12f).
export const REBASE_SCHEMA = {
  type: 'object',
  required: ['pr', 'result', 'validation'],
  properties: {
    pr: { type: 'integer' },
    mode: { const: 'rebase' },
    result: { enum: ['resolved', 'unresolved'] },
    headSha: { type: 'string' },
    rebasedOnto: { type: 'string' },
    validation: { enum: ['pass', 'fail'] },
    reason: { type: 'string' },
  },
};

// A single lens returns just its findings array (the per-lens contribution the
// pipeline consolidates) — not the full REVIEW_SCHEMA header, which the pipeline
// computes itself after merging both lenses.
export const LENS_SCHEMA = {
  type: 'object',
  required: ['findings'],
  properties: {
    lens: { type: 'string' },
    findings: { type: 'array', items: FINDING_SCHEMA },
  },
};

export const SCHEMAS = { FINDING_SCHEMA, REVIEW_SCHEMA, LENS_SCHEMA, ADDRESS_SCHEMA, REBASE_SCHEMA };

// ---------------------------------------------------------------------------
// The two review lenses (issue #76). Each is dispatched as its OWN top-level
// agent by the pipeline, so the two lenses get genuine independence even though
// the pipeline itself runs inside crows-nest's review subagent. muster's own
// §1 fan-out can't apply here — a subagent can't spawn nested agents — so the
// pipeline, which holds the top-level agent() capability, owns the fan-out and
// muster's §2 consolidation is reproduced in consolidateLenses() below.
export const LENSES = [
  {
    name: 'code-review',
    // Lens A is muster's conventions+correctness pass. muster §1 specifies it as
    // the built-in `/code-review` SKILL (or an Explore/general-purpose subagent)
    // — there is no `code-review` AGENT type to dispatch, so use the always-
    // resolvable `general-purpose` agent and have it run `/code-review` if it's
    // available, falling back to a conventions+correctness read. Dispatching a
    // bare `agentType: 'code-review'` would fail to resolve and degrade every
    // review — re-introducing the single-lens collapse #76 fixes, as a permanent
    // named degrade.
    agentType: 'general-purpose',
    prompt: (pr) =>
      `Review PR #${pr} as the conventions+correctness lens (muster Lens A). If the built-in ` +
      `\`/code-review\` skill is available, run it over this PR's diff; otherwise read the diff ` +
      `directly against the project's conventions. Assess: does the change match the surrounding ` +
      `code's idioms, is it correct, does it handle errors and edge cases, does it keep to the ` +
      `issue's scope? Return ONLY your findings array in the per-finding schema ` +
      `{severity,file,line,title,detail}. Do not fan out to further agents.`,
  },
  {
    name: 'codex-rescue',
    agentType: 'codex:codex-rescue',
    prompt: (pr) =>
      `Review PR #${pr} as the independent second-opinion lens (muster Lens B) — a root-cause / ` +
      `second-opinion read of the same diff, coming at it cold so you catch what a conventions lens ` +
      `rationalises away. Return ONLY your findings array in the per-finding schema ` +
      `{severity,file,line,title,detail}. Do not fan out to further agents.`,
  },
];

// Consolidate the per-lens finding arrays into one REVIEW_SCHEMA result —
// muster §2 (dedupe + severity-max + preserve disagreement), reproduced here
// because the pipeline now owns the fan-out (issue #76). `lensResults` is an
// array of { name, ok, findings } — `ok:false` is a lens that failed to return.
export function consolidateLenses(pr, lensResults) {
  const ran = lensResults.filter((l) => l.ok);
  const ranNames = ran.map((l) => l.name);
  const failed = lensResults.filter((l) => !l.ok).map((l) => l.name);
  // A review is degraded whenever fewer than two lenses returned — that's the
  // single-lens/degraded state issue #76 makes sure is NAMED, never silent.
  const degraded = ranNames.length < lensResults.length;

  const SEV_RANK = { blocking: 3, major: 2, minor: 1, nit: 0 };
  const byKey = new Map(); // "file\ttitle" (lower, trimmed) -> finding (+ lenses[])
  for (const lens of ran) {
    for (const f of lens.findings || []) {
      const key = `${(f.file || '').trim().toLowerCase()}\t${(f.title || '').trim().toLowerCase()}`;
      const existing = byKey.get(key);
      if (!existing) {
        byKey.set(key, { ...f, lenses: [lens.name] });
        continue;
      }
      // Both lenses flagged it — strongest signal. Keep the higher severity and
      // record both lenses (muster §2.1–2.2): independent agreement isn't buried.
      if (!existing.lenses.includes(lens.name)) existing.lenses.push(lens.name);
      if ((SEV_RANK[f.severity] ?? -1) > (SEV_RANK[existing.severity] ?? -1)) {
        existing.severity = f.severity;
      }
    }
  }

  const findings = [...byKey.values()].sort(
    (a, b) =>
      (SEV_RANK[b.severity] ?? -1) - (SEV_RANK[a.severity] ?? -1) ||
      (a.file || '').localeCompare(b.file || '') ||
      (a.line ?? 0) - (b.line ?? 0),
  );

  const summary = { blocking: 0, major: 0, minor: 0, nit: 0 };
  for (const f of findings) if (f.severity in summary) summary[f.severity]++;

  return {
    pr,
    summary,
    lenses: ranNames,
    degraded,
    degradedReason: degraded
      ? `single-lens/degraded — only [${ranNames.join(', ') || 'none'}] returned; ` +
        `missing [${failed.join(', ') || 'none'}]`
      : undefined,
    findings,
  };
}

// ---------------------------------------------------------------------------
// The merge gate — delegated to merge-gate.mjs so the decision is computed from
// data in exactly one place. Callable from JS (this) or shell (the .md docs).
// ---------------------------------------------------------------------------

export function computeMergeDecision(state) {
  const res = spawnSync(process.execPath, [MERGE_GATE], {
    input: JSON.stringify(state),
    encoding: 'utf8',
  });
  if (res.error) throw res.error;
  let parsed;
  try {
    parsed = JSON.parse(res.stdout || res.stderr || '{}');
  } catch {
    parsed = { decision: 'error', reasons: ['merge-gate produced unparseable output'] };
  }
  return parsed; // { decision: "merge" | "ready_awaiting_human" | "blocked", reasons, ... }
}

// ---------------------------------------------------------------------------
// The Workflow. `deps` injects the host's capabilities so this stays a pure,
// testable orchestration:
//   deps.agent({ agentType, prompt, schema, background })  -> structured result
//   deps.sh(cmd)                                           -> { code, stdout }
//   deps.log(line)
// `ctx` carries the run inputs: { pr, config } where config is .armada/config.json.
// Returns exactly one terminal result: { pr, decision, reason, headSha }.
// ---------------------------------------------------------------------------

export async function runReviewMergePipeline(ctx, deps) {
  const { pr, config } = ctx;
  const { agent, sh, log = () => {} } = deps;
  const autoMerge = config.autoMerge === true;
  const maxReviewRounds = Number.isFinite(config.maxReviewRounds) ? config.maxReviewRounds : 2;
  const maxRebaseRounds = Number.isFinite(config.maxRebaseRounds) ? config.maxRebaseRounds : 1;
  const build = config.commands?.build;
  const test = config.commands?.test;
  const lint = config.commands?.lint;

  let review = null;
  let headSha = null;
  let rebaseRounds = 0;

  for (let round = 1; round <= maxReviewRounds; round++) {
    // 4.1 Review — fan the two muster lenses out as TWO TOP-LEVEL agents from
    // the pipeline, then consolidate here (issue #76). The pipeline holds the
    // top-level agent() capability, so it — not a muster subagent — owns the
    // fan-out: dispatching one `muster` agent that then tries to spawn its two
    // lenses would fail, because a subagent can't nest agents, and the review
    // would silently collapse to a single lens. Launching both lenses at the
    // top level gives them genuine independence even inside crows-nest's review
    // subagent. Structured return only; each lens's transcript stays in its own
    // context. If a lens can't run (agent type missing / errors), the review is
    // marked degraded and the missing lens is NAMED — never a silent single lens.
    log(`§4.1 review round ${round}/${maxReviewRounds} on PR #${pr} — ${LENSES.length} lenses (top-level)`);
    const lensResults = await Promise.all(
      LENSES.map(async (lens) => {
        try {
          const res = await agent({
            agentType: lens.agentType,
            prompt: lens.prompt(pr),
            schema: LENS_SCHEMA,
          });
          const findings = Array.isArray(res) ? res : res?.findings;
          if (!Array.isArray(findings)) {
            return { name: lens.name, ok: false, findings: [] };
          }
          return { name: lens.name, ok: true, findings };
        } catch (e) {
          log(`§4.1 lens ${lens.name} failed: ${e && e.message ? e.message : e}`);
          return { name: lens.name, ok: false, findings: [] };
        }
      }),
    );
    review = consolidateLenses(pr, lensResults);

    const blocking = review?.summary?.blocking;
    const degraded = review?.degraded === true;
    if (degraded) log(`§4.1 review DEGRADED on PR #${pr}: ${review.degradedReason}`);

    // Post the consolidated verdict back onto the PR (muster §3) — inline
    // comments + a top-level summary — via a write-capable agent, so the review
    // is durable on the PR and not just in the pipeline's terminal result. The
    // degrade, when present, is named explicitly in that summary. Best-effort:
    // a failed post never fails the pipeline (the structured gate still holds).
    try {
      await agent({
        agentType: 'muster',
        prompt:
          `Post this ALREADY-CONSOLIDATED muster review onto PR #${pr} (muster §3 only — do NOT ` +
          `re-run the lenses or fan out): inline comments for located findings, plus one top-level ` +
          `summary comment with counts by severity and the bottom line. ` +
          (degraded
            ? `This review is DEGRADED — state that explicitly in the summary: "${review.degradedReason}". `
            : `Both lenses ran (${review.lenses.join(' + ')}). `) +
          `Consolidated review: ${JSON.stringify(review)}`,
        schema: REVIEW_SCHEMA,
      });
    } catch (e) {
      log(`§4.1 review post failed (non-fatal): ${e && e.message ? e.message : e}`);
    }

    // 4.2 Address — only when there is something actionable. A degraded review
    // is NOT "no findings" — never skip address on a degraded read.
    const actionable = degraded || !(blocking === 0) || (review?.findings?.length ?? 0) > 0;
    let addr = null;
    if (actionable && !degraded) {
      log(`§4.2 address ${review.findings.length} finding(s) on PR #${pr}`);
      addr = await agent({
        agentType: 'shipwright',
        prompt: `Address review findings on PR #${pr} (address-review mode). Findings: ${JSON.stringify(
          review.findings,
        )}`,
        schema: ADDRESS_SCHEMA,
      });
      headSha = addr.headSha ?? headSha;
      if (addr.blockingDisagreement) {
        return terminal(pr, 'blocked', 'shipwright disagreed with a blocking finding — hand to human', headSha);
      }
    }

    // 4.3 Verify — re-validate the head locally + CI rollup.
    log(`§4.3 verify PR #${pr}`);
    const localGreen = runLocalGate(sh, [build, test, lint]);
    const ci = ciStatus(sh, pr);

    // 4.4 Bounded loop: if this round changed code and still isn't converged,
    // loop back to review; otherwise fall through to make-mergeable + gate.
    const stillUnresolved = degraded || !(blocking === 0) || ci !== 'green' || !localGreen;
    const changedThisRound = !!addr && addr.validation === 'pass';
    if (changedThisRound && stillUnresolved && round < maxReviewRounds) {
      continue; // re-review the new head
    }

    // 4.4b Make-mergeable — only when autoMerge is on and GitHub says BEHIND/CONFLICTING.
    let mergeable = prMergeable(sh, pr);
    if (autoMerge && (mergeable === 'BEHIND' || mergeable === 'CONFLICTING')) {
      if (rebaseRounds >= maxRebaseRounds) {
        return terminal(pr, 'blocked', `still ${mergeable} after ${rebaseRounds} rebase round(s)`, headSha);
      }
      rebaseRounds++;
      log(`§4.4b make-mergeable (${mergeable}) round ${rebaseRounds}/${maxRebaseRounds} on PR #${pr}`);
      if (mergeable === 'BEHIND') {
        sh(`gh pr update-branch ${pr}`);
      } else {
        const reb = await agent({
          agentType: 'shipwright',
          prompt: `Rebase PR #${pr} onto ${config.baseBranch} (rebase mode), resolve conflicts integrating both sides, re-validate, force-push with --force-with-lease.`,
          schema: REBASE_SCHEMA,
        });
        if (reb.result !== 'resolved' || reb.validation !== 'pass') {
          return terminal(pr, 'blocked', reb.reason || 'rebase unresolved or failed validation', reb.headSha);
        }
        headSha = reb.headSha ?? headSha;
      }
      // A rebase changes the head: re-review it (counts against maxReviewRounds).
      if (round < maxReviewRounds) continue;
    }

    // 4.5 Gated merge — computed from data by merge-gate.mjs. The model never
    // eyeballs this; it acts on `decision`.
    mergeable = prMergeable(sh, pr);
    const state = {
      pr,
      autoMerge,
      mergeMethod: config.mergeMethod,
      review: { blocking, degraded },
      ci,
      localChecks: localGreen,
      isDraft: prIsDraft(sh, pr),
      mergeable,
      protectionsSatisfied: branchProtectionsSatisfied(sh, pr),
      rounds: round,
      maxReviewRounds,
    };
    const gate = computeMergeDecision(state);
    log(`§4.5 gate → ${gate.decision}: ${(gate.reasons || []).join('; ')}`);

    if (gate.decision === 'merge') {
      const method = gate.mergeMethod ? `--${gate.mergeMethod}` : '';
      // Merge WITHOUT --delete-branch, then reap the head branch via
      // reapMergedBranch (issue #38). The reap path applies a guard that
      // --delete-branch can't: it never deletes a head branch that still backs
      // another open PR. Keeping deletion in one guarded, fail-soft helper is
      // safer than gh's atomic delete, which has no such guard.
      const res = sh(`gh pr merge ${pr} ${method}`.trim());
      if (res.code !== 0) {
        // A refused merge (e.g. unmet protection) is a block, not a retry.
        return terminal(pr, 'blocked', `gh pr merge refused: ${(res.stdout || '').trim()}`, headSha);
      }
      // Best-effort, fail-soft local cleanup: the remote delete may have been
      // refused by branch protection / a permission layer, and the branch may
      // still be checked out in a worktree. None of that may fail the merge —
      // the PR is already merged. Log what couldn't be reaped and carry on.
      const reap = reapMergedBranch(sh, pr, config.baseBranch, log);
      return terminal(pr, 'merged', `all gates satisfied — merged${reap ? ` (${reap})` : ''}`, headSha);
    }
    if (gate.decision === 'ready_awaiting_human') {
      return terminal(pr, 'ready_awaiting_human', gate.reasons.join('; '), headSha);
    }
    return terminal(pr, 'blocked', gate.reasons.join('; '), headSha);
  }

  return terminal(pr, 'blocked', `no convergence after ${maxReviewRounds} round(s)`, headSha);
}

function terminal(pr, decision, reason, headSha) {
  return { pr, decision, reason, headSha: headSha ?? null };
}

// Best-effort, fail-soft cleanup of a merged PR's head branch (issue #38).
// The atomic `gh pr merge --delete-branch` already tries to drop the *remote*
// branch; this reaps any *local* leftovers (worktree + local branch) and never
// throws — a failed delete must not fail the merge. Returns a short status
// string for the merge trail. Guardrails:
//   - only acts on a PR confirmed MERGED;
//   - never deletes the base/default branch;
//   - removes the local worktree first (a branch checked out in a worktree
//     can't be branch-deleted), tolerating failure either way.
function reapMergedBranch(sh, pr, baseBranch, log = () => {}) {
  try {
    // Confirm MERGED and learn the head branch — don't reap on anything else.
    const meta = sh(`gh pr view ${pr} --json state,headRefName --jq "[.state,.headRefName]|@tsv"`);
    const [state, headRef] = (meta.stdout || '').trim().split('\t');
    if ((state || '').toUpperCase() !== 'MERGED') return 'branch not reaped (PR not MERGED)';
    if (!headRef) return 'branch not reaped (no head ref)';

    // Guardrail: never touch the base/default branch.
    const base = (baseBranch || '').trim();
    if (headRef === base || headRef === 'master' || headRef === 'main') {
      return `branch ${headRef} not reaped (base/default branch)`;
    }

    // Guardrail: never delete a head branch that still backs ANOTHER open PR
    // (two open PRs can share a head). If we can't determine this, fail safe and
    // skip the reap rather than risk orphaning the other PR.
    const others = sh(`gh pr list --head ${headRef} --state open --json number --jq "length"`);
    if (others.code !== 0) {
      return `branch ${headRef} not reaped (could not confirm no other open PR uses it)`;
    }
    if ((others.stdout || '').trim() !== '0') {
      return `branch ${headRef} not reaped (still backs another open PR)`;
    }

    const notes = [];

    // Delete the remote head branch (the merge no longer passes --delete-branch,
    // so the reap owns this — and only reaches here once the open-PR guard above
    // has cleared). Fail-soft: branch protection / a permission layer may refuse.
    const remote = sh(`git ls-remote --exit-code --heads origin ${headRef}`);
    if (remote.code === 0) {
      const del = sh(`git push origin --delete ${headRef}`);
      notes.push(del.code === 0 ? 'remote branch deleted' : 'remote branch delete refused (protection?)');
    }

    // Remove any local worktree backing the branch BEFORE deleting it — a branch
    // checked out in a worktree can't be deleted. Tolerate either failing.
    const wt = sh('git worktree list --porcelain');
    const wtPath = worktreePathForBranch(wt.stdout || '', headRef);
    if (wtPath) {
      const rm = sh(`git worktree remove --force "${wtPath}"`);
      if (rm.code === 0) notes.push('worktree removed');
      else notes.push('worktree remove failed (left in place)');
    }

    // Delete the local branch if present. -D (force) because a squash/rebase
    // merge leaves the local branch looking "unmerged" to git.
    const local = sh(`git rev-parse --verify --quiet refs/heads/${headRef}`);
    if (local.code === 0) {
      const dl = sh(`git branch -D ${headRef}`);
      notes.push(dl.code === 0 ? 'local branch deleted' : 'local branch delete failed (left in place)');
    }

    const msg = notes.length ? `reaped ${headRef}: ${notes.join(', ')}` : `branch ${headRef} already clean`;
    log(`§4.5 cleanup → ${msg}`);
    return msg;
  } catch (e) {
    // Fail-soft: cleanup must never fail the merge.
    const msg = `branch cleanup skipped (non-fatal: ${e && e.message ? e.message : e})`;
    log(`§4.5 cleanup → ${msg}`);
    return msg;
  }
}

// Parse `git worktree list --porcelain` for the worktree path whose checked-out
// branch is `headRef` (refs/heads/<headRef>), if any.
function worktreePathForBranch(porcelain, headRef) {
  let curPath = null;
  for (const line of porcelain.split('\n')) {
    if (line.startsWith('worktree ')) curPath = line.slice('worktree '.length).trim();
    else if (line.startsWith('branch ')) {
      const ref = line.slice('branch '.length).trim();
      if (ref === `refs/heads/${headRef}`) return curPath;
    }
  }
  return null;
}

// --- Small shell helpers (read-only probes + the gate's inputs). They expect
//     deps.sh to return { code, stdout }. ---
function runLocalGate(sh, cmds) {
  for (const cmd of cmds) {
    if (!cmd) continue;
    if (sh(cmd).code !== 0) return false;
  }
  return true;
}
function ciStatus(sh, pr) {
  const r = sh(`gh pr checks ${pr}`);
  const out = (r.stdout || '').toLowerCase();
  if (/fail|error|timed_out/.test(out)) return 'red';
  if (/pending|in_progress|queued/.test(out)) return 'pending';
  return r.code === 0 ? 'green' : 'pending';
}
function prMergeable(sh, pr) {
  const r = sh(`gh pr view ${pr} --json mergeable --jq .mergeable`);
  return (r.stdout || '').trim().toUpperCase() || 'UNKNOWN';
}
function prIsDraft(sh, pr) {
  const r = sh(`gh pr view ${pr} --json isDraft --jq .isDraft`);
  return (r.stdout || '').trim() === 'true';
}
function branchProtectionsSatisfied(sh, pr) {
  // GitHub is the source of truth; mergeStateStatus BLOCKED/BEHIND/DIRTY means not yet.
  // Fail closed: only the known-good states satisfy. Empty/unknown (gh failed or the
  // field was absent) is NOT satisfied — never treat missing protection state as green.
  const r = sh(`gh pr view ${pr} --json mergeStateStatus --jq .mergeStateStatus`);
  const st = (r.stdout || '').trim().toUpperCase();
  return st === 'CLEAN' || st === 'HAS_HOOKS' || st === 'UNSTABLE';
}

// ---------------------------------------------------------------------------
// CLI: print the plan / schemas so they're inspectable and runnable.
// ---------------------------------------------------------------------------
const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const arg = process.argv[2];
  if (arg === '--schemas') {
    console.log(JSON.stringify(SCHEMAS, null, 2));
  } else {
    console.log(
      [
        'review→merge pipeline (crows-nest §4) — deterministic Workflow:',
        '  §4.1 review     → agent(code-review) + agent(codex:codex-rescue)  TWO top-level lenses',
        '                    → consolidateLenses() (dedupe + sev-max) → REVIEW_SCHEMA; degrade NAMED',
        '                    → agent(muster) posts the consolidated verdict on the PR (best-effort)',
        '  §4.2 address    → agent(shipwright, ADDRESS_SCHEMA)   triage + fix + reply',
        '  §4.3 verify     → build && test && lint + gh pr checks',
        '  §4.4 loop       → re-review until converged (≤ maxReviewRounds)',
        '  §4.4b mergeable → agent(shipwright, REBASE_SCHEMA)    only if autoMerge && BEHIND/CONFLICTING',
        '  §4.5 gate       → merge-gate.mjs(state) → merge | ready_awaiting_human | blocked',
        '  §4.5 cleanup    → on merge: gh pr merge --delete-branch + fail-soft reap of local worktree/branch',
        '',
        'Reference from a skill via ${CLAUDE_PLUGIN_ROOT}/scripts/review-merge-pipeline.mjs',
        'Inspect schemas: node scripts/review-merge-pipeline.mjs --schemas',
      ].join('\n'),
    );
  }
}
