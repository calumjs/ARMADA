#!/usr/bin/env node
// Tests for the spyglass-run-snapshot.mjs operator guardrails (issue #133):
//   * single-driver lock  — a 2nd --watch driver against the same --out refuses
//     (naming the live pid); a stale lock (dead holder) is taken over; a one-shot
//     snapshot neither takes nor is blocked by the lock.
//   * served-dir check    — a --served-root that differs from --out warns, and
//     refuses under --strict.
//
// Dependency-free (Node built-ins only), to match validate-skills.mjs and the
// merge-gate tests. Two layers: fast in-process unit tests of the exported
// primitives, plus an end-to-end subprocess test that launches a real --watch
// driver and asserts a second one is refused (the acceptance-criteria scenario).
//
// Run: node scripts/spyglass-run-snapshot.test.mjs

import { spawn, spawnSync } from 'child_process';
import { fileURLToPath, pathToFileURL } from 'url';
import { mkdtempSync, mkdirSync, existsSync, readFileSync, writeFileSync, rmSync } from 'fs';
import path from 'path';
import os from 'os';

import {
  LOCK_NAME, LOCK_INFO, pidAlive, acquireWatchLock, releaseWatchLock,
  samePath, servedRootFromCommand, checkServedRoot,
} from './spyglass-run-snapshot.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SCRIPT = path.join(HERE, 'spyglass-run-snapshot.mjs');

// The lock is a DIRECTORY (<dir>/LOCK_NAME/) whose holder metadata lives in an
// owner.json file inside it. Seed a fake lock the way a real holder would.
function seedLock(dir, info, { raw } = {}) {
  const lockDir = path.join(dir, LOCK_NAME);
  mkdirSync(lockDir, { recursive: true });
  writeFileSync(path.join(lockDir, LOCK_INFO), raw != null ? raw : JSON.stringify(info));
}
function readLockInfo(dir) {
  return JSON.parse(readFileSync(path.join(dir, LOCK_NAME, LOCK_INFO), 'utf8'));
}

let passed = 0;
const failures = [];
function test(name, fn) {
  try { fn(); passed++; }
  catch (e) { failures.push(`${name}: ${e.message}`); }
}
async function testAsync(name, fn) {
  try { await fn(); passed++; }
  catch (e) { failures.push(`${name}: ${e.message}`); }
}
function assert(cond, msg) { if (!cond) throw new Error(msg); }

function tmpDir() {
  return mkdtempSync(path.join(os.tmpdir(), 'spyglass-lock-test-'));
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// --- pidAlive --------------------------------------------------------------
test('pidAlive: the current process is alive', () => {
  assert(pidAlive(process.pid) === true, 'own pid should be alive');
});
test('pidAlive: an absurd pid is dead', () => {
  assert(pidAlive(2 ** 31 - 1) === false, 'a huge unused pid should read as dead');
});
test('pidAlive: garbage pids are dead', () => {
  for (const p of [0, -1, NaN, null, undefined, 'x']) {
    assert(pidAlive(p) === false, `pid ${String(p)} should read as dead`);
  }
});

// --- acquireWatchLock / releaseWatchLock -----------------------------------
test('acquireWatchLock: fresh dir → acquires and writes pid + startedAt', () => {
  const dir = tmpDir();
  try {
    const r = acquireWatchLock(dir);
    assert(r.ok === true, 'fresh acquire should succeed');
    assert(typeof r.nonce === 'string' && r.nonce, 'acquire returns an owner nonce');
    const lock = readLockInfo(dir);
    assert(lock.pid === process.pid, 'lock records our pid');
    assert(typeof lock.startedAt === 'string' && lock.startedAt, 'lock records startedAt');
    assert(lock.nonce === r.nonce, 'lock records the owner nonce');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('acquireWatchLock: LIVE holder → refuses and returns the holder', () => {
  const dir = tmpDir();
  try {
    // A live foreign holder: use our own pid but a different recorded pid won't do
    // (must be alive). process.pid is alive; simulate a foreign live holder by
    // writing a lock with a pid we know is alive but != us is impossible in-proc,
    // so use the parent shell's guaranteed-alive pid: our own, and assert the
    // takeover branch instead is covered below. Here we forge a live OTHER holder
    // by spawning a child that stays alive.
    const child = spawn(process.execPath, ['-e', 'setTimeout(()=>{}, 60000)'], { stdio: 'ignore' });
    try {
      // Wait for the child to actually be alive.
      seedLock(dir, { pid: child.pid, startedAt: new Date().toISOString(), out: dir });
      const r = acquireWatchLock(dir);
      assert(r.ok === false, 'should refuse against a live holder');
      assert(r.holder && r.holder.pid === child.pid, 'refusal names the live holder pid');
    } finally { child.kill(); }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('acquireWatchLock: STALE holder (dead pid) → transparently taken over', () => {
  const dir = tmpDir();
  try {
    const deadPid = 2 ** 31 - 1;
    seedLock(dir, { pid: deadPid, startedAt: new Date().toISOString(), out: dir });
    const r = acquireWatchLock(dir);
    assert(r.ok === true, 'stale lock should be taken over');
    assert(r.tookOver && r.tookOver.pid === deadPid, 'takeover reports the previous dead holder');
    const lock = readLockInfo(dir);
    assert(lock.pid === process.pid, 'lock now records our pid');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('acquireWatchLock: corrupt lock → taken over', () => {
  const dir = tmpDir();
  try {
    seedLock(dir, null, { raw: 'not json {{{' });
    const r = acquireWatchLock(dir);
    assert(r.ok === true, 'corrupt lock should be taken over');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('releaseWatchLock: removes our lock; leaves a foreign one', () => {
  const dir = tmpDir();
  try {
    const lockPath = path.join(dir, LOCK_NAME);
    const acq = acquireWatchLock(dir);
    releaseWatchLock(lockPath, acq.nonce);
    assert(!existsSync(lockPath), 'our lock is removed on release');
    // Foreign lock (different pid) must NOT be deleted.
    seedLock(dir, { pid: 2 ** 31 - 1, startedAt: 'x', nonce: 'foreign' });
    releaseWatchLock(lockPath, acq.nonce);
    assert(existsSync(lockPath), 'a foreign lock is left intact');
    // Our own pid but a DIFFERENT nonce (a lock a later takeover reclaimed) is left too.
    rmSync(lockPath, { recursive: true, force: true });
    seedLock(dir, { pid: process.pid, startedAt: 'x', nonce: 'not-ours' });
    releaseWatchLock(lockPath, acq.nonce);
    assert(existsSync(lockPath), 'a lock with our pid but a foreign nonce is left intact');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// --- atomic acquire: concurrent racers → exactly one winner ----------------
// Two separate PROCESSES race to acquire the SAME lock at the same instant. The
// old existsSync-then-write path let BOTH through (a TOCTOU race); the `wx`
// exclusive create must let exactly ONE win. Each racer, once acquired, stays
// alive briefly so the loser observes it as a LIVE holder and refuses.
const SCRIPT_URL = pathToFileURL(SCRIPT).href;
function spawnAcquirer(dir) {
  const code =
    `import(${JSON.stringify(SCRIPT_URL)}).then(async (m) => {` +
    `  const r = m.acquireWatchLock(${JSON.stringify(dir)});` +
    `  process.stdout.write(r.ok ? 'OK' : 'NO');` +
    `  await new Promise((res) => setTimeout(res, 700));` +
    `  process.exit(0);` +
    `});`;
  return spawn(process.execPath, ['-e', code], { stdio: ['ignore', 'pipe', 'ignore'] });
}
function collectStdout(child) {
  return new Promise((resolve) => {
    let out = '';
    child.stdout.on('data', (d) => { out += d; });
    child.on('close', () => resolve(out.trim()));
  });
}
async function raceAcquire(dir, n = 2) {
  const kids = Array.from({ length: n }, () => spawnAcquirer(dir));
  return Promise.all(kids.map(collectStdout));
}

await testAsync('acquireWatchLock: two racers on a FRESH lock → exactly one ok (atomic)', async () => {
  const dir = tmpDir();
  try {
    const results = await raceAcquire(dir, 2);
    const oks = results.filter((r) => r === 'OK').length;
    assert(oks === 1, `exactly one racer must acquire a fresh lock, got ${oks} of [${results.join(',')}]`);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

await testAsync('acquireWatchLock: two racers taking over the SAME stale lock → exactly one ok', async () => {
  const dir = tmpDir();
  try {
    // Seed a stale lock (dead pid) — both racers see it as takeable, but only one
    // may win the atomic rename-claim; the other refuses on the live winner.
    seedLock(dir, { pid: 2 ** 31 - 1, startedAt: new Date().toISOString(), out: dir });
    const results = await raceAcquire(dir, 2);
    const oks = results.filter((r) => r === 'OK').length;
    assert(oks === 1, `exactly one racer must take over a stale lock, got ${oks} of [${results.join(',')}]`);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// --- served-dir helpers ----------------------------------------------------
test('samePath: same dir matches, different dirs do not', () => {
  const a = tmpDir(), b = tmpDir();
  try {
    assert(samePath(a, a) === true, 'a dir equals itself');
    assert(samePath(a, path.join(a, '.', '')) === true, 'normalised equal paths match');
    assert(samePath(a, b) === false, 'distinct dirs do not match');
  } finally { rmSync(a, { recursive: true, force: true }); rmSync(b, { recursive: true, force: true }); }
});

test('servedRootFromCommand: explicit dir flags parse; implicit cwd declines', () => {
  const dir = tmpDir();
  try {
    assert(servedRootFromCommand(`python -m http.server 8000 -d ${dir}`) === dir, 'python -d');
    assert(servedRootFromCommand(`npx http-server ${dir} -p 8080`) === dir, 'http-server positional');
    assert(servedRootFromCommand(`npx serve ${dir}`) === dir, 'npx serve positional');
    // Non-existent dir → declines (won't fabricate a served root).
    assert(servedRootFromCommand('http-server /no/such/dir/xyz') === null, 'nonexistent dir declines');
    // A bare `serve` SUBCOMMAND of an unrelated tool must NOT be mistaken for the
    // npm serve package (real-world false positive: an app-server broker).
    assert(servedRootFromCommand(`node app-server-broker.mjs serve ${dir}`) === null, 'unrelated serve subcommand declines');
    // A non-server command → null.
    assert(servedRootFromCommand('node build.js') === null, 'non-server declines');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('checkServedRoot: match → no warning; mismatch → warns (non-strict)', () => {
  const out = tmpDir(), other = tmpDir();
  try {
    let warned = false;
    const log = { error: () => { warned = true; }, log: () => { warned = true; } };
    // Match → silent, returns false.
    assert(checkServedRoot({ outDir: out, served: { root: out, via: 'test' }, strict: false, log }) === false, 'match is a no-op');
    assert(warned === false, 'no warning on match');
    // Mismatch → warns, returns true.
    assert(checkServedRoot({ outDir: out, served: { root: other, via: 'test' }, strict: false, log }) === true, 'mismatch detected');
    assert(warned === true, 'warned on mismatch');
    // Unknown served root → silent no-op.
    assert(checkServedRoot({ outDir: out, served: null, strict: false, log }) === false, 'unknown served root is a no-op');
  } finally { rmSync(out, { recursive: true, force: true }); rmSync(other, { recursive: true, force: true }); }
});

// --- end-to-end: real --watch driver refuses a second, one-shot unaffected -
async function waitForLock(dir, ms = 8000) {
  const infoPath = path.join(dir, LOCK_NAME, LOCK_INFO);
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    if (existsSync(infoPath)) {
      try { return JSON.parse(readFileSync(infoPath, 'utf8')); } catch { /* mid-write */ }
    }
    await sleep(100);
  }
  return null;
}

await testAsync('e2e: 2nd --watch driver against the same --out is refused, naming the pid', async () => {
  const dir = tmpDir();
  // A repo that resolves without a `gh repo view` (so no auth needed); gh queries
  // then fail → the snapshot is `degraded` but still writes + the watch stays alive.
  const argv = ['--out', dir, '--repo', 'example/none', '--no-open', '--watch', '3600'];
  const first = spawn(process.execPath, [SCRIPT, ...argv], { stdio: 'ignore' });
  try {
    const held = await waitForLock(dir);
    assert(held && Number(held.pid) === first.pid, `first watcher should hold the lock (got ${JSON.stringify(held)})`);

    const second = spawnSync(process.execPath, [SCRIPT, ...argv], { encoding: 'utf8' });
    assert(second.status === 1, `second watcher should exit 1, got ${second.status}`);
    const msg = (second.stderr || '') + (second.stdout || '');
    assert(/refusing to start/i.test(msg), `refusal message expected, got: ${msg}`);
    assert(msg.includes(String(first.pid)), `refusal should name the live pid ${first.pid}, got: ${msg}`);

    // A one-shot (non-watch) snapshot to the SAME --out is UNaffected.
    const oneShot = spawnSync(process.execPath, [SCRIPT, '--out', dir, '--repo', 'example/none', '--no-open'], { encoding: 'utf8' });
    assert(oneShot.status === 0, `one-shot snapshot should succeed (exit 0), got ${oneShot.status}: ${oneShot.stderr}`);
  } finally {
    first.kill();
    await sleep(200);
    rmSync(dir, { recursive: true, force: true });
  }
});

// --- e2e: --strict served mismatch refuses ---------------------------------
await testAsync('e2e: --strict with a served-root != --out refuses to start', async () => {
  const out = tmpDir(), served = tmpDir();
  try {
    const res = spawnSync(process.execPath, [
      SCRIPT, '--out', out, '--repo', 'example/none', '--no-open',
      '--served-root', served, '--strict',
    ], { encoding: 'utf8' });
    assert(res.status === 1, `--strict mismatch should exit 1, got ${res.status}`);
    const msg = (res.stderr || '') + (res.stdout || '');
    assert(/SERVED-DIR MISMATCH/i.test(msg), `served-dir banner expected, got: ${msg}`);
  } finally {
    rmSync(out, { recursive: true, force: true });
    rmSync(served, { recursive: true, force: true });
  }
});

// --- Report ----------------------------------------------------------------
if (failures.length) {
  console.error(`spyglass-run-snapshot.test.mjs: ${failures.length} FAILED, ${passed} passed`);
  for (const f of failures) console.error(`  ✗ ${f}`);
  process.exit(1);
}
console.log(`spyglass-run-snapshot.test.mjs: all ${passed} tests passed`);
