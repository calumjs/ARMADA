#!/usr/bin/env node
// ARMADA quartermaster — verdict + accounting tests (dependency-free).
//
// Exercises the pure budget/verdict logic that gates dispatch: under / at / over
// each threshold, the no-budget case, and the no-data (degrade-open) case, plus a
// small burn-rate/forecast sanity check and an end-to-end account() fold over
// synthetic cost signals. Exits non-zero on any failure so it works as a gate.
//
// Run: node scripts/quartermaster.test.mjs

import { verdict, burnAndForecast, account } from './quartermaster.mjs';

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

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
