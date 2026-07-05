#!/usr/bin/env node
// ARMADA spyglass — per-run operations dashboard (data plumbing).
//
// Companion mode to `spyglass` (the sea-chart). Where spyglass renders the WHOLE
// fleet as an animated chart, this renders each IN-FLIGHT run as a focused voyage
// card: ARMADA's REAL pipeline (the armada:* label state machine), the run's
// worktree/branch/folder metadata, the logbook "done video", and a per-model cost
// table with REAL usage numbers.
//
// It ALSO keeps recently MERGED/SHIPPED (and blocked) runs on the board — a bounded
// "recent voyages" harbour of completed voyages — so a run doesn't vanish the moment
// it merges/ships. In addition to the open/in-flight set it fetches today, it scans a
// BOUNDED recent window of recently-closed/merged issues & PRs (a configurable cap
// AND/OR time window) and renders each as a terminal run with its accurate outcome
// (Merged / Shipped / Blocked), merge-commit link, and final cost. (Issue #113.)
//
// The stages are ARMADA's genuine, OBSERVABLE states — NOT the inspiration mock's
// invented list. Every stage is derivable from labels + PR/CI/review state:
//
//   Queued (armada) → Building (armada:underway) → PR opened (armada:done / a
//   draft PR / a ready-but-unclaimed PR) → In review (armada:reviewing; shows
//   "Addressing" on a change-request round) → Awaiting merge (ready, approved,
//   not merged) → Merged (armada:merged) → Shipped (armada:shipped), with
//   Blocked (armada:blocked) as an exception overlay.
//
// The voyage metaphor (SKILL §6 + the app): harbour (Queued) → open sea (Building,
// PR opened, In review, Awaiting merge) → port (Merged, Shipped). See SKILL.md §6
// for the exact label→stage mapping — kept in lockstep with stageForIssue /
// stageForPr / groupForStage below.
//
// It is READ-ONLY with respect to the fleet, exactly like spyglass/crows-nest:
//   * GitHub reads only — `gh repo view`, `gh issue list` (open AND recently
//     `--state closed`), `gh pr list` (open AND recently `--state merged`/`closed`),
//     and GET-only `gh api .../releases`. Every `gh` verb is a read — NEVER a write
//     (no label/comment/merge/close, no `gh api` POST/PATCH/DELETE). The recent-window
//     scan (#113) adds only more READ list queries, never a write.
//   * Local reads only — `git worktree list` (to resolve a run's worktree path),
//     `out/costs/_runs.json` (the crows-nest-written run→(branch,worktree) map, so
//     an in-flight run's branch/worktree/folder surface BEFORE a PR exists), and
//     `out/costs/<run>.json` (the per-model cost post-mortem, CONSUMED when
//     present). It NEVER produces either — crows-nest writes them at its reconcile
//     points (crows-nest §8g); this driver only reads.
//
// The only files it writes are the snapshot + a copy of the bundled HTML app,
// into a scratch/output dir — never the tracked repo:
//
//   <outDir>/run-state.json        — the per-run snapshot the app polls
//   <outDir>/spyglass-run.html     — the self-contained, no-server dashboard
//
// Dependency-free (Node built-ins + `gh`/`git` CLIs), to match validate-skills.
//
// Run:
//   node spyglass-run-snapshot.mjs [--label <triggerLabel>] [--out <dir>]
//                                  [--repo <owner/name>] [--open]
//                                  [--watch <seconds>] [--no-open]
//                                  [--recent-hours <N>] [--recent-cap <N>]
//                                  [--served-root <dir>] [--strict]
//
// TWO OPERATOR GUARDRAILS keep a live dashboard from silently freezing on stale
// data (issue #133 — a real incident: several stale --watch drivers overwrote the
// same run-state.json while the web server served a DIFFERENT directory, so the
// board showed a 2-day-old snapshot and nothing errored):
//
//   * SINGLE-DRIVER LOCK — a `--watch` driver takes an exclusive lock (pid +
//     startedAt) in its --out dir. A SECOND watcher against the same --out refuses
//     to start and names the live pid; a dead holder's lock is transparently taken
//     over; the lock is released on clean exit. A one-shot (non-watch) snapshot is
//     UNaffected — it neither takes nor is blocked by the lock.
//   * SERVED-DIR SANITY CHECK — `--served-root <dir>` (or SPYGLASS_SERVED_ROOT /
//     spyglass.servedRoot, or a best-effort auto-detect of a running static server)
//     names the directory actually served over HTTP. If --out is not that dir the
//     driver warns LOUDLY on startup, and REFUSES to start under `--strict`.
//
// The recent-voyages window is bounded and configurable (flag > env > config >
// default): `--recent-hours` / `SPYGLASS_RECENT_HOURS` / `spyglass.recentWindowHours`
// (default 24; <=0 = no time filter, cap only) and `--recent-cap` /
// `SPYGLASS_RECENT_CAP` / `spyglass.recentCap` (default 12; <=0 = recent lane off).

import { readFileSync, existsSync, mkdirSync, writeFileSync, copyFileSync, renameSync, rmSync, realpathSync, statSync } from 'fs';
import http from 'http';
import path from 'path';
import os from 'os';
import { fileURLToPath } from 'url';
import { execFileSync, spawn } from 'child_process';
import { createHash, randomBytes } from 'crypto';
import { resolveActive, isValidRepo } from './repo-target.mjs';
// The phase→progress map lives with the liveness producer (single source of truth,
// #156). Importing is side-effect-free — liveness-beat guards its main() on isEntry.
import { progressFor } from './liveness-beat.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// A content stamp of the shipped dashboard app (spyglass-run-app.html) — a short
// hash of its bytes, recomputed each snapshot. It changes whenever the UI's
// HTML/CSS/JS changes, so an already-open tab (a passive/streamed kiosk tab or the
// local watch tab) can notice a NEW spyglass version in the polled snapshot and
// self-reload to pick it up — no manual F5 / stream restart (SKILL §6). Additive
// and READ-ONLY. Falls back to null if the app file can't be read, in which case
// the app omits the stamp and never reloads — exactly today's behaviour.
function computeAppVersion() {
  try {
    return createHash('sha256')
      .update(readFileSync(path.join(__dirname, 'spyglass-run-app.html')))
      .digest('hex')
      .slice(0, 12);
  } catch {
    return null;
  }
}

// ARMADA's genuine voyage stages — each is OBSERVABLE from the armada:* labels
// plus PR draft/CI/review sub-state (see stageForIssue / stageForPr). This is the
// REAL pipeline, not the inspiration mock's invented 12 (Feasibility, Scoping,
// AI review, Watching PR, Approved, Harvest, …). Blocked is an overlay, not a leg.
const STAGES = [
  'Queued',         // 0 — issue armed (armada), waiting to be picked up
  'Building',       // 1 — armada:underway: shipwright research → plan → implement → validate
  'PR opened',      // 2 — armada:done / a draft or ready-but-unclaimed PR
  'In review',      // 3 — PR armada:reviewing: muster's 2-lens review (+ address rounds)
  'Awaiting merge', // 4 — reviewed, green, approved; waiting on the merge gate
  'Merged',         // 5 — armada:merged: the gated merge landed
  'Shipped',        // 6 — armada:shipped: issue closed, logbook + cartography done
];

// A short, honest description of what ARMADA actually does in each stage — used by
// the app's pipeline captions. These describe the stage; they are NOT sub-steps the
// dashboard claims to detect progress through (labels don't expose sub-step state).
const STAGE_CAPTIONS = [
  'armed & waiting for the lookout',
  'shipwright: research → plan → implement → validate',
  'branch pushed, PR open',
  'muster: 2-lens review → consolidate → address',
  'green & approved — at the merge gate',
  'gated merge landed',
  'closed; logbook walkthrough + cartography',
];

// ---------------------------------------------------------------------------
// Arg parsing
// ---------------------------------------------------------------------------
function parseArgs(argv) {
  const args = { open: undefined, watch: 0 };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--label') args.label = argv[++i];
    else if (a === '--out') args.out = argv[++i];
    else if (a === '--repo') args.repo = argv[++i];
    else if (a === '--open') args.open = true;
    else if (a === '--no-open') args.open = false;
    else if (a === '--watch') args.watch = Number(argv[++i]) || 0;
    else if (a === '--recent-hours') args.recentHours = argv[++i];
    else if (a === '--recent-cap') args.recentCap = argv[++i];
    else if (a === '--est-burn') args.estBurn = argv[++i];
    else if (a === '--served-root') args.servedRoot = argv[++i];
    else if (a === '--strict') args.strict = true;
  }
  return args;
}

// Resolve a numeric setting with the repo's documented precedence:
// --flag > env var > config value > built-in default. Each candidate is trimmed
// and skipped when empty / non-numeric (first-non-empty-wins), so a blank flag or
// whitespace-only env doesn't short-circuit the chain. (Cartography conventions.)
function resolveNum(flagVal, envName, cfgVal, def) {
  const pick = (v) => {
    if (v == null) return null;
    const s = String(v).trim();
    if (s === '') return null;
    const n = Number(s);
    return Number.isFinite(n) ? n : null;
  };
  const f = pick(flagVal); if (f != null) return f;
  const e = pick(process.env[envName]); if (e != null) return e;
  const c = pick(cfgVal); if (c != null) return c;
  return def;
}

// ---------------------------------------------------------------------------
// GUARDRAIL 1 — single-driver lock (#133)
//
// A `--watch` driver is a long-lived PRODUCER: it rewrites <out>/run-state.json on
// every tick. Two (or four) of them against the same --out silently race, each
// clobbering the other's snapshot, so the board freezes on whichever wrote last.
// The lock makes that impossible: the first watcher writes a lockfile with its pid
// + startedAt into --out; a second watcher sees the LIVE holder and refuses,
// naming the pid so the operator can kill it. A holder whose pid is dead (crash,
// kill -9) left a STALE lock — the newcomer transparently takes it over. The lock
// is a plain file in the scratch/output dir (never the tracked repo), so the
// spyglass read-only invariant holds. One-shot (non-watch) snapshots never take
// or consult the lock — they write once and exit, so they can't wedge the board.
// ---------------------------------------------------------------------------
// The lock is a DIRECTORY (`mkdirSync` is an atomic exclusive arbiter — see
// acquireWatchLock); the holder's metadata (pid / startedAt / nonce) is a plain file
// written INSIDE it. A directory lock is used — not an O_EXCL file lock — because a
// FILE lock's stale-takeover cannot be made race-free with fs primitives (unlink then
// create leaves a gap where two takers of the same dead lock both win); a directory
// can be CLAIMED atomically by a single rename, closing that gap. (Issue #147, folded
// into #144.)
const LOCK_NAME = '.spyglass-run.lock';   // the lock DIRECTORY
const LOCK_INFO = 'owner.json';           // holder metadata file, written INSIDE it

// Is `pid` a live process? `kill(pid, 0)` sends no signal but validates existence:
// ESRCH → gone (stale); EPERM → alive but owned by another user (still live). Any
// non-integer / non-positive pid is treated as dead so a corrupt lock is takeable.
function pidAlive(pid) {
  const n = Number(pid);
  if (!Number.isInteger(n) || n <= 0) return false;
  try { process.kill(n, 0); return true; }
  catch (e) { return e && e.code === 'EPERM'; }
}

// Acquire the watch lock in `outDir`. Returns { ok:true, lockPath, nonce, tookOver }
// on success (fresh acquire or stale-takeover), or { ok:false, holder, lockPath } when
// a LIVE holder already owns it. Never throws for the caller's decision path.
//
// PROTOCOL — a DIRECTORY lock. This CLOSES the structural stale-takeover race that a
// file lock can't (the unlink-then-create gap where two takers of one dead lock both
// win). A far narrower, unreproduced residual remains: the mkdir→write-owner.json gap
// (see readHolder) — a winner preempted for longer than the ~30ms read grace between
// creating the dir and writing owner.json can be misjudged stale and have its live
// lock claimed. It is benign for this read-only view (worst case: two drivers briefly
// refresh the same run-state.json, which is idempotent) and has not been reproduced.
//
//   * FRESH acquire: `mkdirSync(lockDir)` is atomically exclusive — of N racers
//     creating the lock exactly one succeeds; the rest get EEXIST. (`writeFileSync`
//     with `wx` gives the same fresh guarantee, but see below for why a file lock is
//     insufficient.)
//   * STALE takeover: the dead dir is CLAIMED with a single
//     `renameSync(lockDir → lockDir.stale.<pid>.<nonce>)`. A directory rename atomically
//     moves the ONE existing source: of N takers racing to rename the SAME stale dir,
//     exactly one succeeds; the losers get ENOENT (the source already moved) and retry
//     from the top. The winner deletes the renamed-away dir and `mkdirSync`s a fresh
//     lock. The arbiter is the single successful rename, then the single successful
//     mkdir — there is no unlink-then-create gap. (A file lock CAN'T do this: `wx` only
//     arbitrates concurrent CREATES, so two takers of the same DEAD file lock both pass
//     the liveness guard, both unlink, and an interleaving lets BOTH create+win.)
//   * The `nonce` is our OWNER TOKEN. Release removes the lock only when BOTH pid and
//     nonce match, so a later taker never deletes a lock we no longer own.
function acquireWatchLock(outDir) {
  mkdirSync(outDir, { recursive: true });
  const lockPath = path.join(outDir, LOCK_NAME);
  const infoPath = path.join(lockPath, LOCK_INFO);
  const nonce = randomBytes(12).toString('hex');

  const writeInfo = () => writeFileSync(infoPath, JSON.stringify({
    pid: process.pid,
    startedAt: new Date().toISOString(),
    out: path.resolve(outDir),
    nonce,
  }, null, 2));

  // Atomic exclusive create of the lock DIR. true → we now own it; false → it already
  // existed (EEXIST). Any other error is a real fault and propagates.
  const tryMkdir = () => {
    try { mkdirSync(lockPath); return true; }
    catch (e) { if (e && e.code === 'EEXIST') return false; throw e; }
  };
  // Bounded synchronous sleep (no busy-spin): the mid-write grace + a short backoff
  // between takeover attempts.
  const sleepMs = (ms) => {
    try { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); } catch { /* SAB off → skip */ }
  };
  // Read the current holder's metadata. mkdir creates the dir THEN writeInfo writes
  // owner.json, so a racer reading in that gap would see the dir but no (or a
  // half-written) info file and wrongly judge a LIVE mid-write winner as stale. Give a
  // brief grace: if the dir is present but owner.json isn't parseable yet, re-read a
  // few times before concluding it's stale. A genuinely empty/corrupt lock costs only
  // this small grace, then reads as null (→ takeable).
  const readHolder = () => {
    for (let i = 0; i < 6; i++) {
      try { return JSON.parse(readFileSync(infoPath, 'utf8')); } catch { /* absent/mid-write/corrupt */ }
      if (!existsSync(lockPath)) return null;  // dir vanished → truly gone
      sleepMs(5);
    }
    return null;
  };
  // A live foreign holder (a real pid, not ours, still running).
  const liveForeign = (h) => {
    const p = h ? Number(h.pid) : NaN;
    return Number.isInteger(p) && p !== process.pid && pidAlive(p);
  };

  // Bounded acquire loop: fresh-create → refuse-if-live → atomically claim the stale
  // dir and recreate. A losing takeover retries from the top; the bound stops any
  // pathological livelock (it then refuses conservatively rather than spin forever).
  for (let attempt = 0; attempt < 100; attempt++) {
    // 1) Try to win a FRESH lock outright.
    if (tryMkdir()) { writeInfo(); return { ok: true, lockPath, nonce, tookOver: null }; }

    // 2) It already existed. If a LIVE holder owns it, refuse (name the pid).
    const holder = readHolder();
    if (liveForeign(holder)) return { ok: false, holder, lockPath };

    // 3) Stale (dead / corrupt / our own leftover). CLAIM it atomically by renaming the
    //    dead dir away — exactly one taker's rename of the single source succeeds; the
    //    losers get ENOENT and retry. No unlink-then-create gap.
    const hpid = holder ? Number(holder.pid) : NaN;
    const tookOver = (holder && Number.isInteger(hpid) && hpid !== process.pid) ? holder : null;
    const staleName = `${lockPath}.stale.${process.pid}.${nonce}.${attempt}`;
    try {
      renameSync(lockPath, staleName);
    } catch {
      // Lost the claim (ENOENT: another taker already moved it; or a transient Windows
      // EPERM). Back off briefly and retry from the top to re-evaluate the holder.
      sleepMs(5);
      continue;
    }
    // We won the claim. Drop the renamed-away dead dir, then create a fresh lock.
    try { rmSync(staleName, { recursive: true, force: true }); } catch { /* best-effort */ }
    if (tryMkdir()) { writeInfo(); return { ok: true, lockPath, nonce, tookOver }; }
    // A brand-new acquirer slipped in and mkdir'd the fresh dir between our rename and
    // ours. Loop: re-read the new holder and refuse-if-live / re-contend for takeover.
    sleepMs(5);
  }

  // Exhausted the bound — refuse conservatively rather than risk two concurrent drivers.
  const holder = readHolder();
  return { ok: false, holder, lockPath };
}

// Release the lock — but ONLY if it's still ours (pid AND owner nonce match), guarding
// against deleting a lock a newer takeover already claimed. Best-effort; swallows all
// errors. Removes the whole lock dir.
function releaseWatchLock(lockPath, nonce) {
  try {
    if (!lockPath || !existsSync(lockPath)) return;
    const held = JSON.parse(readFileSync(path.join(lockPath, LOCK_INFO), 'utf8'));
    const ours = held && Number(held.pid) === process.pid && (nonce == null || held.nonce === nonce);
    if (ours) rmSync(lockPath, { recursive: true, force: true });
  } catch { /* best-effort */ }
}

// Register clean-exit release across normal exit and the signals a Ctrl-C / kill
// sends, so the lock doesn't outlive the process and wedge the next watcher.
function installLockRelease(lockPath, nonce) {
  let released = false;
  const release = () => { if (!released) { released = true; releaseWatchLock(lockPath, nonce); } };
  process.on('exit', release);
  process.on('SIGINT', () => { release(); process.exit(130); });
  process.on('SIGTERM', () => { release(); process.exit(143); });
  process.on('SIGHUP', () => { release(); process.exit(129); });
}

// ---------------------------------------------------------------------------
// GUARDRAIL 2 — served-dir sanity check (#133)
//
// The dashboard is polled over HTTP by a static file server. If the driver writes
// run-state.json to a directory the server does NOT serve, the board reads a
// different (older, or empty) file and freezes — exactly the second half of the
// incident. This check compares --out against the directory actually served and
// warns LOUDLY (or, under --strict, refuses) on a mismatch. The served dir is
// resolved: --served-root > SPYGLASS_SERVED_ROOT > spyglass.servedRoot > a
// best-effort auto-detect of a running static server. When it can't be determined
// the check stays silent. The auto-detect matches only unambiguous static servers,
// but an UNRELATED static server running on the box CAN still trigger a warn — so
// the mismatch is a loud warning by default; refusal (--strict) is opt-in. READ-ONLY.
// ---------------------------------------------------------------------------

// Normalise a path for comparison: absolute, symlinks resolved when possible,
// case-folded on Windows (its filesystem is case-insensitive).
function normPath(p) {
  let r = path.resolve(p);
  try { r = realpathSync(r); } catch { /* not yet created — resolve() is enough */ }
  return process.platform === 'win32' ? r.toLowerCase() : r;
}
function samePath(a, b) { return normPath(a) === normPath(b); }

// List running process command lines (best-effort, cross-platform, short timeout).
// Used only by the auto-detect — any failure yields [] so detection silently
// declines rather than erroring.
function listProcessCommandLines() {
  try {
    if (process.platform === 'win32') {
      const out = execFileSync('powershell', [
        '-NoProfile', '-Command',
        'Get-CimInstance Win32_Process | Select-Object -ExpandProperty CommandLine',
      ], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 4000 });
      return out.split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
    }
    const out = execFileSync('ps', ['-eo', 'args='], {
      encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 4000,
    });
    return out.split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
  } catch { return []; }
}

// Extract a served root from ONE static-server command line — but only when the
// directory is EXPLICIT in the command (a server serving an implicit cwd isn't
// recoverable from its args, so we decline rather than guess). Recognises the
// common static servers; requires the candidate to resolve to an existing dir.
function servedRootFromCommand(cmd) {
  if (!cmd) return null;
  // Only UNAMBIGUOUS dedicated static file servers — recognising a bare `serve`
  // token would collide with unrelated `... serve` subcommands (e.g. an app-server
  // broker), producing a false alarm, so the npm `serve` package is matched ONLY
  // via an `npx serve` / `pnpm dlx serve` / `yarn dlx serve` invocation.
  const isHttpServer = /\bhttp-server\b/.test(cmd);          // node http-server
  const isPyHttp = /\bhttp\.server\b/.test(cmd);             // python -m http.server
  const isPhp = /\bphp\b.*\s-S\s/.test(cmd);                 // php -S host:port
  const isServePkg = /\b(?:npx|pnpm\s+dlx|yarn\s+dlx)\s+serve\b/.test(cmd);
  if (!(isHttpServer || isPyHttp || isPhp || isServePkg)) return null;
  // A candidate must resolve to an existing DIRECTORY (a file/log that merely
  // exists must never be mistaken for the served root).
  const asDir = (d) => {
    if (!d) return null;
    const cleaned = d.replace(/^["']|["']$/g, '');
    try {
      if (existsSync(cleaned) && statSync(cleaned).isDirectory()) { realpathSync(cleaned); return cleaned; }
    } catch { /* skip */ }
    return null;
  };
  // Explicit directory flags first: -d / --directory (python http.server,
  // http-server), -t (php -S document root).
  const flag = cmd.match(/(?:^|\s)(?:-d|--directory|-t)[=\s]+("[^"]+"|'[^']+'|\S+)/);
  if (flag) { const d = asDir(flag[1]); if (d) return d; }
  // Else the first bare (non-flag) token after the server keyword that resolves to
  // an existing directory — the positional root of `http-server <dir>` / `serve <dir>`.
  const after = cmd.match(/(?:\bhttp-server\b|(?:npx|pnpm\s+dlx|yarn\s+dlx)\s+serve\b)\s+(.*)$/);
  if (after) {
    for (const tok of after[1].split(/\s+/)) {
      if (!tok || tok.startsWith('-')) continue;
      const d = asDir(tok);
      if (d) return d;
    }
  }
  return null;
}

// Best-effort auto-detect of the served root from a running static server.
function detectServedRoot() {
  for (const cmd of listProcessCommandLines()) {
    const root = servedRootFromCommand(cmd);
    if (root) return { root, via: 'auto-detect' };
  }
  return null;
}

// Resolve the served root with documented precedence, or null when unknown.
function resolveServedRoot(flagVal, cfgVal) {
  const pick = (v) => { const s = v == null ? '' : String(v).trim(); return s || null; };
  const f = pick(flagVal); if (f) return { root: f, via: '--served-root' };
  const e = pick(process.env.SPYGLASS_SERVED_ROOT); if (e) return { root: e, via: 'SPYGLASS_SERVED_ROOT' };
  const c = pick(cfgVal); if (c) return { root: c, via: 'spyglass.servedRoot' };
  return detectServedRoot(); // { root, via:'auto-detect' } or null
}

// Run the served-dir sanity check. On a mismatch: warn LOUDLY, and under `strict`
// print the banner to stderr and exit(1) (before any snapshot is written). When
// the served root is unknown, or matches --out, this is a silent no-op. Returns
// true when a mismatch was detected (for tests / callers).
function checkServedRoot({ outDir, served, strict, log = console }) {
  if (!served || !served.root) return false;
  if (samePath(served.root, outDir)) return false;
  const outAbs = path.resolve(outDir);
  const srvAbs = path.resolve(served.root);
  const banner = [
    '',
    '  ############################################################',
    `  # spyglass-run: SERVED-DIR MISMATCH${strict ? ' — REFUSING (--strict)' : ' — WARNING'}`,
    '  #',
    '  #  --out is NOT the directory being served over HTTP, so the',
    '  #  dashboard will poll a DIFFERENT run-state.json and FREEZE',
    '  #  on stale data. Nothing will error — the board just lies.',
    '  #',
    `  #    writing snapshot to : ${outAbs}`,
    `  #    server is serving   : ${srvAbs}  (via ${served.via})`,
    '  #',
    '  #  Fix: point --out at the served dir, or serve --out.',
    '  ############################################################',
    '',
  ].join('\n');
  if (strict) {
    (log.error || log.log).call(log, banner);
    (log.error || log.log).call(log, 'spyglass-run: refusing to start under --strict (served-dir mismatch)');
    process.exit(1);
  }
  (log.error || log.log).call(log, banner);
  return true;
}

// ---------------------------------------------------------------------------
// Repo + config discovery (degrades gracefully on an uncommissioned repo)
// ---------------------------------------------------------------------------
function readConfig() {
  const p = path.join(process.cwd(), '.armada', 'config.json');
  if (existsSync(p)) {
    try { return { config: JSON.parse(readFileSync(p, 'utf8')), commissioned: true }; }
    catch { /* malformed — treat as uncommissioned */ }
  }
  return { config: {}, commissioned: false };
}

function ghJson(args) {
  try {
    const out = execFileSync('gh', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    return JSON.parse(out);
  } catch {
    return null;
  }
}

function resolveRepo(explicit, config = {}) {
  // The SINGLE SOURCE OF TRUTH for the resolution rule is repo-target.mjs. Use its
  // resolver so the precedence (--repo flag > config.activeRepo > ambient) AND the
  // REPO_RE validation (junk / leading-hyphen rejected before it reaches `gh`) match
  // crows-nest exactly. Only call `gh repo view` for the ambient repo when neither the
  // flag nor config.activeRepo already decides it — preserving today's single-repo path.
  const active = typeof config.activeRepo === 'string' ? config.activeRepo.trim() : '';
  const needAmbient = !isValidRepo(explicit) && !isValidRepo(active);
  const ambient = needAmbient
    ? (() => { const r = ghJson(['repo', 'view', '--json', 'nameWithOwner']); return r && r.nameWithOwner ? r.nameWithOwner : null; })()
    : null;
  return resolveActive({ flagRepo: explicit, config, ambient }).repo;
}

function labelNames(labels) {
  return (labels || []).map((l) => (typeof l === 'string' ? l : l.name)).filter(Boolean);
}

// ---------------------------------------------------------------------------
// Local read-only sources
// ---------------------------------------------------------------------------

// Map a branch name → its local git worktree path (read-only). shipwright works
// each run in an isolated worktree, so this ties a run's branch to a folder on
// disk the operator can open/copy. Absent branches degrade to null.
function worktreeMap() {
  const map = {};
  let out;
  try {
    out = execFileSync('git', ['worktree', 'list', '--porcelain'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
  } catch {
    return map;
  }
  let cur = null;
  for (const line of out.split(/\r?\n/)) {
    if (line.startsWith('worktree ')) cur = line.slice('worktree '.length).trim();
    else if (line.startsWith('branch ') && cur) {
      const ref = line.slice('branch '.length).trim().replace(/^refs\/heads\//, '');
      map[ref] = cur;
    }
  }
  return map;
}

// Consume the crows-nest-written run→(branch, worktree) map (READ-ONLY). crows-nest
// records the isolation worktree it dispatched each build into (crows-nest §8g),
// keyed by issue number, so an IN-FLIGHT run surfaces its branch / worktree / folder
// BEFORE a PR exists — no more "n/a — no local worktree" during a build. This driver
// only reads it; the file lives under the gitignored out/costs/ dir. Degrades to {}.
// Shape: { "<issue>": { issue, branch, worktree, startedAt } }.
function readRunMap() {
  const p = path.join(process.cwd(), 'out', 'costs', '_runs.json');
  if (!existsSync(p)) return {};
  try {
    const data = JSON.parse(readFileSync(p, 'utf8'));
    const runs = data && typeof data === 'object' ? (data.runs || data) : {};
    const map = {};
    for (const [k, v] of Object.entries(runs)) {
      if (v && typeof v === 'object') map[String(k)] = v;
    }
    return map;
  } catch {
    return {};
  }
}

// Consume the cost post-mortem for a run when present. This dashboard is a
// CONSUMER — it never produces this file (crows-nest writes it, §8g). Tries
// out/costs/<branch>.json then out/costs/<issue>.json. Degrades to null.
//
// Path resolution (#157): the producer now consolidates every run's cost file into the
// MAIN repo's out/costs/ (surviving worktree cleanup), so the main-repo path is the
// authoritative source and is tried FIRST. But an IN-FLIGHT run's reconcile MAY still
// have written into its own build worktree (a producer invoked with cwd inside the
// worktree under older behaviour, or an explicit --out=<worktree>), so when we know the
// run's worktree we also look under <worktree>/out/costs/ as a fallback. A file in the
// main repo always wins over the worktree copy (it's the reconciled/consolidated one).
// The run's cost-file basename is <branch> or <issue> with path separators flattened to
// match the producer's `String(run).replace(/[\\/]/g, '-')` on write.
function readCost(branch, issueNumber, worktree) {
  const safe = (s) => String(s).replace(/[\\/]/g, '-');
  const roots = [path.join(process.cwd(), 'out', 'costs')];
  if (worktree) roots.push(path.join(worktree, 'out', 'costs'));
  const candidates = [];
  for (const root of roots) {
    if (branch) candidates.push(path.join(root, `${safe(branch)}.json`));
    if (issueNumber != null) candidates.push(path.join(root, `${safe(issueNumber)}.json`));
  }
  for (const c of candidates) {
    if (existsSync(c)) {
      try {
        const data = JSON.parse(readFileSync(c, 'utf8'));
        return { data, pointer: path.relative(process.cwd(), c).replace(/\\/g, '/') };
      } catch { /* malformed — skip, try next */ }
    }
  }
  // Report the conventional pointer even when absent, so the footer can show it.
  const pointer = branch
    ? `out/costs/${safe(branch)}.json`
    : (issueNumber != null ? `out/costs/${safe(issueNumber)}.json` : 'out/costs/<run>.json');
  return { data: null, pointer };
}

// Consume the agent LIVENESS beat for a run (READ-ONLY) and derive a coarse, honest
// PROGRESS estimate (#156). shipwright/muster emit a phase + monotonic step to
// out/liveness/<run>.json as they advance (SKILL §0a/§0b); this driver only READS it
// and maps the phase → % via the producer's own phase→progress table (single source
// of truth, imported above). It NEVER writes the beat file. Degrades to null (→ the
// dashboard shows no bar) when the file is absent/corrupt or the phase is unrecognised.
//
// Path resolution mirrors readCost: an in-flight run beats into whatever cwd the
// dispatched subagent runs in — often its build WORKTREE, sometimes the main repo —
// so we look under BOTH <cwd>/out/liveness and <worktree>/out/liveness. The run's
// beat-file basename is <branch> or <issue|pr> with path separators flattened, to
// match the producer's `String(run).replace(/[\\/]/g, '-')` on write. A terminal
// marker reads 100%; otherwise the phase maps to its coarse %.
function readLiveness(branch, issueNumber, prNumber, worktree) {
  const safe = (s) => String(s).replace(/[\\/]/g, '-');
  const roots = [path.join(process.cwd(), 'out', 'liveness')];
  if (worktree) roots.push(path.join(worktree, 'out', 'liveness'));
  const keys = [branch, issueNumber, prNumber].filter((k) => k != null);
  let doc = null;
  for (const root of roots) {
    for (const k of keys) {
      const f = path.join(root, `${safe(k)}.json`);
      if (existsSync(f)) {
        try { doc = JSON.parse(readFileSync(f, 'utf8')); break; }
        catch { /* malformed — skip, try next */ }
      }
    }
    if (doc) break;
  }
  if (!doc || typeof doc !== 'object') return null;
  const phase = doc.phase || null;
  const terminal = !!doc.terminal;
  // Terminal → 100; else the phase's coarse %, or null when unrecognised (no bar).
  const pct = terminal ? 100 : progressFor(phase);
  if (pct == null) return null;
  const beatTs = (typeof doc.beatTs === 'number' && Number.isFinite(doc.beatTs)) ? doc.beatTs : null;
  return {
    pct,                 // 0..100 coarse estimate
    phase,               // the liveness phase it was derived from
    terminal,            // terminal marker present → 100
    estimate: true,      // ALWAYS honestly an estimate (phase-derived, not true sub-step)
    source: 'liveness',
    beatAt: doc.beatAt || null,
    beatTs,
  };
}

// Discover the logbook "done video" for a run from GitHub release assets
// (READ-ONLY GET). logbook uploads the walkthrough as a per-PR/issue release
// asset. Returns the best video match {name,url,updatedAt} or null.
//
// `gh api <list> --paginate` CONCATENATES one JSON value per page — `[...][...]`
// is NOT valid JSON, so JSON.parse fails past page 1 (~30 releases) and the panel
// silently shows "no done video" on exactly the repos big enough to page (the
// fleet's OWN case — logbook uploads a release asset per run). `--paginate --slurp`
// wraps every page in one outer array, so it parses cleanly; we flatten it. (#105.)
function releaseAssets(repo) {
  if (!repo) return [];
  const flatten = (pages) => {
    const flat = [];
    for (const rel of (pages || [])) {
      for (const a of (rel.assets || [])) {
        flat.push({ tag: rel.tag_name, name: a.name, url: a.browser_download_url, updatedAt: a.updated_at, size: a.size });
      }
    }
    return flat;
  };
  // --slurp yields an array of pages, each page an array of release objects.
  const slurped = ghJson(['api', `repos/${repo}/releases`, '--paginate', '--slurp']);
  if (Array.isArray(slurped)) {
    const releases = slurped.flat ? slurped.flat() : [].concat(...slurped);
    return flatten(releases);
  }
  // Fallback: a single (first) page without --slurp still parses.
  const one = ghJson(['api', `repos/${repo}/releases`]);
  return Array.isArray(one) ? flatten(one) : [];
}

const VIDEO_RE = /\.(mp4|webm|mov|m4v)$/i;
function matchDoneVideo(assets, { issueNumber, prNumber, branch }) {
  if (!assets || !assets.length) return null;
  const nums = [issueNumber, prNumber].filter((n) => n != null).map(String);
  const numHit = (s) => nums.some((n) => new RegExp(`(^|[^0-9])${n}([^0-9]|$)`).test(s || ''));
  const brHit = (s) => branch && (s || '').toLowerCase().includes(branch.toLowerCase());
  const videos = assets.filter((a) => VIDEO_RE.test(a.name || ''));
  // Prefer a video whose asset name or release tag references this run.
  const scored = videos
    .map((a) => ({ a, score: (numHit(a.name) || brHit(a.name) ? 2 : 0) + (numHit(a.tag) || brHit(a.tag) ? 1 : 0) }))
    .filter((x) => x.score > 0)
    .sort((x, y) => y.score - x.score);
  const pick = scored.length ? scored[0].a : null;
  if (!pick) return null;
  return { name: pick.name, url: pick.url, updatedAt: pick.updatedAt };
}

// ---------------------------------------------------------------------------
// Stage inference — map ARMADA's REAL armada:* state machine (+ PR draft/CI/review
// sub-state) onto the genuine voyage stages. Documented in SKILL.md §6 (lockstep).
//
// activeIndex = the current stage (0-based into STAGES). Earlier stages render
// "done", the active one "active", later ones "upcoming". `blocked` overrides the
// active dot. A shipped/merged terminal run marks the last reached stage done.
//
// armada:blocked is LOSSY: crows-nest DROPS the prior state label when it sets
// armada:blocked, so the exact last-reached stage isn't recoverable from labels.
// We approximate from the unit KIND (the same thing SKILL §6 documents): a blocked
// ISSUE with no PR was armada:underway → Building; a blocked PR reached the review
// pipeline → In review. Code and SKILL state the SAME approximation.
// ---------------------------------------------------------------------------
const IDX = { QUEUED: 0, BUILDING: 1, PR_OPENED: 2, IN_REVIEW: 3, AWAITING: 4, MERGED: 5, SHIPPED: 6 };

function stageForIssue(labels) {
  const ls = labelNames(labels);
  if (ls.includes('armada:blocked')) return { activeIndex: IDX.BUILDING, blocked: true, status: 'Blocked', terminal: false };
  if (ls.includes('armada:shipped')) return { activeIndex: IDX.SHIPPED, blocked: false, status: 'Shipped', terminal: true };
  if (ls.includes('armada:merged')) return { activeIndex: IDX.MERGED, blocked: false, status: 'Merged', terminal: false };
  if (ls.includes('armada:done')) return { activeIndex: IDX.PR_OPENED, blocked: false, status: 'PR opened', terminal: false };
  if (ls.includes('armada:underway')) return { activeIndex: IDX.BUILDING, blocked: false, status: 'Building', terminal: false };
  return { activeIndex: IDX.QUEUED, blocked: false, status: 'Queued', terminal: false };
}

function stageForPr(pr) {
  const ls = labelNames(pr.labels);
  const decision = (pr.reviewDecision || '').toUpperCase();
  if (ls.includes('armada:blocked')) return { activeIndex: IDX.IN_REVIEW, blocked: true, status: 'Blocked', terminal: false };
  if (ls.includes('armada:shipped')) return { activeIndex: IDX.SHIPPED, blocked: false, status: 'Shipped', terminal: true };
  if (ls.includes('armada:merged')) return { activeIndex: IDX.MERGED, blocked: false, status: 'Merged', terminal: false };
  if (ls.includes('armada:reviewing')) {
    // muster's review is in flight, or shipwright is addressing a change round.
    // "Addressing" is the one review sub-state we CAN observe (a change request
    // on the PR); otherwise it's a fresh/ongoing review.
    const addressing = decision === 'CHANGES_REQUESTED';
    return { activeIndex: IDX.IN_REVIEW, blocked: false, status: addressing ? 'Addressing' : 'In review', terminal: false };
  }
  if (pr.isDraft) return { activeIndex: IDX.PR_OPENED, blocked: false, status: 'PR opened', terminal: false };
  // Ready PR carrying the trigger label but not yet claimed for review. If it's
  // been approved (muster/human), it's reviewed-and-green waiting on the gate
  // (the ready_awaiting_human terminal, autoMerge off) → Awaiting merge; otherwise
  // it's open and waiting for the lookout to pick it up → PR opened.
  if (decision === 'APPROVED') return { activeIndex: IDX.AWAITING, blocked: false, status: 'Awaiting merge', terminal: false };
  return { activeIndex: IDX.PR_OPENED, blocked: false, status: 'PR opened', terminal: false };
}

// ---------------------------------------------------------------------------
// Terminal outcome for a recently-closed/merged run (#113). A run that has left the
// in-flight set (its issue closed, or its PR merged/closed) is rendered on the recent
// "harbour" lane with its accurate terminal outcome, derived from the SAME state model
// (labels + PR merged/closed state):
//   * a merged PR whose issue closed as completed  → Shipped (activeIndex Shipped)
//   * armada:shipped                               → Shipped
//   * a merged PR / armada:merged                  → Merged  (activeIndex Merged)
//   * armada:blocked, or a PR closed WITHOUT merge  → Blocked (blocked overlay)
// terminal:true; group `done` (Merged/Shipped) or `blocked`. The blocked activeIndex
// reuses the documented lossy approximation (a blocked PR → In review; else Building).
// ---------------------------------------------------------------------------
function recentOutcome({ issue, pr }) {
  const ils = labelNames(issue && issue.labels);
  const pls = labelNames(pr && pr.labels);
  const has = (n) => ils.includes(n) || pls.includes(n);
  const prMerged = !!(pr && (String(pr.state).toUpperCase() === 'MERGED' || pr.mergedAt));
  const prClosedUnmerged = !!(pr && String(pr.state).toUpperCase() === 'CLOSED' && !pr.mergedAt);
  const issueClosed = !!(issue && String(issue.state).toUpperCase() === 'CLOSED');
  // stateReason separates a completed close from a not-planned/duplicate one. Only a
  // COMPLETED close is a "Shipped" voyage; an absent/unknown reason (older gh, reopened)
  // is treated leniently as completed so a genuine ship is never lost.
  const reason = issue ? String(issue.stateReason || '').toUpperCase() : '';
  const issueCompleted = reason === '' || reason === 'COMPLETED';
  if (has('armada:blocked') || (prClosedUnmerged && !prMerged)) {
    return {
      activeIndex: pr ? IDX.IN_REVIEW : IDX.BUILDING,
      blocked: true, status: 'Blocked', outcome: 'Blocked', terminal: true, group: 'blocked',
    };
  }
  if (has('armada:shipped') || (issueClosed && prMerged && issueCompleted)) {
    return { activeIndex: IDX.SHIPPED, blocked: false, status: 'Shipped', outcome: 'Shipped', terminal: true, group: 'done' };
  }
  if (prMerged || has('armada:merged')) {
    return { activeIndex: IDX.MERGED, blocked: false, status: 'Merged', outcome: 'Merged', terminal: true, group: 'done' };
  }
  // No terminal label, no merged PR. A closed issue with no PR: a completed (or
  // unknown-reason) close counts as shipped; a not-planned/duplicate close is not a
  // voyage outcome — return null so the recent-scan skips it (never enters the harbour).
  if (issueClosed && !issueCompleted) return null;
  return { activeIndex: IDX.SHIPPED, blocked: false, status: 'Shipped', outcome: 'Shipped', terminal: true, group: 'done' };
}

// ---------------------------------------------------------------------------
// Coarse fleet GROUPS for the multi-run overview roll-up — derived from the voyage
// stages so the totals bar can count runs by state at a glance:
//   queued        — armed, not yet picked up (stage 0)
//   building      — shipwright building (stage 1)
//   reviewing     — PR open + under review / addressing (stages 2, 3)
//   awaiting-merge— reviewed, green, at the gate (stage 4)
//   done          — merged / shipped, or a terminal run (stages 5, 6)
//   blocked       — any blocked run (overrides all of the above)
// Documented in SKILL.md §6 alongside the stage mapping (kept in lockstep).
// ---------------------------------------------------------------------------
const GROUPS = ['queued', 'building', 'reviewing', 'awaiting-merge', 'done', 'blocked'];
function groupForStage({ activeIndex, blocked, terminal }) {
  if (blocked) return 'blocked';
  if (terminal || activeIndex >= IDX.MERGED) return 'done';        // Merged, Shipped
  if (activeIndex === IDX.AWAITING) return 'awaiting-merge';       // Awaiting merge
  if (activeIndex === IDX.PR_OPENED || activeIndex === IDX.IN_REVIEW) return 'reviewing'; // PR opened / In review
  if (activeIndex === IDX.BUILDING) return 'building';             // Building
  return 'queued';                                                 // Queued
}

// ---------------------------------------------------------------------------
// Correlate a PR to the issue it closes (read-only, from the PR body/branch).
// ---------------------------------------------------------------------------
function closesIssue(pr) {
  const body = pr.body || '';
  const m = body.match(/\b(?:clos(?:e|es|ed)|fix(?:es|ed)?|resolv(?:e|es|ed))\s+#(\d+)/i);
  if (m) return Number(m[1]);
  const b = pr.headRefName || '';
  const bm = b.match(/(?:^|[^0-9])(\d{1,6})(?:[^0-9]|$)/);
  return bm ? Number(bm[1]) : null;
}

// ---------------------------------------------------------------------------
// Scheduler-state — the WAITING-runs dependency graph (#111).
//
// crows-nest builds a cross-track dependency/conflict graph every tick (§2b) and
// holds the units that aren't on the runnable frontier, each with a REASON (§2e:
// "waiting on #N" / "conflicts with #M on <file>" / "queued: N/M builds in flight").
// That graph is crows-nest-internal — NOT in GitHub labels. The producer that
// exposes it read-only is `spyglass-cost-postmortem.mjs schedule`, which crows-nest
// runs at §2c to write out/costs/_schedule.json. This strictly READ-ONLY driver
// CONSUMES that file when present (authoritative). When it's absent it degrades
// gracefully: it infers what edges it can from the issue/PR bodies + file overlap
// it already fetched, and renders a clearly-marked BEST-EFFORT graph — never a
// fabricated one (with no signals at all the graph is just the flat queued list).
// ---------------------------------------------------------------------------

// The dependency lockfiles crows-nest §2b treats as an expected shared surface.
const LOCKFILES = ['package-lock.json', 'yarn.lock', 'pnpm-lock.yaml', 'npm-shrinkwrap.json'];

// Explicit prerequisite references in a body (crows-nest §2b explicit signals).
function dependsRefs(body) {
  const out = new Set();
  const re = /\b(?:depends on|blocked by|needs|builds on|built on|build on|extends|after|requires)\s+#(\d+)/gi;
  let m;
  while ((m = re.exec(body || ''))) out.add(Number(m[1]));
  return [...out];
}

// Best-effort file-path tokens in a body (for same-file / shared-lockfile overlap).
// A path is a slash-joined dotted token (`scripts/foo.mjs`, `skills/spyglass/SKILL.md`);
// bare lockfile names are recognised too. Deliberately conservative — a false hit only
// matters if TWO runs mention the SAME bogus path, and the whole graph is marked inferred.
function filePaths(body) {
  const out = new Set();
  const re = /(?:[A-Za-z0-9_.-]+\/)+[A-Za-z0-9_.-]+\.[A-Za-z0-9]+/g;
  let m;
  while ((m = re.exec(body || ''))) out.add(m[0].replace(/[.,);:`'"]+$/, ''));
  for (const lf of LOCKFILES) {
    if (new RegExp(`(^|[^A-Za-z0-9._-])${lf.replace(/\./g, '\\.')}([^A-Za-z0-9._-]|$)`).test(body || '')) out.add(lf);
  }
  return [...out];
}

const isLockfile = (f) => LOCKFILES.includes(String(f || '').split('/').pop());

// Consume the crows-nest-written scheduler-state file (READ-ONLY). Shape (schema 1):
//   { schema, generatedAt, tick, maxConcurrentBuilds, inFlightBuilds,
//     nodes:[{ unit:'issue'|'pr', number, held, eligible, reasons:[..], files:[..] }],
//     edges:[{ from, to, kind:'depends'|'same-file'|'lockfile'|'base', file?, reason, satisfied }] }
// Absent/corrupt → null (driver then infers). Never written here.
function readSchedulerState() {
  const p = path.join(process.cwd(), 'out', 'costs', '_schedule.json');
  if (!existsSync(p)) return null;
  try {
    const d = JSON.parse(readFileSync(p, 'utf8'));
    return (d && typeof d === 'object' && Array.isArray(d.nodes)) ? d : null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// CI rollup → red / pending / green / none (same derivation as spyglass).
// ---------------------------------------------------------------------------
function ciOf(pr) {
  const roll = Array.isArray(pr.statusCheckRollup) ? pr.statusCheckRollup : [];
  const states = roll.map((c) => (c.conclusion || c.state || '').toString().toUpperCase());
  if (!states.length) return 'none';
  if (states.some((s) => ['FAILURE', 'ERROR', 'CANCELLED', 'TIMED_OUT'].includes(s))) return 'red';
  if (states.some((s) => ['PENDING', 'IN_PROGRESS', 'QUEUED', 'EXPECTED'].includes(s))) return 'pending';
  return 'green';
}

// ---------------------------------------------------------------------------
// Cost normalisation — the per-model cost post-mortem crows-nest writes (§8g).
// Accepts { models:[{model,in,out,cacheRead,cacheWrite,cost}], sessions,
// subagents, codex, matchMode, unpriced:[], totalCost }. Missing → n/a.
// ---------------------------------------------------------------------------
// Aggregate normalizeCost's per-model rows into a compact per-run model breakdown
// (#151). Sums tokens (in+out+cache) and priced cost per DISTINCT model, then adds
// each model's token- and cost-share. Returns a sorted array (busiest model first)
// or null when there are no rows. Shares are null when that whole dimension is
// absent, so an unpriced-only or token-less file still lists which models ran.
function buildModelUsage(models) {
  if (!Array.isArray(models) || models.length === 0) return null;
  const byModel = new Map();
  for (const m of models) {
    const key = m.model || '?';
    let e = byModel.get(key);
    if (!e) { e = { model: key, tokens: null, cost: null }; byModel.set(key, e); }
    for (const k of ['in', 'out', 'cacheRead', 'cacheWrite']) {
      if (typeof m[k] === 'number') e.tokens = (e.tokens ?? 0) + m[k];
    }
    if (typeof m.cost === 'number') e.cost = (e.cost ?? 0) + m.cost;
  }
  const rows = [...byModel.values()];
  const totTok = rows.reduce((a, r) => a + (typeof r.tokens === 'number' ? r.tokens : 0), 0);
  const totCost = rows.reduce((a, r) => a + (typeof r.cost === 'number' ? r.cost : 0), 0);
  const anyTok = rows.some((r) => typeof r.tokens === 'number');
  const anyCost = rows.some((r) => typeof r.cost === 'number');
  for (const r of rows) {
    r.tokenShare = (anyTok && totTok > 0 && typeof r.tokens === 'number') ? r.tokens / totTok : null;
    r.costShare = (anyCost && totCost > 0 && typeof r.cost === 'number') ? r.cost / totCost : null;
  }
  rows.sort((a, b) =>
    ((b.tokens ?? 0) - (a.tokens ?? 0)) ||
    ((b.cost ?? 0) - (a.cost ?? 0)) ||
    String(a.model).localeCompare(String(b.model)));
  return rows;
}

function normalizeCost(cost) {
  if (!cost || !cost.data) return { present: false, pointer: cost ? cost.pointer : null };
  const d = cost.data;
  const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
  const models = Array.isArray(d.models) ? d.models.map((m) => ({
    model: String(m.model ?? m.name ?? '?'),
    in: num(m.in ?? m.input),
    out: num(m.out ?? m.output),
    cacheRead: num(m.cacheRead ?? m.cache_read ?? m.cacheR),
    cacheWrite: num(m.cacheWrite ?? m.cache_write ?? m.cacheW),
    cost: num(m.cost),
  })) : [];
  // totalCost is only a real number when at least one PRICED model contributed.
  // A run whose only usage is unpriced (codex / gpt — the review second lens) has
  // NO priced cost: the producer writes `totalCost:null`, and the fallback below
  // must NOT reduce a list of all-null model costs to a misleading `0` — a terminal
  // run with unpriced-only usage must degrade to `—`, never `$0.00` (#121). So sum
  // only the priced models, and yield null when none are priced.
  const anyPriced = models.some((m) => typeof m.cost === 'number');
  const totalCost = num(d.totalCost ?? d.total_cost) ??
    (anyPriced ? models.reduce((a, m) => a + (typeof m.cost === 'number' ? m.cost : 0), 0) : null);
  // Per-run TOKEN USAGE (#149) — the SAME signals the cost is computed from (tokens ×
  // per-model rate). Surface the underlying counts so an operator sees input/output
  // (and total) tokens, not just dollars. A top-level total on the post-mortem wins
  // when the producer wrote one; otherwise sum across the per-model rows. Each field
  // is null when NO model reported that dimension, so an older/unpriced file with no
  // token data degrades to `tokens:null` and the dashboard shows cost only. Cache
  // reads/writes ARE tokens the run processed, so they fold into the total.
  const sumTok = (key) => {
    let any = false; let sum = 0;
    for (const m of models) { if (typeof m[key] === 'number') { any = true; sum += m[key]; } }
    return any ? sum : null;
  };
  const tInput = num(d.inputTokens ?? d.tokensIn ?? d.totalInput) ?? sumTok('in');
  const tOutput = num(d.outputTokens ?? d.tokensOut ?? d.totalOutput) ?? sumTok('out');
  const tCacheR = sumTok('cacheRead');
  const tCacheW = sumTok('cacheWrite');
  const anyTok = [tInput, tOutput, tCacheR, tCacheW].some((v) => typeof v === 'number');
  const tokenTotal = num(d.totalTokens ?? d.total_tokens ?? d.tokens) ??
    (anyTok ? (tInput ?? 0) + (tOutput ?? 0) + (tCacheR ?? 0) + (tCacheW ?? 0) : null);
  const tokens = (anyTok || typeof tokenTotal === 'number') ? {
    input: tInput,
    output: tOutput,
    cacheRead: tCacheR,
    cacheWrite: tCacheW,
    total: tokenTotal,
  } : null;
  // Per-MODEL breakdown (#151) — WHICH models the run used and each model's share
  // of the work, derived from the SAME per-model rows above (#155): each carries
  // in/out/cache tokens + priced cost. Aggregate by model name (a run can accrue
  // several rows for one model across sessions), then compute each model's token-
  // and cost-share (fractions 0..1; null when that dimension has no data across
  // any model). Sorted by the strongest available signal (tokens, then cost, then
  // name). Null overall when there are no model rows → the dashboard degrades to
  // no model chip. Read-only: a pure derivation of what normalizeCost already saw.
  const modelUsage = buildModelUsage(models);
  return {
    present: true,
    pointer: cost.pointer,
    models,
    modelUsage,
    tokens,
    sessions: num(d.sessions) ?? null,
    subagents: num(d.subagents) ?? null,
    codex: num(d.codex) ?? null,
    matchMode: d.matchMode ?? d.match ?? null,
    unpriced: Array.isArray(d.unpriced) ? d.unpriced.map(String) : [],
    totalCost,
    // `final` — the producer latches it true at the ship reconcile (--final,
    // crows-nest §8g.ii); a file written at build/PR reconcile is `final:false`
    // (real-so-far, still accruing). Legacy files (#109/#112) predate the flag —
    // pass through whatever's present; buildRun ORs it with recent/terminal so a
    // completed run's cost still reads as final. Boolean or null when absent.
    final: (typeof d.final === 'boolean') ? d.final : null,
    updatedAt: d.updatedAt ?? d.generatedAt ?? null,
  };
}

// Rough elapsed-based cost estimate for an IN-FLIGHT run (#115). The dashboard is
// strictly read-only and the harness surfaces a subagent's token usage ONLY in its
// completion notification — there is no mid-build usage stream to read. So while a
// run is actively working with no reconcile file yet, we derive an HONEST estimate
// from the one live signal available read-only — elapsed build time — at a coarse,
// configurable burn rate. It is CLEARLY labelled an estimate and converges to the
// real figure the moment the producer writes real usage. Returns USD or null.
function estFromElapsed(iso, ratePerMin) {
  if (!iso || !(ratePerMin > 0)) return null;
  const ms = Date.now() - Date.parse(iso);
  if (!Number.isFinite(ms)) return null;
  if (ms <= 0) return 0;
  return Number(((ms / 60000) * ratePerMin).toFixed(4));
}

// ---------------------------------------------------------------------------
// Build the WAITING-runs dependency graph for the snapshot (#111). Prefers the
// crows-nest-written producer file (authoritative); falls back to a best-effort
// graph inferred from the issue/PR bodies + file overlap this driver already has.
//
//   runs        — the in-flight run objects (already carrying group/activeIndex/status)
//   recentRuns  — completed voyages (used to know which prerequisites have LANDED)
//   issues,prs  — the raw §2a records, kept for `body`/`labels` (dependency + file signals)
//   cap         — maxConcurrentBuilds (for the "queued: N/M builds in flight" reason)
//   schedState  — the parsed producer file, or null (→ infer)
//   repo        — owner/name for building unit URLs on inferred stub prerequisites
//
// Returns { present, source:'producer'|'inferred'|'none', note, maxConcurrentBuilds,
//           inFlightBuilds, nodes:[...], edges:[...] }. A node is a queued/held run
// (waiting:true) or a referenced prerequisite still in flight (waiting:false); the
// runnable frontier is the waiting+eligible set. Edges point dependent → prerequisite.
// ---------------------------------------------------------------------------
function buildScheduler({ runs, recentRuns, issues, prs, cap, schedState, repo }) {
  const inFlightBuilds = runs.filter((r) => r.group === 'building').length;
  const IDX_DONE = IDX.MERGED;
  const unitUrl = (unit, n) =>
    repo ? `https://github.com/${repo}/${unit === 'pr' ? 'pull' : 'issues'}/${n}` : null;

  // number → the in-flight run that carries it (issue OR pr number), for status/title.
  const runByNum = new Map();
  const landed = new Set(); // prerequisites that have landed (merged/shipped) — satisfied
  for (const r of [...runs, ...recentRuns]) {
    const done = r.group === 'done' || r.terminal || r.activeIndex >= IDX_DONE;
    for (const n of [r.issueNumber, r.prNumber]) {
      if (n == null) continue;
      if (done) landed.add(n);
      else if (!runByNum.has(n)) runByNum.set(n, r);
    }
  }
  const bodyByNum = new Map();
  const prioByNum = new Map();
  for (const it of (issues || [])) {
    bodyByNum.set(it.number, it.body || '');
    prioByNum.set(it.number, labelNames(it.labels).some((n) => /^(priority|p0)$/i.test(n)));
  }
  for (const pr of (prs || [])) {
    if (!bodyByNum.has(pr.number)) bodyByNum.set(pr.number, pr.body || '');
    if (!prioByNum.has(pr.number)) prioByNum.set(pr.number, labelNames(pr.labels).some((n) => /^(priority|p0)$/i.test(n)));
  }

  // A node for a referenced-but-not-waiting prerequisite: use the in-flight run's real
  // status when we can see it; else a lightweight external stub.
  const nodeFromRun = (r, waiting, eligible, held, reasons, files) => ({
    key: r.issueNumber != null ? 'i' + r.issueNumber : 'p' + r.prNumber,
    unit: r.prNumber != null && r.issueNumber == null ? 'pr' : 'issue',
    number: r.issueNumber ?? r.prNumber,
    issueNumber: r.issueNumber ?? null,
    prNumber: r.prNumber ?? null,
    title: r.title || `#${r.issueNumber ?? r.prNumber}`,
    url: r.prUrl || r.issueUrl || null,
    group: r.group, activeIndex: r.activeIndex,
    status: waiting ? (held ? 'Held' : 'Eligible') : (r.status || 'in flight'),
    waiting, eligible, held, reasons: reasons || [], files: files || [],
  });

  // ---- authoritative: the crows-nest producer file ----
  if (schedState && Array.isArray(schedState.nodes)) {
    const nodes = schedState.nodes.map((n) => {
      const num = Number(n.number);
      const r = runByNum.get(num);
      const held = !!n.held || (Array.isArray(n.reasons) && n.reasons.length > 0 && n.eligible !== true);
      const eligible = n.eligible != null ? !!n.eligible : !held;
      const base = r
        ? nodeFromRun(r, true, eligible, held, n.reasons || [], n.files || [])
        : {
            key: (n.unit === 'pr' ? 'p' : 'i') + num, unit: n.unit || 'issue', number: num,
            issueNumber: n.unit === 'pr' ? null : num, prNumber: n.unit === 'pr' ? num : null,
            title: n.title || `#${num}`, url: unitUrl(n.unit || 'issue', num),
            group: 'queued', activeIndex: IDX.QUEUED,
            status: held ? 'Held' : 'Eligible', waiting: true, eligible, held,
            reasons: n.reasons || [], files: n.files || [],
          };
      return base;
    });
    const edges = (schedState.edges || []).map((e) => ({
      from: Number(e.from), to: Number(e.to), kind: e.kind || 'depends',
      file: e.file || null, reason: e.reason || null,
      satisfied: e.satisfied != null ? !!e.satisfied : false,
    }));
    // Synthesize a node for any edge ENDPOINT the producer didn't list as a waiting
    // node — most importantly a `depends on #N` / `blocked by #N` prerequisite that is
    // still IN FLIGHT (building/reviewing), so it never sat on the held-runs frontier.
    // Without an endpoint node the app silently DROPS the edge (drawGraphEdges skips any
    // edge whose from/to element is missing), degrading a real "waiting on #N" edge to a
    // bare reason chip. Mirror the inferred path's ensureRunNode/ensureStubNode: use the
    // in-flight run's already-fetched real status when we can see it, a satisfied
    // Shipped marker when it has landed, else a lightweight external stub. The endpoint
    // is a referenced prerequisite, not part of the waiting set → waiting:false. Strictly
    // read-only (no new fetch). #126.
    const present = new Set(nodes.map((n) => n.number));
    const synthEndpoint = (num) => {
      if (!Number.isFinite(num) || present.has(num)) return;
      present.add(num);
      const r = runByNum.get(num);
      if (r) {
        nodes.push(nodeFromRun(r, false, false, false, [], []));
        return;
      }
      const done = landed.has(num);
      nodes.push({
        key: 'i' + num, unit: 'issue', number: num, issueNumber: num, prNumber: null,
        title: `#${num}`, url: unitUrl('issue', num),
        group: done ? 'done' : 'queued', activeIndex: done ? IDX_DONE : IDX.QUEUED,
        status: done ? 'Shipped' : 'pending',
        waiting: false, eligible: false, held: false, reasons: [], files: [],
      });
    };
    for (const e of edges) { synthEndpoint(e.from); synthEndpoint(e.to); }
    return {
      present: true, source: 'producer', note: null,
      maxConcurrentBuilds: schedState.maxConcurrentBuilds ?? cap,
      inFlightBuilds: schedState.inFlightBuilds ?? inFlightBuilds,
      tick: schedState.tick ?? null, generatedAt: schedState.generatedAt ?? null,
      nodes, edges,
    };
  }

  // ---- best-effort inference (degraded) ----
  const waiting = runs.filter((r) => !r.recent && !r.terminal && r.group === 'queued');
  if (!waiting.length) {
    return {
      present: false, source: 'none', note: null,
      maxConcurrentBuilds: cap, inFlightBuilds, nodes: [], edges: [],
    };
  }

  // File sets for the in-flight (non-queued) runs too, so a queued run can conflict
  // with a build already under way.
  const inFlight = runs.filter((r) => !r.recent && !r.terminal && r.group !== 'queued');
  const keyOf = (r) => (r.issueNumber != null ? 'i' + r.issueNumber : 'p' + r.prNumber);
  const rawFilesOf = (r) => filePaths(bodyByNum.get(r.issueNumber) || bodyByNum.get(r.prNumber) || '');
  // Body prose is a NOISY overlap signal in this repo: nearly every issue's acceptance
  // criteria name the same repo-meta files (`scripts/validate-skills.mjs`,
  // `.claude-plugin/plugin.json`, `.armada/config.json`), which would wire a spurious
  // "same-file" edge between essentially all fleet runs. crows-nest uses real PR `files`;
  // we only have prose, so we drop UBIQUITOUS files — any path mentioned by at least half
  // the considered runs (and ≥3) is boilerplate, not a discriminating touch signal — while
  // KEEPING lockfiles (a genuinely expected shared surface, §2b). This is why the inferred
  // graph is explicitly marked best-effort.
  const fileCache = new Map();
  const considered = [...waiting, ...inFlight];
  const freq = new Map();
  for (const r of considered) {
    const fs = rawFilesOf(r);
    fileCache.set(keyOf(r), fs);
    for (const f of fs) freq.set(f, (freq.get(f) || 0) + 1);
  }
  const ubiquitousCut = Math.max(3, Math.ceil(considered.length / 2));
  const discriminating = (f) => isLockfile(f) || (freq.get(f) || 0) < ubiquitousCut;
  const filesOf = (r) => (fileCache.get(keyOf(r)) || rawFilesOf(r)).filter(discriminating);

  const edges = [];
  const nodeMap = new Map();     // key → node
  const ensureRunNode = (r, waitingFlag) => {
    const k = r.issueNumber != null ? 'i' + r.issueNumber : 'p' + r.prNumber;
    if (!nodeMap.has(k)) nodeMap.set(k, nodeFromRun(r, waitingFlag, false, false, [], filesOf(r)));
    return nodeMap.get(k);
  };
  const ensureStubNode = (num) => {
    const k = 'i' + num;
    if (!nodeMap.has(k)) {
      nodeMap.set(k, {
        key: k, unit: 'issue', number: num, issueNumber: num, prNumber: null,
        title: `#${num}`, url: unitUrl('issue', num), group: 'queued', activeIndex: IDX.QUEUED,
        status: 'pending', waiting: false, eligible: false, held: false, reasons: [], files: [],
      });
    }
    return nodeMap.get(k);
  };
  const addReason = (node, text) => { if (!node.reasons.includes(text)) node.reasons.push(text); };

  // Seed every waiting run as a node.
  for (const w of waiting) ensureRunNode(w, true);

  // 1) Explicit prerequisites (depends on / blocked by / builds on / after …).
  for (const w of waiting) {
    const wn = ensureRunNode(w, true);
    for (const dep of dependsRefs(bodyByNum.get(w.issueNumber) || bodyByNum.get(w.prNumber) || '')) {
      if (dep === wn.number) continue;
      if (landed.has(dep)) continue; // prerequisite already landed — satisfied, no hold
      const target = runByNum.get(dep);
      if (target) ensureRunNode(target, false); else ensureStubNode(dep);
      addReason(wn, `waiting on #${dep}`);
      edges.push({ from: wn.number, to: dep, kind: 'depends', file: null, reason: `waiting on #${dep}`, satisfied: false });
    }
  }

  // 2) Same-file / shared-lockfile conflict with an IN-FLIGHT run (serialise; §2b).
  for (const w of waiting) {
    const wn = ensureRunNode(w, true);
    const wf = wn.files;
    for (const x of inFlight) {
      const xf = filesOf(x);
      const shared = wf.filter((f) => xf.includes(f));
      for (const f of shared) {
        const xNum = x.issueNumber ?? x.prNumber;
        ensureRunNode(x, false);
        const lock = isLockfile(f);
        addReason(wn, lock ? `lockfile merge #${xNum} first` : `conflicts with #${xNum} on ${f}`);
        edges.push({ from: wn.number, to: xNum, kind: lock ? 'lockfile' : 'same-file', file: f,
          reason: lock ? `lockfile merge #${xNum} first` : `conflicts with #${xNum} on ${f}`, satisfied: false });
      }
    }
  }

  // 3) Same-file conflict between two WAITING runs — the FIFO-later / non-priority
  //    one holds (crows-nest §2c de-conflicts the frontier against itself).
  for (let i = 0; i < waiting.length; i++) {
    for (let j = i + 1; j < waiting.length; j++) {
      const a = ensureRunNode(waiting[i], true), b = ensureRunNode(waiting[j], true);
      const shared = a.files.filter((f) => b.files.includes(f));
      if (!shared.length) continue;
      // Keep the priority unit, else the lower number (FIFO-earlier); hold the other.
      const aPrio = prioByNum.get(a.number), bPrio = prioByNum.get(b.number);
      const keepA = aPrio && !bPrio ? true : (bPrio && !aPrio ? false : a.number <= b.number);
      const hold = keepA ? b : a, keep = keepA ? a : b;
      for (const f of shared) {
        const lock = isLockfile(f);
        addReason(hold, lock ? `lockfile merge #${keep.number} first` : `conflicts with #${keep.number} on ${f}`);
        edges.push({ from: hold.number, to: keep.number, kind: lock ? 'lockfile' : 'same-file', file: f,
          reason: lock ? `lockfile merge #${keep.number} first` : `conflicts with #${keep.number} on ${f}`, satisfied: false });
      }
    }
  }

  // 4) Concurrency cap — a waiting run with no other hold, but the fleet is at its
  //    build ceiling, is held "queued: N/M builds in flight" (crows-nest §2e).
  const overCap = cap > 0 && inFlightBuilds >= cap;
  for (const w of waiting) {
    const wn = ensureRunNode(w, true);
    if (wn.reasons.length === 0 && overCap) addReason(wn, `queued: ${inFlightBuilds}/${cap} builds in flight`);
  }

  // Finalise waiting-node status: held iff it has any reason, else on the frontier.
  let anyEdge = false;
  for (const node of nodeMap.values()) {
    if (node.waiting) {
      node.held = node.reasons.length > 0;
      node.eligible = !node.held;
      node.status = node.held ? 'Held' : 'Eligible';
    }
  }
  if (edges.length) anyEdge = true;

  return {
    present: true, source: 'inferred',
    note: 'best-effort — inferred from issue/PR bodies + file overlap; crows-nest scheduler-state (out/costs/_schedule.json) not available',
    maxConcurrentBuilds: cap, inFlightBuilds,
    nodes: [...nodeMap.values()], edges,
    anyEdge,
  };
}

// ---------------------------------------------------------------------------
// Snapshot — the read-only scan + correlate + build runs.
// ---------------------------------------------------------------------------
function snapshot({ label, repo, commissioned, recentHours, recentCap, estRatePerMin, maxConcurrentBuilds }) {
  const repoArgs = repo ? ['--repo', repo] : [];

  // Read-only §2a reads. NOTE: crows-nest DROPS the base trigger label when it
  // claims a run (an underway issue carries `armada:underway`, not `armada`), so
  // a server-side `--label armada` filter would miss every in-flight run — the
  // exact runs this dashboard exists to show. We fetch open issues/PRs and keep
  // any carrying the trigger label OR one of its `armada:*` state labels.
  const inFleet = (labels) => labelNames(labels).some((n) => n === label || n.startsWith(label + ':'));

  const rawIssues = commissioned
    ? ghJson([
        'issue', 'list', ...repoArgs, '--state', 'open',
        '--json', 'number,title,labels,createdAt,updatedAt,author,body', '--limit', '50',
      ])
    : null;
  const rawPrs = commissioned
    ? ghJson([
        'pr', 'list', ...repoArgs, '--state', 'open',
        '--json', 'number,title,isDraft,labels,headRefName,baseRefName,mergeable,reviewDecision,statusCheckRollup,createdAt,updatedAt,body', '--limit', '50',
      ])
    : null;

  const ghOk = rawIssues !== null || rawPrs !== null;
  const issues = (rawIssues || []).filter((it) => inFleet(it.labels));
  const prs = (rawPrs || []).filter((pr) => inFleet(pr.labels));

  const wt = worktreeMap();
  const runMap = readRunMap();
  const assets = ghOk ? releaseAssets(repo) : [];

  const unitUrl = (kind, n) =>
    repo ? `https://github.com/${repo}/${kind === 'pr' ? 'pull' : 'issues'}/${n}` : null;

  // Correlate: issue number → its open PR (if any).
  const prByIssue = {};
  for (const pr of prs) {
    const iss = closesIssue(pr);
    if (iss != null && prByIssue[iss] == null) prByIssue[iss] = pr;
  }

  const runs = [];
  const seen = new Set();

  // A run is "in flight" if the issue is queued/underway/done/blocked, or it has
  // an open PR. Queued (unclaimed) issues are shown too — the intake leg. When
  // `recent` is set the run is a terminal, recently-closed/merged voyage (#113):
  // its stage comes from recentOutcome() and it carries completedAt + merge commit.
  function buildRun({ issue, pr, recent }) {
    const issueNumber = issue ? issue.number : null;
    const prNumber = pr ? pr.number : null;
    // Branch: prefer the PR's head; else the crows-nest run map (in-flight, pre-PR).
    const runRec = issueNumber != null ? runMap[String(issueNumber)] : null;
    const branch = (pr && pr.headRefName) || (runRec && runRec.branch) || null;
    const stage = recent
      ? recentOutcome({ issue, pr })
      : (pr ? stageForPr(pr) : stageForIssue(issue.labels));
    // A recent run whose outcome is a non-voyage close (not-planned/duplicate, no PR)
    // is excluded from the harbour lane entirely.
    if (recent && !stage) return null;
    // Worktree: git worktree list by branch, else the run map's recorded path.
    const worktree = (branch && wt[branch]) || (runRec && runRec.worktree) || null;
    const costRaw = readCost(branch, issueNumber, worktree);
    const cost = normalizeCost(costRaw);

    // --- Estimated (in-flight) vs final (reconciled) cost — #115 -------------
    // A run that is actively working (Building / In review) but hasn't finalised
    // is "accruing"; if it has no reconcile file yet we show an elapsed-based
    // ESTIMATE instead of a misleading $0.00. The burn clock is the time since
    // BUILDING began — the crows-nest dispatch time (run map startedAt), else the
    // PR/issue open time — NOT `startedAt` (the run's age), so idle queue time
    // doesn't inflate the estimate.
    const working = !recent && !stage.blocked && !stage.terminal
      && stage.activeIndex >= IDX.BUILDING && stage.activeIndex <= IDX.IN_REVIEW;
    const costSince = (runRec && (runRec.startedAt || runRec.dispatchedAt))
      || (pr && pr.createdAt) || (issue && issue.createdAt) || null;
    const recorded = cost.present && typeof cost.totalCost === 'number';
    // final: producer latched it (--final at ship), or the run has left in-flight.
    cost.final = !!(cost.final || recent || stage.terminal);
    // accruing: actively working and not yet finalised — real-so-far or estimated.
    cost.accruing = working && !cost.final;
    // A pure estimate applies ONLY with no recorded usage yet (a build/review
    // before any reconcile). Recorded-but-partial (final:false + real numbers) is
    // real-so-far, not an estimate — the dashboard labels it "so far", not "est".
    cost.estimated = cost.accruing && !recorded;
    cost.costSince = cost.accruing ? costSince : null;
    cost.estRatePerMin = estRatePerMin;
    cost.estTotalCost = cost.estimated ? estFromElapsed(costSince, estRatePerMin) : null;
    const doneVideo = matchDoneVideo(assets, { issueNumber, prNumber, branch });
    // Coarse, honest PROGRESS estimate (#156) from the agent liveness beat. Read-only;
    // null when no beat / unknown phase (→ the dashboard shows no bar). A recent
    // (terminal) run drops it — its outcome, not a live %, is what the harbour shows.
    const progress = recent ? null : readLiveness(branch, issueNumber, prNumber, worktree);
    // Elapsed since the run started: the issue/PR open time, or the crows-nest
    // dispatch time from the run map (whichever is earliest & known).
    const startedAt = (issue && issue.createdAt) || (pr && pr.createdAt)
      || (runRec && (runRec.startedAt || runRec.dispatchedAt)) || null;
    // Terminal timestamp + merge-commit link for a recent (completed) run.
    const completedAt = recent
      ? ((pr && (pr.mergedAt || pr.closedAt)) || (issue && issue.closedAt) || null)
      : null;
    const mergeOid = recent && pr && pr.mergeCommit
      ? (pr.mergeCommit.oid || pr.mergeCommit.sha || null) : null;

    // --- Ready to merge (#140) — the human merge queue -----------------------
    // A PR that has PASSED review and is mergeable but is NOT yet merged: the
    // `ready_awaiting_human` terminal (crows-nest §3e — "reviewed, addressed, green"
    // with autoMerge off). On ARMADA's OWN fleet PRs this is the COMMON resting state,
    // because the self-approval classifier blocks the lookout from self-merging, so a
    // human must run the merge (the incident that chartered this — #132/#137/#138 sat
    // reviewed-clean and mergeable, unseen). Derived from the SAME real state the stage
    // model already uses — no new signal: reviewDecision APPROVED → the 'Awaiting merge'
    // stage (IDX.AWAITING, stageForPr), AND GitHub reports the PR cleanly `mergeable`
    // (MERGEABLE — not BEHIND/CONFLICTING/UNKNOWN), AND CI isn't red/pending. Strictly
    // READ-ONLY: it only SURFACES the exact `gh pr merge` command; it never runs it.
    const ci = pr ? ciOf(pr) : null;
    const mergeableState = pr && pr.mergeable ? String(pr.mergeable).toUpperCase() : null;
    const readyToMerge = !recent && !!pr && !stage.blocked && !stage.terminal
      && stage.activeIndex === IDX.AWAITING
      && mergeableState === 'MERGEABLE'
      && ci !== 'red' && ci !== 'pending';
    // The exact, copyable human-merge command — only when the PR is actually ready.
    // Squash + delete-branch matches ARMADA's house merge (SKILL / merge-gate default).
    const mergeCommand = (readyToMerge && prNumber != null)
      ? `gh pr merge ${prNumber} --squash --delete-branch` : null;
    // "How long it's been waiting" — since the PR last changed (crows-nest's
    // 'awaiting human merge' hand-back is the last write to it), else the run start.
    const waitingSince = readyToMerge ? ((pr && pr.updatedAt) || startedAt) : null;

    return {
      issueNumber,
      prNumber,
      title: (issue && issue.title) || (pr && pr.title) || `#${issueNumber ?? prNumber}`,
      issueUrl: issueNumber != null ? unitUrl('issue', issueNumber) : null,
      prUrl: prNumber != null ? unitUrl('pr', prNumber) : null,
      branch,
      worktree,
      folder: worktree, // for a worktree run the folder IS the worktree path
      startedAt,
      ci,
      // ready-to-merge (#140) — the human merge queue; null/false on runs that aren't
      // a reviewed-clean, mergeable, unmerged PR. mergeCommand is only shown, never run.
      mergeable: mergeableState,
      readyToMerge,
      mergeCommand,
      waitingSince,
      stages: STAGES,
      stageCaptions: STAGE_CAPTIONS,
      activeIndex: stage.activeIndex,
      status: stage.status,
      blocked: stage.blocked,
      terminal: stage.terminal,
      group: recent ? stage.group : groupForStage(stage),
      doneVideo,
      progress, // #156 — coarse phase-derived % from liveness (null → no bar)
      cost,
      // recent-lane fields (#113); absent/null on in-flight runs.
      recent: !!recent,
      outcome: recent ? stage.outcome : null,
      completedAt,
      mergeCommitOid: mergeOid,
      mergeCommitUrl: (mergeOid && repo) ? `https://github.com/${repo}/commit/${mergeOid}` : null,
    };
  }

  for (const issue of issues) {
    seen.add(issue.number);
    runs.push(buildRun({ issue, pr: prByIssue[issue.number] || null }));
  }
  // PRs whose issue isn't in the armed-issue list (already de-armed / closed).
  for (const pr of prs) {
    const iss = closesIssue(pr);
    if (iss != null && seen.has(iss)) continue;
    runs.push(buildRun({ issue: null, pr }));
  }

  // Sort: blocked first, then by furthest-along stage, then by number.
  runs.sort((a, b) =>
    (Number(b.blocked) - Number(a.blocked)) ||
    (b.activeIndex - a.activeIndex) ||
    ((a.issueNumber ?? a.prNumber ?? 0) - (b.issueNumber ?? b.prNumber ?? 0)));

  const blockedCount = runs.filter((r) => r.blocked).length;

  // Ready-to-merge queue (#140) — reviewed-clean, mergeable, unmerged PRs waiting on a
  // HUMAN merge, LONGEST-WAITING first (oldest waitingSince). This is a focused,
  // actionable view of the same in-flight runs (each also stays in the voyage list);
  // strictly read-only — every entry carries only the pre-built `gh pr merge` command.
  const readyToMergeRuns = runs
    .filter((r) => r.readyToMerge)
    .sort((a, b) => (Date.parse(a.waitingSince || a.startedAt || 0) || 0)
                  - (Date.parse(b.waitingSince || b.startedAt || 0) || 0));

  // -------------------------------------------------------------------------
  // Recent voyages (#113) — a BOUNDED window of recently-closed/merged runs, so a
  // run stays on the board after it merges/ships instead of vanishing. READ-ONLY:
  // `gh issue list --state closed`, `gh pr list --state merged`, `--state closed`.
  // Bounded by a configurable cap AND/OR time window; oldest runs age out.
  // -------------------------------------------------------------------------
  const recentRuns = [];
  const recentWindow = { hours: recentHours, cap: recentCap };
  let shippedToday = 0;
  if (commissioned && ghOk && recentCap > 0) {
    // Fetch a bounded slab, then filter to fleet + window + cap in JS. gh doesn't
    // sort by merge/close date, so over-fetch a little and sort by completedAt here.
    const listLimit = Math.min(100, Math.max(recentCap * 4, 40));
    const closedIssues = ghJson([
      'issue', 'list', ...repoArgs, '--state', 'closed',
      '--json', 'number,title,labels,createdAt,updatedAt,closedAt,state,stateReason,author,body',
      '--limit', String(listLimit),
    ]) || [];
    const mergedPrs = ghJson([
      'pr', 'list', ...repoArgs, '--state', 'merged',
      '--json', 'number,title,isDraft,labels,headRefName,baseRefName,state,mergeable,reviewDecision,statusCheckRollup,createdAt,updatedAt,closedAt,mergedAt,mergeCommit,body',
      '--limit', String(listLimit),
    ]) || [];
    const closedPrs = ghJson([
      'pr', 'list', ...repoArgs, '--state', 'closed',
      '--json', 'number,title,isDraft,labels,headRefName,baseRefName,state,mergeable,reviewDecision,statusCheckRollup,createdAt,updatedAt,closedAt,mergedAt,mergeCommit,body',
      '--limit', String(listLimit),
    ]) || [];
    const recentPrs = [...mergedPrs, ...closedPrs];

    // Correlate a recent closed issue with the recent PR that closed it.
    const prByIssueR = {};
    for (const pr of recentPrs) {
      const iss = closesIssue(pr);
      if (iss != null && prByIssueR[iss] == null) prByIssueR[iss] = pr;
    }

    const seenR = new Set();
    const built = [];
    // Closed fleet issues first (each carries its terminal armada:* label).
    for (const issue of closedIssues) {
      if (!inFleet(issue.labels)) continue;
      if (seen.has(issue.number)) continue; // still shown as in-flight — don't double-list
      const pr = prByIssueR[issue.number] || null;
      const run = buildRun({ issue, pr, recent: true });
      if (!run) continue; // not-planned/duplicate close with no PR — not a voyage
      built.push(run);
      seenR.add('i' + issue.number);
      if (pr) seenR.add('p' + pr.number);
    }
    // Recent PRs whose closing issue isn't in the closed-issue set (or has no issue).
    for (const pr of recentPrs) {
      if (seenR.has('p' + pr.number)) continue;
      if (!inFleet(pr.labels)) continue;
      const iss = closesIssue(pr);
      if (iss != null && (seen.has(iss) || seenR.has('i' + iss))) continue;
      const run = buildRun({ issue: null, pr, recent: true });
      if (!run) continue;
      built.push(run);
      seenR.add('p' + pr.number);
    }

    // Bound by the time window (when > 0), then sort newest-completed first, then cap.
    const nowMs = Date.now();
    const windowMs = recentHours > 0 ? recentHours * 3600 * 1000 : Infinity;
    const completedMs = (r) => Date.parse(r.completedAt || '') || 0;
    const withinWindow = built.filter((r) => {
      const t = completedMs(r);
      if (!t) return recentHours <= 0; // no timestamp — keep only when the window is off
      return (nowMs - t) <= windowMs;
    });
    withinWindow.sort((a, b) => completedMs(b) - completedMs(a));
    for (const r of withinWindow.slice(0, recentCap)) recentRuns.push(r);

    // shipped-today roll-up — non-blocked terminal runs completed since local midnight
    // (counted from the full windowed set, so the count is accurate even past the cap).
    const midnight = new Date(); midnight.setHours(0, 0, 0, 0);
    const sot = midnight.getTime();
    shippedToday = withinWindow.filter((r) => !r.blocked && completedMs(r) >= sot).length;
  }

  // Fleet roll-up — counts by coarse group, total in-flight, total cost — for the
  // totals bar. Client-recomputable, but emitted here so the grouping is
  // authoritative + documented in one place. (Additive; schema 2.)
  // Fleet cost now folds in-flight runs into the total honestly (#115): a run's
  // real recorded figure when present, else its elapsed-based estimate. `estIncluded`
  // flags that the total carries non-final (estimated or accruing) figures so the
  // manifest can caveat it rather than presenting a moving number as settled.
  const rollup = { inFlight: runs.length, totalCost: 0, costKnown: false, estIncluded: false };
  for (const g of GROUPS) rollup[g] = 0;
  for (const r of runs) {
    if (rollup[r.group] != null) rollup[r.group] += 1;
    const c = r.cost || {};
    let tc = (c.present && typeof c.totalCost === 'number') ? c.totalCost : null;
    if (tc == null && c.estimated && typeof c.estTotalCost === 'number') tc = c.estTotalCost;
    if (c.accruing || c.estimated) rollup.estIncluded = true;
    if (typeof tc === 'number' && Number.isFinite(tc)) { rollup.totalCost += tc; rollup.costKnown = true; }
  }
  // Recent-lane counts (#113): how many completed voyages sit in the harbour, and
  // how many shipped today. The fleet cost above stays in-flight only.
  rollup.recent = recentRuns.length;
  rollup.shippedToday = shippedToday;
  // Ready-to-merge count (#140) — reviewed-clean, mergeable, unmerged PRs awaiting a human.
  rollup.readyToMerge = readyToMergeRuns.length;

  // Waiting-runs dependency graph (#111) — the crows-nest scheduler-state producer
  // when present, else a best-effort graph inferred from bodies + file overlap.
  const scheduler = buildScheduler({
    runs, recentRuns, issues, prs, cap: maxConcurrentBuilds,
    schedState: (commissioned && ghOk) ? readSchedulerState() : null, repo,
  });
  rollup.waiting = scheduler.nodes.filter((n) => n.waiting).length;
  rollup.eligible = scheduler.nodes.filter((n) => n.waiting && n.eligible).length;
  rollup.held = scheduler.nodes.filter((n) => n.waiting && n.held).length;

  return {
    schema: 7,                         // schema 7 (#140): + readyToMerge[] — the human merge queue (reviewed-clean, mergeable, unmerged PRs, longest-waiting first); each in-flight PR run gains mergeable/readyToMerge/mergeCommand/waitingSince; rollup gains readyToMerge. schema 6 (#156): each in-flight run gains progress {pct, phase, estimate, terminal, source} — a coarse phase-derived % from the liveness beat (null when unavailable). schema 5 (#111): + scheduler {source, nodes, edges} — the waiting-runs dependency graph; rollup gains waiting/eligible/held. Additive — older tabs read tolerantly.
    appVersion: computeAppVersion(),   // content stamp of the shipped app, recomputed each snapshot (so a long-lived --watch producer re-stamps when the UI ships) → drives the tab's version self-reload (SKILL §6)
    estRatePerMin,                     // coarse USD/min burn rate the dashboard uses to live-tick an in-flight run's estimate off `costSince` (kept here so it's server-configurable and driver/dashboard agree)
    generatedAt: new Date().toISOString(),
    repo: repo || 'unknown',
    triggerLabel: label,
    commissioned,
    ghOk,
    stageNames: STAGES,
    stageCaptions: STAGE_CAPTIONS,
    groupNames: GROUPS,
    degraded: !commissioned || !ghOk
      ? (!commissioned ? 'uncommissioned — no .armada/config.json; no runs to show'
                       : 'gh query failed or unauthenticated; no runs to show')
      : null,
    runs,
    recentRuns,
    readyToMerge: readyToMergeRuns,    // #140 — the human merge queue (reviewed-clean, mergeable, unmerged PRs), longest-waiting first
    recentWindow,
    scheduler,
    rollup,
    summary: `runs ${runs.length} · blocked ${blockedCount} · ready ${rollup.readyToMerge} · recent ${recentRuns.length} · waiting ${rollup.waiting}`,
  };
}

// ---------------------------------------------------------------------------
// Output + browser open
// ---------------------------------------------------------------------------
function writeOutputs(outDir, state) {
  mkdirSync(outDir, { recursive: true });
  writeFileSync(path.join(outDir, 'run-state.json'), JSON.stringify(state, null, 2));
  const appSrc = path.join(__dirname, 'spyglass-run-app.html');
  const appDst = path.join(outDir, 'spyglass-run.html');
  if (existsSync(appSrc)) copyFileSync(appSrc, appDst);
  return { json: path.join(outDir, 'run-state.json'), html: appDst };
}

// Serve outDir over a throwaway localhost http server and open THAT — not the raw
// file:// path. The dashboard fetches `./run-state.json`; browsers block that fetch
// under the file:// origin, so a file:// open leaves it stuck on "waiting for
// run-state.json …". A minimal static server bound to 127.0.0.1 on an ephemeral
// port fixes it while keeping the driver READ-ONLY (it serves only the scratch
// outDir it just wrote — the snapshot + copied app — never the tracked repo, and
// answers GETs only). Contained to root: a requested path must resolve to root or
// under it, else 403. Returns a Promise of { url, close }.
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
};
function serveDir(dir, indexFile) {
  const root = path.resolve(dir);
  return new Promise((resolve, reject) => {
    const srv = http.createServer((req, res) => {
      const rel = decodeURIComponent((req.url || '/').split('?')[0]);
      const file = path.resolve(root, '.' + (rel === '/' ? '/' + indexFile : rel));
      if (file !== root && !file.startsWith(root + path.sep)) { res.writeHead(403); res.end('forbidden'); return; }
      try {
        const body = readFileSync(file);
        res.writeHead(200, { 'content-type': MIME[path.extname(file)] || 'application/octet-stream', 'cache-control': 'no-store' });
        res.end(body);
      } catch { res.writeHead(404); res.end('not found'); }
    });
    srv.on('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      resolve({ url: `http://127.0.0.1:${srv.address().port}/${indexFile}`, close: () => { try { srv.close(); } catch {} } });
    });
  });
}

// Open a URL (or path) in the OS default browser. Best-effort — the URL is also printed.
function openInBrowser(target) {
  const plat = process.platform;
  try {
    if (plat === 'win32') spawn('cmd', ['/c', 'start', '', target], { detached: true, stdio: 'ignore' }).unref();
    else if (plat === 'darwin') spawn('open', [target], { detached: true, stdio: 'ignore' }).unref();
    else spawn('xdg-open', [target], { detached: true, stdio: 'ignore' }).unref();
  } catch { /* non-fatal — the URL is printed */ }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
function main() {
  const args = parseArgs(process.argv.slice(2));
  const { config, commissioned } = readConfig();
  const label = args.label || config.triggerLabel || 'armada';
  const repo = resolveRepo(args.repo, config);
  const slug = (repo || 'local-repo').replace(/[^A-Za-z0-9._-]+/g, '-');
  const outDir = args.out || path.join(os.tmpdir(), 'armada-spyglass-run', slug);

  // Recent-voyages window (#113) — bounded + configurable: --flag > env > config > default.
  const sg = (config && config.spyglass) || {};
  const recentHours = resolveNum(args.recentHours, 'SPYGLASS_RECENT_HOURS', sg.recentWindowHours, 24);
  const recentCap = resolveNum(args.recentCap, 'SPYGLASS_RECENT_CAP', sg.recentCap, 12);
  // In-flight cost estimate burn rate (#115): coarse USD/min, --flag > env > config >
  // default. A deliberately rough heuristic (the fleet runs on subscriptions/relays,
  // not per-token billing) — clearly labelled an estimate on the dashboard. Default
  // ~$0.03/min (≈ $1.80/hr), in the ballpark of an Opus build's API-equivalent spend.
  // <=0 disables the estimate (in-flight runs then show "accruing…" with no number).
  const estRatePerMin = resolveNum(args.estBurn, 'SPYGLASS_EST_BURN_PER_MIN', sg.estBurnUsdPerMin, 0.03);
  // Build ceiling used only for the waiting-graph "queued: N/M builds in flight" reason
  // (#111) — mirrors crows-nest's maxConcurrentBuilds (§1); config, else default 3.
  const maxConcurrentBuilds = resolveNum(args.maxBuilds, 'ARMADA_MAX_BUILDS', config.maxConcurrentBuilds, 3);

  // GUARDRAIL 2 (#133) — served-dir sanity check. Runs for BOTH one-shot and watch
  // startups (writing to the wrong dir is a mistake either way); under --strict a
  // mismatch refuses BEFORE any snapshot / lock work.
  const served = resolveServedRoot(args.servedRoot, sg.servedRoot);
  checkServedRoot({ outDir, served, strict: !!args.strict });

  // GUARDRAIL 1 (#133) — single-driver lock. Only a --watch driver (a long-lived
  // producer) takes the lock; a one-shot snapshot is unaffected. A live holder →
  // refuse and name its pid; a dead holder's stale lock → transparently take over.
  if (args.watch > 0) {
    const lock = acquireWatchLock(outDir);
    if (!lock.ok) {
      const h = lock.holder || {};
      console.error(
        `spyglass-run: refusing to start — a live --watch driver already owns ${path.resolve(outDir)}\n` +
        `  held by pid ${h.pid}${h.startedAt ? ` (started ${h.startedAt})` : ''}.\n` +
        `  Stop that driver first (e.g. kill ${h.pid}), or point --out at a different dir.`,
      );
      process.exit(1);
    }
    if (lock.tookOver) {
      console.log(
        `spyglass-run: took over a stale lock — previous holder pid ${lock.tookOver.pid} is no longer running` +
        `${lock.tookOver.startedAt ? ` (started ${lock.tookOver.startedAt})` : ''}.`,
      );
    }
    installLockRelease(lock.lockPath, lock.nonce);
  }

  function once(firstRun) {
    const state = snapshot({ label, repo, commissioned, recentHours, recentCap, estRatePerMin, maxConcurrentBuilds });
    const out = writeOutputs(outDir, state);
    const d = state.degraded ? ` [degraded: ${state.degraded}]` : '';
    console.log(`spyglass-run: ${state.summary}${d}`);
    if (firstRun) {
      console.log(`spyglass-run: snapshot → ${out.json}`);
      console.log(`spyglass-run: view     → ${out.html}`);
    }
    return out;
  }

  const first = once(true);

  // Serve the scratch outDir over localhost and open THAT — a file:// open blocks
  // the app's fetch('./run-state.json'), leaving the dashboard stuck on "waiting
  // for run-state.json …". Keep the process alive to serve (a one-shot --open now
  // serves until Ctrl-C; --watch keeps re-snapshotting into the served dir).
  if (args.open !== false) {
    return serveDir(outDir, path.basename(first.html)).then((server) => {
      console.log(`spyglass-run: serving → ${server.url}`);
      openInBrowser(server.url);
      if (args.watch > 0) {
        console.log(`spyglass-run: watching — re-snapshotting every ${args.watch}s (Ctrl-C to stop)`);
        setInterval(() => once(false), args.watch * 1000);
      } else {
        console.log('spyglass-run: serving the dashboard — press Ctrl-C to stop');
      }
      return first;
    }).catch((e) => {
      // Server couldn't bind — degrade to a file:// open (fetch may be blocked) so
      // the run never hard-fails; the paths are already printed.
      console.log(`spyglass-run: could not start local server (${e.message}); opening file:// (fetch may be blocked)`);
      openInBrowser(first.html);
      if (args.watch > 0) {
        console.log(`spyglass-run: watching — re-snapshotting every ${args.watch}s (Ctrl-C to stop)`);
        setInterval(() => once(false), args.watch * 1000);
      }
      return first;
    });
  }

  // --no-open (e.g. the /loop pattern): just refresh the snapshot in place. A
  // separate --open/--watch process (or /spyglass-run) holds the served window.
  if (args.watch > 0) {
    console.log(`spyglass-run: watching — re-snapshotting every ${args.watch}s (Ctrl-C to stop)`);
    setInterval(() => once(false), args.watch * 1000);
  }
  return first;
}

// Run only when invoked as the entry script, so tests can `import` the guardrail
// helpers below without kicking off a live snapshot / watch loop.
const isEntry = process.argv[1]
  && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));
if (isEntry) main();

// Exported for unit tests (spyglass-run-snapshot.test.mjs) — the guardrail
// primitives. Importing this module never triggers main() (see isEntry above).
export {
  LOCK_NAME, LOCK_INFO, pidAlive, acquireWatchLock, releaseWatchLock,
  samePath, servedRootFromCommand, resolveServedRoot, checkServedRoot, parseArgs,
};
