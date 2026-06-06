#!/usr/bin/env node
// ARMADA spyglass — synthetic fixture snapshots for the sea-trial harness.
//
// The live fleet only exhibits a few states at any moment; to exercise the
// renderer across the full visual range (calm, busy/choppy, storm-with-blocked,
// cartography on/off) we synthesise deterministic `fleet-state.json` snapshots
// that match the SAME schema `spyglass-snapshot.mjs` writes. These drive the
// repeatable visual-regression trial in `spyglass-trial.mjs`.
//
// READ-ONLY w.r.t. the fleet: this never touches GitHub or the repo — it only
// emits JSON to a scratch/output dir. It is a dev/test aid, not shipped into
// the rendered view.
//
// Run:
//   node spyglass-fixtures.mjs            # list the fixture names
//   node spyglass-fixtures.mjs <name>     # print one fixture's JSON to stdout
//   node spyglass-fixtures.mjs --all --out <dir>   # write every fixture as <name>.json

import { mkdirSync, writeFileSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const REPO = 'calumjs/ARMADA';
const SEED = 0x5f3759df; // a fixed, recognisable seed for stable coastlines

// Deterministic timestamps relative to a fixed "now" so age/throughput is stable.
const NOW = Date.UTC(2026, 5, 6, 12, 0, 0);
const ago = (ms) => new Date(NOW - ms).toISOString();
const H = 3600e3;
const D = 24 * H;

function issue(number, title, state, ageMs) {
  const map = {
    queued: { state: 'queued', zone: 'horizon', label: 'drifting' },
    underway: { state: 'underway', zone: 'horizon', label: 'set sail' },
    done: { state: 'done', zone: 'horizon', label: 'reached port' },
    blocked: { state: 'blocked', zone: 'horizon', label: 'blocked' },
  };
  return {
    number, title, author: 'calumjs',
    createdAt: ago(ageMs + 2 * D), updatedAt: ago(ageMs),
    url: `https://github.com/${REPO}/issues/${number}`,
    ship: map[state],
  };
}

function pr(number, title, state, ageMs, ci = 'green') {
  const map = {
    ready: { state: 'ready', zone: 'harbour', label: 'arrived in harbour' },
    reviewing: { state: 'reviewing', zone: 'harbour', label: 'at the docks' },
    merged: { state: 'merged', zone: 'harbour', label: 'docking' },
    shipped: { state: 'shipped', zone: 'harbour', label: 'safely arrived' },
    draft: { state: 'draft', zone: 'harbour', label: 'fitting out' },
    blocked: { state: 'blocked', zone: 'harbour', label: 'blocked' },
  };
  return {
    number, title, isDraft: state === 'draft', headRefName: `feat/${number}`,
    createdAt: ago(ageMs + 1 * D), updatedAt: ago(ageMs),
    url: `https://github.com/${REPO}/pull/${number}`,
    ci, ship: map[state],
  };
}

function tickFrom(issues, prs) {
  const dispatched = [];
  const held = [];
  for (const it of issues) {
    if (it.ship.state === 'queued') dispatched.push({ kind: 'issue', number: it.number, title: it.title, action: 'build' });
    else if (it.ship.state === 'blocked') held.push({ kind: 'issue', number: it.number, title: it.title, reason: 'blocked — needs a human' });
  }
  for (const p of prs) {
    if (p.ship.state === 'ready' && p.ci !== 'red') dispatched.push({ kind: 'pr', number: p.number, title: p.title, action: 'review' });
    else if (p.ship.state === 'ready' && p.ci === 'red') held.push({ kind: 'pr', number: p.number, title: p.title, reason: 'CI failing' });
    else if (p.ship.state === 'blocked') held.push({ kind: 'pr', number: p.number, title: p.title, reason: 'blocked — needs a human' });
  }
  const blockedCount =
    issues.filter((i) => i.ship.state === 'blocked').length +
    prs.filter((p) => p.ship.state === 'blocked').length;
  let weather = 'calm';
  if (blockedCount > 0) weather = 'storm';
  else if (dispatched.length > 0) weather = 'choppy';
  return {
    at: new Date(NOW).toISOString(), dispatched, held, blockedCount, weather,
    summary: `horizon ${issues.length} · harbour ${prs.length} · dispatch ${dispatched.length} · hold ${held.length} · blocked ${blockedCount}`,
  };
}

function throughputFrom(issues, prs) {
  const edges = [6 * H, 24 * H, 72 * H, 168 * H];
  const buckets = [0, 0, 0, 0, 0];
  const all = [...issues, ...prs];
  for (const u of all) {
    const age = NOW - Date.parse(u.updatedAt);
    let i = edges.findIndex((e) => age < e);
    if (i < 0) i = 4;
    buckets[i]++;
  }
  return {
    buckets, bucketLabels: ['<6h', '<24h', '<3d', '<7d', 'older'],
    horizon: issues.length, harbour: prs.length,
    blocked: issues.filter((i) => i.ship.state === 'blocked').length + prs.filter((p) => p.ship.state === 'blocked').length,
    tide: Math.min(1, all.length / 12),
  };
}

function snap(issues, prs, { cartography }) {
  return {
    schema: 2,
    generatedAt: new Date(NOW).toISOString(),
    repo: REPO, triggerLabel: 'armada', commissioned: true, ghOk: true,
    seed: SEED, degraded: null,
    cartography: cartography
      ? { present: true, files: ['heuristics.json', 'chart.json'], note: '2 cartography file(s)' }
      : { present: false, note: 'no .armada/cartography/ — layer off' },
    issues, prs,
    tick: tickFrom(issues, prs),
    throughput: throughputFrom(issues, prs),
  };
}

// --- The canonical fixtures -------------------------------------------------
const FIXTURES = {
  // calm / single unit — quietest possible non-empty sea
  calm: () => snap(
    [issue(54, 'spyglass: research-grounded visual upgrade', 'underway', 3 * H)],
    [],
    { cartography: false },
  ),

  // busy / choppy — several issues and PRs in flight, work dispatching, no block
  busy: () => snap(
    [
      issue(54, 'spyglass: research-grounded visual upgrade', 'underway', 2 * H),
      issue(60, 'crows-nest: smarter conflict graph', 'queued', 1 * H),
      issue(61, 'muster: parallel review lenses', 'queued', 30 * 60e3),
      issue(58, 'logbook: per-PR narrated walkthrough', 'done', 5 * H),
    ],
    [
      pr(55, 'shipwright: stacked PR series support', 'ready', 1 * H),
      pr(56, 'cartographer: learned heuristics', 'reviewing', 4 * H),
      pr(57, 'crows-nest: ship’s bell hook', 'merged', 8 * H),
    ],
    { cartography: false },
  ),

  // storm / blocked — at least one blocked unit ⇒ storm weather (rain+lightning)
  storm: () => snap(
    [
      issue(54, 'spyglass: visual upgrade', 'underway', 2 * H),
      issue(62, 'commission: detect monorepo roots', 'blocked', 6 * H),
      issue(63, 'charter: dedupe against open issues', 'queued', 45 * 60e3),
    ],
    [
      pr(64, 'shipwright: rebase mode', 'reviewing', 3 * H),
      pr(65, 'merge-gate: required-checks parsing', 'blocked', 10 * H, 'red'),
    ],
    { cartography: false },
  ),

  // cartography ON — same busy state, chart layer present
  cartography: () => snap(
    [
      issue(54, 'spyglass: research-grounded visual upgrade', 'underway', 2 * H),
      issue(60, 'crows-nest: smarter conflict graph', 'queued', 1 * H),
      issue(58, 'logbook: walkthrough', 'done', 5 * H),
    ],
    [
      pr(55, 'shipwright: stacked PR series', 'ready', 1 * H),
      pr(56, 'cartographer: learned heuristics', 'reviewing', 4 * H),
    ],
    { cartography: true },
  ),

  // narrow viewport content — same as busy; the trial drives the small size
  narrow: () => snap(
    [
      issue(54, 'spyglass: visual upgrade', 'underway', 2 * H),
      issue(60, 'crows-nest: conflict graph', 'queued', 1 * H),
    ],
    [pr(55, 'shipwright: stacked PRs', 'ready', 1 * H)],
    { cartography: true },
  ),

  // empty sea — no armed units (degrades to calm, message shown)
  empty: () => snap([], [], { cartography: false }),
};

// --- CLI --------------------------------------------------------------------
export { FIXTURES };

const _isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

function main() {
  const argv = process.argv.slice(2);
  const all = argv.includes('--all');
  const outIdx = argv.indexOf('--out');
  const outDir = outIdx >= 0 ? argv[outIdx + 1] : null;

  if (all) {
    if (!outDir) { console.error('--all requires --out <dir>'); process.exit(1); }
    mkdirSync(outDir, { recursive: true });
    for (const [name, fn] of Object.entries(FIXTURES)) {
      writeFileSync(path.join(outDir, `${name}.json`), JSON.stringify(fn(), null, 2));
      console.log(`fixture ${name} → ${path.join(outDir, name + '.json')}`);
    }
    return;
  }

  const name = argv.find((a) => !a.startsWith('--'));
  if (!name) { console.log('fixtures: ' + Object.keys(FIXTURES).join(', ')); return; }
  if (!FIXTURES[name]) { console.error(`unknown fixture: ${name}`); process.exit(1); }
  console.log(JSON.stringify(FIXTURES[name](), null, 2));
}

if (_isMain) main();
