#!/usr/bin/env node
// ARMADA spyglass — per-run operations dashboard (data plumbing).
//
// Companion mode to `spyglass` (the sea-chart). Where spyglass renders the WHOLE
// fleet as an animated chart, this renders each IN-FLIGHT run as a focused voyage
// card: ARMADA's REAL pipeline (the armada:* label state machine), the run's
// worktree/branch/folder metadata, the logbook "done video", and a per-model cost
// table with REAL usage numbers.
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
//   * GitHub reads only — `gh repo view`, `gh issue list`, `gh pr list`, and
//     GET-only `gh api .../releases`. NEVER a write (no label/comment/merge/close).
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

import { readFileSync, existsSync, mkdirSync, writeFileSync, copyFileSync } from 'fs';
import path from 'path';
import os from 'os';
import { fileURLToPath } from 'url';
import { execFileSync, spawn } from 'child_process';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

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
    updatedAt: d.updatedAt ?? d.generatedAt ?? null,
  };
}

// ---------------------------------------------------------------------------
// Snapshot — the read-only scan + correlate + build runs.
// ---------------------------------------------------------------------------
function snapshot({ label, repo, commissioned }) {
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
  // an open PR. Queued (unclaimed) issues are shown too — the intake leg.
  function buildRun({ issue, pr }) {
    const issueNumber = issue ? issue.number : null;
    const prNumber = pr ? pr.number : null;
    // Branch: prefer the PR's head; else the crows-nest run map (in-flight, pre-PR).
    const runRec = issueNumber != null ? runMap[String(issueNumber)] : null;
    const branch = (pr && pr.headRefName) || (runRec && runRec.branch) || null;
    const stage = pr ? stageForPr(pr) : stageForIssue(issue.labels);
    // Worktree: git worktree list by branch, else the run map's recorded path.
    const worktree = (branch && wt[branch]) || (runRec && runRec.worktree) || null;
    const costRaw = readCost(branch, issueNumber);
    const cost = normalizeCost(costRaw);
    const doneVideo = matchDoneVideo(assets, { issueNumber, prNumber, branch });
    // Elapsed since the run started: the issue/PR open time, or the crows-nest
    // dispatch time from the run map (whichever is earliest & known).
    const startedAt = (issue && issue.createdAt) || (pr && pr.createdAt)
      || (runRec && (runRec.startedAt || runRec.dispatchedAt)) || null;

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
      stageCaptions: STAGE_CAPTIONS,
      activeIndex: stage.activeIndex,
      status: stage.status,
      blocked: stage.blocked,
      terminal: stage.terminal,
      group: groupForStage(stage),
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

  // Fleet roll-up — counts by coarse group, total in-flight, total cost — for the
  // totals bar. Client-recomputable, but emitted here so the grouping is
  // authoritative + documented in one place. (Additive; schema 2.)
  const rollup = { inFlight: runs.length, totalCost: 0, costKnown: false };
  for (const g of GROUPS) rollup[g] = 0;
  for (const r of runs) {
    if (rollup[r.group] != null) rollup[r.group] += 1;
    const tc = r.cost && r.cost.present ? r.cost.totalCost : null;
    if (typeof tc === 'number' && Number.isFinite(tc)) { rollup.totalCost += tc; rollup.costKnown = true; }
  }

  return {
    schema: 2,
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
    rollup,
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
