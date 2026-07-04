#!/usr/bin/env node
// ARMADA quartermaster — verdict + accounting tests (dependency-free).
//
// Exercises the pure budget/verdict logic that gates dispatch: under / at / over
// each threshold, the no-budget case, and the no-data (degrade-open) case, plus a
// small burn-rate/forecast sanity check and an end-to-end account() fold over
// synthetic cost signals. Exits non-zero on any failure so it works as a gate.
//
// Run: node scripts/quartermaster.test.mjs

import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'fs';
import os from 'os';
import path from 'path';
import { verdict, burnAndForecast, account, readCostSignals } from './quartermaster.mjs';

let pass = 0, fail = 0;
function check(name, cond) {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.error(`  ✗ ${name}`); }
}

console.log('quartermaster — verdict logic');

// ---- no budget → always allow (ungoverned) ----
check('no budget → allow', verdict({ budget: {}, todaySpend: 999, inFlightReserve: 999, maxRunUSD: 999, dataAvailable: true }).decision === 'allow');
check('no budget → code no-budget', verdict({ budget: {}, todaySpend: 999, dataAvailable: true }).code === 'no-budget');

// ---- no data (budget set) → allow + warn (degrade open) ----
{
  const v = verdict({ budget: { perDayUSD: 10 }, todaySpend: 0, inFlightReserve: 0, maxRunUSD: null, dataAvailable: false });
  check('budget set, no data → allow', v.decision === 'allow');
  check('budget set, no data → warn', v.warn === true && v.code === 'no-data');
}

// ---- per-day: under / at / over ----
check('per-day UNDER → allow', verdict({ budget: { perDayUSD: 10 }, todaySpend: 5, inFlightReserve: 2, maxRunUSD: 5, dataAvailable: true }).decision === 'allow');
check('per-day AT threshold → allow', verdict({ budget: { perDayUSD: 10 }, todaySpend: 8, inFlightReserve: 2, maxRunUSD: 8, dataAvailable: true }).decision === 'allow');
check('per-day OVER → pause', verdict({ budget: { perDayUSD: 10 }, todaySpend: 8, inFlightReserve: 3, maxRunUSD: 8, dataAvailable: true }).decision === 'pause');

// ---- per-run: under / at / over ----
check('per-run UNDER → allow', verdict({ budget: { perRunUSD: 5 }, todaySpend: 4, inFlightReserve: 0, maxRunUSD: 4, dataAvailable: true }).decision === 'allow');
check('per-run AT threshold → allow', verdict({ budget: { perRunUSD: 5 }, todaySpend: 5, inFlightReserve: 0, maxRunUSD: 5, dataAvailable: true }).decision === 'allow');
{
  const v = verdict({ budget: { perRunUSD: 5 }, todaySpend: 6, inFlightReserve: 0, maxRunUSD: 6, dataAvailable: true });
  check('per-run OVER → pause', v.decision === 'pause' && v.code === 'over-budget');
  check('per-run OVER → reason names the run overrun', /per-run budget/.test(v.reason));
}

// ---- both budgets: per-run trips even when per-day is fine ----
{
  const v = verdict({ budget: { perRunUSD: 3, perDayUSD: 100 }, todaySpend: 5, inFlightReserve: 0, maxRunUSD: 4, dataAvailable: true });
  check('per-run trips under a generous per-day', v.decision === 'pause');
}

console.log('quartermaster — burn-rate / forecast');
{
  // $6 over exactly 3h, at 15:00 with 9h left → 2 $/h, forecast 6 + 2*9 = 24.
  const nowMs = new Date('2026-07-04T15:00:00').getTime();
  const b = burnAndForecast({ todaySpend: 6, windowStartMs: nowMs - 3 * 3_600_000, nowMs, dayEndMs: new Date('2026-07-05T00:00:00').getTime() });
  check('burn-rate = $2.00/hr', Math.abs(b.burnRatePerHour - 2) < 1e-9);
  check('forecast EOD = $24.00', Math.abs(b.forecastEndOfDay - 24) < 1e-9);
  check('zero spend → zero burn', burnAndForecast({ todaySpend: 0, windowStartMs: nowMs - 3_600_000, nowMs, dayEndMs: nowMs + 3_600_000 }).burnRatePerHour === 0);
}

console.log('quartermaster — account() over synthetic signals');
{
  const nowMs = new Date('2026-07-04T14:00:00').getTime();
  const startMs = new Date('2026-07-04T12:00:00').getTime(); // 2h ago
  const oldMs = new Date('2026-07-03T09:00:00').getTime();   // yesterday — excluded
  const signals = {
    dataAvailable: true,
    todayRuns: [
      { run: 'a', cost: 4, priced: true, final: true, startedAtMs: startMs, activityMs: startMs },
      { run: 'b', cost: 2, priced: true, final: false, startedAtMs: nowMs - 3_600_000, activityMs: nowMs - 1000 },
    ],
    // account() only reads todayRuns; yesterday's is pre-filtered out by readCostSignals.
    runs: [{ run: 'c', cost: 99, final: true, activityMs: oldMs }],
  };
  const acct = account({ signals, budget: { perRunUSD: 5 }, nowMs });
  check('todaySpend = $6 (4 + 2)', acct.todaySpend === 6);
  check('inFlightCount = 1 (run b)', acct.inFlightCount === 1);
  check('inFlightReserve fills toward per-run cap (5-2=3)', acct.inFlightReserve === 3);
  check('maxRunUSD = 4', acct.maxRunUSD === 4);

  // The full fold should then PAUSE: projected 6 + 3 = 9 > per-day 8.
  const v = verdict({ budget: { perRunUSD: 5, perDayUSD: 8 }, todaySpend: acct.todaySpend, inFlightReserve: acct.inFlightReserve, maxRunUSD: acct.maxRunUSD, dataAvailable: true });
  check('folded account → pause over per-day 8', v.decision === 'pause');
}

// ---------------------------------------------------------------------------
// FIX 1 — the per-run pause reflects CURRENT risk only: it gates on IN-FLIGHT
// runs, not finished ones. A completed overrun must NOT stay sticky-paused all
// day; a run currently over its per-run budget SHOULD pause.
// ---------------------------------------------------------------------------
console.log('quartermaster — per-run pause is not sticky on finished runs (FIX 1)');

// Direct on the pure rule: a null in-flight max (nothing accruing) never trips per-run.
check('finished overrun, nothing in-flight (maxInFlightRunUSD null) → allow',
  verdict({ budget: { perRunUSD: 5 }, todaySpend: 9, inFlightReserve: 0, maxRunUSD: 9, maxInFlightRunUSD: null, dataAvailable: true }).decision === 'allow');
check('in-flight run over per-run (maxInFlightRunUSD 6) → pause',
  verdict({ budget: { perRunUSD: 5 }, todaySpend: 6, inFlightReserve: 0, maxRunUSD: 6, maxInFlightRunUSD: 6, dataAvailable: true }).decision === 'pause');

// End-to-end through account(): a FINISHED overrun with nothing in flight.
{
  const nowMs = new Date('2026-07-04T14:00:00').getTime();
  const t = nowMs - 3_600_000;
  const signals = {
    dataAvailable: true,
    todayRuns: [{ run: 'over', cost: 9, priced: true, final: true, startedAtMs: t, activityMs: nowMs - 1000 }],
    runs: [],
  };
  const acct = account({ signals, budget: { perRunUSD: 5 }, nowMs });
  check('finished overrun → maxInFlightRunUSD is null', acct.maxInFlightRunUSD === null);
  check('finished overrun → maxRunUSD still records it ($9)', acct.maxRunUSD === 9);
  const v = verdict({ budget: { perRunUSD: 5 }, todaySpend: acct.todaySpend, inFlightReserve: acct.inFlightReserve, maxRunUSD: acct.maxRunUSD, maxInFlightRunUSD: acct.maxInFlightRunUSD, dataAvailable: true });
  check('folded: finished per-run overrun, nothing in-flight → ALLOW (not sticky-paused)', v.decision === 'allow');
}
// End-to-end through account(): a run currently IN-FLIGHT and over per-run.
{
  const nowMs = new Date('2026-07-04T14:00:00').getTime();
  const t = nowMs - 3_600_000;
  const signals = {
    dataAvailable: true,
    todayRuns: [{ run: 'live', cost: 6, priced: true, final: false, startedAtMs: t, activityMs: nowMs - 1000 }],
    runs: [],
  };
  const acct = account({ signals, budget: { perRunUSD: 5 }, nowMs });
  check('in-flight overrun → maxInFlightRunUSD is $6', acct.maxInFlightRunUSD === 6);
  const v = verdict({ budget: { perRunUSD: 5, perDayUSD: 1000 }, todaySpend: acct.todaySpend, inFlightReserve: acct.inFlightReserve, maxRunUSD: acct.maxRunUSD, maxInFlightRunUSD: acct.maxInFlightRunUSD, dataAvailable: true });
  check('folded: in-flight run currently over per-run → PAUSE', v.decision === 'pause' && v.code === 'over-budget');
}

// ---------------------------------------------------------------------------
// FIX 2 — a present-but-empty or all-malformed out/costs/ is the NO-DATA case:
// allow + warn ("cost data unavailable"), not a false "$0 within budget".
// ---------------------------------------------------------------------------
console.log('quartermaster — no USABLE cost data → degrade open + warn (FIX 2)');
{
  // out/costs/ exists but is empty → no usable cost signal.
  const tmp = mkdtempSync(path.join(os.tmpdir(), 'qm-empty-'));
  mkdirSync(path.join(tmp, 'out', 'costs'), { recursive: true });
  const s = readCostSignals(tmp, { nowMs: Date.now() });
  check('existing-but-empty out/costs/ → dataAvailable false', s.dataAvailable === false);
  const v = verdict({ budget: { perDayUSD: 10 }, todaySpend: 0, inFlightReserve: 0, maxRunUSD: null, maxInFlightRunUSD: null, dataAvailable: s.dataAvailable });
  check('empty cost dir → ALLOW + warn (no-data), not $0-within-budget', v.decision === 'allow' && v.warn === true && v.code === 'no-data');
  check('empty cost dir → reason says cost data unavailable', /cost data unavailable/.test(v.reason));
  rmSync(tmp, { recursive: true, force: true });
}
{
  // Every cost doc present but malformed/unparseable → no usable cost signal.
  const tmp = mkdtempSync(path.join(os.tmpdir(), 'qm-bad-'));
  const cd = path.join(tmp, 'out', 'costs');
  mkdirSync(cd, { recursive: true });
  writeFileSync(path.join(cd, 'run-1.json'), '{ not valid json');
  writeFileSync(path.join(cd, 'run-2.json'), 'also not json at all');
  const s = readCostSignals(tmp, { nowMs: Date.now() });
  check('all-malformed cost docs → dataAvailable false', s.dataAvailable === false);
  rmSync(tmp, { recursive: true, force: true });
}
{
  // Guard against over-triggering: one readable doc → data IS available.
  const tmp = mkdtempSync(path.join(os.tmpdir(), 'qm-ok-'));
  const cd = path.join(tmp, 'out', 'costs');
  mkdirSync(cd, { recursive: true });
  writeFileSync(path.join(cd, 'run-1.json'), JSON.stringify({ run: 'run-1', totalCost: 1.5, final: true, updatedAt: new Date().toISOString() }));
  const s = readCostSignals(tmp, { nowMs: Date.now() });
  check('one readable cost doc → dataAvailable true', s.dataAvailable === true);
  rmSync(tmp, { recursive: true, force: true });
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
