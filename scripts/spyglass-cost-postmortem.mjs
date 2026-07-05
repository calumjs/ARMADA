#!/usr/bin/env node
// ARMADA spyglass — cost post-mortem producer (crows-nest-side).
//
// This is the PRODUCER half of the per-run dashboard's cost + in-flight metadata.
// The read-only driver (`spyglass-run-snapshot.mjs`) and the dashboard only ever
// READ; this script is the one thing that WRITES the data they consume — and it
// writes ONLY under `out/costs/` (gitignored), never the tracked tree.
//
// crows-nest already receives each dispatched subagent's token usage on completion
// (build, the two review lenses, address rounds) plus any codex usage. At its
// reconcile points (crows-nest §8g) it hands that usage here, keyed by the run's
// branch (or issue number). This script accumulates it into a per-model breakdown
// with an API-EQUIVALENT cost estimate (not billing), so the dashboard's cost table
// shows REAL numbers instead of n/a, refreshed as the run progresses.
//
// It also records the run -> (branch, worktree) map the read-only driver consumes so
// an in-flight run's branch/worktree/folder surface BEFORE a PR exists.
//
// Dependency-free (Node built-ins only), to match validate-skills.
//
// Subcommands:
//   record  --run <branch|issue> [--final] [--repo <owner/name>] [--out <dir>]
//           (--usage-json '<json>' | --usage-file <path> | stdin)
//       Accumulate one or more usage entries into out/costs/<run>.json.
//       --final stamps `"final": true` — the run has reconciled its last usage
//       (the issue-shipped reconcile, crows-nest §5/§8g.ii). Without it the doc is
//       `"final": false`: real numbers RECORDED SO FAR, but the run is still
//       accruing (more usage to come at review/address/ship). The read-only
//       dashboard uses this to distinguish an in-flight/partial figure from the
//       final reconciled cost (spyglass §6). Once final, re-records stay final.
//       A usage entry (single object or an array of them):
//         { "role": "build"|"review"|"address"|"codex"|..., "model": "claude-opus-4-8",
//           "usage": { "input_tokens": N, "output_tokens": N,
//                      "cache_read_input_tokens": N, "cache_creation_input_tokens": N },
//           "toolUses": N, "durationMs": N,
//           "sessions": 1, "subagents": 1, "codex": 0 }
//       (usage keys are tolerant: in/out/cacheRead/cacheWrite aliases accepted.)
//
//   map     --issue <n> --branch <b> [--worktree <path>] [--started-at <iso>] [--out <dir>]
//       Record/refresh out/costs/_runs.json[<issue>] = { issue, branch, worktree, startedAt }
//       so the driver surfaces in-flight branch/worktree/folder before a PR exists.
//
//   schedule --nodes-json '<json>' --edges-json '<json>' [--max-builds N]
//            [--in-flight N] [--tick N] [--out <dir>]   (or a whole doc on stdin)
//       Expose the crows-nest scheduler-state (the waiting-runs dependency graph it
//       builds each tick, §2b/§2c) read-only for the dashboard: write
//       out/costs/_schedule.json = { schema, generatedAt, tick, maxConcurrentBuilds,
//       inFlightBuilds, nodes:[{ unit, number, held, eligible, reasons[], files[] }],
//       edges:[{ from, to, kind:'depends'|'same-file'|'lockfile'|'base', file?, reason,
//       satisfied }] }. The strictly read-only spyglass driver CONSUMES this file when
//       present (authoritative); absent it, it infers a best-effort graph itself. This
//       is the producer half of the waiting-graph view (spyglass §6, #111).
//
//   check | --check
//       Doctor: print the baked price table + the resolved out dir. Writes NOTHING.

import { readFileSync, existsSync, mkdirSync, writeFileSync } from 'fs';
import { execFileSync } from 'child_process';
import path from 'path';
import { fileURLToPath } from 'url';

// ---------------------------------------------------------------------------
// API-equivalent price table — USD per 1,000,000 tokens. An ESTIMATE, not billing
// (ARMADA runs on subscriptions/relays, not per-token API billing). Rates from the
// Claude API pricing the fleet's own models use; cache-read ~= 0.1x input, cache
// write (5m TTL) ~= 1.25x input. Matched to a model id HEURISTICALLY by substring
// (matchMode "heuristic"), so id variants (claude-opus-4-8, opus-4-8,
// us.anthropic.claude-opus-4-8, ...) all resolve. Models with no entry (codex /
// gpt-5.4 — the review second lens) are UNPRICED: their tokens still show, cost n/a.
// Keep in lockstep with the models ARMADA truly uses (skills/spyglass/SKILL.md §6).
const PRICES = [
  // [substring test, { in, out, cacheRead, cacheWrite } per 1M ]
  [/opus/i,   { in: 5,    out: 25,   cacheRead: 0.5,  cacheWrite: 6.25 }],
  [/sonnet/i, { in: 3,    out: 15,   cacheRead: 0.3,  cacheWrite: 3.75 }],
  [/haiku/i,  { in: 1,    out: 5,    cacheRead: 0.1,  cacheWrite: 1.25 }],
  // codex / GPT (the codex-rescue second lens) — no API-equivalent rate baked in.
  // Intentionally NOT priced: tokens are shown, cost renders n/a, id -> unpriced[].
];

function priceFor(model) {
  const m = String(model || '');
  for (const [re, rate] of PRICES) if (re.test(m)) return rate;
  return null; // unpriced (codex / gpt / unknown)
}

// ---------------------------------------------------------------------------
// Arg parsing (tolerant hand-rolled; a valued flag never swallows a following --flag)
// ---------------------------------------------------------------------------
function parseArgs(argv) {
  const args = { _: [] };
  const valued = new Set(['--run', '--repo', '--out', '--usage-json', '--usage-file',
    '--issue', '--branch', '--worktree', '--started-at',
    '--nodes-json', '--edges-json', '--nodes-file', '--edges-file',
    '--max-builds', '--in-flight', '--tick']);
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--check') { args.check = true; continue; }
    if (valued.has(a)) {
      const next = argv[i + 1];
      const v = (next && !next.startsWith('--')) ? argv[++i] : undefined;
      const key = a.slice(2).replace(/-([a-z])/g, (_, c) => c.toUpperCase()); // --started-at -> startedAt
      args[key] = v;
    } else if (a.startsWith('--')) {
      args[a.slice(2)] = true;
    } else {
      args._.push(a);
    }
  }
  return args;
}

// Resolve the CANONICAL repo root for cost data — the MAIN worktree, not whichever
// isolated build worktree this producer happens to be invoked from (#157). crows-nest
// dispatches each build into `.claude/worktrees/<agent>/`, and a reconcile that runs
// with its cwd inside that worktree would otherwise write `out/costs/<run>.json` there
// — where the read-only dashboard driver (which reads the MAIN repo's `out/costs/`)
// never looks, and which is DELETED when the worktree is cleaned up on ship. So a run's
// real cost + token data never survived to the board.
//
// `git rev-parse --git-common-dir` yields the SHARED `.git` (the main repo's) even from
// a linked worktree; its parent is the main worktree root. Every run — from any
// worktree — thus consolidates its cost file into the one main-repo `out/costs/`, where
// the driver reads and where it outlives worktree cleanup. Read-only w.r.t. git; on any
// failure (not a git repo, bare repo, git absent) it degrades to `cwd` — never throws.
function mainRepoRoot() {
  try {
    const common = execFileSync('git', ['rev-parse', '--path-format=absolute', '--git-common-dir'], {
      encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    if (!common) return process.cwd();
    // For the standard `<root>/.git` layout (main or linked worktree) the parent of the
    // common git dir is the main worktree root.
    const root = path.dirname(common);
    return root || process.cwd();
  } catch {
    return process.cwd();
  }
}

// The cost data dir. An explicit `--out` always wins (tests / an operator override).
// Absent it, consolidate into the MAIN repo's `out/costs/` (#157) rather than the raw
// cwd, so a reconcile invoked from inside a build worktree still lands where the
// dashboard driver reads and survives worktree cleanup.
function outDirOf(args) {
  const base = args.out || mainRepoRoot();
  return path.join(base, 'out', 'costs');
}

// Read `budget.perRunUSD` from .armada/config.json (read-only), for the
// quartermaster over-budget flag (#148). Returns a finite number or null. Never
// throws — a missing/malformed config just means "no per-run budget".
function readPerRunBudget(args) {
  const p = path.join(args.out || process.cwd(), '.armada', 'config.json');
  if (!existsSync(p)) return null;
  try {
    const cfg = JSON.parse(readFileSync(p, 'utf8'));
    const v = cfg && cfg.budget ? cfg.budget.perRunUSD : null;
    return typeof v === 'number' && Number.isFinite(v) ? v : (v != null && v !== '' && Number.isFinite(Number(v)) ? Number(v) : null);
  } catch { return null; }
}

const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : (Number.isFinite(Number(v)) && v !== '' && v != null ? Number(v) : null));
const nz = (v) => num(v) || 0;

// Pull the four token axes from a tolerant usage object.
function tokensOf(u) {
  u = u || {};
  return {
    in: nz(u.input_tokens ?? u.in ?? u.input),
    out: nz(u.output_tokens ?? u.out ?? u.output),
    cacheRead: nz(u.cache_read_input_tokens ?? u.cacheRead ?? u.cache_read ?? u.cacheR),
    cacheWrite: nz(u.cache_creation_input_tokens ?? u.cacheWrite ?? u.cache_write ?? u.cacheW),
  };
}

function costOfModel(model, t) {
  const rate = priceFor(model);
  if (!rate) return null;
  return (t.in / 1e6) * rate.in
    + (t.out / 1e6) * rate.out
    + (t.cacheRead / 1e6) * rate.cacheRead
    + (t.cacheWrite / 1e6) * rate.cacheWrite;
}

// ---------------------------------------------------------------------------
// record — accumulate usage into out/costs/<run>.json
// ---------------------------------------------------------------------------
function readUsageEntries(args) {
  let raw = null;
  if (args.usageJson) raw = args.usageJson;
  else if (args.usageFile) raw = readFileSync(args.usageFile, 'utf8');
  else {
    // stdin (best-effort; empty is fine for a metadata-only refresh)
    try { raw = readFileSync(0, 'utf8'); } catch { raw = ''; }
  }
  raw = (raw || '').trim();
  if (!raw) return [];
  let parsed;
  try { parsed = JSON.parse(raw); } catch { throw new Error('usage payload is not valid JSON'); }
  return Array.isArray(parsed) ? parsed : [parsed];
}

function loadDoc(file, run) {
  if (existsSync(file)) {
    try { return JSON.parse(readFileSync(file, 'utf8')); } catch { /* corrupt — restart */ }
  }
  return { schema: 1, run, models: [], sessions: 0, subagents: 0, codex: 0, matchMode: 'heuristic', unpriced: [], totalCost: 0, final: false, estimated: false };
}

function record(args) {
  const run = args.run;
  if (!run) throw new Error('record needs --run <branch|issue>');
  const dir = outDirOf(args);
  const file = path.join(dir, `${String(run).replace(/[\\/]/g, '-')}.json`);
  const doc = loadDoc(file, String(run));
  doc.run = String(run);

  // Index existing model rows for accumulation.
  const byModel = new Map();
  for (const m of (doc.models || [])) byModel.set(m.model, m);

  for (const entry of readUsageEntries(args)) {
    const model = String(entry.model || entry.name || 'unknown');
    const t = tokensOf(entry.usage || entry);
    let row = byModel.get(model);
    if (!row) { row = { model, in: 0, out: 0, cacheRead: 0, cacheWrite: 0, cost: null }; byModel.set(model, row); }
    row.in += t.in; row.out += t.out; row.cacheRead += t.cacheRead; row.cacheWrite += t.cacheWrite;
    // counts: a completion may represent claude sessions / subagents / codex runs.
    doc.sessions = nz(doc.sessions) + nz(entry.sessions);
    doc.subagents = nz(doc.subagents) + nz(entry.subagents);
    doc.codex = nz(doc.codex) + nz(entry.codex);
  }

  // Recompute per-model cost + the unpriced list + the total from the accumulated
  // token axes (idempotent w.r.t. the totals — no double counting on re-price).
  const unpriced = new Set();
  let total = 0; let anyPriced = false;
  doc.models = [];
  for (const row of byModel.values()) {
    const c = costOfModel(row.model, row);
    row.cost = (typeof c === 'number' && Number.isFinite(c)) ? Number(c.toFixed(4)) : null;
    if (row.cost == null) unpriced.add(row.model); else { total += row.cost; anyPriced = true; }
    doc.models.push(row);
  }
  doc.models.sort((a, b) => (b.cost || 0) - (a.cost || 0) || a.model.localeCompare(b.model));
  doc.unpriced = Array.from(unpriced);
  doc.matchMode = 'heuristic';
  doc.totalCost = anyPriced ? Number(total.toFixed(4)) : null;
  // The recorded figures are always REAL usage (never a live estimate — that is a
  // read-only, dashboard-side derivation from elapsed, spyglass §6). `final` marks
  // whether this is the last reconcile: --final (the ship reconcile) latches it true
  // and it never un-latches, so a re-record after ship can't demote a final run back
  // to accruing. Absent --final the doc is `final:false` = real-so-far, still accruing.
  doc.estimated = false;
  doc.final = !!args.final || !!doc.final;
  doc.updatedAt = new Date().toISOString();

  // quartermaster hook (issue #148): flag a run that overran its per-run budget on
  // its OWN post-mortem, so a governance overrun is recorded per run, not just in
  // aggregate. Read-only w.r.t. config; stamps `overBudget` when a real total
  // exceeds `budget.perRunUSD`. Absent/unset budget → cleared. Never fatal.
  const perRunUSD = readPerRunBudget(args);
  if (typeof perRunUSD === 'number' && Number.isFinite(perRunUSD) && typeof doc.totalCost === 'number') {
    doc.overBudget = doc.totalCost > perRunUSD
      ? { perRunUSD, totalCost: doc.totalCost, over: Number((doc.totalCost - perRunUSD).toFixed(4)) }
      : false;
  } else {
    delete doc.overBudget;
  }

  mkdirSync(dir, { recursive: true });
  writeFileSync(file, JSON.stringify(doc, null, 2));
  const rel = path.relative(process.cwd(), file).replace(/\\/g, '/');
  const over = doc.overBudget ? ` · ⚠ OVER per-run budget $${perRunUSD} (by $${doc.overBudget.over.toFixed(2)})` : '';
  console.log(`spyglass-cost: ${rel} · ${doc.models.length} model(s) · total ${doc.totalCost == null ? 'n/a' : '$' + doc.totalCost.toFixed(2)} · ${doc.final ? 'final' : 'accruing'}${doc.unpriced.length ? ' · unpriced ' + doc.unpriced.join(',') : ''}${over}`);
  return file;
}

// ---------------------------------------------------------------------------
// map — record/refresh the run -> (branch, worktree) map
// ---------------------------------------------------------------------------
function mapRun(args) {
  const issue = args.issue;
  if (!issue) throw new Error('map needs --issue <n>');
  const dir = outDirOf(args);
  const file = path.join(dir, '_runs.json');
  let doc = { schema: 1, runs: {} };
  if (existsSync(file)) {
    try {
      const parsed = JSON.parse(readFileSync(file, 'utf8'));
      doc = parsed && parsed.runs ? parsed : { schema: 1, runs: parsed || {} };
    } catch { /* corrupt — restart */ }
  }
  const key = String(issue);
  const prev = doc.runs[key] || {};
  doc.runs[key] = {
    issue: Number(issue),
    branch: args.branch || prev.branch || null,
    worktree: args.worktree || prev.worktree || null,
    startedAt: args.startedAt || prev.startedAt || new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  mkdirSync(dir, { recursive: true });
  writeFileSync(file, JSON.stringify(doc, null, 2));
  const rel = path.relative(process.cwd(), file).replace(/\\/g, '/');
  console.log(`spyglass-cost: ${rel} · run #${key} -> ${doc.runs[key].branch || '(no branch)'}${doc.runs[key].worktree ? ' @ ' + doc.runs[key].worktree : ''}`);
  return file;
}

// ---------------------------------------------------------------------------
// schedule — expose the crows-nest scheduler-state (waiting-runs graph) read-only
// for the dashboard (#111). crows-nest builds this graph every tick (§2b/§2c); this
// writes it to out/costs/_schedule.json, which the strictly read-only spyglass
// driver consumes (authoritative) when present. Additive, side-channel (§8g).
// ---------------------------------------------------------------------------
function schedule(args) {
  const dir = outDirOf(args);
  const file = path.join(dir, '_schedule.json');
  const parseArr = (json, fileArg) => {
    let raw = json;
    if (raw == null && fileArg) raw = readFileSync(fileArg, 'utf8');
    raw = (raw || '').trim();
    if (!raw) return null;
    let parsed;
    try { parsed = JSON.parse(raw); } catch { throw new Error('schedule payload is not valid JSON'); }
    return parsed;
  };
  let nodes = parseArr(args.nodesJson, args.nodesFile);
  let edges = parseArr(args.edgesJson, args.edgesFile);
  let tick = args.tick, maxBuilds = args.maxBuilds, inFlight = args.inFlight;
  // Whole-doc form on stdin ({ nodes, edges, tick, maxConcurrentBuilds, inFlightBuilds }).
  if (nodes == null && edges == null) {
    let raw = '';
    try { raw = readFileSync(0, 'utf8'); } catch { raw = ''; }
    raw = raw.trim();
    if (raw) {
      let doc;
      try { doc = JSON.parse(raw); } catch { throw new Error('schedule payload is not valid JSON'); }
      nodes = doc.nodes; edges = doc.edges;
      if (tick == null) tick = doc.tick;
      if (maxBuilds == null) maxBuilds = doc.maxConcurrentBuilds;
      if (inFlight == null) inFlight = doc.inFlightBuilds;
    }
  }
  nodes = Array.isArray(nodes) ? nodes : [];
  edges = Array.isArray(edges) ? edges : [];
  const normNodes = nodes.map((n) => {
    const out = {
      unit: n.unit === 'pr' ? 'pr' : 'issue',
      number: num(n.number),
      held: !!n.held,
      eligible: n.eligible != null ? !!n.eligible : !n.held,
      reasons: Array.isArray(n.reasons) ? n.reasons.map(String) : [],
      files: Array.isArray(n.files) ? n.files.map(String) : [],
    };
    if (n.title != null) out.title = String(n.title);
    return out;
  }).filter((n) => Number.isFinite(n.number));
  const KINDS = ['depends', 'same-file', 'lockfile', 'base'];
  const normEdges = edges.map((e) => ({
    from: num(e.from), to: num(e.to),
    kind: KINDS.includes(e.kind) ? e.kind : 'depends',
    file: e.file != null ? String(e.file) : null,
    reason: e.reason != null ? String(e.reason) : null,
    satisfied: !!e.satisfied,
  })).filter((e) => Number.isFinite(e.from) && Number.isFinite(e.to));
  const doc = {
    schema: 1,
    generatedAt: new Date().toISOString(),
    tick: num(tick),
    maxConcurrentBuilds: num(maxBuilds),
    inFlightBuilds: num(inFlight),
    nodes: normNodes,
    edges: normEdges,
  };
  mkdirSync(dir, { recursive: true });
  writeFileSync(file, JSON.stringify(doc, null, 2));
  const rel = path.relative(process.cwd(), file).replace(/\\/g, '/');
  console.log(`spyglass-cost: ${rel} · ${normNodes.length} node(s) · ${normEdges.length} edge(s) · ${normNodes.filter((n) => n.eligible).length} eligible`);
  return file;
}

// ---------------------------------------------------------------------------
// check — doctor (writes nothing)
// ---------------------------------------------------------------------------
function check(args) {
  console.log('spyglass-cost doctor — writes nothing');
  console.log(`  out dir: ${outDirOf(args)}`);
  console.log('  API-equivalent price table (USD per 1M tokens; estimate, not billing):');
  for (const [re, r] of PRICES) {
    console.log(`    ${String(re).replace(/[/ig]/g, '').padEnd(8)} in $${r.in}  out $${r.out}  cacheR $${r.cacheRead}  cacheW $${r.cacheWrite}`);
  }
  console.log('    codex/gpt: UNPRICED (tokens shown, cost n/a, id -> unpriced[])');
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
    if (cmd === 'map') return mapRun(args);
    if (cmd === 'schedule') return schedule(args);
    console.error('usage: spyglass-cost-postmortem.mjs record --run <branch|issue> [--final] [--usage-json <json>|--usage-file <path>|stdin]');
    console.error('       spyglass-cost-postmortem.mjs map --issue <n> --branch <b> [--worktree <path>] [--started-at <iso>]');
    console.error('       spyglass-cost-postmortem.mjs schedule --nodes-json <json> --edges-json <json> [--max-builds N] [--in-flight N] [--tick N]');
    console.error('       spyglass-cost-postmortem.mjs check');
    process.exitCode = 2;
  } catch (e) {
    // Side-channel by design (crows-nest §8g): never fatal to the caller — print
    // and exit non-zero so the tick can log-and-ignore, but do not throw.
    console.error(`spyglass-cost: ${e && e.message ? e.message : e}`);
    process.exitCode = 1;
  }
}

// Run as a CLI only when invoked directly — importing this module (e.g. the test
// harness) must NOT execute main(). Mirrors liveness-beat.mjs / consolidate-run-artifacts.mjs.
const isEntry = process.argv[1]
  && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));
if (isEntry) main();

export { mapRun, record, outDirOf, mainRepoRoot };
