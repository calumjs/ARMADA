#!/usr/bin/env node
// ARMADA fleet — up-front run ESTIMATE (agent-side producer + reader).
//
// WHY (#212). The fleet BUILDS but never PREDICTS, so there is no calibration and no
// accountability: nobody can ask "how close was the estimate?" because there is no
// estimate. This records a best-effort PREDICTION at the start of a run — an estimated
// COST (USD) and estimated TIME-TO-SHIP (seconds) — made AFTER planning but BEFORE the
// implement step, so it is a genuine forecast and NOT backfilled from the result. The
// dashboard later grades estimate → actual per shipped run (spyglass-run-snapshot.mjs
// reads out/estimates/<run>.json; the app renders the delta + a calibration rollup).
//
// SIDE-CHANNEL DISCIPLINE (mirrors liveness-beat.mjs §0a). It writes ONLY under
// `out/estimates/<run>.json` (gitignored), never the tracked tree — the same producer
// pattern as the liveness beat + cost post-mortem. It is best-effort: if the script is
// missing or the write fails the caller swallows it and carries on — an estimate write
// must NEVER block, fail, or delay the build. It is a courtesy prediction, not a step
// the build depends on.
//
// REAP-SAFE (mirrors liveness-beat.mjs mainRepoRoot). shipwright builds in an isolated
// worktree that crows-nest reaps on merge, but the read-only dashboard reads the MAIN
// repo's out/estimates/. So the producer resolves the main repo root itself via
// `git rev-parse --git-common-dir` (which from a linked worktree points at the shared
// main .git) and consolidates every run's estimate into the main repo's out/estimates/,
// where it outlives the worktree reap. An explicit --out always wins (tests / override).
//
// HONEST-PREDICTION GUARANTEE. `record` writes ONLY the numbers you pass in — it derives
// nothing from any actual/result signal. The estimate is stamped with `at` (when it was
// predicted) so a reader can confirm it predates the ship. Re-recording overwrites (a
// planning revision is still an up-front prediction); the schema is deliberately minimal.
//
// Subcommands:
//   record --run <branch|issue> --cost <usd> --duration <sec> [--note <t>] [--out <dir>]
//       Write/overwrite the up-front prediction for a run: estimated cost (USD) and
//       estimated time-to-ship (seconds), stamped `at` now. Either number may be omitted
//       (→ null, that dimension ungraded). Cheap, synchronous, never throws fatally.
//
//   read  --run <branch|issue> [--out <dir>]
//       Reader side. Print the run's estimate JSON (stdout), or `null` when absent /
//       corrupt. Writes NOTHING. Used by tests + operators; the dashboard reads the file
//       directly (spyglass-run-snapshot.mjs readEstimate).
//
//   check | --check
//       Doctor: print the resolved out dir + the schema. Writes NOTHING.

import { readFileSync, existsSync, mkdirSync, writeFileSync } from 'fs';
import { execFileSync } from 'child_process';
import path from 'path';
import { fileURLToPath } from 'url';

const SCHEMA = 1;

// ---------------------------------------------------------------------------
// Arg parsing (tolerant hand-rolled; a valued flag never swallows a following --flag).
// Mirrors liveness-beat.mjs so the two producers parse identically.
// ---------------------------------------------------------------------------
function parseArgs(argv) {
  const args = { _: [] };
  const valued = new Set(['--run', '--cost', '--duration', '--note', '--out']);
  const known = new Set([...valued, '--check']);
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--check') { args.check = true; continue; }
    if (valued.has(a)) {
      const next = argv[i + 1];
      const v = (next !== undefined && !known.has(next)) ? argv[++i] : undefined;
      const key = a.slice(2).replace(/-([a-z])/g, (_, c) => c.toUpperCase());
      args[key] = v;
    } else if (a.startsWith('--')) {
      args[a.slice(2)] = true;
    } else {
      args._.push(a);
    }
  }
  return args;
}

// Resolve the CANONICAL repo root — the MAIN worktree, not whichever isolated build
// worktree this producer runs in (reap-safe, identical to liveness-beat.mjs). Read-only
// w.r.t. git; degrades to cwd on any failure (not a git repo, bare, git absent).
function mainRepoRoot() {
  try {
    const common = execFileSync('git', ['rev-parse', '--path-format=absolute', '--git-common-dir'], {
      encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    if (!common) return process.cwd();
    const root = path.dirname(common);
    return root || process.cwd();
  } catch {
    return process.cwd();
  }
}

// The estimates data dir. An explicit --out always wins (tests / an operator override);
// absent it, consolidate into the MAIN repo's out/estimates/ so an estimate emitted from
// inside a build worktree still lands where the dashboard reads and survives the reap.
function outDirOf(args) {
  const base = args.out || mainRepoRoot();
  return path.join(base, 'out', 'estimates');
}

// A non-negative finite number, or null. An estimate can't be negative; a blank / junk /
// negative value degrades to null (that dimension is simply ungraded on the dashboard).
const numOrNull = (v) => {
  if (v == null || v === '') return null;
  const n = Number(v);
  return (Number.isFinite(n) && n >= 0) ? n : null;
};
const fileFor = (dir, run) => path.join(dir, `${String(run).replace(/[\\/]/g, '-')}.json`);

// ---------------------------------------------------------------------------
// record — write/overwrite the up-front prediction.
// ---------------------------------------------------------------------------
function record(args) {
  const run = args.run;
  if (!run) throw new Error('record needs --run <branch|issue>');
  const cost = numOrNull(args.cost);
  const durationSec = numOrNull(args.duration);
  const dir = outDirOf(args);
  const file = fileFor(dir, run);
  const doc = {
    schema: SCHEMA,
    run: String(run),
    cost,                 // estimated USD (null → cost ungraded)
    durationSec,          // estimated time-to-ship in seconds (null → time ungraded)
    at: new Date().toISOString(),   // when the prediction was made (before the build)
    note: args.note != null ? String(args.note) : null,
  };
  mkdirSync(dir, { recursive: true });
  writeFileSync(file, JSON.stringify(doc, null, 2));
  const rel = path.relative(process.cwd(), file).replace(/\\/g, '/');
  const costStr = cost != null ? `$${cost.toFixed(2)}` : '—';
  const durStr = durationSec != null ? `${Math.round(durationSec)}s` : '—';
  console.log(`estimate: ${rel} · cost ${costStr} · time ${durStr}`);
  return file;
}

// ---------------------------------------------------------------------------
// read — reader side; print the estimate (or null). Writes nothing.
// Returns the parsed doc (or null) for programmatic callers / tests.
// ---------------------------------------------------------------------------
function readEstimate(args) {
  const run = args.run;
  if (!run) throw new Error('read needs --run <branch|issue>');
  const dir = outDirOf(args);
  const file = fileFor(dir, run);
  if (!existsSync(file)) { console.log('null'); return null; }
  let doc = null;
  try { doc = JSON.parse(readFileSync(file, 'utf8')); }
  catch { console.log('null'); return null; }
  if (!doc || typeof doc !== 'object') { console.log('null'); return null; }
  // Normalise the two graded fields so a corrupt/partial file reads cleanly.
  const out = {
    schema: doc.schema ?? SCHEMA,
    run: doc.run != null ? String(doc.run) : String(run),
    cost: numOrNull(doc.cost),
    durationSec: numOrNull(doc.durationSec),
    at: doc.at != null ? String(doc.at) : null,
    note: doc.note != null ? String(doc.note) : null,
  };
  console.log(JSON.stringify(out, null, 2));
  return out;
}

// ---------------------------------------------------------------------------
// check — doctor (writes nothing).
// ---------------------------------------------------------------------------
function check(args) {
  console.log('estimate doctor — writes nothing');
  console.log(`  out dir: ${outDirOf(args)}`);
  console.log(`  schema : ${SCHEMA}  { schema, run, cost, durationSec, at, note }`);
  console.log('  record --run <n> --cost <usd> --duration <sec>  (best-effort, side-channel, up-front)');
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
function main() {
  const argv = process.argv.slice(2);
  const args = parseArgs(argv);
  const cmd = args._[0];
  try {
    if (args.check || cmd === 'check') return check(args);
    if (cmd === 'record') return record(args);
    if (cmd === 'read') return readEstimate(args);
    console.error('usage: estimate.mjs record --run <branch|issue> --cost <usd> --duration <sec> [--note <t>]');
    console.error('       estimate.mjs read --run <branch|issue>');
    console.error('       estimate.mjs check');
    process.exitCode = 2;
  } catch (e) {
    // Side-channel by design: never fatal to the caller — print and exit non-zero so the
    // agent can log-and-ignore, but do not throw.
    console.error(`estimate: ${e && e.message ? e.message : e}`);
    process.exitCode = 1;
  }
}

const isEntry = process.argv[1]
  && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));
if (isEntry) main();

// Exported for consumers + unit tests. Importing never triggers main() (see isEntry).
export { SCHEMA, mainRepoRoot, outDirOf, numOrNull, fileFor };
