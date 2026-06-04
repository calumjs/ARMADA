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

export const SCHEMAS = { FINDING_SCHEMA, REVIEW_SCHEMA, ADDRESS_SCHEMA, REBASE_SCHEMA };

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
    // 4.1 Review — parallel fan-out via muster (its two lenses run in parallel
    // inside the muster subagent). Structured return only; transcript stays in
    // the subagent's context.
    log(`§4.1 review round ${round}/${maxReviewRounds} on PR #${pr}`);
    review = await agent({
      agentType: 'muster',
      prompt: `Review PR #${pr}. Return the consolidated structured findings.`,
      schema: REVIEW_SCHEMA,
    });

    const blocking = review?.summary?.blocking;
    const degraded = review?.degraded === true;

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
      const res = sh(`gh pr merge ${pr} ${method}`.trim());
      if (res.code !== 0) {
        // A refused merge (e.g. unmet protection) is a block, not a retry.
        return terminal(pr, 'blocked', `gh pr merge refused: ${(res.stdout || '').trim()}`, headSha);
      }
      return terminal(pr, 'merged', 'all gates satisfied — merged', headSha);
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
        '  §4.1 review     → agent(muster, REVIEW_SCHEMA)        parallel fan-out + consolidate',
        '  §4.2 address    → agent(shipwright, ADDRESS_SCHEMA)   triage + fix + reply',
        '  §4.3 verify     → build && test && lint + gh pr checks',
        '  §4.4 loop       → re-review until converged (≤ maxReviewRounds)',
        '  §4.4b mergeable → agent(shipwright, REBASE_SCHEMA)    only if autoMerge && BEHIND/CONFLICTING',
        '  §4.5 gate       → merge-gate.mjs(state) → merge | ready_awaiting_human | blocked',
        '',
        'Reference from a skill via ${CLAUDE_PLUGIN_ROOT}/scripts/review-merge-pipeline.mjs',
        'Inspect schemas: node scripts/review-merge-pipeline.mjs --schemas',
      ].join('\n'),
    );
  }
}
