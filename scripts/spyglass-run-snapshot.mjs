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
//
// The recent-voyages window is bounded and configurable (flag > env > config >
// default): `--recent-hours` / `SPYGLASS_RECENT_HOURS` / `spyglass.recentWindowHours`
// (default 24; <=0 = no time filter, cap only) and `--recent-cap` /
// `SPYGLASS_RECENT_CAP` / `spyglass.recentCap` (default 12; <=0 = recent lane off).

import { readFileSync, existsSync, mkdirSync, writeFileSync, copyFileSync } from 'fs';
import path from 'path';
import os from 'os';
import { fileURLToPath } from 'url';
import { execFileSync, spawn } from 'child_process';
import { createHash } from 'crypto';

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
    const costRaw = readCost(branch, issueNumber);
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
      group: recent ? stage.group : groupForStage(stage),
      doneVideo,
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
    schema: 5,                         // schema 5 (#111): + scheduler {source, nodes, edges} — the waiting-runs dependency graph (producer or inferred); rollup gains waiting/eligible/held. Additive — older tabs read tolerantly.
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
    recentWindow,
    scheduler,
    rollup,
    summary: `runs ${runs.length} · blocked ${blockedCount} · recent ${recentRuns.length} · waiting ${rollup.waiting}`,
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

  function once(firstRun) {
    const state = snapshot({ label, repo, commissioned, recentHours, recentCap, estRatePerMin, maxConcurrentBuilds });
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
