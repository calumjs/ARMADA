#!/usr/bin/env node
// Tests for scripts/semver-higher-merge.mjs — the plugin.json version merge driver.
//
// Dependency-free (Node built-ins + the git binary), to match merge-gate.test.mjs.
// Covers the pure logic (compareSemver / resolveConflicts) AND a real end-to-end git
// merge: two branches bumping the version to different values must merge with no
// manual conflict and land on the HIGHER version.
//
// Run: node scripts/semver-higher-merge.test.mjs

import { spawnSync } from 'child_process';
import { fileURLToPath } from 'url';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import { compareSemver, highestVersion, resolveConflicts } from './semver-higher-merge.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
// Forward-slash the path: it goes into a `git config` driver string that git parses
// via a shell, where backslashes would be treated as escapes (Windows).
const DRIVER = path.join(HERE, 'semver-higher-merge.mjs').replace(/\\/g, '/');

let failures = 0;
function check(name, cond) {
  if (cond) {
    console.log(`  ok   ${name}`);
  } else {
    failures++;
    console.error(`  FAIL ${name}`);
  }
}

// --- unit: compareSemver ---------------------------------------------------
check('compareSemver 0.48.14 > 0.48.13', compareSemver('0.48.14', '0.48.13') > 0);
check('compareSemver 0.48.13 < 0.48.14', compareSemver('0.48.13', '0.48.14') < 0);
check('compareSemver equal', compareSemver('1.2.3', '1.2.3') === 0);
check('compareSemver 0.49.0 > 0.48.99', compareSemver('0.49.0', '0.48.99') > 0);
check('compareSemver 1.0.0 > 0.99.99', compareSemver('1.0.0', '0.99.99') > 0);
check('highestVersion picks max', highestVersion(['0.48.13', '0.48.15', '0.48.14']) === '0.48.15');

// --- unit: resolveConflicts (pure version-line conflict) -------------------
const conflicted = [
  '{',
  '  "name": "armada",',
  '<<<<<<< ours',
  '  "version": "0.48.14",',
  '=======',
  '  "version": "0.48.15",',
  '>>>>>>> theirs',
  '  "license": "MIT"',
  '}',
].join('\n');
const r1 = resolveConflicts(conflicted);
check('resolveConflicts resolves version conflict', r1.resolved === true);
check('resolveConflicts keeps higher version', r1.resolved && r1.text.includes('"version": "0.48.15"'));
check('resolveConflicts drops markers', r1.resolved && !r1.text.includes('<<<<<<<') && !r1.text.includes('>>>>>>>'));
check('resolveConflicts preserves trailing comma', r1.resolved && r1.text.includes('"version": "0.48.15",'));

// --- unit: resolveConflicts bails on a non-version conflict ----------------
const otherConflict = [
  '{',
  '<<<<<<< ours',
  '  "description": "a",',
  '=======',
  '  "description": "b",',
  '>>>>>>> theirs',
  '}',
].join('\n');
check('resolveConflicts bails on non-version conflict', resolveConflicts(otherConflict).resolved === false);

// --- integration: a real two-branch git merge -----------------------------
function git(cwd, ...args) {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8' });
  return { status: r.status, out: (r.stdout || '') + (r.stderr || '') };
}

function plugin(version) {
  return JSON.stringify({ name: 'armada', version, license: 'MIT' }, null, 2) + '\n';
}

const repo = mkdtempSync(path.join(tmpdir(), 'armada-mergedriver-'));
try {
  git(repo, 'init', '-q', '-b', 'main');
  git(repo, 'config', 'user.email', 'test@example.com');
  git(repo, 'config', 'user.name', 'test');
  // Register the driver exactly as documented, pointing at the real resolver.
  git(repo, 'config', 'merge.semver-higher.name', 'keep the higher plugin.json version');
  git(repo, 'config', 'merge.semver-higher.driver', `node ${DRIVER} %O %A %B %P`);

  const dir = path.join(repo, '.claude-plugin');
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(repo, '.gitattributes'), '.claude-plugin/plugin.json merge=semver-higher\n');
  const pj = path.join(dir, 'plugin.json');
  writeFileSync(pj, plugin('0.48.13'));
  git(repo, 'add', '-A');
  git(repo, 'commit', '-qm', 'base 0.48.13');

  // Branch A bumps to 0.48.14
  git(repo, 'checkout', '-q', '-b', 'feature-a');
  writeFileSync(pj, plugin('0.48.14'));
  git(repo, 'commit', '-qam', 'bump 0.48.14');

  // Branch B (off main) bumps to 0.48.15
  git(repo, 'checkout', '-q', 'main');
  git(repo, 'checkout', '-q', '-b', 'feature-b');
  writeFileSync(pj, plugin('0.48.15'));
  git(repo, 'commit', '-qam', 'bump 0.48.15');

  // Merge A into B — same line changed on both → would normally conflict.
  const merge = git(repo, 'merge', '--no-edit', 'feature-a');
  check('integration: merge exits clean (no manual conflict)', merge.status === 0);

  const merged = readFileSync(pj, 'utf8');
  check('integration: no conflict markers left', !merged.includes('<<<<<<<') && !merged.includes('>>>>>>>'));
  check('integration: resolved to the higher version 0.48.15', merged.includes('"version": "0.48.15"'));
  check('integration: result is valid JSON', (() => { try { JSON.parse(merged); return true; } catch { return false; } })());
} finally {
  rmSync(repo, { recursive: true, force: true });
}

if (failures > 0) {
  console.error(`\n${failures} check(s) failed.`);
  process.exit(1);
}
console.log('\nAll semver-higher-merge checks passed.');
