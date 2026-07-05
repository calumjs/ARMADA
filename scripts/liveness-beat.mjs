#!/usr/bin/env node
// ARMADA fleet — agent liveness beat (agent-side producer + reader classifier).
//
// WHY (real incident, issue #134): a slow-but-healthy build/review agent was
// misdiagnosed as 'stalled' FIVE times in one session because the crows-nest
// guessed on a frozen output-file mtime. A stale mtime does NOT mean wedged — a
// FINISHED agent goes quiet, and a long SINGLE tool call (e.g. a headless
// screenshot render, muster §1b) freezes mtime while the agent works normally.
// One false positive killed an agent that had already committed + pushed and was
// one step from opening its PR (recovered only by luck).
//
// THE SIGNAL. Instead of mtime, an agent emits a coarse LIVENESS BEAT carrying a
// PHASE (worktree / implementing / validating / visual-inspection / opening-pr /
// …) and a MONOTONIC step counter, and writes a TERMINAL MARKER when it finishes.
// A reader (crows-nest) classifies each in-flight run into one of:
//   working — beat is fresh, OR within a PHASE-AWARE grace (so a long single tool
//             call in a known-long phase like visual-inspection is NOT a stall).
//   done    — a terminal marker is present (quiet-after-done is unambiguous).
//   wedged  — no terminal marker AND no beat within the phase's grace (genuinely
//             stuck: no step progress past a phase-aware timeout).
//   unknown — no beat file yet (agent may not have started emitting) — treated
//             CONSERVATIVELY by the reader, never as wedged.
//
// RE-ARM ACROSS DISPATCHES. A branch is NOT one dispatch — it flows through several
// back-to-back ones over its lifecycle: build -> review -> address-review -> rebase.
// Each is a fresh subagent that emits its own beats, and shipwright's build ends by
// latching a TERMINAL marker. If that latch stuck forever it would short-circuit
// EVERY later dispatch on the same branch to 'done', blinding wedged-detection for
// muster's visual-inspection and the addressing/rebasing rounds. So the FIRST beat
// of a new dispatch RE-ARMS the run: a `beat` on an already-terminal doc clears the
// terminal marker and bumps a monotonic `lifecycle` counter, making that dispatch
// classifiable as working/wedged again. `done` is only ever written last in a
// dispatch, so a beat arriving after it always belongs to the NEXT dispatch —
// re-arming can never revive a genuinely-finished agent (it has already returned).
//
// This is the AGENT-side producer half (shipwright/muster subagents call `beat`
// and `done`) plus a reader-side `classify` that centralises the phase-aware
// timeout math so crows-nest never re-implements it. It writes ONLY under
// `out/liveness/` (gitignored), never the tracked tree — same side-channel
// discipline as the spyglass cost producer (crows-nest §8g). Dependency-free
// (Node built-ins only), to match validate-skills.
//
// Subcommands:
//   beat  --run <branch|issue> --phase <phase> [--step N] [--pid N] [--note <t>] [--out <dir>]
//       Emit/refresh a beat for a run: bump the monotonic step, stamp the phase
//       and current time into out/liveness/<run>.json. Call it when ENTERING each
//       coarse phase (and optionally at long-phase checkpoints). Cheap, synchronous,
//       never throws.
//
//   done  --run <branch|issue> [--status <s>] [--reason <t>] [--out <dir>]
//       Write the TERMINAL marker: terminal:true, status, endedAt. The run then
//       classifies 'done' until the NEXT dispatch's first `beat` re-arms it (see
//       RE-ARM above) — a finished agent going quiet is never mistaken for wedged,
//       yet a later dispatch on the same branch is not blinded. Status is free-text
//       (opened|blocked|shipped|reviewed|merged|…); default 'done'.
//
//   classify [--run <branch|issue>] [--now <epoch-ms>] [--out <dir>]
//       Reader side. With --run, classify that one run; without, classify every
//       run file in the dir. Prints a JSON classification (stdout) the reader
//       consumes: { run, state, phase, step, terminal, beatAt, sinceMs, graceMs,
//       reason, … }. Applies the PHASE_GRACE table below. Writes NOTHING.
//
//   check | --check
//       Doctor: print the phase-grace table + the resolved out dir. Writes NOTHING.

import { readFileSync, existsSync, mkdirSync, writeFileSync, readdirSync } from 'fs';
import { execFileSync } from 'child_process';
import path from 'path';
import { fileURLToPath } from 'url';

// ---------------------------------------------------------------------------
// PHASE-AWARE grace table — how long a phase may legitimately go WITHOUT a beat
// before a reader may consider the run wedged (ms). The whole point of the signal:
// a phase known to run one long native tool call (a headless render, a full test
// suite) gets a generous grace, so a healthy agent inside it is NOT a false stall.
// Matched case-insensitively; an UNRECOGNISED phase falls back to DEFAULT_GRACE
// (permissive by design — a reader fails safe toward 'working', never kills on a
// phase it doesn't know). Coarse names align with shipwright's stages (§4–§7) and
// muster's (§1/§1b). Keep in lockstep with the SKILL.md docs.
const MIN = 60_000;
const PHASE_GRACE = {
  research:            10 * MIN, // §2 research + gather context
  planning:            10 * MIN, // §3 plan (may pause on a plan sign-off)
  worktree:             5 * MIN, // §4 create worktree
  implementing:        20 * MIN, // §5 implement — long edit/tool sequences
  validating:          15 * MIN, // §6 validate — a test suite can run long
  'visual-inspection':  8 * MIN, // muster §1b — ONE long headless render call
  addressing:          20 * MIN, // shipwright §11 address-review round
  rebasing:            15 * MIN, // shipwright §12 rebase
  reviewing:           15 * MIN, // muster §1 two-lens review fan-out
  posting:              6 * MIN, // muster §3 post the review (inline gh api comments)
  'opening-pr':         6 * MIN, // §7 open the PR (the near-miss step in #134)
};
const DEFAULT_GRACE = 12 * MIN;

function graceFor(phase) {
  const p = String(phase || '').trim().toLowerCase();
  if (Object.prototype.hasOwnProperty.call(PHASE_GRACE, p)) return PHASE_GRACE[p];
  return DEFAULT_GRACE;
}

// ---------------------------------------------------------------------------
// PHASE→PROGRESS map (issue #156) — a COARSE, honest progress estimate (0..100)
// derived from the same phase a run beats. It is deliberately an ESTIMATE: labels
// don't expose true sub-step progress, so a phase-derived % is the soundest honest
// signal. It never stalls the fleet (a pure display derivation on the reader side)
// and degrades to null on an unrecognised phase (→ the dashboard shows NO bar).
//
// The ladders mirror shipwright's stages (§0a/§2–§7/§11–§12) and muster's (§0b/§1–§3):
//   shipwright: research 10 → planning 20 → worktree 25 → implementing 40 →
//               validating 75 → (addressing 60, rebasing 80) → opening-pr 95
//   muster:     reviewing 40 → visual-inspection 70 → posting 90
//   done:       100 (terminal marker present)
// Matched case-insensitively; an UNRECOGNISED phase → null (no honest estimate →
// no bar). Keep in lockstep with the SKILL.md docs + the liveness reference.
const PHASE_PROGRESS = {
  research:            10,
  planning:            20,
  worktree:            25,
  implementing:        40,
  validating:          75,
  addressing:          60,
  rebasing:            80,
  'opening-pr':        95,
  reviewing:           40,
  'visual-inspection': 70,
  posting:             90,
  done:               100,
};

// Coarse progress % (0..100) for a phase, or null when the phase is unrecognised
// (the reader then shows no bar — degrade cleanly). A terminal run is handled by
// the caller (classifyDoc) as 100 regardless of the last phase.
function progressFor(phase) {
  const p = String(phase || '').trim().toLowerCase();
  if (Object.prototype.hasOwnProperty.call(PHASE_PROGRESS, p)) return PHASE_PROGRESS[p];
  return null;
}

// ---------------------------------------------------------------------------
// Arg parsing (tolerant hand-rolled; a valued flag never swallows a following --flag)
// ---------------------------------------------------------------------------
function parseArgs(argv) {
  const args = { _: [] };
  const valued = new Set(['--run', '--phase', '--step', '--pid', '--note',
    '--status', '--reason', '--now', '--out']);
  // A valued flag consumes the next token as its value UNLESS that token is itself a
  // KNOWN flag — so it never swallows a following real flag, yet a free-text value
  // that merely starts with '--' (e.g. --note "--x broke") is kept, not mis-parsed
  // as a spurious boolean. (Nit: informational --note/--reason are the case here.)
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

// Resolve the CANONICAL repo root for liveness data — the MAIN worktree, not whichever
// isolated build worktree this producer happens to be invoked from (#170). This mirrors
// the spyglass cost producer (spyglass-cost-postmortem.mjs mainRepoRoot): crows-nest
// dispatches each build into `.claude/worktrees/<agent>/`, and a subagent that beats with
// its cwd inside that worktree would otherwise write `out/liveness/<run>.json` THERE —
// where the read-only dashboard driver (which reads the MAIN repo's `out/liveness/`) never
// looks, and which is DELETED when the worktree is reaped on ship. So a run's progress beat
// never survived to the board (the exact defect #170 was chartered on: an in-flight build's
// worktree had no out/liveness the dashboard could read).
//
// `git rev-parse --git-common-dir` yields the SHARED `.git` (the main repo's) even from a
// linked worktree; its parent is the main worktree root. Every run — from any worktree —
// thus consolidates its beat into the one main-repo `out/liveness/`, where the reader
// classifies (crows-nest §2d) and where it outlives worktree cleanup. This is ALSO the
// path-resolution fix (AC-5): the beat lands in the right place WITHOUT depending on
// `${CLAUDE_PLUGIN_ROOT}` resolving inside the worktree. Read-only w.r.t. git; on any
// failure (not a git repo, bare repo, git absent) it degrades to `cwd` — never throws.
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

// The liveness data dir. An explicit `--out` always wins (tests / an operator override).
// Absent it, consolidate into the MAIN repo's `out/liveness/` (#170) rather than the raw
// cwd, so a beat emitted from inside a build worktree still lands where the dashboard
// driver reads and survives worktree cleanup.
function outDirOf(args) {
  const base = args.out || mainRepoRoot();
  return path.join(base, 'out', 'liveness');
}

const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : (Number.isFinite(Number(v)) && v !== '' && v != null ? Number(v) : null));
const fileFor = (dir, run) => path.join(dir, `${String(run).replace(/[\\/]/g, '-')}.json`);

function loadDoc(file, run) {
  if (existsSync(file)) {
    try { return JSON.parse(readFileSync(file, 'utf8')); } catch { /* corrupt — restart */ }
  }
  return { schema: 1, run: String(run), phase: null, step: 0, lifecycle: 1, pid: null,
    note: null, startedAt: null, beatAt: null, beatTs: null, terminal: false,
    status: null, reason: null, endedAt: null };
}

// ---------------------------------------------------------------------------
// beat — bump the monotonic step, stamp the phase + current time.
// ---------------------------------------------------------------------------
function beat(args) {
  const run = args.run;
  if (!run) throw new Error('beat needs --run <branch|issue>');
  if (!args.phase) throw new Error('beat needs --phase <phase>');
  const dir = outDirOf(args);
  const file = fileFor(dir, run);
  const doc = loadDoc(file, run);
  const now = Date.now();
  // step is MONOTONIC: max(existing+1, explicit --step). A reader comparing two
  // reads sees it advance => forward progress even inside one long phase.
  const explicit = num(args.step);
  doc.step = Math.max((num(doc.step) || 0) + 1, explicit != null ? explicit : 0);
  doc.run = String(run);
  doc.phase = String(args.phase);
  if (args.pid != null) doc.pid = num(args.pid);
  else if (doc.pid == null) doc.pid = process.ppid || null;
  doc.note = args.note != null ? String(args.note) : null;
  // RE-ARM: a beat on an already-terminal run is the FIRST beat of a NEW dispatch on
  // this branch (build -> review -> address-review -> rebase are separate dispatches;
  // `done` is only ever written last, so nothing else beats after it within a
  // dispatch). Clear the latched terminal marker and bump the lifecycle so this fresh
  // dispatch is classifiable as working/wedged again instead of short-circuiting to
  // 'done'. This can never revive a truly-finished agent — that agent has returned
  // and will emit no further beats.
  if (doc.terminal) {
    doc.terminal = false;
    doc.lifecycle = (num(doc.lifecycle) || 1) + 1;
    doc.status = null;
    doc.reason = null;
    doc.endedAt = null;
    doc.startedAt = new Date(now).toISOString(); // this dispatch's own start
  } else {
    doc.startedAt = doc.startedAt || new Date(now).toISOString();
  }
  if (doc.lifecycle == null) doc.lifecycle = 1;
  doc.beatAt = new Date(now).toISOString();
  doc.beatTs = now;
  mkdirSync(dir, { recursive: true });
  writeFileSync(file, JSON.stringify(doc, null, 2));
  const rel = path.relative(process.cwd(), file).replace(/\\/g, '/');
  console.log(`liveness: ${rel} · ${doc.phase} · step ${doc.step} · grace ${Math.round(graceFor(doc.phase) / MIN)}m`);
  return file;
}

// ---------------------------------------------------------------------------
// done — write the latched terminal marker.
// ---------------------------------------------------------------------------
function done(args) {
  const run = args.run;
  if (!run) throw new Error('done needs --run <branch|issue>');
  const dir = outDirOf(args);
  const file = fileFor(dir, run);
  const doc = loadDoc(file, run);
  const now = Date.now();
  doc.run = String(run);
  doc.step = (num(doc.step) || 0) + 1;
  if (doc.lifecycle == null) doc.lifecycle = 1;
  doc.phase = 'done';
  doc.terminal = true; // terminal for THIS dispatch; the next dispatch's first beat re-arms it
  doc.status = args.status != null ? String(args.status) : 'done';
  doc.reason = args.reason != null ? String(args.reason) : null;
  doc.endedAt = new Date(now).toISOString();
  doc.beatAt = new Date(now).toISOString();
  doc.beatTs = now;
  mkdirSync(dir, { recursive: true });
  writeFileSync(file, JSON.stringify(doc, null, 2));
  const rel = path.relative(process.cwd(), file).replace(/\\/g, '/');
  console.log(`liveness: ${rel} · DONE (${doc.status}) · step ${doc.step}`);
  return file;
}

// ---------------------------------------------------------------------------
// classify — reader side. Apply the phase-aware grace; never writes.
// ---------------------------------------------------------------------------
function classifyDoc(doc, now) {
  const step = num(doc.step) || 0;
  const phase = doc.phase || null;
  const base = { run: doc.run, phase, step, lifecycle: num(doc.lifecycle) || 1,
    pid: doc.pid ?? null, terminal: !!doc.terminal, beatAt: doc.beatAt || null,
    startedAt: doc.startedAt || null,
    // COARSE progress estimate (#156) — phase-derived %, or null when the phase is
    // unrecognised. A terminal run reads 100 (below). Honest: it's an estimate.
    progress: progressFor(phase) };
  if (doc.terminal) {
    // A finished agent is NEVER wedged — the terminal marker is the whole point.
    return { ...base, progress: 100, state: 'done', status: doc.status || 'done',
      sinceMs: null, graceMs: null,
      reason: `terminal marker present (${doc.status || 'done'}) — done, not wedged` };
  }
  const beatTs = num(doc.beatTs);
  const grace = graceFor(phase);
  if (beatTs == null) {
    return { ...base, state: 'unknown', sinceMs: null, graceMs: grace,
      reason: 'beat file present but no beat timestamp — treat conservatively, not wedged' };
  }
  const sinceMs = Math.max(0, now - beatTs);
  if (sinceMs <= grace) {
    return { ...base, state: 'working', sinceMs, graceMs: grace,
      reason: `phase '${phase}' beat ${Math.round(sinceMs / 1000)}s ago, within ${Math.round(grace / MIN)}m grace` };
  }
  return { ...base, state: 'wedged', sinceMs, graceMs: grace,
    reason: `no beat for ${Math.round(sinceMs / MIN)}m in phase '${phase}' (grace ${Math.round(grace / MIN)}m) and no terminal marker — genuinely stuck` };
}

function classify(args) {
  const dir = outDirOf(args);
  const now = num(args.now) != null ? num(args.now) : Date.now();
  const readOne = (run) => {
    const file = fileFor(dir, run);
    if (!existsSync(file)) {
      // No beat file at all: the agent may not have started emitting yet. A reader
      // must NOT treat this as wedged — fall back to its own conservative grace.
      return { run: String(run), state: 'unknown', phase: null, step: 0,
        terminal: false, beatAt: null, sinceMs: null, graceMs: null,
        reason: 'no liveness beat file — agent may not have started emitting; do not classify as wedged' };
    }
    let doc;
    try { doc = JSON.parse(readFileSync(file, 'utf8')); }
    catch { return { run: String(run), state: 'unknown', reason: 'beat file unreadable/corrupt — treat conservatively' }; }
    return classifyDoc(doc, now);
  };
  let result;
  if (args.run) {
    result = readOne(args.run);
  } else {
    const runs = [];
    if (existsSync(dir)) {
      for (const f of readdirSync(dir)) {
        if (!f.endsWith('.json') || f.startsWith('_')) continue;
        try { runs.push(classifyDoc(JSON.parse(readFileSync(path.join(dir, f), 'utf8')), now)); }
        catch {
          // A corrupt/truncated file must SURFACE as unknown, not silently vanish
          // from the multi-run overview — a live-but-mid-write run is still a run.
          runs.push({ run: f.replace(/\.json$/, ''), state: 'unknown', phase: null,
            step: 0, lifecycle: 1, terminal: false, beatAt: null, sinceMs: null,
            graceMs: null, reason: 'beat file unreadable/corrupt — treat conservatively, not wedged' });
        }
      }
    }
    result = runs;
  }
  console.log(JSON.stringify(result, null, 2));
  return result;
}

// ---------------------------------------------------------------------------
// check — doctor (writes nothing)
// ---------------------------------------------------------------------------
function check(args) {
  console.log('liveness-beat doctor — writes nothing');
  console.log(`  out dir: ${outDirOf(args)}`);
  console.log('  phase-aware grace table (no beat for longer => a reader may call it wedged):');
  for (const [p, g] of Object.entries(PHASE_GRACE)) {
    console.log(`    ${p.padEnd(20)} ${Math.round(g / MIN)}m`);
  }
  console.log(`    ${'(any other phase)'.padEnd(20)} ${Math.round(DEFAULT_GRACE / MIN)}m  (default — permissive)`);
  console.log('  phase→progress map (#156) — coarse HONEST estimate surfaced on spyglass in-flight cards:');
  for (const [p, pct] of Object.entries(PHASE_PROGRESS)) {
    console.log(`    ${p.padEnd(20)} ${String(pct).padStart(3)}%`);
  }
  console.log(`    ${'(any other phase)'.padEnd(20)}   —   (no estimate → no bar)`);
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
    if (cmd === 'beat') return beat(args);
    if (cmd === 'done') return done(args);
    if (cmd === 'classify') return classify(args);
    console.error('usage: liveness-beat.mjs beat --run <branch|issue> --phase <phase> [--step N] [--pid N] [--note <t>]');
    console.error('       liveness-beat.mjs done --run <branch|issue> [--status <s>] [--reason <t>]');
    console.error('       liveness-beat.mjs classify [--run <branch|issue>] [--now <epoch-ms>]');
    console.error('       liveness-beat.mjs check');
    process.exitCode = 2;
  } catch (e) {
    // Side-channel by design: never fatal to the caller — print and exit non-zero
    // so the agent/tick can log-and-ignore, but do not throw.
    console.error(`liveness: ${e && e.message ? e.message : e}`);
    process.exitCode = 1;
  }
}

// Run only when invoked as the entry script, so other modules (e.g. the spyglass
// snapshot driver, #156) can `import` the phase→progress map + progressFor without
// kicking off a beat/classify. Importing this module has no side effects.
const isEntry = process.argv[1]
  && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));
if (isEntry) main();

// Exported for consumers (the spyglass snapshot threads the phase→% into run-state.json)
// and unit tests. Importing never triggers main() (see isEntry above).
export { PHASE_PROGRESS, progressFor, PHASE_GRACE, graceFor, classifyDoc, mainRepoRoot, outDirOf };
