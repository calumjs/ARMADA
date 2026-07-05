#!/usr/bin/env node
// ARMADA sea-trial preflight — never-throws / clean-exit tests (dependency-free).
//
// The preflight's core contract is: it ALWAYS exits 0 and NEVER throws, whatever the
// invocation — a malformed CLI, an absent/empty config, a runnable app with no browser.
// A thrown TypeError (e.g. existsSync(undefined) from a trailing value-flag) would violate
// that contract and let an optional runtime skill wedge a build. These tests spawn the real
// script as a subprocess and assert exit 0 with no error on stderr for each degraded path,
// including the regression case: `--config` given as the last token with no value.
//
// Run: node scripts/sea-trial-preflight.test.mjs

import { spawnSync } from 'child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';

const here = path.dirname(fileURLToPath(import.meta.url));
const script = path.join(here, 'sea-trial-preflight.mjs');

let pass = 0, fail = 0;
function check(name, cond, detail) {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`); }
}

// Run the preflight from `cwd` with `args`, returning { code, stdout, stderr }.
function runPreflight(args, cwd) {
  const r = spawnSync(process.execPath, [script, ...args], { cwd, encoding: 'utf8' });
  return { code: r.status, stdout: r.stdout || '', stderr: r.stderr || '' };
}

// A run "threw" if the process exited non-zero or emitted a stack trace / Error on stderr.
function threw(r) {
  return r.code !== 0 || /Error|throw|at \S+ \(/.test(r.stderr);
}

const tmp = mkdtempSync(path.join(os.tmpdir(), 'sea-trial-pf-'));

try {
  console.log('sea-trial preflight — never throws, always exits 0');

  // ---- 1. MANDATORY regression: `--config` as the last token, no value following ----
  // Before the fix this set args.config = undefined → existsSync(undefined) → TypeError.
  {
    const r = runPreflight(['--config'], tmp);
    check('--config with no value → exit 0', r.code === 0, `code=${r.code}`);
    check('--config with no value → does not throw', !threw(r), r.stderr.trim());
    check('--config with no value → SKIP verdict', /SKIP/i.test(r.stdout), r.stdout.trim());
  }

  // ---- 1b. `--config` followed by another flag (also a missing value) ----
  {
    const r = runPreflight(['--config', '--json'], tmp);
    check('--config --json (flag as value) → exit 0', r.code === 0, `code=${r.code}`);
    check('--config --json → does not throw', !threw(r), r.stderr.trim());
  }

  // ---- 1c. `--max-runtime-sec` as the last token, no value ----
  {
    const r = runPreflight(['--max-runtime-sec'], tmp);
    check('--max-runtime-sec with no value → exit 0', r.code === 0, `code=${r.code}`);
    check('--max-runtime-sec with no value → does not throw', !threw(r), r.stderr.trim());
  }

  // ---- 2. No config file present (not commissioned) → clean SKIP ----
  {
    const noCfg = mkdtempSync(path.join(os.tmpdir(), 'sea-trial-nocfg-'));
    const r = runPreflight([], noCfg);
    check('no config → exit 0', r.code === 0, `code=${r.code}`);
    check('no config → SKIP', /SKIP/i.test(r.stdout) && !threw(r), r.stdout.trim());
    rmSync(noCfg, { recursive: true, force: true });
  }

  // ---- 3. Config present but NO commands.run (no runnable app) → clean SKIP ----
  {
    const noApp = mkdtempSync(path.join(os.tmpdir(), 'sea-trial-noapp-'));
    mkdirSync(path.join(noApp, '.armada'));
    writeFileSync(path.join(noApp, '.armada', 'config.json'), JSON.stringify({ commands: { test: 'x' } }));
    const r = runPreflight([], noApp);
    check('no commands.run → exit 0', r.code === 0, `code=${r.code}`);
    check('no commands.run → SKIP', /SKIP/i.test(r.stdout) && !threw(r), r.stdout.trim());
    rmSync(noApp, { recursive: true, force: true });
  }

  // ---- 4. Config WITH commands.run but no Playwright/browser → DEGRADE (still exit 0) ----
  {
    const app = mkdtempSync(path.join(os.tmpdir(), 'sea-trial-app-'));
    mkdirSync(path.join(app, '.armada'));
    writeFileSync(path.join(app, '.armada', 'config.json'), JSON.stringify({ commands: { run: 'npm start' } }));
    // Clear any system-browser escape hatches so the probe genuinely finds no backend.
    const env = { ...process.env };
    delete env.SEA_TRIAL_BROWSER_EXECUTABLE; delete env.SEA_TRIAL_BROWSER_CHANNEL;
    delete env.LOGBOOK_BROWSER_EXECUTABLE; delete env.LOGBOOK_BROWSER_CHANNEL;
    const r = spawnSync(process.execPath, [script], { cwd: app, encoding: 'utf8', env });
    const res = { code: r.status, stdout: r.stdout || '', stderr: r.stderr || '' };
    check('runnable app, no browser → exit 0', res.code === 0, `code=${res.code}`);
    check('runnable app, no browser → does not throw', !threw(res), res.stderr.trim());
    // Either DEGRADE (no browser resolvable) or READY (host happens to have Playwright) — never a throw.
    check('runnable app → DEGRADE or READY', /DEGRADE|READY/i.test(res.stdout), res.stdout.trim());
    rmSync(app, { recursive: true, force: true });
  }

  console.log(`\n${fail === 0 ? '✓ PASS' : '✗ FAIL'} — ${pass} passed, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
} finally {
  rmSync(tmp, { recursive: true, force: true });
}
