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

import { consolidateLenses, runReviewMergePipeline, checkoutRepoVia } from './review-merge-pipeline.mjs';

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

async function testAsync(name, fn) {
  try {
    await fn();
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

// --- Multi-repo build/merge GUARD (activeRepo != checkout → refuse) ----------
// The merge pipeline runs against the LOCAL checkout; selecting a different
// activeRepo must REFUSE rather than merge the wrong repo. It must do so BEFORE
// dispatching any reviewer/builder agent.
const fakeCheckout = (repo) => (cmd) =>
  /gh repo view/.test(cmd) ? { code: 0, stdout: `${repo}\n` } : { code: 0, stdout: '' };

await testAsync('GUARD: activeRepo != checkout → blocked, and NO agent is dispatched', async () => {
  let agentCalls = 0;
  const agent = async () => { agentCalls++; return {}; };
  const res = await runReviewMergePipeline(
    { pr: 7, config: { repos: ['calumjs/ARMADA', 'calumjs/site'], activeRepo: 'calumjs/site' } },
    { agent, sh: fakeCheckout('calumjs/ARMADA') },
  );
  assert(res.decision === 'blocked', `expected blocked, got ${res.decision}`);
  assert(/multi-repo build\/merge not supported/.test(res.reason), `expected guard reason, got: ${res.reason}`);
  assert(agentCalls === 0, `guard must refuse BEFORE any agent runs, but agent ran ${agentCalls}x`);
});

await testAsync('GUARD: single-repo default (activeRepo == checkout) lets the pipeline proceed to review', async () => {
  let agentCalls = 0;
  const agent = async () => { agentCalls++; return {}; };
  const res = await runReviewMergePipeline(
    { pr: 8, config: { activeRepo: 'calumjs/ARMADA' } },
    { agent, sh: fakeCheckout('calumjs/ARMADA') },
  );
  // The guard passed, so the review fan-out ran (agent dispatched) and the terminal
  // is NOT the guard's refusal.
  assert(agentCalls > 0, 'expected the pipeline to dispatch review agents past the guard');
  assert(!/multi-repo build\/merge not supported/.test(res.reason || ''), `must not be the guard refusal, got: ${res.reason}`);
});

test('checkoutRepoVia reads the ambient repo from the injected sh', () => {
  const repo = checkoutRepoVia((cmd) => (/gh repo view/.test(cmd) ? { code: 0, stdout: 'a/b\n' } : { code: 1, stdout: '' }));
  assert(repo === 'a/b', `expected a/b, got ${repo}`);
});

// --- Report ----------------------------------------------------------------

if (failures.length) {
  console.error(`review-merge-pipeline.test.mjs: ${failures.length} FAILED, ${passed} passed`);
  for (const f of failures) console.error(`  ✗ ${f}`);
  process.exit(1);
}
console.log(`review-merge-pipeline.test.mjs: all ${passed} tests passed`);
