#!/usr/bin/env node
// ARMADA quartermaster — the fleet's cost governor (accounting + enforcement).
//
// spyglass already OBSERVES per-run cost; quartermaster turns that observability
// into GOVERNANCE. It reads the SAME read-only cost signals spyglass consumes —
// the per-run post-mortems `scripts/spyglass-cost-postmortem.mjs` writes under
// `out/costs/<run>.json`, plus the run→(branch,worktree,startedAt) map in
// `out/costs/_runs.json` — and answers two questions:
//
//   report   what is the fleet spending? — today's total spend, the in-flight
//            (accruing) portion, per-run spends, a burn-rate (USD/hour) and a
//            simple end-of-day forecast at the current rate.
//   check    may we dispatch more work? — an allow/pause verdict against the
//            budgets in `.armada/config.json` (`budget.perRunUSD` /
//            `budget.perDayUSD`). crows-nest consults this BEFORE it dispatches a
//            build (crows-nest §2c/§2d) and holds new work — with the reason
//            surfaced — when the verdict is PAUSE.
//
// Design guarantees (issue #148):
//   * Dependency-free — Node built-ins only, to match validate-skills / spyglass.
//   * READ-ONLY w.r.t. the cost data — it never writes under out/costs/ (that is
//     the cost-postmortem producer's job). `check`/`report` write nothing at all.
//   * Never blocks the fleet on MISSING data. No budget set → allow (ungoverned).
//     Cost signals unavailable → allow + a warning (degrade open, never closed).
//   * Verdict compares against budgets with a strict `>` — spend AT the threshold
//     still allows; only spend that WOULD EXCEED it pauses.
//
// Run:
//   node scripts/quartermaster.mjs report [--json] [--repo-root <dir>]
//   node scripts/quartermaster.mjs check  [--json] [--repo-root <dir>]
//                                         [--per-run <usd>] [--per-day <usd>]
//
// `check` ALWAYS exits 0 (a governor must never crash the tick); the decision is
// on stdout — a leading `ALLOW`/`PAUSE` token in text mode, or `decision` in
// `--json` mode. `--per-run`/`--per-day` override the config budgets (for a
// what-if or a test); otherwise the budgets come from `.armada/config.json`.

import { readFileSync, existsSync, readdirSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

// ---------------------------------------------------------------------------
// Small numeric helpers (tolerant; mirror the cost-postmortem conventions).
// ---------------------------------------------------------------------------
export const isNum = (v) => typeof v === 'number' && Number.isFinite(v);
const numOrNull = (v) => {
  if (isNum(v)) return v;
  if (v == null || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};
const usd = (v) => (isNum(v) ? `$${v.toFixed(2)}` : 'n/a');

// ---------------------------------------------------------------------------
// The pure verdict — the governed decision, isolated so it is trivially testable
// (under / at / over threshold, no-budget, no-data). Takes already-computed
// numbers so the enforcement rule is one small, side-effect-free function.
//
//   budget          { perRunUSD?, perDayUSD? } — either/both optional.
//   todaySpend      actual recorded spend today (final + accruing-so-far), USD.
//   inFlightReserve conservative estimate of the REMAINING spend the currently
//                   in-flight runs will still accrue, USD (>= 0).
//   maxRunUSD       the largest single run's spend today, USD (or null).
//   dataAvailable   whether any cost signal could be read at all.
//
// Returns { decision:'allow'|'pause', code, reason, warn?, breaches? }.
// ---------------------------------------------------------------------------
export function verdict({ budget, todaySpend, inFlightReserve, maxRunUSD, dataAvailable }) {
  const perRun = numOrNull(budget && budget.perRunUSD);
  const perDay = numOrNull(budget && budget.perDayUSD);
  const hasBudget = perRun != null || perDay != null;

  // No budget configured → the fleet is deliberately ungoverned. Allow cleanly.
  if (!hasBudget) {
    return { decision: 'allow', code: 'no-budget', reason: 'no budget configured — fleet is ungoverned' };
  }
  // Cost signals unavailable → degrade OPEN. Never block the fleet on missing
  // data; surface a warning so the gap is visible.
  if (!dataAvailable) {
    return {
      decision: 'allow', code: 'no-data', warn: true,
      reason: 'cost data unavailable — allowing (a governor never blocks the fleet on missing data)',
    };
  }

  const spend = isNum(todaySpend) ? todaySpend : 0;
  const reserve = isNum(inFlightReserve) ? inFlightReserve : 0;
  const projectedDay = spend + reserve;
  const breaches = [];

  // A single run that has already blown its per-run budget → pause new dispatches.
  if (perRun != null && isNum(maxRunUSD) && maxRunUSD > perRun) {
    breaches.push(`a run has spent ${usd(maxRunUSD)} — over the per-run budget ${usd(perRun)}`);
  }
  // Today's projected spend (actual + a conservative in-flight reserve) would
  // exceed the per-day budget → pause. Strict `>`: AT the budget still allows.
  if (perDay != null && projectedDay > perDay) {
    breaches.push(
      `today's projected spend ${usd(projectedDay)} (actual ${usd(spend)} + in-flight reserve ${usd(reserve)}) ` +
      `would exceed the per-day budget ${usd(perDay)}`,
    );
  }

  if (breaches.length) {
    return { decision: 'pause', code: 'over-budget', reason: breaches.join('; '), breaches };
  }
  const within = [];
  if (perDay != null) within.push(`day ${usd(projectedDay)}/${usd(perDay)}`);
  if (perRun != null) within.push(`max run ${usd(maxRunUSD)}/${usd(perRun)}`);
  return { decision: 'allow', code: 'within-budget', reason: `within budget (${within.join(', ')})` };
}

// ---------------------------------------------------------------------------
// Burn-rate + forecast — also pure, so the arithmetic is testable in isolation.
//   todaySpend    recorded spend so far today, USD.
//   windowStartMs epoch ms of the earliest activity today (burn clock start).
//   nowMs         epoch ms "now".
//   dayEndMs      epoch ms of the next local midnight.
// Returns { elapsedHours, burnRatePerHour, hoursRemaining, forecastEndOfDay }.
// ---------------------------------------------------------------------------
export function burnAndForecast({ todaySpend, windowStartMs, nowMs, dayEndMs }) {
  const spend = isNum(todaySpend) ? todaySpend : 0;
  // Floor elapsed at one minute so a run that just started doesn't divide by ~0
  // into an absurd rate; the report labels a very-young window low-confidence.
  const elapsedMs = Math.max((nowMs - windowStartMs) || 0, 60_000);
  const elapsedHours = elapsedMs / 3_600_000;
  const burnRatePerHour = spend > 0 ? spend / elapsedHours : 0;
  const hoursRemaining = Math.max((dayEndMs - nowMs) / 3_600_000, 0);
  const forecastEndOfDay = spend + burnRatePerHour * hoursRemaining;
  return { elapsedHours, burnRatePerHour, hoursRemaining, forecastEndOfDay };
}

// ---------------------------------------------------------------------------
// Read-only cost-signal reading (mirrors spyglass-run-snapshot.mjs).
// ---------------------------------------------------------------------------
function readConfig(root) {
  const p = path.join(root, '.armada', 'config.json');
  if (existsSync(p)) {
    try { return JSON.parse(readFileSync(p, 'utf8')); } catch { /* malformed */ }
  }
  return {};
}

// Consume the run→(branch,worktree,startedAt) map crows-nest writes (READ-ONLY).
// Shape: { runs: { "<issue>": { issue, branch, worktree, startedAt, updatedAt } } }.
function readRunMap(costsDir) {
  const p = path.join(costsDir, '_runs.json');
  if (!existsSync(p)) return {};
  try {
    const data = JSON.parse(readFileSync(p, 'utf8'));
    const runs = data && typeof data === 'object' ? (data.runs || data) : {};
    const map = {};
    for (const [k, v] of Object.entries(runs)) if (v && typeof v === 'object') map[String(k)] = v;
    return map;
  } catch { return {}; }
}

// Sum only the PRICED total. A doc whose only usage is unpriced (codex/gpt review
// lens) carries totalCost:null — it contributes 0 to spend but is NOT missing data.
function totalOf(doc) {
  const t = numOrNull(doc && (doc.totalCost ?? doc.total_cost));
  return t == null ? 0 : t;
}

// Read every per-run cost post-mortem under out/costs/ (skipping the private
// _runs.json / _schedule.json), correlate each to its startedAt via the run map,
// and keep the ones active TODAY (local day). Strictly read-only.
export function readCostSignals(root, { nowMs = Date.now() } = {}) {
  const costsDir = path.join(root, 'out', 'costs');
  const dataAvailable = existsSync(costsDir);
  if (!dataAvailable) {
    return { dataAvailable: false, costsDir, runs: [], todayRuns: [] };
  }
  const runMap = readRunMap(costsDir);
  // branch → startedAt, for correlating a branch-keyed cost doc to its dispatch time.
  const startedByBranch = {};
  const startedByIssue = {};
  for (const [issue, rec] of Object.entries(runMap)) {
    if (rec.startedAt) {
      startedByIssue[issue] = rec.startedAt;
      if (rec.branch) startedByBranch[rec.branch] = rec.startedAt;
    }
  }

  const start = new Date(nowMs); start.setHours(0, 0, 0, 0);
  const startOfDayMs = start.getTime();

  const runs = [];
  let files = [];
  try { files = readdirSync(costsDir); } catch { files = []; }
  for (const f of files) {
    if (!f.endsWith('.json')) continue;
    if (f === '_runs.json' || f === '_schedule.json') continue;
    let doc;
    try { doc = JSON.parse(readFileSync(path.join(costsDir, f), 'utf8')); } catch { continue; }
    if (!doc || typeof doc !== 'object') continue;
    const runKey = String(doc.run ?? f.replace(/\.json$/, ''));
    const updatedAt = doc.updatedAt || doc.generatedAt || null;
    const startedAt = startedByBranch[runKey] || startedByIssue[runKey] || updatedAt || null;
    const activityMs = Date.parse(updatedAt || startedAt || '') || null;
    runs.push({
      run: runKey,
      cost: totalOf(doc),
      priced: numOrNull(doc.totalCost ?? doc.total_cost) != null,
      final: doc.final === true,
      updatedAt,
      startedAtMs: Date.parse(startedAt || '') || null,
      activityMs,
    });
  }

  // "Today" = active since local midnight (by last activity; startedAt as fallback).
  const todayRuns = runs.filter((r) => r.activityMs != null && r.activityMs >= startOfDayMs);
  return { dataAvailable: true, costsDir, runs, todayRuns, startOfDayMs };
}

// ---------------------------------------------------------------------------
// Accounting — fold the today-runs into the numbers report/check need. Pure given
// the signals, so the whole pipeline is testable end-to-end.
//   budget is used ONLY to size the conservative in-flight reserve (each accruing
//   run is assumed to run up toward its per-run budget; absent a per-run budget it
//   is assumed to at least double its recorded-so-far spend).
// ---------------------------------------------------------------------------
export function account({ signals, budget, nowMs = Date.now() }) {
  const perRun = numOrNull(budget && budget.perRunUSD);
  const today = signals.todayRuns || [];
  const todaySpend = today.reduce((a, r) => a + (isNum(r.cost) ? r.cost : 0), 0);
  const inFlight = today.filter((r) => !r.final);
  const inFlightSoFar = inFlight.reduce((a, r) => a + (isNum(r.cost) ? r.cost : 0), 0);
  // Conservative estimate of the REMAINING spend still to come from in-flight runs.
  const inFlightReserve = inFlight.reduce((a, r) => {
    const soFar = isNum(r.cost) ? r.cost : 0;
    const remaining = perRun != null ? Math.max(perRun - soFar, 0) : soFar; // double, or fill to cap
    return a + remaining;
  }, 0);
  const maxRunUSD = today.length ? Math.max(...today.map((r) => (isNum(r.cost) ? r.cost : 0))) : null;

  // Burn window starts at the earliest activity today.
  const stamps = today.map((r) => r.startedAtMs || r.activityMs).filter((n) => isNum(n));
  const windowStartMs = stamps.length ? Math.min(...stamps) : nowMs;
  const dayEnd = new Date(nowMs); dayEnd.setHours(24, 0, 0, 0);
  const burn = burnAndForecast({ todaySpend, windowStartMs, nowMs, dayEndMs: dayEnd.getTime() });

  return {
    todaySpend,
    inFlightCount: inFlight.length,
    inFlightSoFar,
    inFlightReserve,
    maxRunUSD,
    runCount: today.length,
    perRunSpends: today.map((r) => ({ run: r.run, cost: r.cost, final: r.final, priced: r.priced })),
    ...burn,
  };
}

// ---------------------------------------------------------------------------
// Arg parsing
// ---------------------------------------------------------------------------
function parseArgs(argv) {
  const args = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--json') args.json = true;
    else if (a === '--repo-root') args.repoRoot = argv[++i];
    else if (a === '--per-run') args.perRun = argv[++i];
    else if (a === '--per-day') args.perDay = argv[++i];
    else if (a.startsWith('--')) args[a.slice(2)] = true;
    else args._.push(a);
  }
  return args;
}

function resolveBudget(config, args) {
  const cfg = (config && config.budget) || {};
  const perRun = args.perRun != null ? numOrNull(args.perRun) : numOrNull(cfg.perRunUSD);
  const perDay = args.perDay != null ? numOrNull(args.perDay) : numOrNull(cfg.perDayUSD);
  const out = {};
  if (perRun != null) out.perRunUSD = perRun;
  if (perDay != null) out.perDayUSD = perDay;
  return out;
}

// ---------------------------------------------------------------------------
// report — what is the fleet spending today?
// ---------------------------------------------------------------------------
function runReport(root, args) {
  const config = readConfig(root);
  const budget = resolveBudget(config, args);
  const signals = readCostSignals(root);
  const acct = account({ signals, budget });

  if (args.json) {
    console.log(JSON.stringify({
      mode: 'report',
      dataAvailable: signals.dataAvailable,
      budget,
      today: {
        spend: round(acct.todaySpend),
        runs: acct.runCount,
        inFlight: { count: acct.inFlightCount, soFar: round(acct.inFlightSoFar), reserve: round(acct.inFlightReserve) },
        maxRun: acct.maxRunUSD == null ? null : round(acct.maxRunUSD),
        burnRatePerHour: round(acct.burnRatePerHour),
        elapsedHours: round(acct.elapsedHours, 3),
        hoursRemaining: round(acct.hoursRemaining, 3),
        forecastEndOfDay: round(acct.forecastEndOfDay),
      },
      runs: acct.perRunSpends.map((r) => ({ run: r.run, cost: r.priced ? round(r.cost) : null, final: r.final })),
    }, null, 2));
    return 0;
  }

  const L = [];
  L.push('⚓ quartermaster — fleet spend, today');
  if (!signals.dataAvailable) {
    L.push('  cost data: UNAVAILABLE (no out/costs/ — cost tracking not wired; crows-nest `costs` off?)');
    L.push('  today\'s spend: n/a · in-flight: n/a · burn-rate: n/a · forecast: n/a');
  } else {
    L.push(`  today's spend:   ${usd(acct.todaySpend)}   (${acct.runCount} run${acct.runCount === 1 ? '' : 's'} active today)`);
    L.push(`  in-flight:       ${usd(acct.inFlightSoFar)} so far across ${acct.inFlightCount} accruing run${acct.inFlightCount === 1 ? '' : 's'}` +
      (acct.inFlightReserve > 0 ? ` (+${usd(acct.inFlightReserve)} reserve to come)` : ''));
    L.push(`  largest run:     ${usd(acct.maxRunUSD)}`);
    const conf = acct.elapsedHours < 0.25 ? '  (low confidence — window < 15 min)' : '';
    L.push(`  burn-rate:       ${usd(acct.burnRatePerHour)}/hr  over ${acct.elapsedHours.toFixed(2)} h${conf}`);
    L.push(`  forecast (EOD):  ${usd(acct.forecastEndOfDay)}   (${acct.hoursRemaining.toFixed(1)} h left at current rate)`);
  }
  const parts = [];
  if (budget.perRunUSD != null) parts.push(`perRunUSD ${usd(budget.perRunUSD)}`);
  if (budget.perDayUSD != null) parts.push(`perDayUSD ${usd(budget.perDayUSD)}`);
  L.push(`  budget:          ${parts.length ? parts.join(' · ') : 'none (ungoverned)'}`);
  console.log(L.join('\n'));
  return 0;
}

// ---------------------------------------------------------------------------
// check — may we dispatch more work? (the enforcement verdict)
// ---------------------------------------------------------------------------
function runCheck(root, args) {
  const config = readConfig(root);
  const budget = resolveBudget(config, args);
  const signals = readCostSignals(root);
  const acct = account({ signals, budget });
  const v = verdict({
    budget,
    todaySpend: acct.todaySpend,
    inFlightReserve: acct.inFlightReserve,
    maxRunUSD: acct.maxRunUSD,
    dataAvailable: signals.dataAvailable,
  });

  if (args.json) {
    console.log(JSON.stringify({
      mode: 'check',
      decision: v.decision,
      code: v.code,
      reason: v.reason,
      warn: !!v.warn,
      budget,
      todaySpend: round(acct.todaySpend),
      inFlightReserve: round(acct.inFlightReserve),
      maxRun: acct.maxRunUSD == null ? null : round(acct.maxRunUSD),
      forecastEndOfDay: round(acct.forecastEndOfDay),
    }, null, 2));
    return 0;
  }

  const tag = v.decision === 'pause' ? 'PAUSE' : 'ALLOW';
  console.log(`${tag} — quartermaster: ${v.reason}`);
  if (v.decision === 'pause') {
    // A clear, loud alert on a real budget breach (issue #148 scope 4). crows-nest
    // holds new dispatches and surfaces this reason; the foghorn can voice it.
    console.log('  ⚠ BUDGET ALERT — new dispatches should HOLD until spend drops below budget.');
  } else if (v.warn) {
    console.log('  ⚠ ' + v.reason);
  }
  return 0;
}

function round(v, dp = 2) { return isNum(v) ? Number(v.toFixed(dp)) : v; }

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
function usage() {
  console.error('usage: quartermaster.mjs report [--json] [--repo-root <dir>]');
  console.error('       quartermaster.mjs check  [--json] [--repo-root <dir>] [--per-run <usd>] [--per-day <usd>]');
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const root = args.repoRoot || process.cwd();
  const cmd = args._[0];
  try {
    if (cmd === 'report') return process.exit(runReport(root, args));
    if (cmd === 'check') return process.exit(runCheck(root, args));
    usage();
    process.exit(2);
  } catch (e) {
    // A governor must never crash the tick. On any unexpected error, degrade to a
    // clear allow+warn on stdout and exit 0 (never block the fleet on our own bug).
    if (cmd === 'check') {
      console.log('ALLOW — quartermaster: internal error, degrading to allow (never block the fleet)');
      console.error(`quartermaster: ${e && e.message ? e.message : e}`);
      process.exit(0);
    }
    console.error(`quartermaster: ${e && e.message ? e.message : e}`);
    process.exit(1);
  }
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) main();
