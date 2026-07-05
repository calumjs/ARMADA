#!/usr/bin/env node
// Tests for spyglass-cost-postmortem.mjs — the `map` subcommand that records the
// run→(branch, worktree) map into out/costs/_runs.json (issue #191). This map is what
// lets scripts/liveness-beat.mjs + the read-only dashboard driver resolve an in-flight
// run to its branch, so its phase→% beats and cost climb WITHOUT a live /loop. The write
// must be idempotent: dispatching (or re-dispatching) the same issue updates the entry in
// place — it never duplicates a run and never loses the original startedAt burn-clock.
//
// Dependency-free (Node built-ins only), matching validate-skills and the other
// scripts/*.test.mjs. Run: node scripts/spyglass-cost-postmortem.test.mjs

import { mkdtempSync, existsSync, readFileSync, rmSync } from 'fs';
import path from 'path';
import os from 'os';

import { mapRun, outDirOf } from './spyglass-cost-postmortem.mjs';

let passed = 0;
const failures = [];
function test(name, fn) {
  try { fn(); passed++; }
  catch (e) { failures.push(`${name}: ${e && e.stack ? e.stack : e.message}`); }
}
function assert(cond, msg) { if (!cond) throw new Error(msg || 'assertion failed'); }
function eq(a, b, msg) { if (a !== b) throw new Error(`${msg || 'not equal'}: ${a} !== ${b}`); }

function tmpDir() { return mkdtempSync(path.join(os.tmpdir(), 'armada-costmap-')); }
const runsFile = (out) => path.join(outDirOf({ out }), '_runs.json');
const rj = (p) => JSON.parse(readFileSync(p, 'utf8'));

// --- (a) dispatch writes the run→branch entry ------------------------------
test('map: a dispatch records the run→(branch, worktree) entry', () => {
  const out = tmpDir();
  try {
    mapRun({ out, issue: '191', branch: '191-runs-map-on-dispatch', worktree: '/wt/191' });
    const file = runsFile(out);
    assert(existsSync(file), 'expected out/costs/_runs.json to be written');
    const doc = rj(file);
    eq(doc.schema, 1, 'schema stamped');
    const entry = doc.runs['191'];
    assert(entry, 'expected a run entry keyed by issue number');
    eq(entry.issue, 191, 'issue recorded as a number');
    eq(entry.branch, '191-runs-map-on-dispatch', 'branch recorded');
    eq(entry.worktree, '/wt/191', 'worktree recorded');
    assert(typeof entry.startedAt === 'string' && entry.startedAt, 'startedAt burn-clock stamped');
  } finally { rmSync(out, { recursive: true, force: true }); }
});

// --- (b) writing twice is idempotent (update in place, no dup) --------------
test('map: re-dispatching the same issue updates in place — no duplicate, startedAt preserved', () => {
  const out = tmpDir();
  try {
    // First dispatch — records branch + worktree + a startedAt.
    mapRun({ out, issue: '191', branch: '191-first', worktree: '/wt/a', startedAt: '2026-07-05T00:00:00.000Z' });
    const first = rj(runsFile(out));
    eq(Object.keys(first.runs).length, 1, 'one run after first dispatch');
    const started = first.runs['191'].startedAt;
    eq(started, '2026-07-05T00:00:00.000Z', 'startedAt taken from the first dispatch');

    // Second dispatch of the SAME issue (e.g. re-armed, or the loop also writing it):
    // a new branch/worktree, no explicit startedAt.
    mapRun({ out, issue: '191', branch: '191-second', worktree: '/wt/b' });
    const second = rj(runsFile(out));
    eq(Object.keys(second.runs).length, 1, 'still exactly one run — updated in place, not duplicated');
    eq(second.runs['191'].branch, '191-second', 'branch updated to the latest dispatch');
    eq(second.runs['191'].worktree, '/wt/b', 'worktree updated to the latest dispatch');
    eq(second.runs['191'].startedAt, started, 'original startedAt burn-clock preserved across re-dispatch');
  } finally { rmSync(out, { recursive: true, force: true }); }
});

// --- (b') a bare re-write with no new fields keeps the prior values ---------
test('map: a metadata-less refresh preserves the existing branch/worktree', () => {
  const out = tmpDir();
  try {
    mapRun({ out, issue: '42', branch: '42-thing', worktree: '/wt/42' });
    mapRun({ out, issue: '42' }); // e.g. crows-nest gap-filling with no new info
    const doc = rj(runsFile(out));
    eq(Object.keys(doc.runs).length, 1, 'no duplicate run created');
    eq(doc.runs['42'].branch, '42-thing', 'branch preserved when none supplied');
    eq(doc.runs['42'].worktree, '/wt/42', 'worktree preserved when none supplied');
  } finally { rmSync(out, { recursive: true, force: true }); }
});

// --- distinct issues coexist in the one map --------------------------------
test('map: separate issues each get their own entry', () => {
  const out = tmpDir();
  try {
    mapRun({ out, issue: '1', branch: 'one' });
    mapRun({ out, issue: '2', branch: 'two' });
    const doc = rj(runsFile(out));
    eq(Object.keys(doc.runs).length, 2, 'two distinct runs');
    eq(doc.runs['1'].branch, 'one', 'run 1 branch');
    eq(doc.runs['2'].branch, 'two', 'run 2 branch');
  } finally { rmSync(out, { recursive: true, force: true }); }
});

// --- summary ---------------------------------------------------------------
if (failures.length) {
  console.error(`\n✗ ${failures.length} failed, ${passed} passed\n`);
  for (const f of failures) console.error('  - ' + f);
  process.exit(1);
}
console.log(`✓ ${passed} passed`);
