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
// Browser channel: the harness drives whatever already-installed Chromium-family
// channel you pass with `--channel` — default `msedge` (Microsoft Edge), or
// `--channel chrome` for Google Chrome. It adds no browser/runtime dependency of
// its own; the channel must already be present on the machine.
//
// Run:
//   node spyglass-trial.mjs                 # all fixtures, default + narrow sizes,
//                                           # plus a reduced-motion render
//   node spyglass-trial.mjs --out <dir>     # choose the scratch/output dir
//   node spyglass-trial.mjs --only storm,calm
//   node spyglass-trial.mjs --channel chrome   # default: msedge
//   node spyglass-trial.mjs --snapshot <fleet-state.json>  # also trial a real snapshot
//
// Exit code: 0 only if EVERY expected PNG was captured and is non-empty; on any
// failure the harness prints the underlying Playwright error and exits non-zero,
// so a broken trial can never be mistaken for a passing one.

import { readFileSync, writeFileSync, copyFileSync, mkdirSync, existsSync, statSync } from 'fs';
import http from 'http';
import path from 'path';
import os from 'os';
import { fileURLToPath } from 'url';
import { spawn } from 'child_process';
import { FIXTURES } from './spyglass-fixtures.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const APP = path.join(__dirname, 'spyglass-app.html');

function parseArgs(argv) {
  const a = { channel: 'msedge', only: null, snapshot: null, out: null, settleMs: 1400, retries: 2, navTimeoutMs: 30000 };
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i];
    if (k === '--out') a.out = argv[++i];
    else if (k === '--channel') a.channel = argv[++i];
    else if (k === '--only') a.only = argv[++i].split(',').map((s) => s.trim()).filter(Boolean);
    else if (k === '--snapshot') a.snapshot = argv[++i];
    else if (k === '--settle') a.settleMs = Number(argv[++i]) || 1400;
    else if (k === '--retries') a.retries = Math.max(0, Number(argv[++i]) || 0);
    else if (k === '--timeout') a.navTimeoutMs = Number(argv[++i]) || 30000;
  }
  return a;
}

const MIME = { '.html': 'text/html', '.json': 'application/json', '.png': 'image/png' };

// Serve a single dir over HTTP — in a SEPARATE child process. This matters:
// the capture step blocks while Playwright (a child) makes HTTP requests back
// to us; if the server lived in this process its event loop would be busy
// supervising the capture and the navigation could stall. A dedicated server
// process sidesteps that entirely. Returns { url, close }.
//
// `dir` is resolved to a canonical absolute path BEFORE it crosses into the
// child: the child's path-traversal guard compares `path.resolve(file)` against
// `path.resolve(dir)`, so the two are always in the same normalised form. The
// previous guard compared a `path.join`-normalised file path against the raw,
// un-normalised `dir` string — which falsely tripped (a spurious 403 → the app
// never loaded → Playwright reported `net::ERR_HTTP_RESPONSE_CODE_FAILURE`,
// surfaced only as "navigating … waiting until load") whenever `dir` arrived in
// a different shape than `path.join` emits (a forward-slash `--out`, a relative
// path, a trailing separator, or mixed separators on Windows).
function serve(dir) {
  const root = path.resolve(dir);
  return new Promise((resolve, reject) => {
    const code = `
      const http = require('http'), fs = require('fs'), path = require('path');
      const root = path.resolve(${JSON.stringify(root)});
      const MIME = ${JSON.stringify(MIME)};
      const srv = http.createServer((req, res) => {
        const rel = decodeURIComponent((req.url || '/').split('?')[0]);
        const file = path.resolve(root, '.' + (rel === '/' ? '/spyglass.html' : rel));
        // Contain to root: file must equal root or sit under root + separator.
        if (file !== root && !file.startsWith(root + path.sep)) { res.writeHead(403); res.end('forbidden'); return; }
        try {
          const body = fs.readFileSync(file);
          res.writeHead(200, { 'content-type': MIME[path.extname(file)] || 'application/octet-stream', 'cache-control': 'no-store' });
          res.end(body);
        } catch { res.writeHead(404); res.end('not found'); }
      });
      srv.listen(0, '127.0.0.1', () => process.stdout.write('PORT ' + srv.address().port + '\\n'));
    `;
    const child = spawn(process.execPath, ['-e', code], { stdio: ['ignore', 'pipe', 'pipe'] });
    // Drain stderr so a full pipe buffer can never block the server child, and
    // so a child startup error is visible rather than swallowed.
    let childErr = '';
    child.stderr.on('data', (d) => { childErr += d; });
    let settled = false;
    const fail = (msg) => { if (settled) return; settled = true; try { child.kill(); } catch {} reject(new Error(msg + (childErr ? `\n${childErr.trim()}` : ''))); };
    let buf = '';
    const onData = (d) => {
      buf += d;
      const m = buf.match(/PORT (\d+)/);
      if (m && !settled) { settled = true; child.stdout.off('data', onData); resolve({ url: `http://127.0.0.1:${m[1]}`, close: () => { try { child.kill(); } catch {} } }); }
    };
    child.stdout.on('data', onData);
    child.on('error', (e) => fail(`server failed to spawn: ${e.message}`));
    child.on('exit', (code) => { if (!settled) fail(`server exited before listening (code ${code})`); });
    setTimeout(() => fail('server did not start in time'), 5000);
  });
}

// Readiness handshake: even once the child has printed its PORT (the `listen`
// callback fired), poll the URL until it actually answers a request with a 2xx —
// don't race a capture against a server that is listening but not yet serving.
// Resolves when the server returns < 400 for `/`; rejects after `timeoutMs`.
function waitUntilReady(url, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve, reject) => {
    const attempt = () => {
      const req = http.get(url + '/', (res) => {
        res.resume(); // drain
        if (res.statusCode && res.statusCode < 400) return resolve();
        retryOrFail(new Error(`server not ready: HTTP ${res.statusCode}`));
      });
      req.on('error', (e) => retryOrFail(e));
      req.setTimeout(2000, () => { req.destroy(new Error('readiness probe timed out')); });
    };
    const retryOrFail = (e) => {
      if (Date.now() >= deadline) return reject(new Error(`server never became ready: ${e.message}`));
      setTimeout(attempt, 120);
    };
    attempt();
  });
}

// We run through a shell (required to launch `npx`/`npx.cmd` on Windows), so we
// quote every argument ourselves — otherwise the viewport "W,H" / the URL would
// be word-split by the shell. q() wraps an arg in double quotes safely.
const q = (s) => `"${String(s).replace(/(["\\])/g, '\\$1')}"`;

// One capture via the Playwright CLI — ASYNC (returns a Promise of a result).
// It must be async: the static server runs in a child process and the parent's
// own event loop should stay responsive while Playwright (also a child) drives
// the navigation. We go through a shell (to launch npx/npx.cmd on Windows) and
// quote args ourselves so the viewport "W,H" and URL aren't word-split.
//
// Robust navigation:
//   --timeout            bounds every Playwright action (default 30s); without
//                        it the CLI uses "no timeout" and a stuck nav hangs.
//   --wait-for-selector  await the app's first paint — the canvas exists and the
//                        status line has been written after the fleet-state.json
//                        fetch resolves — so the screenshot isn't taken before
//                        the scene renders. The app sets #status on first poll().
//   --wait-for-timeout   a short settle on top, for the eased animation frame.
//
// Returns { ok, code, err } so the caller can retry transient failures and
// surface the underlying Playwright error on a final failure.
function capture({ pageUrl, out, channel, size, settleMs, colorScheme, navTimeoutMs }) {
  const parts = [
    'npx', 'playwright', 'screenshot',
    '--channel', channel,
    '--viewport-size', q(`${size[0]},${size[1]}`),
    '--timeout', String(navTimeoutMs),
    '--wait-for-selector', q('#status'),
    '--wait-for-timeout', String(settleMs),
  ];
  if (colorScheme) parts.push('--color-scheme', colorScheme);
  parts.push(q(pageUrl), q(out));
  return new Promise((resolve) => {
    const child = spawn(parts.join(' '), { stdio: ['ignore', 'pipe', 'pipe'], shell: true });
    let err = '';
    child.stderr.on('data', (d) => { err += d; });
    child.stdout.on('data', () => {});
    child.on('error', (e) => resolve({ ok: false, code: null, err: e.message }));
    child.on('close', (code) => resolve({ ok: code === 0, code, err: err.trim() }));
  });
}

// Capture with bounded retry of transient failures. Verifies the PNG was
// actually written and is non-empty (a 0-byte file is a failure even if the CLI
// exited 0). On a final failure it returns the full underlying error so the
// caller can surface it.
async function captureWithRetry(opts, retries) {
  let last = { ok: false, err: 'not attempted' };
  for (let attempt = 0; attempt <= retries; attempt++) {
    last = await capture(opts);
    if (last.ok) {
      try {
        if (statSync(opts.out).size > 0) return { ok: true };
        last = { ok: false, err: 'screenshot file is empty (0 bytes)' };
      } catch (e) {
        last = { ok: false, err: `screenshot file missing after capture: ${e.message}` };
      }
    }
    if (attempt < retries) {
      process.stderr.write(`  … retry ${attempt + 1}/${retries} for ${path.basename(opts.out)}\n`);
    }
  }
  return { ok: false, err: last.err, code: last.code };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  // Resolve to a canonical absolute path: a relative or forward-slash `--out`
  // must be the SAME shape the server child's path guard resolves to (see serve).
  const outDir = path.resolve(args.out || path.join(os.tmpdir(), 'armada-spyglass-trial'));
  const shots = path.join(outDir, 'captures');
  mkdirSync(shots, { recursive: true });

  if (!existsSync(APP)) { console.error(`spyglass app not found: ${APP}`); process.exit(1); }

  // States to trial: synthetic fixtures (+ optional real snapshot).
  const names = (args.only || Object.keys(FIXTURES)).filter((n) => FIXTURES[n] || n === 'snapshot');
  const states = names.map((n) => ({ name: n, json: JSON.stringify(FIXTURES[n](), null, 2) }));
  if (args.snapshot) {
    states.push({ name: 'snapshot', json: readFileSync(args.snapshot, 'utf8') });
  }

  // Copy the app and seed an initial fleet-state.json BEFORE serving, so the
  // readiness probe (and any first navigation) sees a real page, not a 404.
  copyFileSync(APP, path.join(outDir, 'spyglass.html'));
  if (states.length) writeFileSync(path.join(outDir, 'fleet-state.json'), states[0].json);

  const server = await serve(outDir);
  // Readiness handshake: wait until the server actually answers before any
  // capture — don't race a still-spawning server.
  try {
    await waitUntilReady(server.url);
  } catch (e) {
    server.close();
    console.error(`spyglass-trial: ${e.message}`);
    process.exit(1);
  }

  const SIZES = { wide: [1600, 1000], narrow: [760, 1100] };
  let ok = 0, fail = 0;
  const failures = [];
  console.log(`spyglass-trial: ${states.length} state(s) → ${shots} (channel: ${args.channel})`);

  const runOne = async (label, pageUrl, out, size) => {
    const r = await captureWithRetry(
      { pageUrl, out, channel: args.channel, size, settleMs: args.settleMs, navTimeoutMs: args.navTimeoutMs },
      args.retries,
    );
    if (r.ok) { ok++; return; }
    fail++;
    const detail = r.err || `exit ${r.code}`;
    failures.push({ label, out: path.basename(out), detail });
    console.error(`  ✗ ${label} (${path.basename(out)}) failed:\n${detail.split('\n').map((l) => '      ' + l).join('\n')}`);
  };

  for (const st of states) {
    writeFileSync(path.join(outDir, 'fleet-state.json'), st.json);
    // wide motion render
    await runOne(`${st.name}/wide`, server.url, path.join(shots, `${st.name}-wide.png`), SIZES.wide);
    // narrow render — the small-viewport / no-overlap check
    await runOne(`${st.name}/narrow`, server.url, path.join(shots, `${st.name}-narrow.png`), SIZES.narrow);
    // reduced-motion render — forced via the app's ?reduced=1 hook
    await runOne(`${st.name}/reduced`, server.url + '/spyglass.html?reduced=1', path.join(shots, `${st.name}-reduced.png`), SIZES.wide);
    console.log(`  • ${st.name}: wide + narrow + reduced`);
  }
  server.close();

  console.log(`spyglass-trial: ${ok} capture(s) ok, ${fail} failed → ${shots}`);
  if (fail > 0) {
    // Surface failures loudly and exit non-zero — a broken trial must never be
    // mistaken for a passing one.
    console.error(`spyglass-trial: FAILED — ${fail} capture(s) did not produce a usable PNG:`);
    for (const f of failures) console.error(`  - ${f.label} (${f.out})`);
    process.exit(1);
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
