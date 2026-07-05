#!/usr/bin/env node
// Tests for consolidate-run-artifacts.mjs (issue #170) + the liveness-beat mainRepoRoot
// consolidation fix. Dependency-free (Node built-ins only), matching validate-skills and
// the other scripts/*.test.mjs. Run: node scripts/consolidate-run-artifacts.test.mjs

import { mkdtempSync, mkdirSync, existsSync, readFileSync, writeFileSync, rmSync } from 'fs';
import { spawnSync } from 'child_process';
import { fileURLToPath } from 'url';
import path from 'path';
import os from 'os';

import {
  consolidateKind, completeness, cmp,
} from './consolidate-run-artifacts.mjs';
import { outDirOf } from './liveness-beat.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CONSOLIDATE = path.join(HERE, 'consolidate-run-artifacts.mjs');
const LIVENESS = path.join(HERE, 'liveness-beat.mjs');

let passed = 0;
const failures = [];
function test(name, fn) {
  try { fn(); passed++; }
  catch (e) { failures.push(`${name}: ${e && e.stack ? e.stack : e.message}`); }
}
function assert(cond, msg) { if (!cond) throw new Error(msg || 'assertion failed'); }
function eq(a, b, msg) { if (a !== b) throw new Error(`${msg || 'not equal'}: ${a} !== ${b}`); }

function tmpDir() { return mkdtempSync(path.join(os.tmpdir(), 'armada-consolidate-')); }
const wj = (p, obj) => { mkdirSync(path.dirname(p), { recursive: true }); writeFileSync(p, JSON.stringify(obj, null, 2)); };
const rj = (p) => JSON.parse(readFileSync(p, 'utf8'));

// --- completeness ordering -------------------------------------------------
test('completeness: liveness terminal beats a non-terminal', () => {
  const term = completeness('liveness', { terminal: true, beatTs: 1, step: 1 });
  const live = completeness('liveness', { terminal: false, beatTs: 999, step: 99 });
  assert(cmp(term, live) > 0, 'terminal must win regardless of step/beat');
});

test('completeness: liveness higher beatTs wins among non-terminal', () => {
  const older = completeness('liveness', { terminal: false, beatTs: 100, step: 2 });
  const newer = completeness('liveness', { terminal: false, beatTs: 200, step: 1 });
  assert(cmp(newer, older) > 0, 'later beat wins');
});

test('completeness: costs final beats non-final', () => {
  const fin = completeness('costs', { final: true, updatedAt: '2020-01-01T00:00:00Z', totalCost: 0 });
  const acc = completeness('costs', { final: false, updatedAt: '2030-01-01T00:00:00Z', totalCost: 99 });
  assert(cmp(fin, acc) > 0, 'final must win over accruing');
});

// --- consolidateKind: copy when main lacks the file ------------------------
test('consolidateKind: worktree-only file is copied into main', () => {
  const wt = tmpDir(); const main = tmpDir();
  try {
    wj(path.join(wt, 'out', 'liveness', '55.json'), { run: '55', phase: 'implementing', beatTs: 10, step: 3 });
    const s = consolidateKind('liveness', wt, main, {});
    assert(s.copied.includes('55.json'), 'expected 55.json copied');
    assert(existsSync(path.join(main, 'out', 'liveness', '55.json')), 'main must now have the file');
  } finally { rmSync(wt, { recursive: true, force: true }); rmSync(main, { recursive: true, force: true }); }
});

// --- consolidateKind: main's more-complete copy is KEPT --------------------
test('consolidateKind: main terminal beat is NOT clobbered by a stale worktree beat', () => {
  const wt = tmpDir(); const main = tmpDir();
  try {
    // worktree has an in-flight beat; main has the crows-nest-emitted terminal beat.
    wj(path.join(wt, 'out', 'liveness', '55.json'), { run: '55', phase: 'implementing', terminal: false, beatTs: 500, step: 9 });
    wj(path.join(main, 'out', 'liveness', '55.json'), { run: '55', phase: 'done', terminal: true, beatTs: 100, step: 2 });
    const s = consolidateKind('liveness', wt, main, {});
    assert(s.keptMain.includes('55.json'), 'main terminal must be kept');
    assert(rj(path.join(main, 'out', 'liveness', '55.json')).terminal === true, 'main must stay terminal');
  } finally { rmSync(wt, { recursive: true, force: true }); rmSync(main, { recursive: true, force: true }); }
});

// --- consolidateKind: worktree's more-complete cost overwrites accruing main ---
test('consolidateKind: worktree final cost overwrites a main accruing cost', () => {
  const wt = tmpDir(); const main = tmpDir();
  try {
    wj(path.join(wt, 'out', 'costs', 'b.json'), { run: 'b', final: true, updatedAt: '2026-01-01T00:00:00Z', totalCost: 1.23 });
    wj(path.join(main, 'out', 'costs', 'b.json'), { run: 'b', final: false, updatedAt: '2025-01-01T00:00:00Z', totalCost: 0.1 });
    const s = consolidateKind('costs', wt, main, {});
    assert(s.copied.includes('b.json'), 'worktree final should win');
    eq(rj(path.join(main, 'out', 'costs', 'b.json')).totalCost, 1.23, 'main cost updated');
  } finally { rmSync(wt, { recursive: true, force: true }); rmSync(main, { recursive: true, force: true }); }
});

// --- consolidateKind: aggregate _runs.json only fills a gap -----------------
test('consolidateKind: _runs.json is copied only when absent, never clobbered', () => {
  const wt = tmpDir(); const main = tmpDir();
  try {
    wj(path.join(wt, 'out', 'costs', '_runs.json'), { schema: 1, runs: { 9: { issue: 9, branch: 'wt' } } });
    wj(path.join(main, 'out', 'costs', '_runs.json'), { schema: 1, runs: { 9: { issue: 9, branch: 'MAIN-authoritative' } } });
    const s = consolidateKind('costs', wt, main, {});
    assert(s.keptMain.includes('_runs.json'), 'main _runs.json must be kept');
    eq(rj(path.join(main, 'out', 'costs', '_runs.json')).runs['9'].branch, 'MAIN-authoritative', 'main map not clobbered');
  } finally { rmSync(wt, { recursive: true, force: true }); rmSync(main, { recursive: true, force: true }); }
});

// --- missing worktree dir is a clean no-op ---------------------------------
test('consolidateKind: absent worktree out dir → clean no-op', () => {
  const wt = tmpDir(); const main = tmpDir();
  try {
    const s = consolidateKind('liveness', wt, main, {});
    eq(s.copied.length, 0, 'nothing copied');
  } finally { rmSync(wt, { recursive: true, force: true }); rmSync(main, { recursive: true, force: true }); }
});

// --- liveness-beat mainRepoRoot: --out override still honoured --------------
test('liveness-beat outDirOf: explicit --out wins over mainRepoRoot', () => {
  const d = tmpDir();
  try { eq(outDirOf({ out: d }), path.join(d, 'out', 'liveness'), 'explicit --out must win'); }
  finally { rmSync(d, { recursive: true, force: true }); }
});

// --- end-to-end: a beat from a linked worktree lands in the MAIN repo -------
test('e2e: liveness beat from a linked worktree consolidates into the main repo', () => {
  const root = tmpDir();
  const mainRepo = path.join(root, 'main');
  const wt = path.join(root, 'wt');
  try {
    mkdirSync(mainRepo, { recursive: true });
    const git = (args, cwd) => spawnSync('git', args, { cwd, encoding: 'utf8' });
    if (git(['--version'], mainRepo).status !== 0) { passed++; return; } // git absent → skip cleanly
    git(['init', '-q', '-b', 'master'], mainRepo);
    git(['config', 'user.email', 't@t'], mainRepo);
    git(['config', 'user.name', 't'], mainRepo);
    writeFileSync(path.join(mainRepo, 'f.txt'), 'x');
    git(['add', '.'], mainRepo);
    git(['commit', '-qm', 'init'], mainRepo);
    // Create a linked worktree off master.
    const add = git(['worktree', 'add', '-q', '-b', 'run-77', wt, 'master'], mainRepo);
    if (add.status !== 0) { passed++; return; } // worktree unsupported → skip cleanly
    // Emit a beat with cwd INSIDE the worktree — it must land in the MAIN repo's out/.
    const r = spawnSync('node', [LIVENESS, 'beat', '--run', 'run-77', '--phase', 'implementing'], { cwd: wt, encoding: 'utf8' });
    assert(r.status === 0, `beat failed: ${r.stderr}`);
    const mainFile = path.join(mainRepo, 'out', 'liveness', 'run-77.json');
    const wtFile = path.join(wt, 'out', 'liveness', 'run-77.json');
    assert(existsSync(mainFile), 'beat MUST land in the MAIN repo out/liveness (survives reaping)');
    assert(!existsSync(wtFile), 'beat must NOT be stranded in the reaped-on-ship worktree');
    git(['worktree', 'remove', '--force', wt], mainRepo);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

// ---------------------------------------------------------------------------
if (failures.length) {
  console.error(`✗ ${failures.length} failing / ${passed} passing`);
  for (const f of failures) console.error(`  - ${f}`);
  process.exit(1);
}
console.log(`✓ consolidate-run-artifacts + liveness-beat consolidation: ${passed} test(s) passing.`);
