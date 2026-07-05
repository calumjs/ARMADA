#!/usr/bin/env node
// ARMADA sea-trial preflight — decide whether a runtime shakedown can run, and never error.
//
// sea-trial launches the project's app (via .armada/config.json → commands.run) and drives a
// real user flow with Playwright to verify a change works at RUNTIME. That whole pass is optional:
// a repo with no runnable app, or a host with no Playwright/browser, must SKIP or DEGRADE with a
// clear note — never fail the build. This preflight is the gate the skill runs FIRST. It reads the
// config read-only, probes for a browser driver, and reports one of three verdicts:
//
//   ready    — commands.run present AND a Playwright/browser backend resolvable → the drive can run
//   degrade  — commands.run present BUT no Playwright/browser → launch-only smoke, no drive
//   skip     — no commands.run (no runnable app) → nothing to shake down
//
// It ALWAYS exits 0 for these verdicts (skip/degrade are the design, not errors). It is dependency-
// free (Node builtins only) and touches nothing on disk — a preflight must never block the fleet.
//
// Run:  node scripts/sea-trial-preflight.mjs [--config <path>] [--json] [--max-runtime-sec N]

import { readFileSync, existsSync } from 'fs';
import { createRequire } from 'module';
import path from 'path';

function parseArgs(argv) {
  const args = { config: '.armada/config.json', json: false, maxRuntimeSec: 180 };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--json') args.json = true;
    else if (a === '--config' || a === '--max-runtime-sec') {
      // Value-flags MUST be followed by a value. A trailing value-flag (or one immediately
      // followed by another flag) is a malformed invocation — if we blindly consumed the next
      // token we'd assign `undefined` and later throw in existsSync(undefined). Record it and
      // let the run degrade to a clean SKIP (exit 0) instead of throwing.
      const val = argv[i + 1];
      if (val === undefined || (typeof val === 'string' && val.startsWith('--'))) {
        args.malformed = `${a} given with no value`;
        continue; // don't consume a token; keep defaults intact
      }
      i++;
      if (a === '--config') args.config = val;
      else args.maxRuntimeSec = Number(val) || args.maxRuntimeSec;
    }
  }
  return args;
}

// Read commands.run from the repo's config, tolerating an absent/malformed file (fail soft → skip).
function readRunCommand(configPath) {
  // Guard against a non-string path (belt-and-suspenders vs a malformed --config): existsSync(undefined)
  // throws a TypeError, which would violate the never-throws contract. Treat it as a clean skip.
  if (typeof configPath !== 'string' || !existsSync(configPath)) return { present: false, reason: 'not commissioned (.armada/config.json absent)' };
  let cfg;
  try {
    cfg = JSON.parse(readFileSync(configPath, 'utf8'));
  } catch (e) {
    return { present: false, reason: `config unreadable (${e.message})` };
  }
  const run = cfg && cfg.commands && cfg.commands.run;
  if (typeof run !== 'string' || run.trim() === '') {
    return { present: false, reason: 'no runnable app (commands.run absent)', budget: cfg && cfg['sea-trial'] };
  }
  return { present: true, command: run.trim(), budget: cfg && cfg['sea-trial'] };
}

// Probe for a browser driver, degrading gracefully. We never install anything — we only detect.
function probePlaywright() {
  // An explicit system-browser path/channel counts as a usable backend even without Playwright's
  // own Chromium (mirrors logbook's LOGBOOK_BROWSER_EXECUTABLE / _CHANNEL escape hatches).
  const exe = process.env.SEA_TRIAL_BROWSER_EXECUTABLE || process.env.LOGBOOK_BROWSER_EXECUTABLE;
  const channel = process.env.SEA_TRIAL_BROWSER_CHANNEL || process.env.LOGBOOK_BROWSER_CHANNEL;
  const require = createRequire(import.meta.url);
  for (const mod of ['playwright', 'playwright-core', 'puppeteer', 'puppeteer-core']) {
    try {
      require.resolve(mod);
      return { available: true, via: mod };
    } catch { /* keep probing */ }
  }
  if (exe && existsSync(exe)) return { available: true, via: `system browser (${path.basename(exe)})` };
  if (channel) return { available: true, via: `system browser channel (${channel})` };
  return { available: false, reason: 'no Playwright/Puppeteer module and no SEA_TRIAL_BROWSER_EXECUTABLE/_CHANNEL' };
}

const args = parseArgs(process.argv.slice(2));
// A malformed invocation (e.g. a trailing value-flag with no value) can't be trusted to point at the
// right config — degrade to a clean SKIP rather than reading an undefined path (which would throw).
const run = args.malformed
  ? { present: false, reason: `malformed invocation (${args.malformed})` }
  : readRunCommand(args.config);
const browser = run.present ? probePlaywright() : { available: false, reason: 'not probed (no runnable app)' };

let verdict, reason;
if (!run.present) {
  verdict = 'skip';
  reason = run.reason;
} else if (!browser.available) {
  verdict = 'degrade';
  reason = `${browser.reason} — launch-only smoke, no browser drive`;
} else {
  verdict = 'ready';
  reason = `runnable app + browser backend (${browser.via})`;
}

// Effective runtime budget: config sea-trial.budget.maxRuntimeSec wins, else the CLI/default.
const cfgBudget = run.budget && run.budget.budget && Number(run.budget.budget.maxRuntimeSec);
const maxRuntimeSec = cfgBudget > 0 ? cfgBudget : args.maxRuntimeSec;

const report = {
  verdict,                       // "ready" | "degrade" | "skip"
  reason,
  runCommand: run.present ? run.command : null,
  browser: run.present ? browser : null,
  maxRuntimeSec,
};

if (args.json) {
  console.log(JSON.stringify(report, null, 2));
} else {
  const icon = { ready: '🟢', degrade: '🟡', skip: '⚪' }[verdict];
  console.log(`${icon} sea-trial preflight: ${verdict.toUpperCase()} — ${reason}`);
  if (run.present) console.log(`   run: ${run.command}`);
  console.log(`   runtime budget: ${maxRuntimeSec}s`);
  if (verdict === 'skip') console.log('   → no runtime verification possible; report SKIPPED (not a failure).');
  if (verdict === 'degrade') console.log('   → launch the app and smoke-check it starts; skip the browser drive.');
}

// Never error on a skip/degrade/ready verdict — degradation is the design, not a failure.
process.exit(0);
