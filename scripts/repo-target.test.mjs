#!/usr/bin/env node
// Tests for scripts/repo-target.mjs — the ACTIVE-repo resolver/selector.
//
// Dependency-free (Node built-ins only), to match validate-skills.mjs and the
// script under test. Exercises the pure helpers (no gh, no filesystem) plus a
// subprocess smoke of `resolve --repo` (which never touches gh because the flag
// short-circuits ambient resolution).
//
// Run: node scripts/repo-target.test.mjs

import assert from 'assert';
import { spawnSync } from 'child_process';
import { fileURLToPath } from 'url';
import path from 'path';
import { normalizeRepos, isValidRepo, resolveActive, planUse } from './repo-target.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SCRIPT = path.join(HERE, 'repo-target.mjs');

let passed = 0;
function test(name, fn) {
  try {
    fn();
    passed++;
  } catch (e) {
    console.error(`FAIL: ${name}`);
    console.error(e && e.stack ? e.stack : e);
    process.exit(1);
  }
}

// --- normalizeRepos ---------------------------------------------------------
test('normalizeRepos accepts an array of owner/name', () => {
  assert.deepStrictEqual(normalizeRepos(['a/b', 'c/d']), ['a/b', 'c/d']);
});
test('normalizeRepos accepts a comma-separated string (authors-style)', () => {
  assert.deepStrictEqual(normalizeRepos('a/b, c/d'), ['a/b', 'c/d']);
});
test('normalizeRepos drops junk and non-owner/name entries', () => {
  assert.deepStrictEqual(normalizeRepos(['a/b', 'notarepo', '', 42, 'x/y']), ['a/b', 'x/y']);
});
test('normalizeRepos on absent/garbage yields []', () => {
  assert.deepStrictEqual(normalizeRepos(undefined), []);
  assert.deepStrictEqual(normalizeRepos(null), []);
  assert.deepStrictEqual(normalizeRepos({}), []);
});

// --- isValidRepo ------------------------------------------------------------
test('isValidRepo distinguishes owner/name from junk', () => {
  assert.ok(isValidRepo('calumjs/ARMADA'));
  assert.ok(!isValidRepo('ARMADA'));
  assert.ok(!isValidRepo('a/b/c'));
  assert.ok(!isValidRepo(''));
});

// --- resolveActive: the precedence rule -------------------------------------
test('flag wins over config.activeRepo and ambient', () => {
  const r = resolveActive({
    flagRepo: 'flag/repo',
    config: { activeRepo: 'cfg/repo', repos: ['cfg/repo'] },
    ambient: 'amb/repo',
  });
  assert.strictEqual(r.repo, 'flag/repo');
  assert.strictEqual(r.source, 'flag');
});
test('config.activeRepo wins over ambient when no flag', () => {
  const r = resolveActive({ config: { activeRepo: 'cfg/repo' }, ambient: 'amb/repo' });
  assert.strictEqual(r.repo, 'cfg/repo');
  assert.strictEqual(r.source, 'config.activeRepo');
});
test('SINGLE-REPO DEFAULT: no repos/activeRepo => ambient cwd repo, unchanged', () => {
  const r = resolveActive({ config: {}, ambient: 'amb/repo' });
  assert.strictEqual(r.repo, 'amb/repo');
  assert.strictEqual(r.source, 'ambient');
  assert.deepStrictEqual(r.repos, []);
});
test('repos configured but no activeRepo still defaults to ambient (unambiguous)', () => {
  const r = resolveActive({ config: { repos: ['a/b', 'c/d'] }, ambient: 'a/b' });
  assert.strictEqual(r.repo, 'a/b');
  assert.strictEqual(r.source, 'ambient');
});
test('no ambient (not in a repo) but repos set => first configured repo', () => {
  const r = resolveActive({ config: { repos: ['a/b', 'c/d'] }, ambient: null });
  assert.strictEqual(r.repo, 'a/b');
  assert.strictEqual(r.source, 'repos[0]');
});
test('nothing resolvable => null repo', () => {
  const r = resolveActive({ config: {}, ambient: null });
  assert.strictEqual(r.repo, null);
});
test('an invalid flag is ignored, falling through to config', () => {
  const r = resolveActive({ flagRepo: 'bogus', config: { activeRepo: 'cfg/repo' }, ambient: null });
  assert.strictEqual(r.repo, 'cfg/repo');
  assert.strictEqual(r.source, 'config.activeRepo');
});

// --- planUse: the switch validation -----------------------------------------
test('use a configured repo succeeds and sets active', () => {
  const p = planUse({ target: 'a/b', config: { repos: ['a/b', 'c/d'] } });
  assert.ok(p.ok);
  assert.strictEqual(p.active, 'a/b');
  assert.deepStrictEqual(p.repos, ['a/b', 'c/d']);
});
test('use an unconfigured repo without --add is refused', () => {
  const p = planUse({ target: 'x/y', config: { repos: ['a/b'] } });
  assert.ok(!p.ok);
  assert.match(p.reason, /not in the configured repos/);
});
test('use --add appends then selects', () => {
  const p = planUse({ target: 'x/y', config: { repos: ['a/b'] }, add: true });
  assert.ok(p.ok);
  assert.deepStrictEqual(p.repos, ['a/b', 'x/y']);
  assert.strictEqual(p.active, 'x/y');
});
test('use --add on the very first repo (empty repos) works', () => {
  const p = planUse({ target: 'a/b', config: {}, add: true });
  assert.ok(p.ok);
  assert.deepStrictEqual(p.repos, ['a/b']);
});
test('use rejects a malformed target', () => {
  const p = planUse({ target: 'notarepo', config: { repos: ['a/b'] }, add: true });
  assert.ok(!p.ok);
});

// --- subprocess smoke: resolve --repo short-circuits ambient (no gh needed) --
test('CLI `resolve --repo` prints the flag repo and its source', () => {
  const res = spawnSync(process.execPath, [SCRIPT, 'resolve', '--repo', 'flag/repo', '--json'], {
    encoding: 'utf8',
  });
  assert.strictEqual(res.status, 0);
  const out = JSON.parse(res.stdout);
  assert.strictEqual(out.repo, 'flag/repo');
  assert.strictEqual(out.source, 'flag');
});

console.log(`ok — ${passed} tests passed`);
