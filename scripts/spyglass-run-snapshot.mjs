#!/usr/bin/env node
// ARMADA spyglass — per-run operations dashboard (data plumbing).
//
// Companion mode to `spyglass` (the sea-chart). Where spyglass renders the WHOLE
// fleet as an animated chart, this renders each IN-FLIGHT run as a focused detail
// card: a 12-stage pipeline, worktree/branch/folder metadata, the logbook "done
// video", and a per-model cost table.
//
// It is READ-ONLY with respect to the fleet, exactly like spyglass/crows-nest:
//   * GitHub reads only — `gh repo view`, `gh issue list`, `gh pr list`, and
//     GET-only `gh api .../releases`. NEVER a write (no label/comment/merge/close).
//   * Local reads only — `git worktree list` (to resolve a run's worktree path)
//     and `out/costs/<run>.json` (the cost post-mortem, CONSUMED when present).
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

import { readFileSync, existsSync, mkdirSync, writeFileSync, copyFileSync } from 'fs';
import path from 'path';
import os from 'os';
import { fileURLToPath } from 'url';
import { execFileSync, spawn } from 'child_process';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// The 12 finer operator-facing stages (coarser than the armada:* labels, which
// several of these are INFERRED from — see stageFor() and the SKILL.md mapping).
const STAGES = [
  'Feasibility', 'Scoping', 'Planning', 'Building', 'Testing', 'AI review',
  'PR submitted', 'Watching PR', 'Feedback', 'Approved', 'Merged', 'Harvest',
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
  }
  return args;
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

function resolveRepo(explicit) {
  if (explicit) return explicit;
  const r = ghJson(['repo', 'view', '--json', 'nameWithOwner']);
  return r && r.nameWithOwner ? r.nameWithOwner : null;
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

// Consume the cost post-mortem for a run when present. This dashboard is a
// CONSUMER — it never produces this file (out of scope, a separate concern).
// Tries out/costs/<branch>.json then out/costs/<issue>.json. Degrades to null.
function readCost(branch, issueNumber) {
  const candidates = [];
  if (branch) candidates.push(path.join(process.cwd(), 'out', 'costs', `${branch}.json`));
  if (issueNumber != null) candidates.push(path.join(process.cwd(), 'out', 'costs', `${issueNumber}.json`));
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
    ? `out/costs/${branch}.json`
    : (issueNumber != null ? `out/costs/${issueNumber}.json` : 'out/costs/<run>.json');
  return { data: null, pointer };
}

// Discover the logbook "done video" for a run from GitHub release assets
// (READ-ONLY GET). logbook uploads the walkthrough as a per-PR/issue release
// asset. Returns the best video match {name,url,updatedAt} or null.
function releaseAssets(repo) {
  if (!repo) return [];
  const rows = ghJson([
    'api', `repos/${repo}/releases`, '--paginate',
    '--jq', '[.[] | {tag: .tag_name} as $r | .assets[] | {tag: $r.tag, name: .name, url: .browser_download_url, updatedAt: .updated_at, size: .size}]',
  ]);
  // gh --jq with --paginate can emit several JSON arrays concatenated; ghJson
  // parses the first. Fall back to a plain fetch + flatten if needed.
  if (Array.isArray(rows)) return rows;
  const raw = ghJson(['api', `repos/${repo}/releases`, '--paginate']);
  if (!Array.isArray(raw)) return [];
  const flat = [];
  for (const rel of raw) {
    for (const a of (rel.assets || [])) {
      flat.push({ tag: rel.tag_name, name: a.name, url: a.browser_download_url, updatedAt: a.updated_at, size: a.size });
    }
  }
  return flat;
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
// Stage inference — map the coarse armada:* label state machine (+ PR/review
// sub-state) onto the 12 finer operator stages. Documented in the SKILL.md.
//
// activeIndex = the current stage (0-based into STAGES). Earlier stages render
// "done", the active one "active", later ones "upcoming". `blocked` overrides
// the dot for the active stage. A shipped/merged terminal run marks the last
// reached stage done and the run complete.
// ---------------------------------------------------------------------------
function stageForIssue(labels) {
  const ls = labelNames(labels);
  if (ls.includes('armada:blocked')) return { activeIndex: 3, blocked: true, status: 'Blocked', terminal: false };
  if (ls.includes('armada:done')) return { activeIndex: 6, blocked: false, status: 'PR submitted', terminal: false };
  if (ls.includes('armada:underway')) return { activeIndex: 3, blocked: false, status: 'Building', terminal: false };
  return { activeIndex: 0, blocked: false, status: 'Feasibility', terminal: false };
}

function stageForPr(pr) {
  const ls = labelNames(pr.labels);
  const decision = (pr.reviewDecision || '').toUpperCase();
  if (ls.includes('armada:blocked')) return { activeIndex: 8, blocked: true, status: 'Blocked', terminal: false };
  if (ls.includes('armada:shipped')) return { activeIndex: 11, blocked: false, status: 'Harvest', terminal: true };
  if (ls.includes('armada:merged')) return { activeIndex: 10, blocked: false, status: 'Merged', terminal: false };
  if (ls.includes('armada:reviewing')) return { activeIndex: 8, blocked: false, status: 'Feedback', terminal: false };
  if (pr.isDraft) return { activeIndex: 6, blocked: false, status: 'PR submitted', terminal: false };
  // Ready PR: approved → Approved, otherwise being watched by crows-nest.
  if (decision === 'APPROVED') return { activeIndex: 9, blocked: false, status: 'Approved', terminal: false };
  return { activeIndex: 7, blocked: false, status: 'Watching PR', terminal: false };
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
// Cost normalisation — tolerant of a cost post-mortem schema that may not exist
// yet. Accepts { models:[{model,in,out,cacheRead,cacheWrite,cost}], sessions,
// subagents, codex, matchMode, unpriced:[], totalCost }. Missing → n/a.
// ---------------------------------------------------------------------------
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
  const totalCost = num(d.totalCost ?? d.total_cost) ??
    (models.length ? models.reduce((a, m) => a + (m.cost || 0), 0) : null);
  return {
    present: true,
    pointer: cost.pointer,
    models,
    sessions: num(d.sessions) ?? null,
    subagents: num(d.subagents) ?? null,
    codex: num(d.codex) ?? null,
    matchMode: d.matchMode ?? d.match ?? null,
    unpriced: Array.isArray(d.unpriced) ? d.unpriced.map(String) : [],
    totalCost,
  };
}

// ---------------------------------------------------------------------------
// Snapshot — the read-only scan + correlate + build runs.
// ---------------------------------------------------------------------------
function snapshot({ label, repo, commissioned }) {
  const repoArgs = repo ? ['--repo', repo] : [];

  const rawIssues = commissioned
    ? ghJson([
        'issue', 'list', ...repoArgs, '--label', label, '--state', 'open',
        '--json', 'number,title,labels,createdAt,updatedAt,author,body', '--limit', '50',
      ])
    : null;
  const rawPrs = commissioned
    ? ghJson([
        'pr', 'list', ...repoArgs, '--label', label, '--state', 'open',
        '--json', 'number,title,isDraft,labels,headRefName,baseRefName,mergeable,reviewDecision,statusCheckRollup,createdAt,updatedAt,body', '--limit', '50',
      ])
    : null;

  const ghOk = rawIssues !== null || rawPrs !== null;
  const issues = rawIssues || [];
  const prs = rawPrs || [];

  const wt = worktreeMap();
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

  // A run is "in flight" if the issue is underway/done/blocked, or it has an
  // open PR. Queued (unclaimed) issues are shown too — the intake stage.
  function buildRun({ issue, pr }) {
    const issueNumber = issue ? issue.number : null;
    const prNumber = pr ? pr.number : null;
    const branch = pr ? pr.headRefName : null;
    const stage = pr ? stageForPr(pr) : stageForIssue(issue.labels);
    const worktree = branch && wt[branch] ? wt[branch] : null;
    const costRaw = readCost(branch, issueNumber);
    const cost = normalizeCost(costRaw);
    const doneVideo = matchDoneVideo(assets, { issueNumber, prNumber, branch });
    const startedAt = (issue && issue.createdAt) || (pr && pr.createdAt) || null;

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
      ci: pr ? ciOf(pr) : null,
      stages: STAGES,
      activeIndex: stage.activeIndex,
      status: stage.status,
      blocked: stage.blocked,
      terminal: stage.terminal,
      doneVideo,
      cost,
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

  return {
    schema: 1,
    generatedAt: new Date().toISOString(),
    repo: repo || 'unknown',
    triggerLabel: label,
    commissioned,
    ghOk,
    stageNames: STAGES,
    degraded: !commissioned || !ghOk
      ? (!commissioned ? 'uncommissioned — no .armada/config.json; no runs to show'
                       : 'gh query failed or unauthenticated; no runs to show')
      : null,
    runs,
    summary: `runs ${runs.length} · blocked ${blockedCount}`,
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

function openInBrowser(htmlPath) {
  const plat = process.platform;
  try {
    if (plat === 'win32') spawn('cmd', ['/c', 'start', '', htmlPath], { detached: true, stdio: 'ignore' }).unref();
    else if (plat === 'darwin') spawn('open', [htmlPath], { detached: true, stdio: 'ignore' }).unref();
    else spawn('xdg-open', [htmlPath], { detached: true, stdio: 'ignore' }).unref();
  } catch { /* non-fatal — the path is printed */ }
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
  const outDir = args.out || path.join(os.tmpdir(), 'armada-spyglass-run', slug);

  function once(firstRun) {
    const state = snapshot({ label, repo, commissioned });
    const out = writeOutputs(outDir, state);
    const d = state.degraded ? ` [degraded: ${state.degraded}]` : '';
    console.log(`spyglass-run: ${state.summary}${d}`);
    if (firstRun) {
      console.log(`spyglass-run: snapshot → ${out.json}`);
      console.log(`spyglass-run: view     → ${out.html}`);
      if (args.open !== false) openInBrowser(out.html);
    }
    return out;
  }

  const first = once(true);
  if (args.watch > 0) {
    console.log(`spyglass-run: watching — re-snapshotting every ${args.watch}s (Ctrl-C to stop)`);
    setInterval(() => once(false), args.watch * 1000);
  }
  return first;
}

main();
