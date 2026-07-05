#!/usr/bin/env node
// ARMADA fleet — consolidate a run's side-channel artifacts out of a build worktree
// into the MAIN repo BEFORE the worktree is reaped (issue #170).
//
// WHY. crows-nest dispatches each build into an isolated worktree and REAPS that
// worktree on merge (crows-nest §4.5 "Branch cleanup on merge"). The spyglass
// dashboard reads the run's cost (`out/costs/<run>.json`) and progress/liveness
// (`out/liveness/<run>.json`) from the MAIN repo's `out/`. A subagent that emitted
// either file with its cwd INSIDE the worktree wrote it THERE — where the dashboard
// never looks and which vanishes when the worktree is deleted. So the observability
// data was reliably lost (#170: an in-flight build's worktree had the only copy, and
// reaping destroyed it).
//
// Both producers now consolidate into the main repo directly (spyglass-cost-postmortem
// mainRepoRoot + liveness-beat mainRepoRoot), so in the healthy path a beat/cost never
// lands in the worktree at all. But that resolution can DEGRADE — `git rev-parse` may
// fail inside a freshly-created worktree, or a subagent may pass an explicit
// `--out=<worktree>` — and then the file DOES land in the worktree. This helper is the
// belt-and-suspenders: run it at the reconcile point, just BEFORE reaping the worktree,
// to drain any worktree-local `out/costs`/`out/liveness` into the main repo so nothing
// the run recorded is lost.
//
// It is a MERGE, not a blind overwrite: the main repo already holds crows-nest's own
// authoritatively-recorded cost + the terminal beat it emitted on the run's behalf, and
// those must win over a stale worktree copy. So each file is copied only when the main
// repo LACKS it, or when the worktree copy is strictly MORE COMPLETE (a terminal beat /
// a `final` cost / a later timestamp / more accumulated work). The crows-nest-owned
// aggregate map/schedule files (`_runs.json`, `_schedule.json`) are copied only when
// absent in main — never clobbered.
//
// Dependency-free (Node built-ins only), to match validate-skills. Best-effort and
// side-channel: it NEVER throws for the caller (crows-nest §8g discipline) — a missing
// worktree, an unreadable file, or a copy error is logged and skipped, and reaping
// proceeds regardless.
//
// Usage:
//   node consolidate-run-artifacts.mjs --worktree <path> [--main <mainRepoRoot>]
//                                       [--kinds costs,liveness] [--quiet]
//   node consolidate-run-artifacts.mjs --check

import { readFileSync, existsSync, mkdirSync, writeFileSync, readdirSync, copyFileSync } from 'fs';
import { execFileSync } from 'child_process';
import path from 'path';
import { fileURLToPath } from 'url';

const DEFAULT_KINDS = ['costs', 'liveness'];
// crows-nest-owned aggregate files under out/costs — authoritative in the main repo;
// only ever copied into main when ABSENT there, never overwritten from a worktree.
const AGGREGATE_ONLY_IF_ABSENT = new Set(['_runs.json', '_schedule.json']);

function parseArgs(argv) {
  const args = { _: [] };
  const valued = new Set(['--worktree', '--main', '--kinds']);
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--check') { args.check = true; continue; }
    if (a === '--quiet') { args.quiet = true; continue; }
    if (valued.has(a)) {
      const next = argv[i + 1];
      const v = (next !== undefined && !next.startsWith('--')) ? argv[++i] : undefined;
      args[a.slice(2)] = v;
    } else if (a.startsWith('--')) {
      args[a.slice(2)] = true;
    } else {
      args._.push(a);
    }
  }
  return args;
}

// Resolve the MAIN repo root from wherever we're invoked (mirrors the producers). From a
// linked worktree `git rev-parse --git-common-dir` still points at the main repo's shared
// `.git`, whose parent is the main worktree root. Degrades to cwd; never throws.
function mainRepoRoot() {
  try {
    const common = execFileSync('git', ['rev-parse', '--path-format=absolute', '--git-common-dir'], {
      encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    if (!common) return process.cwd();
    return path.dirname(common) || process.cwd();
  } catch {
    return process.cwd();
  }
}

function readJson(file) {
  try { return JSON.parse(readFileSync(file, 'utf8')); } catch { return null; }
}

const numOr = (v, d = 0) => (Number.isFinite(Number(v)) && v != null && v !== '' ? Number(v) : d);
const tsOf = (iso) => { const t = Date.parse(iso || ''); return Number.isFinite(t) ? t : 0; };

// A COMPLETENESS score for a run artifact — compared lexicographically, higher wins. The
// ordering encodes "more finished / fresher / more work recorded" so a terminal/final or
// later-written file always beats a stale one, and neither ever loses real recorded work.
function completeness(kind, doc) {
  if (!doc || typeof doc !== 'object') return [-1];
  if (kind === 'liveness') {
    return [doc.terminal ? 1 : 0, numOr(doc.beatTs), numOr(doc.step), numOr(doc.lifecycle, 1)];
  }
  // costs
  return [doc.final ? 1 : 0, tsOf(doc.updatedAt), numOr(doc.totalCost, -1)];
}

// Lexicographic array compare: >0 when a is more complete than b.
function cmp(a, b) {
  const n = Math.max(a.length, b.length);
  for (let i = 0; i < n; i++) {
    const x = a[i] ?? 0; const y = b[i] ?? 0;
    if (x > y) return 1;
    if (x < y) return -1;
  }
  return 0;
}

// Consolidate ONE kind (costs|liveness). Returns a per-kind summary.
function consolidateKind(kind, worktreeDir, mainDir, out) {
  const srcDir = path.join(worktreeDir, 'out', kind);
  const dstDir = path.join(mainDir, 'out', kind);
  const summary = { kind, copied: [], keptMain: [], skipped: [] };
  if (!existsSync(srcDir)) return summary; // nothing in the worktree → nothing to drain
  let entries = [];
  try { entries = readdirSync(srcDir).filter((f) => f.endsWith('.json')); }
  catch { return summary; }
  for (const f of entries) {
    const src = path.join(srcDir, f);
    const dst = path.join(dstDir, f);
    try {
      const mainExists = existsSync(dst);
      // crows-nest-owned aggregates: only fill a gap, never overwrite the main copy.
      if (AGGREGATE_ONLY_IF_ABSENT.has(f)) {
        if (!mainExists) { mkdirSync(dstDir, { recursive: true }); copyFileSync(src, dst); summary.copied.push(f); }
        else summary.keptMain.push(f);
        continue;
      }
      if (!mainExists) {
        mkdirSync(dstDir, { recursive: true });
        copyFileSync(src, dst);
        summary.copied.push(f);
        continue;
      }
      // Both present → keep whichever is more complete.
      const srcDoc = readJson(src);
      const mainDoc = readJson(dst);
      if (cmp(completeness(kind, srcDoc), completeness(kind, mainDoc)) > 0) {
        copyFileSync(src, dst);
        summary.copied.push(f);
      } else {
        summary.keptMain.push(f);
      }
    } catch (e) {
      // Best-effort: a single bad file never aborts the drain.
      summary.skipped.push(`${f} (${e && e.message ? e.message : e})`);
    }
  }
  return summary;
}

function consolidate(args) {
  const worktree = args.worktree;
  if (!worktree) throw new Error('consolidate needs --worktree <path>');
  const mainDir = args.main || mainRepoRoot();
  const kinds = (args.kinds ? String(args.kinds).split(',') : DEFAULT_KINDS)
    .map((s) => s.trim()).filter(Boolean);
  // A no-op when the worktree path doesn't exist (already reaped, or never created) —
  // that is a normal, healthy case, not an error.
  const results = [];
  for (const kind of kinds) results.push(consolidateKind(kind, worktree, mainDir, args));
  const copied = results.reduce((a, r) => a + r.copied.length, 0);
  const kept = results.reduce((a, r) => a + r.keptMain.length, 0);
  if (!args.quiet) {
    const parts = results
      .filter((r) => r.copied.length || r.keptMain.length || r.skipped.length)
      .map((r) => `${r.kind}: +${r.copied.length}${r.keptMain.length ? ` (kept ${r.keptMain.length})` : ''}${r.skipped.length ? ` skip ${r.skipped.length}` : ''}`);
    console.log(`consolidate: ${worktree} → ${mainDir} · ${copied} copied${kept ? `, ${kept} main-kept` : ''}${parts.length ? ' · ' + parts.join(' · ') : ' · nothing to drain'}`);
  }
  return { mainDir, results, copied, kept };
}

function check() {
  console.log('consolidate-run-artifacts doctor — writes nothing');
  console.log(`  main repo root (from cwd): ${mainRepoRoot()}`);
  console.log(`  kinds drained by default : ${DEFAULT_KINDS.join(', ')}`);
  console.log(`  copy-only-if-absent files: ${[...AGGREGATE_ONLY_IF_ABSENT].join(', ')}`);
  console.log('  merge rule: copy worktree→main when main LACKS the file, or the worktree copy is');
  console.log('              strictly MORE COMPLETE (terminal/final > later-written > more work).');
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  try {
    if (args.check || args._[0] === 'check') return check();
    consolidate(args);
  } catch (e) {
    // Side-channel by design (crows-nest §8g): never fatal to the caller — print and
    // exit non-zero so the tick can log-and-ignore, but reaping proceeds regardless.
    console.error(`consolidate: ${e && e.message ? e.message : e}`);
    process.exitCode = 1;
  }
}

const isEntry = process.argv[1]
  && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));
if (isEntry) main();

export { consolidate, consolidateKind, completeness, cmp, mainRepoRoot };
