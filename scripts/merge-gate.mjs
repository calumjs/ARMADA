#!/usr/bin/env node
// ARMADA merge-gate — the deterministic decision for crows-nest's review→merge pipeline.
//
// The 5-point merge gate (review-merge-pipeline.md §4.5) plus the bounded-loop
// convergence check (§4.4) is exactly the data-driven logic that must NOT be
// re-derived from English on every run. This script takes the pipeline's run
// state as JSON and returns a single terminal decision:
//
//   merge               — every gate holds; the pipeline may merge with mergeMethod.
//   ready_awaiting_human — gates 2–5 hold but autoMerge is off (stop-before-merge).
//   blocked             — some gate failed (with the specific reasons).
//
// The pipeline (review-merge-pipeline.mjs) calls this and acts on `decision`;
// the model never eyeballs the gate. Dependency-free (Node built-ins only) to
// match scripts/validate-skills.mjs.
//
// Run:
//   node scripts/merge-gate.mjs < state.json
//   node scripts/merge-gate.mjs state.json
//   echo '<state-json>' | node scripts/merge-gate.mjs
//
// State shape (all fields optional; missing/unknown is treated as NOT-safe):
//   {
//     "pr": 150,
//     "autoMerge": true,                 // .armada/config.json autoMerge (default false)
//     "mergeMethod": "squash",           // merge | squash | rebase
//     "review": { "blocking": 0, "degraded": false },  // latest muster summary
//     "ci": "green",                     // green | pending | red  (gh pr checks rollup)
//     "localChecks": true,               // §4.3 local build/test/lint all passed (must be true)
//     "isDraft": false,
//     "mergeable": "MERGEABLE",          // MERGEABLE | BEHIND | CONFLICTING | UNKNOWN
//     "protectionsSatisfied": true,      // false when gh pr merge would be refused
//     "rounds": 1,                       // address↔review rounds elapsed
//     "maxReviewRounds": 2               // bound before "no convergence"
//   }
//
// Exit code mirrors the decision so a shell caller can branch on $?:
//   0 = merge, 10 = ready_awaiting_human, 20 = blocked, 1 = bad input.

import { readFileSync } from 'fs';

const EXIT = { merge: 0, ready_awaiting_human: 10, blocked: 20, error: 1 };

function readInput() {
  const fileArg = process.argv[2];
  if (fileArg) return readFileSync(fileArg, 'utf8');
  // stdin (fd 0). readFileSync(0) blocks until EOF — fine for piped input.
  try {
    return readFileSync(0, 'utf8');
  } catch {
    return '';
  }
}

function fail(msg) {
  console.error(JSON.stringify({ decision: 'error', reasons: [msg] }, null, 2));
  process.exit(EXIT.error);
}

const raw = readInput().trim();
if (!raw) fail('no state JSON on stdin or as a file argument');

let s;
try {
  s = JSON.parse(raw);
} catch (e) {
  fail(`state is not valid JSON: ${e.message}`);
}
if (s === null || typeof s !== 'object' || Array.isArray(s)) {
  fail('state must be a JSON object');
}

// --- Normalise inputs defensively. Anything missing/ambiguous fails closed. ---
const autoMerge = s.autoMerge === true; // default false — opt-in only
const review = s.review && typeof s.review === 'object' ? s.review : {};
const blocking = Number.isFinite(review.blocking) ? review.blocking : NaN;
const degraded = review.degraded === true;
const ci = String(s.ci ?? '').toLowerCase();
const isDraft = s.isDraft === true;
const mergeable = String(s.mergeable ?? '').toUpperCase();
const protectionsSatisfied = s.protectionsSatisfied === true;
const rounds = Number.isFinite(s.rounds) ? s.rounds : null;
const maxReviewRounds = Number.isFinite(s.maxReviewRounds) ? s.maxReviewRounds : 2;
const localChecks = s.localChecks; // §4.3 local build/test/lint result; must be true to merge

// --- The five gates (§4.5), each independent of autoMerge so we can report a
//     green-but-awaiting-human PR distinctly from a blocked one. ---
const blockers = []; // reasons a merge is NOT safe (gates 2–5 + convergence)

// Gate 2 — no unresolved blocking finding, and the review was actually produced.
if (degraded) {
  blockers.push('review degraded (a lens failed) — a missing review is not a green light');
} else if (!Number.isFinite(blocking)) {
  blockers.push('no review summary — cannot confirm zero blocking findings');
} else if (blocking > 0) {
  blockers.push(`${blocking} unresolved blocking finding(s)`);
}

// Gate 3 — CI green (never red or pending).
if (ci !== 'green') {
  blockers.push(ci ? `CI is ${ci} (only green merges)` : 'CI status unknown (only green merges)');
}

// Gate 3b — local build/test/lint green (the §4.3 verify result). Fails closed:
// only an explicit `true` clears it, so a missing/unknown local result blocks.
if (localChecks !== true) {
  blockers.push(
    localChecks === false
      ? 'local build/test/lint failed'
      : 'local verify result unknown (only green merges)',
  );
}

// Gate 4 — not draft and mergeable.
if (isDraft) blockers.push('PR is a draft');
if (mergeable !== 'MERGEABLE') {
  blockers.push(
    mergeable
      ? `PR is not mergeable (${mergeable})${
          mergeable === 'BEHIND' || mergeable === 'CONFLICTING' ? ' — needs make-mergeable/rebase' : ''
        }`
      : 'PR mergeability unknown',
  );
}

// Gate 5 — branch protections / required reviews satisfied.
if (!protectionsSatisfied) {
  blockers.push('branch protections / required reviews not satisfied');
}

// Convergence (§4.4) — bound the address↔review loop. If blocking findings or
// red CI persist after maxReviewRounds, that is a hard block (no convergence),
// not a "try again". Only relevant when there is still something unresolved.
const unresolvedThisRound =
  degraded || !Number.isFinite(blocking) || blocking > 0 || ci !== 'green' || localChecks !== true;
let noConvergence = false;
if (rounds !== null && rounds >= maxReviewRounds && unresolvedThisRound) {
  noConvergence = true;
  blockers.push(`no convergence after ${rounds} round(s) (cap ${maxReviewRounds})`);
}

// --- Decide. ---
let decision;
let reasons;
if (blockers.length > 0) {
  decision = 'blocked';
  reasons = blockers;
} else if (!autoMerge) {
  // Gates 2–5 all hold but the operator hasn't opted into autonomous merge.
  decision = 'ready_awaiting_human';
  reasons = ['gates green; autoMerge is off — stop before merge'];
} else {
  decision = 'merge';
  reasons = ['all gates satisfied'];
}

const out = {
  pr: s.pr ?? null,
  decision,
  reasons,
  mergeMethod: decision === 'merge' ? s.mergeMethod ?? null : undefined,
  noConvergence: noConvergence || undefined,
  gates: {
    autoMerge,
    blocking: Number.isFinite(blocking) ? blocking : null,
    degraded,
    ci: ci || null,
    isDraft,
    mergeable: mergeable || null,
    protectionsSatisfied,
    rounds,
    maxReviewRounds,
  },
};
// Drop undefined keys for clean output.
for (const k of Object.keys(out)) if (out[k] === undefined) delete out[k];

console.log(JSON.stringify(out, null, 2));
process.exit(EXIT[decision]);
