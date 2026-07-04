// Throwaway stress harness — NOT shipped. Hammers the two race scenarios with real
// subprocesses and counts exact winners per trial. Run: node scripts/_race-harness.mjs
import { spawn } from 'child_process';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'fs';
import path from 'path';
import os from 'os';
import { fileURLToPath, pathToFileURL } from 'url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SCRIPT_URL = pathToFileURL(path.join(HERE, 'spyglass-run-snapshot.mjs')).href;
const LOCK_NAME = '.spyglass-run.lock';
const LOCK_INFO = 'owner.json';

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
function collect(child) {
  return new Promise((resolve) => { let o = ''; child.stdout.on('data', d => o += d); child.on('close', () => resolve(o.trim())); });
}
async function trial(seedStale, n) {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'race-'));
  try {
    if (seedStale) {
      const ld = path.join(dir, LOCK_NAME); mkdirSync(ld, { recursive: true });
      writeFileSync(path.join(ld, LOCK_INFO), JSON.stringify({ pid: 2 ** 31 - 1, startedAt: new Date().toISOString(), out: dir }));
    }
    const kids = Array.from({ length: n }, () => spawnAcquirer(dir));
    const res = await Promise.all(kids.map(collect));
    return res.filter(r => r === 'OK').length;
  } finally { rmSync(dir, { recursive: true, force: true }); }
}

const ITER = Number(process.argv[2] || 100);
const RACERS = Number(process.argv[3] || 3);
for (const [name, stale] of [['FRESH', false], ['STALE', true]]) {
  const counts = {};
  let bad = 0;
  for (let i = 0; i < ITER; i++) {
    const oks = await trial(stale, RACERS);
    counts[oks] = (counts[oks] || 0) + 1;
    if (oks !== 1) bad++;
  }
  console.log(`${name} takeover, ${RACERS} racers x ${ITER} trials: winners-distribution=${JSON.stringify(counts)}  double-or-zero-wins=${bad}`);
}
