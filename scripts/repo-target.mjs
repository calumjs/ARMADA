#!/usr/bin/env node
// repo-target.mjs — resolve, report, and switch the ARMADA fleet's ACTIVE repo.
//
// ARMADA is commissioned per-repo: `.armada/config.json` lives in one checkout
// and the fleet acts on the ambient `gh` repo (whatever `gh repo view` resolves
// in the cwd). This helper adds first-class, OPT-IN multi-repo targeting on top
// of that, WITHOUT changing the single-repo default:
//
//   * `repos`      — an optional list of "owner/name" the fleet may target.
//   * `activeRepo` — which one is currently selected.
//
// The resolution precedence — the single rule every repo-scoped skill applies —
// is:  --repo flag  >  config.activeRepo  >  ambient `gh repo view`.
//
// When neither `repos` nor `activeRepo` is configured the resolved repo is just
// the ambient cwd repo (source "ambient") — i.e. today's behaviour, byte for
// byte. So a repo with no multi-repo config behaves exactly as before.
//
// Dependency-free (Node built-ins only), to match validate-skills.mjs and the
// other bundled scripts. Reads config from `<cwd>/.armada/config.json`.
//
// CLI:
//   node scripts/repo-target.mjs resolve [--repo <owner/name>] [--json]
//       Print the active repo and WHERE it came from (flag / config / ambient).
//   node scripts/repo-target.mjs list [--json]
//       List every configured repo, marking the active one with '*'. With no
//       `repos` configured, reports the single ambient repo as the sole target.
//   node scripts/repo-target.mjs use <owner/name> [--add]
//       Switch the active repo (writes `activeRepo` into .armada/config.json) —
//       no re-commission. The target must already be in `repos`; pass --add to
//       append it first. This is how you switch which repo the fleet operates
//       on between runs.
//   node scripts/repo-target.mjs guard [--repo <owner/name>]
//       The BUILD/MERGE safety gate. Scans + remote label/comment CAN target a
//       different repo (they're pure `gh --repo` remote ops), but building and
//       merging run against the LOCAL checkout/worktree — and switching activeRepo
//       does NOT switch the checkout. So when the resolved active repo differs
//       from the checkout's origin repo, this REFUSES (exit 4, clear message) so
//       the caller does not silently build/merge the wrong repo. Exit 0 = safe
//       (single-repo default, or activeRepo == checkout). Building a non-checkout
//       repo is a deliberate follow-up — see crows-nest/references/multi-repo.md.
//
// Exit codes: 0 ok · 2 usage error · 3 validation error (target not configured) ·
//             4 build/merge guard: activeRepo != checkout (refuse).

import { existsSync, readFileSync, writeFileSync } from 'fs';
import { execFileSync } from 'child_process';
import { fileURLToPath, pathToFileURL } from 'url';
import path from 'path';

// owner/name — each segment must START with an alphanumeric/dot/underscore (NOT a
// hyphen), so a leading-hyphen token (which `gh` would parse as a FLAG, not a repo)
// can never pass validation and reach a `gh --repo <value>` call. Hyphens are still
// allowed inside a segment (`my-org/my-repo`).
const REPO_RE = /^[A-Za-z0-9._][A-Za-z0-9._-]*\/[A-Za-z0-9._][A-Za-z0-9._-]*$/;

// ---------------------------------------------------------------------------
// Pure helpers (exported for the test — no I/O, no gh, no process.exit)
// ---------------------------------------------------------------------------

// Normalise the `repos` config value into an array of "owner/name" strings.
// Accepts an array (["a/b","c/d"]) OR a comma-separated string ("a/b, c/d") —
// the same dual shape `authors` accepts — and tolerates junk defensively.
export function normalizeRepos(value) {
  let list = [];
  if (Array.isArray(value)) list = value;
  else if (typeof value === 'string') list = value.split(',');
  return list
    .map((s) => (typeof s === 'string' ? s.trim() : ''))
    .filter((s) => REPO_RE.test(s));
}

export function isValidRepo(s) {
  return typeof s === 'string' && REPO_RE.test(s.trim());
}

// The one resolution rule: --repo flag > config.activeRepo > ambient cwd repo.
// Returns { repo, source, repos } where source ∈ flag|config.activeRepo|ambient
// and repo may be null only when nothing resolves (no flag, no config, and gh
// couldn't name the ambient repo). `repos` is the normalised configured set.
export function resolveActive({ flagRepo, config = {}, ambient = null }) {
  const repos = normalizeRepos(config.repos);
  if (isValidRepo(flagRepo)) {
    return { repo: flagRepo.trim(), source: 'flag', repos };
  }
  const active = typeof config.activeRepo === 'string' ? config.activeRepo.trim() : '';
  if (isValidRepo(active)) {
    return { repo: active, source: 'config.activeRepo', repos };
  }
  // No explicit selection. The active repo is the ambient cwd repo — today's
  // single-repo default. If we're not in a git/gh repo at all but a `repos`
  // list was configured, fall back to its first entry so the target is still
  // unambiguous rather than null.
  if (ambient) return { repo: ambient, source: 'ambient', repos };
  if (repos.length) return { repo: repos[0], source: 'repos[0]', repos };
  return { repo: null, source: 'ambient', repos };
}

// Validate a `use <target>` switch against the configured set. Returns
// { ok, repos, reason } — ok=false when the target isn't configured and --add
// wasn't passed. With add=true the target is appended to `repos`.
export function planUse({ target, config = {}, add = false }) {
  if (!isValidRepo(target)) {
    return { ok: false, reason: `not a valid owner/name repo: "${target}"` };
  }
  const t = target.trim();
  let repos = normalizeRepos(config.repos);
  if (!repos.includes(t)) {
    if (!add) {
      return {
        ok: false,
        repos,
        reason: `"${t}" is not in the configured repos [${repos.join(', ') || 'none'}]. `
          + `Add it first with:  repo-target.mjs use ${t} --add`,
      };
    }
    repos = [...repos, t];
  }
  return { ok: true, repos, active: t };
}

// The BUILD/MERGE local-vs-remote guard. Repo-targeted READS (§2a scans) and remote
// WRITES (`gh issue edit`/`comment`, `gh pr edit`/`comment`, label reconcile) work
// cross-repo because they carry `--repo <activeRepo>`. But BUILDING (shipwright) and
// MERGING (`gh pr merge`/`update-branch`, worktree checkout) act on the LOCAL
// checkout, and selecting a different `activeRepo` does NOT re-clone/re-checkout that
// repo. So a build/merge can only safely target the repo the checkout's origin
// already points at. This is the pure decision helper: given the resolved active repo
// and the checkout's origin repo, say whether a build/merge may proceed.
//
// Returns { safe, activeRepo, checkoutRepo, reason }. It fails SAFE (safe:true) only
// on a PROVEN match or when there's nothing to compare (single-repo default, or the
// checkout repo couldn't be determined — the underlying `gh` op would fail on its own
// then). It refuses (safe:false) only on a proven mismatch.
export function assertLocalRepoMatchesActive({ config = {}, checkoutRepo = null, flagRepo = null }) {
  const { repo: activeRepo } = resolveActive({ flagRepo, config, ambient: checkoutRepo });
  // Nothing to compare against, or single-repo default (active resolved to the
  // ambient checkout): always safe — today's behaviour, byte for byte.
  if (!activeRepo || !checkoutRepo || activeRepo === checkoutRepo) {
    return { safe: true, activeRepo, checkoutRepo };
  }
  return {
    safe: false,
    activeRepo,
    checkoutRepo,
    reason:
      `multi-repo build/merge not supported in this increment; activeRepo ${activeRepo} ` +
      `≠ checkout ${checkoutRepo}. Scans + spyglass + remote label/comment ARE repo-targeted, ` +
      `but building/merging a non-checkout repo is a deliberate follow-up (not delivered here). ` +
      `Check out ${activeRepo} (or set activeRepo back to ${checkoutRepo}) to build/merge it.`,
  };
}

// ---------------------------------------------------------------------------
// I/O (only reached from the CLI path)
// ---------------------------------------------------------------------------

function configPath() {
  return path.join(process.cwd(), '.armada', 'config.json');
}

function readConfig() {
  const p = configPath();
  if (existsSync(p)) {
    try {
      return { config: JSON.parse(readFileSync(p, 'utf8')), commissioned: true };
    } catch {
      /* malformed — treat as uncommissioned */
    }
  }
  return { config: {}, commissioned: false };
}

function writeConfig(config) {
  writeFileSync(configPath(), JSON.stringify(config, null, 2) + '\n');
}

function ambientRepo() {
  try {
    const out = execFileSync('gh', ['repo', 'view', '--json', 'nameWithOwner'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const r = JSON.parse(out);
    return r && r.nameWithOwner ? r.nameWithOwner : null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

function parseArgs(argv) {
  const args = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--repo') args.repo = argv[++i];
    else if (a === '--json') args.json = true;
    else if (a === '--add') args.add = true;
    else args._.push(a);
  }
  return args;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const cmd = args._[0] || 'resolve';
  const { config } = readConfig();

  if (cmd === 'resolve') {
    const r = resolveActive({ flagRepo: args.repo, config, ambient: ambientRepo() });
    if (args.json) {
      process.stdout.write(JSON.stringify(r) + '\n');
    } else if (r.repo) {
      process.stdout.write(`${r.repo}  (source: ${r.source})\n`);
    } else {
      process.stderr.write('could not resolve an active repo (no --repo, no config.activeRepo, and `gh repo view` failed)\n');
      process.exit(2);
    }
    return;
  }

  if (cmd === 'list') {
    const r = resolveActive({ flagRepo: args.repo, config, ambient: ambientRepo() });
    const set = r.repos.length ? r.repos : (r.repo ? [r.repo] : []);
    if (args.json) {
      process.stdout.write(JSON.stringify({ active: r.repo, source: r.source, repos: set }) + '\n');
      return;
    }
    if (!set.length) {
      process.stdout.write('no target repo (not in a gh repo and no `repos` configured)\n');
      return;
    }
    for (const repo of set) {
      process.stdout.write(`${repo === r.repo ? '* ' : '  '}${repo}\n`);
    }
    if (r.repos.length === 0) {
      process.stdout.write('(single-repo default — no `repos` configured; showing the ambient repo)\n');
    }
    return;
  }

  if (cmd === 'use') {
    const target = args._[1];
    if (!target) {
      process.stderr.write('usage: repo-target.mjs use <owner/name> [--add]\n');
      process.exit(2);
    }
    const plan = planUse({ target, config, add: args.add });
    if (!plan.ok) {
      process.stderr.write(plan.reason + '\n');
      process.exit(3);
    }
    config.repos = plan.repos;
    config.activeRepo = plan.active;
    writeConfig(config);
    process.stdout.write(`active repo -> ${plan.active}\n`);
    process.stdout.write(`repos: ${plan.repos.join(', ')}\n`);
    return;
  }

  if (cmd === 'guard') {
    // BUILD/MERGE gate: refuse (exit 4) when the resolved active repo differs from
    // the LOCAL checkout's origin repo. The checkout repo is the ambient `gh repo
    // view` — the merge path's `gh pr merge` acts on exactly that repo.
    const g = assertLocalRepoMatchesActive({
      config,
      checkoutRepo: ambientRepo(),
      flagRepo: args.repo,
    });
    if (args.json) {
      process.stdout.write(JSON.stringify(g) + '\n');
    }
    if (g.safe) {
      if (!args.json) {
        process.stdout.write(
          `ok — build/merge may target ${g.activeRepo || 'the ambient repo'} (matches the checkout)\n`,
        );
      }
      return;
    }
    if (!args.json) process.stderr.write(g.reason + '\n');
    process.exit(4);
  }

  process.stderr.write(`unknown command "${cmd}". Use: resolve | list | use | guard\n`);
  process.exit(2);
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  main();
}
