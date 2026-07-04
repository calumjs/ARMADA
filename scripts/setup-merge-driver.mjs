#!/usr/bin/env node
// One-time (idempotent) registration of the `semver-higher` git merge driver for
// this clone. Git merge drivers are named in .gitattributes (which IS committed) but
// their implementation is configured per-clone via `git config` (which is NOT — by
// design, so a repo can't run arbitrary code on your machine just by being cloned).
// So every fresh clone must run this once for plugin.json version conflicts to
// auto-resolve. Until it's run, git falls back to the default text merge (i.e. a
// normal conflict) — safe, just not automatic.
//
// Dependency-free. Run from the repo root:  node scripts/setup-merge-driver.mjs
//
// Equivalent raw commands:
//   git config merge.semver-higher.name   "keep the higher plugin.json version"
//   git config merge.semver-higher.driver "node scripts/semver-higher-merge.mjs %O %A %B %P"

import { spawnSync } from 'child_process';

function gitConfig(key, value) {
  const r = spawnSync('git', ['config', key, value], { encoding: 'utf8' });
  if (r.status !== 0) {
    console.error(`failed: git config ${key}\n${r.stderr || r.stdout || ''}`);
    process.exit(1);
  }
}

// Confirm we're inside a work tree first.
const inTree = spawnSync('git', ['rev-parse', '--is-inside-work-tree'], { encoding: 'utf8' });
if (inTree.status !== 0 || inTree.stdout.trim() !== 'true') {
  console.error('setup-merge-driver: not inside a git work tree. Run from the repo root.');
  process.exit(1);
}

gitConfig('merge.semver-higher.name', 'keep the higher plugin.json version on conflict');
gitConfig('merge.semver-higher.driver', 'node scripts/semver-higher-merge.mjs %O %A %B %P');

console.log('semver-higher merge driver registered for this clone.');
console.log('  .claude-plugin/plugin.json version-bump conflicts will now auto-resolve to the higher version.');
