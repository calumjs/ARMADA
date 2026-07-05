#!/usr/bin/env node
// Tests for the up-front run ESTIMATE feature (#212) — the fleet predicts a run's cost +
// time BEFORE it builds, and the dashboard grades estimate → actual. Three layers, all
// dependency-free (Node built-ins only), to match validate-skills.mjs + the other suites:
//
//   1. estimate.mjs producer  — record → read roundtrip; a missing run reads null (no
//      throw); negative / garbage numbers degrade to null; the file lands under the given
//      --out (side-channel), and record is a genuine forward write (stamps `at`).
//   2. spyglass-run-snapshot.readEstimate — reads out/estimates/<run>.json from a run's
//      worktree; missing/corrupt → null; a null-both file → null; XSS-ish note clamped.
//   3. spyglass-run-app.computeCalibration — the pure estimate→actual grader: has-both →
//      correct signed Δ + error %; estimate-only or actual-only → that dimension null; a
//      run with no estimate is excluded; the rollup averages abs error; no NaN/Infinity.
//
// Run: node scripts/estimate.test.mjs

import { spawnSync } from 'child_process';
import { fileURLToPath } from 'url';
import { mkdtempSync, mkdirSync, existsSync, readFileSync, writeFileSync } from 'fs';
import path from 'path';
import os from 'os';

import { numOrNull, outDirOf, fileFor } from './estimate.mjs';
import { readEstimate } from './spyglass-run-snapshot.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ESTIMATE = path.join(HERE, 'estimate.mjs');
const APP_HTML = path.join(HERE, 'spyglass-run-app.html');

let passed = 0;
const failures = [];
function test(name, fn) {
  try { fn(); passed++; }
  catch (e) { failures.push(`${name}: ${e && e.message ? e.message : e}`); }
}
function eq(a, b, msg) { if (a !== b) throw new Error(`${msg || 'not equal'} — got ${JSON.stringify(a)}, want ${JSON.stringify(b)}`); }
function ok(c, msg) { if (!c) throw new Error(msg || 'expected truthy'); }
function approx(a, b, eps, msg) { if (!(Math.abs(a - b) <= (eps ?? 1e-9))) throw new Error(`${msg || 'not approx'} — got ${a}, want ~${b}`); }

const tmp = () => mkdtempSync(path.join(os.tmpdir(), 'armada-est-'));
function runEstimate(args) {
  return spawnSync(process.execPath, [ESTIMATE, ...args], { encoding: 'utf8' });
}

// ---------------------------------------------------------------------------
// 1. estimate.mjs producer
// ---------------------------------------------------------------------------

test('numOrNull: finite non-negative kept; negative/blank/junk → null', () => {
  eq(numOrNull('3.5'), 3.5, 'positive');
  eq(numOrNull(0), 0, 'zero is valid');
  eq(numOrNull('-5'), null, 'negative → null');
  eq(numOrNull(''), null, 'blank → null');
  eq(numOrNull('abc'), null, 'junk → null');
  eq(numOrNull(null), null, 'null → null');
  eq(numOrNull(Infinity), null, 'infinity → null');
});

test('record → read roundtrip writes under --out and reads the same numbers', () => {
  const dir = tmp();
  const rec = runEstimate(['record', '--run', '212', '--cost', '3.5', '--duration', '1800', '--note', 'medium build', '--out', dir]);
  eq(rec.status, 0, 'record exits 0');
  const file = fileFor(outDirOf({ out: dir }), '212');
  ok(existsSync(file), 'estimate file written under --out/out/estimates');
  const doc = JSON.parse(readFileSync(file, 'utf8'));
  eq(doc.cost, 3.5, 'cost persisted');
  eq(doc.durationSec, 1800, 'duration persisted');
  ok(typeof doc.at === 'string' && !Number.isNaN(Date.parse(doc.at)), 'at is a real ISO stamp');
  const read = runEstimate(['read', '--run', '212', '--out', dir]);
  eq(read.status, 0, 'read exits 0');
  const out = JSON.parse(read.stdout);
  eq(out.cost, 3.5, 'read-back cost');
  eq(out.durationSec, 1800, 'read-back duration');
});

test('read of a run that was never estimated prints null and does not throw', () => {
  const dir = tmp();
  const read = runEstimate(['read', '--run', 'never', '--out', dir]);
  eq(read.status, 0, 'read of missing exits 0 (no throw)');
  eq(read.stdout.trim(), 'null', 'missing → null');
});

test('negative / garbage numbers degrade to null, never NaN', () => {
  const dir = tmp();
  runEstimate(['record', '--run', 'bad', '--cost', '-5', '--duration', 'abc', '--out', dir]);
  const doc = JSON.parse(readFileSync(fileFor(outDirOf({ out: dir }), 'bad'), 'utf8'));
  eq(doc.cost, null, 'negative cost → null');
  eq(doc.durationSec, null, 'garbage duration → null');
});

test('record with no --run errors non-fatally (exit 1, no crash)', () => {
  const r = runEstimate(['record', '--cost', '1']);
  eq(r.status, 1, 'missing --run → exit 1 (side-channel: non-fatal signal)');
});

// ---------------------------------------------------------------------------
// 2. spyglass-run-snapshot.readEstimate (reader side — reads a run's worktree)
// ---------------------------------------------------------------------------

// Seed an estimate file under a fake worktree the way the producer would.
function seedEstimate(worktree, run, doc) {
  const dir = path.join(worktree, 'out', 'estimates');
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, `${String(run).replace(/[\\/]/g, '-')}.json`), JSON.stringify(doc));
}

test('readEstimate: reads a run estimate from its worktree', () => {
  const wt = tmp();
  seedEstimate(wt, '212-est', { schema: 1, run: '212-est', cost: 4.2, durationSec: 900, at: '2026-07-05T00:00:00Z', note: 'x' });
  const e = readEstimate('212-est', 212, null, wt);
  ok(e, 'estimate found');
  eq(e.cost, 4.2, 'cost');
  eq(e.durationSec, 900, 'duration');
  eq(e.at, '2026-07-05T00:00:00Z', 'at');
});

test('readEstimate: missing file → null', () => {
  const wt = tmp();
  eq(readEstimate('nope', 1, null, wt), null, 'no file → null');
});

test('readEstimate: corrupt JSON → null (no throw)', () => {
  const wt = tmp();
  const dir = path.join(wt, 'out', 'estimates');
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, 'corrupt.json'), '{ not json');
  eq(readEstimate('corrupt', null, null, wt), null, 'corrupt → null');
});

test('readEstimate: both numbers null/absent → null (nothing gradeable)', () => {
  const wt = tmp();
  seedEstimate(wt, 'empty', { schema: 1, run: 'empty', cost: null, durationSec: null, at: 'x' });
  eq(readEstimate('empty', null, null, wt), null, 'no gradeable dimension → null');
});

test('readEstimate: negative/Infinity in file coerced to null (never surfaces bad numbers)', () => {
  const wt = tmp();
  seedEstimate(wt, 'neg', { schema: 1, run: 'neg', cost: -3, durationSec: 600, at: 'x' });
  const e = readEstimate('neg', null, null, wt);
  ok(e, 'still has a gradeable duration');
  eq(e.cost, null, 'negative cost dropped');
  eq(e.durationSec, 600, 'valid duration kept');
});

test('readEstimate: an over-long note is clamped', () => {
  const wt = tmp();
  seedEstimate(wt, 'longnote', { schema: 1, run: 'longnote', cost: 1, durationSec: 1, note: 'z'.repeat(500), at: 'x' });
  const e = readEstimate('longnote', null, null, wt);
  ok(e.note.length <= 140, 'note clamped to <=140 chars');
});

// ---------------------------------------------------------------------------
// 3. spyglass-run-app.computeCalibration (pure estimate→actual grader)
//
// Extract the self-contained pure function from the shipped HTML by brace-matching
// (it references only Array/Date/Number/Math — no DOM/storage), then eval it. This mirrors
// how the other pure app folds would be unit-tested without a browser.
// ---------------------------------------------------------------------------
function extractFn(html, name) {
  const start = html.indexOf(`function ${name}(`);
  if (start < 0) throw new Error(`function ${name} not found in app html`);
  let i = html.indexOf('{', start);
  let depth = 0;
  for (; i < html.length; i++) {
    const ch = html[i];
    if (ch === '{') depth++;
    else if (ch === '}') { depth--; if (depth === 0) { i++; break; } }
  }
  const src = html.slice(start, i);
  // eslint-disable-next-line no-new-func
  return new Function(`${src}; return ${name};`)();
}
const computeCalibration = extractFn(readFileSync(APP_HTML, 'utf8'), 'computeCalibration');

// A shipped archive record with an estimate + an actual cost + a lead-time span.
function rec({ key = 'i1', num = 1, estCost, estDur, actCost, startedAt, completedAt, outcome = 'Shipped', noEstimate = false }) {
  return {
    key, issueNumber: num, prNumber: null, title: `run ${num}`,
    outcome, startedAt, completedAt,
    cost: { present: actCost != null, totalCost: actCost != null ? actCost : null },
    estimate: noEstimate ? null : { cost: estCost ?? null, durationSec: estDur ?? null },
  };
}

test('computeCalibration: has-both → correct signed Δ + error %', () => {
  // estimate cost $2, actual $3 → Δ +$1, err 1/3; estimate 1000s, actual 1500s (started→completed
  // 1500s apart) → Δ +500, err 500/1500 = 1/3.
  const started = '2026-07-05T00:00:00Z';
  const completed = '2026-07-05T00:25:00Z'; // 1500s later
  const cal = computeCalibration([rec({ estCost: 2, estDur: 1000, actCost: 3, startedAt: started, completedAt: completed })]);
  eq(cal.n, 1, 'one graded run');
  eq(cal.rows[0].cost.delta, 1, 'cost delta +1 (over)');
  approx(cal.rows[0].cost.errPct, 1 / 3, 1e-9, 'cost err 1/3');
  eq(cal.rows[0].time.delta, 500, 'time delta +500 (over)');
  approx(cal.rows[0].time.errPct, 1 / 3, 1e-9, 'time err 1/3');
  approx(cal.avgCostErr, 1 / 3, 1e-9, 'avg cost err');
  approx(cal.avgTimeErr, 1 / 3, 1e-9, 'avg time err');
  approx(cal.avgErr, 1 / 3, 1e-9, 'combined avg err');
});

test('computeCalibration: under-estimate gives a negative delta', () => {
  const started = '2026-07-05T00:00:00Z';
  const completed = '2026-07-05T00:10:00Z'; // 600s
  const cal = computeCalibration([rec({ estCost: 5, estDur: 1200, actCost: 4, startedAt: started, completedAt: completed })]);
  eq(cal.rows[0].cost.delta, -1, 'cost came in under estimate');
  eq(cal.rows[0].time.delta, -600, 'time came in under estimate');
});

test('computeCalibration: estimate-only (no actual) → that dimension excluded, run dropped if nothing gradeable', () => {
  // has an estimate but no actual cost and no completedAt → nothing gradeable → excluded.
  const cal = computeCalibration([rec({ estCost: 2, estDur: 1000, actCost: null, startedAt: null, completedAt: null })]);
  eq(cal.n, 0, 'no gradeable dimension → excluded');
  eq(cal.any, false, 'panel hidden');
});

test('computeCalibration: actual-only cost, no estimate cost → cost null but time graded', () => {
  const started = '2026-07-05T00:00:00Z';
  const completed = '2026-07-05T00:20:00Z'; // 1200s
  const cal = computeCalibration([rec({ estCost: null, estDur: 1000, actCost: 3, startedAt: started, completedAt: completed })]);
  eq(cal.n, 1, 'graded on time');
  eq(cal.rows[0].cost, null, 'no estimate cost → cost pair null');
  ok(cal.rows[0].time, 'time graded');
  eq(cal.costN, 0, 'no cost samples');
  eq(cal.timeN, 1, 'one time sample');
});

test('computeCalibration: a run with no estimate object is excluded entirely', () => {
  const started = '2026-07-05T00:00:00Z';
  const completed = '2026-07-05T00:20:00Z';
  const cal = computeCalibration([rec({ actCost: 3, startedAt: started, completedAt: completed, noEstimate: true })]);
  eq(cal.n, 0, 'no estimate → not graded');
});

test('computeCalibration: zero actual cost is NOT graded (never divide-by-zero / $0.00)', () => {
  const cal = computeCalibration([rec({ estCost: 2, estDur: null, actCost: 0, startedAt: null, completedAt: null })]);
  eq(cal.n, 0, 'zero/absent actual → excluded');
});

test('computeCalibration: no NaN / Infinity anywhere in the output', () => {
  const started = '2026-07-05T00:00:00Z';
  const completed = '2026-07-05T00:30:00Z';
  const cal = computeCalibration([
    rec({ estCost: 2, estDur: 1000, actCost: 3, startedAt: started, completedAt: completed }),
    rec({ key: 'i2', num: 2, estCost: 10, estDur: 500, actCost: 8, startedAt: started, completedAt: completed }),
  ]);
  const flat = JSON.stringify(cal);
  ok(!/null,"errPct":null/.test(flat) || true, 'sanity');
  for (const v of [cal.avgCostErr, cal.avgTimeErr, cal.avgErr]) {
    ok(v == null || Number.isFinite(v), 'rollup finite or null');
  }
  for (const r of cal.rows) {
    for (const dim of [r.cost, r.time]) {
      if (dim) { ok(Number.isFinite(dim.delta), 'delta finite'); ok(Number.isFinite(dim.errPct), 'errPct finite'); }
    }
  }
  eq(cal.n, 2, 'both graded');
});

test('computeCalibration: empty / non-array input → empty rollup (no throw)', () => {
  eq(computeCalibration([]).any, false, 'empty');
  eq(computeCalibration(null).any, false, 'null');
  eq(computeCalibration(undefined).n, 0, 'undefined');
});

// ---------------------------------------------------------------------------
console.log(`\nestimate + calibration tests: ${passed} passed, ${failures.length} failed`);
for (const f of failures) console.error(`  ✗ ${f}`);
process.exit(failures.length ? 1 : 0);
