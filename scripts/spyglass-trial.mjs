#!/usr/bin/env node
// ARMADA spyglass — the repeatable "sea trial" capture harness (issue #54, F).
//
// The spyglass view is a *visual* deliverable: "beautiful" can't be asserted
// blind, it has to be SEEN. This harness re-runs the closed visual-feedback
// loop on demand — render each canonical fleet state headlessly, capture a PNG,
// and leave the images for inspection / visual-regression comparison.
//
// It is READ-ONLY w.r.t. the fleet and the tracked repo: it touches GitHub not
// at all (it renders synthetic fixtures from spyglass-fixtures.mjs, plus,
// optionally, a real read-only snapshot you pass in), serves a scratch output
// dir over a throwaway localhost server (file:// blocks the app's fetch of
// fleet-state.json), and writes only PNGs + a copied app/JSON into that scratch
// dir. Nothing is shipped into the rendered view — this is a dev/test aid.
//
// It uses the already-available Playwright CLI (`npx playwright screenshot`),
// so it stays dependency-free itself: it spawns the CLI rather than importing a
// module. prefers-reduced-motion is forced via the app's `?reduced=1` URL hook
// (which the app honours in addition to the media query), so the CLI alone is
// enough — no module-level reducedMotion context needed.
//
// Run:
//   node spyglass-trial.mjs                 # all fixtures, default + narrow sizes,
//                                           # plus a reduced-motion render
//   node spyglass-trial.mjs --out <dir>     # choose the scratch/output dir
//   node spyglass-trial.mjs --only storm,calm
//   node spyglass-trial.mjs --channel chrome   # default: msedge
//   node spyglass-trial.mjs --snapshot <fleet-state.json>  # also trial a real snapshot

import { readFileSync, writeFileSync, copyFileSync, mkdirSync, existsSync } from 'fs';
import path from 'path';
import os from 'os';
import { fileURLToPath } from 'url';
import { spawn } from 'child_process';
import { FIXTURES } from './spyglass-fixtures.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const APP = path.join(__dirname, 'spyglass-app.html');

function parseArgs(argv) {
  const a = { channel: 'msedge', only: null, snapshot: null, out: null, settleMs: 1400 };
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i];
    if (k === '--out') a.out = argv[++i];
    else if (k === '--channel') a.channel = argv[++i];
    else if (k === '--only') a.only = argv[++i].split(',').map((s) => s.trim()).filter(Boolean);
    else if (k === '--snapshot') a.snapshot = argv[++i];
    else if (k === '--settle') a.settleMs = Number(argv[++i]) || 1400;
  }
  return a;
}

const MIME = { '.html': 'text/html', '.json': 'application/json', '.png': 'image/png' };

// Serve a single dir over HTTP — in a SEPARATE child process. This matters:
// the capture step blocks while Playwright (a child) makes HTTP requests back
// to us; if the server lived in this process its event loop would be busy
// supervising the capture and the navigation could stall. A dedicated server
// process sidesteps that entirely. Returns { url, close }.
function serve(dir) {
  return new Promise((resolve, reject) => {
    const code = `
      const http = require('http'), fs = require('fs'), path = require('path');
      const dir = ${JSON.stringify(dir)};
      const MIME = ${JSON.stringify(MIME)};
      const srv = http.createServer((req, res) => {
        const rel = decodeURIComponent((req.url || '/').split('?')[0]);
        const file = path.join(dir, rel === '/' ? 'spyglass.html' : rel);
        if (!file.startsWith(dir)) { res.writeHead(403); res.end(); return; }
        try {
          const body = fs.readFileSync(file);
          res.writeHead(200, { 'content-type': MIME[path.extname(file)] || 'application/octet-stream', 'cache-control': 'no-store' });
          res.end(body);
        } catch { res.writeHead(404); res.end('not found'); }
      });
      srv.listen(0, '127.0.0.1', () => process.stdout.write('PORT ' + srv.address().port + '\\n'));
    `;
    const child = spawn(process.execPath, ['-e', code], { stdio: ['ignore', 'pipe', 'pipe'] });
    let buf = '';
    const onData = (d) => {
      buf += d;
      const m = buf.match(/PORT (\d+)/);
      if (m) { child.stdout.off('data', onData); resolve({ url: `http://127.0.0.1:${m[1]}`, close: () => child.kill() }); }
    };
    child.stdout.on('data', onData);
    child.on('error', reject);
    setTimeout(() => reject(new Error('server did not start in time')), 5000);
  });
}

// One capture via the Playwright CLI. Returns true on success.
//
// We run through a shell (required to launch `npx`/`npx.cmd` on Windows), so we
// quote every argument ourselves — otherwise the viewport "W,H" / the URL would
// be word-split by the shell. q() wraps an arg in double quotes safely.
const q = (s) => `"${String(s).replace(/(["\\])/g, '\\$1')}"`;
// One capture via the Playwright CLI — ASYNC (returns a Promise<boolean>).
// It must be async: the static server runs in THIS process's event loop, so a
// blocking spawnSync would starve it and Playwright's navigation would hang.
// We go through a shell (to launch npx/npx.cmd on Windows) and quote args
// ourselves so the viewport "W,H" and URL aren't word-split.
function capture({ pageUrl, out, channel, size, settleMs, colorScheme }) {
  const parts = [
    'npx', 'playwright', 'screenshot',
    '--channel', channel,
    '--viewport-size', q(`${size[0]},${size[1]}`),
    '--wait-for-timeout', String(settleMs),
  ];
  if (colorScheme) parts.push('--color-scheme', colorScheme);
  parts.push(q(pageUrl), q(out));
  return new Promise((resolve) => {
    const child = spawn(parts.join(' '), { stdio: ['ignore', 'pipe', 'pipe'], shell: true });
    let err = '';
    child.stderr.on('data', (d) => { err += d; });
    child.stdout.on('data', () => {});
    child.on('error', (e) => { console.error(`  ✗ capture failed (${path.basename(out)}): ${e.message}`); resolve(false); });
    child.on('close', (code) => {
      if (code !== 0) { console.error(`  ✗ capture failed (${path.basename(out)}): ${err.trim().split('\n').slice(-2).join(' ')}`); resolve(false); }
      else resolve(true);
    });
  });
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const outDir = args.out || path.join(os.tmpdir(), 'armada-spyglass-trial');
  const shots = path.join(outDir, 'captures');
  mkdirSync(shots, { recursive: true });

  if (!existsSync(APP)) { console.error(`spyglass app not found: ${APP}`); process.exit(1); }

  // States to trial: synthetic fixtures (+ optional real snapshot).
  const names = (args.only || Object.keys(FIXTURES)).filter((n) => FIXTURES[n] || n === 'snapshot');
  const states = names.map((n) => ({ name: n, json: JSON.stringify(FIXTURES[n](), null, 2) }));
  if (args.snapshot) {
    states.push({ name: 'snapshot', json: readFileSync(args.snapshot, 'utf8') });
  }

  const server = await serve(outDir);
  // Copy the app once; we rewrite fleet-state.json per state.
  copyFileSync(APP, path.join(outDir, 'spyglass.html'));

  const SIZES = { wide: [1600, 1000], narrow: [760, 1100] };
  let ok = 0, fail = 0;
  console.log(`spyglass-trial: ${states.length} state(s) → ${shots}`);
  for (const st of states) {
    writeFileSync(path.join(outDir, 'fleet-state.json'), st.json);
    // wide motion render
    const wide = path.join(shots, `${st.name}-wide.png`);
    (await capture({ pageUrl: server.url, out: wide, channel: args.channel, size: SIZES.wide, settleMs: args.settleMs }) ? ok++ : fail++);
    // narrow render — the small-viewport / no-overlap check
    const narrow = path.join(shots, `${st.name}-narrow.png`);
    (await capture({ pageUrl: server.url, out: narrow, channel: args.channel, size: SIZES.narrow, settleMs: args.settleMs }) ? ok++ : fail++);
    // reduced-motion render — forced via the app's ?reduced=1 hook
    const reduced = path.join(shots, `${st.name}-reduced.png`);
    (await capture({ pageUrl: server.url + '/spyglass.html?reduced=1', out: reduced, channel: args.channel, size: SIZES.wide, settleMs: args.settleMs }) ? ok++ : fail++);
    console.log(`  • ${st.name}: wide + narrow + reduced`);
  }
  server.close();

  console.log(`spyglass-trial: ${ok} capture(s) ok, ${fail} failed → ${shots}`);
  if (fail > 0) process.exitCode = 1;
}

main().catch((e) => { console.error(e); process.exit(1); });
