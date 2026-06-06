#!/usr/bin/env node
// ARMADA spyglass — the lookout's instrument: a read-only snapshot of fleet
// state, rendered as a live, procedurally-charted sea view in the browser.
//
// This script is the data plumbing behind the spyglass skill. It reads the
// SAME GitHub state crows-nest §2a scans (`gh issue list` / `gh pr list` over
// the triggerLabel and its armada:* states), classifies every issue/PR into a
// ship on the chart, and writes a self-contained snapshot the bundled HTML app
// polls:
//
//   <outDir>/fleet-state.json   — the snapshot (issues, PRs, tick, health, seed)
//   <outDir>/spyglass.html      — the self-contained no-server visualisation
//                                 (copied from the bundled app next to this script)
//
// It is READ-ONLY with respect to the fleet: it runs only `gh ... list` and
// never mutates an issue, PR, or label. The only files it writes are the two
// above, in a scratch/output dir — never the tracked repo.
//
// Dependency-free (Node built-ins + the `gh` CLI only), to match
// scripts/validate-skills.mjs.
//
// Run:
//   node spyglass-snapshot.mjs [--label <triggerLabel>] [--out <dir>]
//                              [--repo <owner/name>] [--open] [--watch <seconds>]
//
// Flags:
//   --label   trigger label (default: .armada/config.json triggerLabel, else "armada")
//   --out     output dir for fleet-state.json + spyglass.html
//             (default: <os-tmp>/armada-spyglass/<repo-slug>)
//   --repo    owner/name to query (default: gh's current repo)
//   --open    open the rendered HTML in the OS default browser (one-shot)
//   --watch N re-snapshot every N seconds until interrupted (keeps the view live)
//   --no-open suppress the browser open even on a one-shot run

import { readFileSync, existsSync, mkdirSync, writeFileSync, copyFileSync, readdirSync, statSync } from 'fs';
import path from 'path';
import os from 'os';
import { fileURLToPath } from 'url';
import { execFileSync, spawn } from 'child_process';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

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
  }
  return args;
}

// ---------------------------------------------------------------------------
// Repo + config discovery (degrades gracefully on an uncommissioned repo)
// ---------------------------------------------------------------------------
function readConfig() {
  // Commissioning is a property of the WORKING repo (cwd), not of where this
  // script lives — an installed plugin is a cache copy that carries ARMADA's
  // own .armada/config.json, which must NOT mask an uncommissioned user repo.
  const p = path.join(process.cwd(), '.armada', 'config.json');
  if (existsSync(p)) {
    try { return { config: JSON.parse(readFileSync(p, 'utf8')), commissioned: true }; }
    catch { /* malformed — treat as uncommissioned */ }
  }
  return { config: {}, commissioned: false };
}

function ghJson(args) {
  // Returns parsed JSON from a `gh` invocation, or null on any failure.
  try {
    const out = execFileSync('gh', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    return JSON.parse(out);
  } catch {
    return null;
  }
}

function resolveRepo(explicit) {
  if (explicit) return explicit;
  const r = ghJson(['repo', 'view', '--json', 'nameWithOwner']);
  return r && r.nameWithOwner ? r.nameWithOwner : null;
}

// ---------------------------------------------------------------------------
// State classification — map real armada:* labels to chart ships
// ---------------------------------------------------------------------------
function labelNames(labels) {
  return (labels || []).map((l) => (typeof l === 'string' ? l : l.name)).filter(Boolean);
}

// Issues (horizon → harbour journey):
//   armada            → drift on the horizon (queued)
//   armada:underway   → set sail (building)
//   armada:done       → reach port (built; PR opening)
//   armada:blocked    → wrecked / storm-bound
function classifyIssue(labels) {
  const ls = labelNames(labels);
  if (ls.includes('armada:blocked')) return { state: 'blocked', zone: 'horizon', label: 'blocked' };
  if (ls.includes('armada:done')) return { state: 'done', zone: 'horizon', label: 'reached port' };
  if (ls.includes('armada:underway')) return { state: 'underway', zone: 'horizon', label: 'set sail' };
  return { state: 'queued', zone: 'horizon', label: 'drifting' };
}

// PRs (harbour pipeline):
//   armada            → arrive in harbour (ready)
//   armada:reviewing  → work the docks (under review)
//   armada:merged     → dock / unload (merging)
//   armada:shipped    → safely arrived
//   armada:blocked    → wrecked / storm-bound
function classifyPr(labels, isDraft) {
  const ls = labelNames(labels);
  if (ls.includes('armada:blocked')) return { state: 'blocked', zone: 'harbour', label: 'blocked' };
  if (ls.includes('armada:shipped')) return { state: 'shipped', zone: 'harbour', label: 'safely arrived' };
  if (ls.includes('armada:merged')) return { state: 'merged', zone: 'harbour', label: 'docking' };
  if (ls.includes('armada:reviewing')) return { state: 'reviewing', zone: 'harbour', label: 'at the docks' };
  if (isDraft) return { state: 'draft', zone: 'harbour', label: 'fitting out' };
  return { state: 'ready', zone: 'harbour', label: 'arrived in harbour' };
}

// ---------------------------------------------------------------------------
// crows-nest §2c style tick: what would be dispatched vs held, and why.
// This mirrors the scheduler's vantage WITHOUT mutating anything — it's a
// read-only narration of the current frontier, not a dispatch.
// ---------------------------------------------------------------------------
function deriveTick(issues, prs, config) {
  const dispatched = [];
  const held = [];

  // Issue eligibility (§2a): queued issues are runnable; underway/done/blocked
  // are already claimed or terminal and sit out the frontier.
  for (const it of issues) {
    if (it.ship.state === 'queued') {
      dispatched.push({ kind: 'issue', number: it.number, title: it.title, action: 'build' });
    } else if (it.ship.state === 'blocked') {
      held.push({ kind: 'issue', number: it.number, title: it.title, reason: 'blocked — needs a human' });
    }
  }

  // PR eligibility (§3a): ready PRs (not draft, not terminal, CI not red) are
  // runnable; reviewing/merged are in flight; blocked sits out.
  for (const pr of prs) {
    const ci = (pr.statusCheckRollup || '').toString().toLowerCase();
    if (pr.ship.state === 'ready' && pr.ci !== 'red') {
      dispatched.push({ kind: 'pr', number: pr.number, title: pr.title, action: 'review' });
    } else if (pr.ship.state === 'ready' && pr.ci === 'red') {
      held.push({ kind: 'pr', number: pr.number, title: pr.title, reason: 'CI failing' });
    } else if (pr.ship.state === 'blocked') {
      held.push({ kind: 'pr', number: pr.number, title: pr.title, reason: 'blocked — needs a human' });
    }
  }

  const blockedCount =
    issues.filter((i) => i.ship.state === 'blocked').length +
    prs.filter((p) => p.ship.state === 'blocked').length;

  // Fleet health → weather. Storms when anything is blocked; choppy when busy.
  let weather = 'calm';
  if (blockedCount > 0) weather = 'storm';
  else if (dispatched.length > 0) weather = 'choppy';

  return {
    at: new Date().toISOString(),
    dispatched,
    held,
    blockedCount,
    weather,
    summary:
      `horizon ${issues.length} · harbour ${prs.length} · ` +
      `dispatch ${dispatched.length} · hold ${held.length} · blocked ${blockedCount}`,
  };
}

// ---------------------------------------------------------------------------
// Seed from repo identity → a stable, recognisable coastline run-to-run.
// A simple deterministic 32-bit hash of the repo slug.
// ---------------------------------------------------------------------------
function seedFromRepo(slug) {
  let h = 2166136261 >>> 0; // FNV-1a
  const s = slug || 'armada';
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619) >>> 0;
  }
  return h >>> 0;
}

// ---------------------------------------------------------------------------
// Cartography layer — OPTIONAL enrichment from .armada/cartography/ (issue #45,
// building in parallel). Spyglass must render fully WITHOUT it: if the dir is
// absent we degrade the layer to off and say so.
// ---------------------------------------------------------------------------
function readCartography() {
  const dir = path.join(process.cwd(), '.armada', 'cartography');
  if (!existsSync(dir)) return { present: false, note: 'no .armada/cartography/ — layer off' };
  try {
    const files = readdirSync(dir).filter((f) => statSync(path.join(dir, f)).isFile());
    return { present: true, files, note: `${files.length} cartography file(s)` };
  } catch {
    return { present: false, note: 'cartography dir unreadable — layer off' };
  }
}

// ---------------------------------------------------------------------------
// Snapshot — the read-only scan + classify + write.
// ---------------------------------------------------------------------------
function snapshot({ label, repo, commissioned }) {
  const repoArgs = repo ? ['--repo', repo] : [];

  // §2a queries — issue list + PR list, --json projected, read-only.
  const rawIssues = commissioned
    ? ghJson([
        'issue', 'list', ...repoArgs, '--label', label, '--state', 'open',
        '--json', 'number,title,labels,createdAt,assignees,author,body', '--limit', '50',
      ])
    : null;
  const rawPrs = commissioned
    ? ghJson([
        'pr', 'list', ...repoArgs, '--label', label, '--state', 'open',
        '--json', 'number,title,isDraft,labels,headRefName,baseRefName,mergeable,statusCheckRollup,updatedAt', '--limit', '50',
      ])
    : null;

  const ghOk = rawIssues !== null || rawPrs !== null;

  const issues = (rawIssues || []).map((it) => ({
    number: it.number,
    title: it.title,
    author: it.author && it.author.login,
    createdAt: it.createdAt,
    ship: classifyIssue(it.labels),
  }));

  const prs = (rawPrs || []).map((pr) => {
    const roll = Array.isArray(pr.statusCheckRollup) ? pr.statusCheckRollup : [];
    const states = roll.map((c) => (c.conclusion || c.state || '').toString().toUpperCase());
    let ci = 'none';
    if (states.length) {
      if (states.some((s) => s === 'FAILURE' || s === 'ERROR' || s === 'CANCELLED' || s === 'TIMED_OUT')) ci = 'red';
      else if (states.some((s) => s === 'PENDING' || s === 'IN_PROGRESS' || s === 'QUEUED' || s === 'EXPECTED')) ci = 'pending';
      else ci = 'green';
    }
    return {
      number: pr.number,
      title: pr.title,
      isDraft: pr.isDraft,
      headRefName: pr.headRefName,
      updatedAt: pr.updatedAt,
      ci,
      ship: classifyPr(pr.labels, pr.isDraft),
    };
  });

  const cartography = readCartography();
  const tick = deriveTick(issues, prs, {});

  return {
    schema: 1,
    generatedAt: new Date().toISOString(),
    repo: repo || 'unknown',
    triggerLabel: label,
    commissioned,
    ghOk,
    seed: seedFromRepo(repo),
    degraded: !commissioned || !ghOk
      ? (!commissioned ? 'uncommissioned — no .armada/config.json; rendering an empty sea'
                       : 'gh query failed or unauthenticated; rendering an empty sea')
      : null,
    cartography,
    issues,
    prs,
    tick,
  };
}

// ---------------------------------------------------------------------------
// Output: ensure the bundled app + the snapshot live side by side in outDir.
// ---------------------------------------------------------------------------
function writeOutputs(outDir, state) {
  mkdirSync(outDir, { recursive: true });
  writeFileSync(path.join(outDir, 'fleet-state.json'), JSON.stringify(state, null, 2));
  // Copy the bundled self-contained HTML app next to the snapshot so it can
  // fetch ./fleet-state.json with no server.
  const appSrc = path.join(__dirname, 'spyglass-app.html');
  const appDst = path.join(outDir, 'spyglass.html');
  if (existsSync(appSrc)) copyFileSync(appSrc, appDst);
  return { json: path.join(outDir, 'fleet-state.json'), html: appDst };
}

function openInBrowser(htmlPath) {
  const plat = process.platform;
  try {
    if (plat === 'win32') spawn('cmd', ['/c', 'start', '', htmlPath], { detached: true, stdio: 'ignore' }).unref();
    else if (plat === 'darwin') spawn('open', [htmlPath], { detached: true, stdio: 'ignore' }).unref();
    else spawn('xdg-open', [htmlPath], { detached: true, stdio: 'ignore' }).unref();
  } catch {
    // Non-fatal — the path is printed; the user can open it manually.
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
function main() {
  const args = parseArgs(process.argv.slice(2));
  const { config, commissioned } = readConfig();
  const label = args.label || config.triggerLabel || 'armada';
  const repo = resolveRepo(args.repo);
  const slug = (repo || 'local-repo').replace(/[^A-Za-z0-9._-]+/g, '-');
  const outDir = args.out || path.join(os.tmpdir(), 'armada-spyglass', slug);

  function once(firstRun) {
    const state = snapshot({ label, repo, commissioned });
    const out = writeOutputs(outDir, state);
    const d = state.degraded ? ` [degraded: ${state.degraded}]` : '';
    console.log(
      `spyglass: ${state.tick.summary} · weather ${state.tick.weather}` +
      `${state.cartography.present ? ' · cartography on' : ' · cartography off'}${d}`
    );
    if (firstRun) {
      console.log(`spyglass: snapshot → ${out.json}`);
      console.log(`spyglass: view    → ${out.html}`);
      // Open on a one-shot run, or on the first iteration of a watch. Default
      // to opening unless explicitly suppressed.
      if (args.open !== false) openInBrowser(out.html);
    }
    return out;
  }

  const first = once(true);

  if (args.watch > 0) {
    console.log(`spyglass: watching — re-snapshotting every ${args.watch}s (Ctrl-C to stop)`);
    setInterval(() => once(false), args.watch * 1000);
  }
  return first;
}

main();
