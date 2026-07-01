#!/usr/bin/env node
// Tests for scripts/merge-gate.mjs — the deterministic review→merge decision.
//
// Dependency-free (Node built-ins only), to match validate-skills.mjs and the
// gate itself. Runs the gate as a subprocess with a JSON state on stdin and
// asserts both the emitted `decision` and the process exit code (which mirrors
// the decision: 0 merge · 10 ready_awaiting_human · 20 blocked · 1 error).
//
// Run: node scripts/merge-gate.test.mjs

import { spawnSync } from 'child_process';
import { fileURLToPath } from 'url';
import path from 'path';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const GATE = path.join(HERE, 'merge-gate.mjs');
const EXIT = { merge: 0, ready_awaiting_human: 10, blocked: 20, error: 1 };

// A fully-clean, mergeable base state. Individual tests override fields. With
// autoMerge:true this resolves to `merge`; with autoMerge:false, to
// `ready_awaiting_human`.
function cleanState(overrides = {}) {
  return {
    pr: 150,
    autoMerge: true,
    mergeMethod: 'squash',
    review: { blocking: 0, degraded: false },
    ci: 'green',
    localChecks: true,
    isDraft: false,
    mergeable: 'MERGEABLE',
    protectionsSatisfied: true,
    rounds: 1,
    maxReviewRounds: 2,
    ...overrides,
  };
}

function runGate(state) {
  const res = spawnSync(process.execPath, [GATE], {
    input: JSON.stringify(state),
    encoding: 'utf8',
  });
  let out = null;
  try {
    out = JSON.parse(res.stdout);
  } catch {
    // fall through — some tests only assert on exit code / error channel
  }
  return { code: res.status, out, stderr: res.stderr };
}

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

function expectDecision(state, decision, { reasonIncludes } = {}) {
  const { code, out } = runGate(state);
  assert(out !== null, `no JSON output (exit ${code})`);
  assert(
    out.decision === decision,
    `expected decision '${decision}', got '${out.decision}' (reasons: ${JSON.stringify(out.reasons)})`,
  );
  assert(
    code === EXIT[decision],
    `expected exit ${EXIT[decision]} for '${decision}', got ${code}`,
  );
  if (reasonIncludes) {
    const joined = (out.reasons || []).join(' | ');
    assert(
      joined.toLowerCase().includes(reasonIncludes.toLowerCase()),
      `expected a reason including '${reasonIncludes}', got: ${joined}`,
    );
  }
  return out;
}

// --- Baseline sanity (unchanged behaviour) ---------------------------------

test('clean + autoMerge:true → merge', () => {
  expectDecision(cleanState({ autoMerge: true }), 'merge');
});

test('clean + autoMerge:false → ready_awaiting_human', () => {
  expectDecision(cleanState({ autoMerge: false }), 'ready_awaiting_human');
});

test('blocking finding → blocked regardless of autoMerge', () => {
  expectDecision(cleanState({ autoMerge: false, review: { blocking: 2, degraded: false } }), 'blocked', {
    reasonIncludes: 'blocking finding',
  });
  expectDecision(cleanState({ autoMerge: true, review: { blocking: 2, degraded: false } }), 'blocked');
});

// --- Issue #99: autoMerge-conditional treatment of a degraded review --------

test('degraded + clean + autoMerge:FALSE → ready_awaiting_human (not blocked)', () => {
  const out = expectDecision(
    cleanState({ autoMerge: false, review: { blocking: 0, degraded: true } }),
    'ready_awaiting_human',
  );
  // The degrade must be NAMED in the reason so a human sees the PR was single-lens.
  const joined = (out.reasons || []).join(' | ').toLowerCase();
  assert(joined.includes('degrad'), `degrade not named in reason: ${JSON.stringify(out.reasons)}`);
});

test('degraded + clean + autoMerge:TRUE → blocked (unattended merge stays unsafe)', () => {
  expectDecision(
    cleanState({ autoMerge: true, review: { blocking: 0, degraded: true } }),
    'blocked',
    { reasonIncludes: 'degraded' },
  );
});

test('degraded + a blocking finding + autoMerge:false → blocked (on the finding)', () => {
  // A degrade is not a free pass: a blocking finding still blocks even when the
  // review was degraded and autoMerge is off.
  expectDecision(
    cleanState({ autoMerge: false, review: { blocking: 3, degraded: true } }),
    'blocked',
    { reasonIncludes: 'blocking finding' },
  );
});

test('degraded with no review summary + autoMerge:false → blocked (no green light)', () => {
  // blocking omitted → cannot confirm zero findings; still not safe even with
  // autoMerge off. This is the "no review at all" case, distinct from a
  // degraded-but-clean single-lens read.
  expectDecision(
    cleanState({ autoMerge: false, review: { degraded: true } }),
    'blocked',
    { reasonIncludes: 'no review summary' },
  );
});

test('degraded + clean + autoMerge:false, rounds at cap → still ready_awaiting_human', () => {
  // Convergence must NOT re-block a clean-but-degraded PR once rounds hit the cap
  // under autoMerge:false — otherwise ready_awaiting_human stays unreachable.
  const out = expectDecision(
    cleanState({
      autoMerge: false,
      review: { blocking: 0, degraded: true },
      rounds: 2,
      maxReviewRounds: 2,
    }),
    'ready_awaiting_human',
  );
  assert(!out.noConvergence, `should not flag noConvergence: ${JSON.stringify(out)}`);
});

test('degraded + clean + autoMerge:true, rounds at cap → blocked (no convergence)', () => {
  // Under autoMerge:true the degrade is a hard blocker, so the convergence bound
  // still trips at the cap.
  const out = expectDecision(
    cleanState({
      autoMerge: true,
      review: { blocking: 0, degraded: true },
      rounds: 2,
      maxReviewRounds: 2,
    }),
    'blocked',
  );
  assert(out.noConvergence === true, `expected noConvergence flag: ${JSON.stringify(out)}`);
});

test('degraded + clean + autoMerge:false, but CI red → blocked (on CI, not degrade)', () => {
  expectDecision(
    cleanState({ autoMerge: false, review: { blocking: 0, degraded: true }, ci: 'red' }),
    'blocked',
    { reasonIncludes: 'CI is red' },
  );
});

// --- Report ----------------------------------------------------------------

if (failures.length) {
  console.error(`merge-gate.test.mjs: ${failures.length} FAILED, ${passed} passed`);
  for (const f of failures) console.error(`  ✗ ${f}`);
  process.exit(1);
}
console.log(`merge-gate.test.mjs: all ${passed} tests passed`);
