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
//   record  --run <branch|issue> [--repo <owner/name>] [--out <dir>]
//           (--usage-json '<json>' | --usage-file <path> | stdin)
//       Accumulate one or more usage entries into out/costs/<run>.json.
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
//   check | --check
//       Doctor: print the baked price table + the resolved out dir. Writes NOTHING.

import { readFileSync, existsSync, mkdirSync, writeFileSync } from 'fs';
import path from 'path';

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
    '--issue', '--branch', '--worktree', '--started-at']);
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

function outDirOf(args) {
  return path.join(args.out || process.cwd(), 'out', 'costs');
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
  return { schema: 1, run, models: [], sessions: 0, subagents: 0, codex: 0, matchMode: 'heuristic', unpriced: [], totalCost: 0 };
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
  doc.updatedAt = new Date().toISOString();

  mkdirSync(dir, { recursive: true });
  writeFileSync(file, JSON.stringify(doc, null, 2));
  const rel = path.relative(process.cwd(), file).replace(/\\/g, '/');
  console.log(`spyglass-cost: ${rel} · ${doc.models.length} model(s) · total ${doc.totalCost == null ? 'n/a' : '$' + doc.totalCost.toFixed(2)}${doc.unpriced.length ? ' · unpriced ' + doc.unpriced.join(',') : ''}`);
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
    console.error('usage: spyglass-cost-postmortem.mjs record --run <branch|issue> [--usage-json <json>|--usage-file <path>|stdin]');
    console.error('       spyglass-cost-postmortem.mjs map --issue <n> --branch <b> [--worktree <path>] [--started-at <iso>]');
    console.error('       spyglass-cost-postmortem.mjs check');
    process.exitCode = 2;
  } catch (e) {
    // Side-channel by design (crows-nest §8g): never fatal to the caller — print
    // and exit non-zero so the tick can log-and-ignore, but do not throw.
    console.error(`spyglass-cost: ${e && e.message ? e.message : e}`);
    process.exitCode = 1;
  }
}

main();
