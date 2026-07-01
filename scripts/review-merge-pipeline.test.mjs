#!/usr/bin/env node
// Tests for scripts/review-merge-pipeline.mjs — specifically consolidateLenses,
// the muster §2 consolidation the pipeline owns after fanning out the two lenses.
//
// Dependency-free (Node built-ins only), matching scripts/merge-gate.test.mjs.
// The focus here is the zero-lens serialization invariant (issue #99 / PR #100):
// when BOTH lenses fail, the consolidated summary must NOT report a confident
// `blocking: 0` — it must be non-finite (null) so the merge gate's no-summary
// guard blocks a fully-unreviewed PR under EITHER autoMerge mode.
//
// Run: node scripts/review-merge-pipeline.test.mjs

import { consolidateLenses } from './review-merge-pipeline.mjs';

let passed = 0;
const failures = [];

function test(name, fn) {
  try {
    fn();
    passed++;
  } catch (e) {
    failures.push(`${name}: ${e.message}`);
  }
}

function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

// (a) Both lenses failed (ran=0) → no confident blocking:0, and degraded.
test('both lenses failed (ran=0) → blocking is NOT finite (null) AND degraded', () => {
  const review = consolidateLenses(100, [
    { name: 'code-review', ok: false, findings: [] },
    { name: 'codex-rescue', ok: false, findings: [] },
  ]);
  assert(
    !Number.isFinite(review.summary.blocking),
    `expected non-finite blocking, got ${JSON.stringify(review.summary.blocking)}`,
  );
  assert(review.summary.blocking === null, `expected null blocking, got ${JSON.stringify(review.summary.blocking)}`);
  assert(review.degraded === true, `expected degraded:true, got ${review.degraded}`);
});

// (b) One lens ran clean, one failed (single-lens) → blocking:0 AND degraded.
test('single lens (one clean, one failed) → blocking === 0 AND degraded', () => {
  const review = consolidateLenses(100, [
    { name: 'code-review', ok: true, findings: [] },
    { name: 'codex-rescue', ok: false, findings: [] },
  ]);
  assert(review.summary.blocking === 0, `expected blocking:0, got ${JSON.stringify(review.summary.blocking)}`);
  assert(review.degraded === true, `expected degraded:true, got ${review.degraded}`);
});

// (c) Both lenses ran clean → blocking:0 AND NOT degraded.
test('both lenses clean → blocking === 0 AND degraded === false', () => {
  const review = consolidateLenses(100, [
    { name: 'code-review', ok: true, findings: [] },
    { name: 'codex-rescue', ok: true, findings: [] },
  ]);
  assert(review.summary.blocking === 0, `expected blocking:0, got ${JSON.stringify(review.summary.blocking)}`);
  assert(review.degraded === false, `expected degraded:false, got ${review.degraded}`);
});

// --- Report ----------------------------------------------------------------

if (failures.length) {
  console.error(`review-merge-pipeline.test.mjs: ${failures.length} FAILED, ${passed} passed`);
  for (const f of failures) console.error(`  ✗ ${f}`);
  process.exit(1);
}
console.log(`review-merge-pipeline.test.mjs: all ${passed} tests passed`);
