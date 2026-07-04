#!/usr/bin/env node
// ARMADA spyglass — synthetic fixture for the per-RUN operations dashboard.
//
// The sea-chart fixtures in spyglass-fixtures.mjs are `fleet-state.json` (schema 2)
// snapshots for the coastline view. The per-run dashboard (spyglass-run-app.html)
// instead consumes a `run-state.json` snapshot written by spyglass-run-snapshot.mjs
// (schema 3). The live fleet only exhibits a couple of run states at any moment, so
// to demo/test the run dashboard across its FULL range — every pipeline stage, a
// blocked run, a recent-voyages lane, live cost breakdowns and a done-video — we
// synthesise ONE deterministic schema-3 snapshot that matches the exact shape the
// snapshot script writes (issue #103).
//
// READ-ONLY w.r.t. the fleet: this never touches GitHub or the repo — it only emits
// JSON. It is a dev/test aid, not shipped into the rendered view. A materialised copy
// is committed at scripts/fixtures/run-state.json so the dashboard can be pointed at
// it with no server and no `gh`.
//
// Run:
//   node spyglass-run-fixtures.mjs                 # print the run-state fixture JSON
//   node spyglass-run-fixtures.mjs --out <dir>     # write <dir>/run-state.json
//   node spyglass-run-fixtures.mjs --write         # (re)write scripts/fixtures/run-state.json

import { mkdirSync, writeFileSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const REPO = 'calumjs/ARMADA';

// The genuine ARMADA voyage stages + captions — kept in lockstep with
// spyglass-run-snapshot.mjs (STAGES / STAGE_CAPTIONS / GROUPS, schema 3).
const STAGES = [
  'Queued', 'Building', 'PR opened', 'In review', 'Awaiting merge', 'Merged', 'Shipped',
];
const STAGE_CAPTIONS = [
  'armed & waiting for the lookout',
  'shipwright: research → plan → implement → validate',
  'branch pushed, PR open',
  'muster: 2-lens review → consolidate → address',
  'green & approved — at the merge gate',
  'gated merge landed',
  'closed; logbook walkthrough + cartography',
];
const GROUPS = ['queued', 'building', 'reviewing', 'awaiting-merge', 'done', 'blocked'];

// Deterministic timestamps relative to a fixed "now" so ages/throughput are stable.
const NOW = Date.UTC(2026, 6, 4, 12, 0, 0);
const ago = (ms) => new Date(NOW - ms).toISOString();
const H = 3600e3;
const D = 24 * H;

const unitUrl = (kind, n) => `https://github.com/${REPO}/${kind === 'pr' ? 'pull' : 'issues'}/${n}`;

// A per-model cost breakdown in the shape normalizeCost() emits (schema 3).
function cost({ totalCost, models, sessions = 1, subagents = 0, codex = 0 }) {
  return {
    present: true,
    pointer: 'out/costs/<branch>.json',
    models,
    sessions,
    subagents,
    codex,
    matchMode: 'branch',
    unpriced: [],
    totalCost,
    updatedAt: ago(20 * 60e3),
  };
}

function mk(o) {
  const {
    issueNumber = null, prNumber = null, title, branch = null, activeIndex, status,
    blocked = false, terminal = false, group, ci = null, worktree = null,
    cost: c = null, doneVideo = null, recent = false, outcome = null,
    startedAt, completedAt = null, mergeOid = null,
  } = o;
  return {
    issueNumber,
    prNumber,
    title,
    issueUrl: issueNumber != null ? unitUrl('issue', issueNumber) : null,
    prUrl: prNumber != null ? unitUrl('pr', prNumber) : null,
    branch,
    worktree,
    folder: worktree,
    startedAt,
    ci,
    stages: STAGES,
    stageCaptions: STAGE_CAPTIONS,
    activeIndex,
    status,
    blocked,
    terminal,
    group,
    doneVideo,
    cost: c || { present: false, pointer: null },
    recent,
    outcome,
    completedAt,
    mergeCommitOid: mergeOid,
    mergeCommitUrl: mergeOid ? `https://github.com/${REPO}/commit/${mergeOid}` : null,
  };
}

// In-flight runs — one per pipeline group, plus a blocked overlay, so the dashboard
// renders every state at once.
function inFlightRuns() {
  return [
    mk({
      issueNumber: 130, title: 'commission: detect pnpm workspaces', branch: null,
      activeIndex: 0, status: 'Queued', group: 'queued', startedAt: ago(40 * 60e3),
    }),
    mk({
      issueNumber: 128, title: 'logbook: system-browser capture backend',
      branch: '128-logbook-system-browser', worktree: 'C:/DataCalumSimpson/128-logbook-system-browser',
      activeIndex: 1, status: 'Building', group: 'building', startedAt: ago(3 * H),
      cost: cost({
        totalCost: 4.12,
        models: [{ model: 'claude-opus-4-8', in: 182000, out: 39000, cacheRead: 1240000, cacheWrite: 96000, cost: 4.12 }],
        sessions: 1, subagents: 2,
      }),
    }),
    mk({
      issueNumber: 124, prNumber: 125, title: 'muster: flag unscoped process kills',
      branch: '124-muster-scoped-kills', ci: 'green',
      worktree: 'C:/DataCalumSimpson/124-muster-scoped-kills',
      activeIndex: 3, status: 'In review', group: 'reviewing', startedAt: ago(6 * H),
      cost: cost({
        totalCost: 6.87,
        models: [
          { model: 'claude-opus-4-8', in: 240000, out: 51000, cacheRead: 2100000, cacheWrite: 130000, cost: 5.91 },
          { model: 'claude-haiku-4-5', in: 88000, out: 12000, cacheRead: 410000, cacheWrite: 0, cost: 0.96 },
        ],
        sessions: 2, subagents: 3, codex: 1,
      }),
    }),
    mk({
      issueNumber: 121, prNumber: 122, title: 'crows-nest: bound rebase rounds',
      branch: '121-crows-nest-rebase-cap', ci: 'green',
      worktree: 'C:/DataCalumSimpson/121-crows-nest-rebase-cap',
      activeIndex: 4, status: 'Awaiting merge', group: 'awaiting-merge', startedAt: ago(9 * H),
      cost: cost({
        totalCost: 5.03,
        models: [{ model: 'claude-opus-4-8', in: 205000, out: 44000, cacheRead: 1680000, cacheWrite: 110000, cost: 5.03 }],
        sessions: 2, subagents: 2,
      }),
    }),
    mk({
      issueNumber: 118, prNumber: 119, title: 'foghorn: cache TTS by content hash',
      branch: '118-foghorn-tts-cache', ci: 'red',
      worktree: 'C:/DataCalumSimpson/118-foghorn-tts-cache',
      activeIndex: 1, status: 'Blocked', blocked: true, group: 'blocked', startedAt: ago(11 * H),
      cost: cost({
        totalCost: 3.44,
        models: [{ model: 'claude-opus-4-8', in: 150000, out: 33000, cacheRead: 980000, cacheWrite: 72000, cost: 3.44 }],
        sessions: 1, subagents: 1,
      }),
    }),
  ];
}

// Recent voyages — a bounded lane of runs that already merged/shipped, so a run
// stays visible after it lands. One carries a done-video (logbook release asset).
function recentRunsList() {
  return [
    mk({
      issueNumber: 114, prNumber: 117, title: 'spyglass: auto-reload the run dashboard',
      branch: '114-spyglass-autoreload', ci: 'green', recent: true,
      activeIndex: 6, status: 'Shipped', terminal: true, outcome: 'Shipped', group: 'done',
      startedAt: ago(2 * D), completedAt: ago(20 * H), mergeOid: 'e78fcba1122334455',
      doneVideo: {
        name: 'walkthrough-pr-117.mp4',
        url: `https://github.com/${REPO}/releases/download/logbook-117/walkthrough-pr-117.mp4`,
        updatedAt: ago(19 * H),
      },
      cost: cost({
        totalCost: 7.21,
        models: [{ model: 'claude-opus-4-8', in: 260000, out: 58000, cacheRead: 2400000, cacheWrite: 140000, cost: 7.21 }],
        sessions: 3, subagents: 4,
      }),
    }),
    mk({
      issueNumber: 113, prNumber: 116, title: 'spyglass: keep merged/shipped runs on the dashboard',
      branch: '113-recent-voyages', ci: 'green', recent: true,
      activeIndex: 5, status: 'Merged', terminal: true, outcome: 'Merged', group: 'done',
      startedAt: ago(3 * D), completedAt: ago(30 * H), mergeOid: '8bd3409aabbccddee',
      cost: cost({
        totalCost: 5.66,
        models: [{ model: 'claude-opus-4-8', in: 210000, out: 47000, cacheRead: 1900000, cacheWrite: 115000, cost: 5.66 }],
        sessions: 2, subagents: 3,
      }),
    }),
  ];
}

function runStateFixture() {
  const runs = inFlightRuns();
  const recentRuns = recentRunsList();

  const blockedCount = runs.filter((r) => r.blocked).length;
  const rollup = { inFlight: runs.length, totalCost: 0, costKnown: false };
  for (const g of GROUPS) rollup[g] = 0;
  for (const r of runs) {
    if (rollup[r.group] != null) rollup[r.group] += 1;
    const tc = r.cost && r.cost.present ? r.cost.totalCost : null;
    if (typeof tc === 'number' && Number.isFinite(tc)) { rollup.totalCost += tc; rollup.costKnown = true; }
  }
  rollup.recent = recentRuns.length;
  rollup.shippedToday = recentRuns.filter((r) => !r.blocked).length;

  return {
    schema: 3,
    appVersion: 'fixture000000',
    generatedAt: new Date(NOW).toISOString(),
    repo: REPO,
    triggerLabel: 'armada',
    commissioned: true,
    ghOk: true,
    stageNames: STAGES,
    stageCaptions: STAGE_CAPTIONS,
    groupNames: GROUPS,
    degraded: null,
    runs,
    recentRuns,
    recentWindow: { hours: 24, cap: 12 },
    rollup,
    summary: `runs ${runs.length} · blocked ${blockedCount} · recent ${recentRuns.length}`,
  };
}

export { runStateFixture };

const _isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

function main() {
  const argv = process.argv.slice(2);
  const json = JSON.stringify(runStateFixture(), null, 2);

  if (argv.includes('--write')) {
    const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures');
    mkdirSync(dir, { recursive: true });
    const file = path.join(dir, 'run-state.json');
    writeFileSync(file, json + '\n');
    console.log(`run-state fixture → ${file}`);
    return;
  }
  const outIdx = argv.indexOf('--out');
  if (outIdx >= 0) {
    const outDir = argv[outIdx + 1];
    if (!outDir) { console.error('--out requires a <dir>'); process.exit(1); }
    mkdirSync(outDir, { recursive: true });
    const file = path.join(outDir, 'run-state.json');
    writeFileSync(file, json + '\n');
    console.log(`run-state fixture → ${file}`);
    return;
  }
  console.log(json);
}

if (_isMain) main();
