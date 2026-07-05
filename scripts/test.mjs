#!/usr/bin/env node
// ARMADA test runner — the fleet's actual gate command.
//
// Runs the two things that make up "the ARMADA test suite", in order:
//   1. validate-skills.mjs — every skills/<name>/SKILL.md has well-formed frontmatter.
//   2. every scripts/*.test.mjs — the dependency-free unit suite covering the fleet's
//      safety-critical logic (merge-gate, review-merge-pipeline, quartermaster,
//      semver-higher-merge, spyglass snapshot/cost, consolidate-run-artifacts, …).
//
// Each child is a plain Node script that self-reports its checks and exits non-zero
// on any failure (Node built-ins only — no external test libs). This runner spawns
// each one, streams its output, and exits non-zero if ANY child fails, so the merge
// gate (commands.test) fails closed when either the frontmatter validation OR any
// unit test breaks. Previously commands.test ran validate-skills.mjs alone, so the
// gate was blind to the unit suite — this wires it in.
//
// Dependency-free and REPO-LOCAL to ARMADA: it runs against this checkout's own
// scripts/ dir via bare relative paths, matching validate-skills.mjs. Point the
// fleet's commands.test at it:  "test": "node scripts/test.mjs"
//
// Run: node scripts/test.mjs

import { readdirSync } from 'fs';
import { spawnSync } from 'child_process';
import path from 'path';
import { fileURLToPath } from 'url';

const SCRIPTS_DIR = path.dirname(fileURLToPath(import.meta.url));

// Ordered list of suites to run. validate-skills first (fast frontmatter gate),
// then every discovered *.test.mjs in stable alphabetical order.
const suites = ['validate-skills.mjs'];
for (const entry of readdirSync(SCRIPTS_DIR).sort()) {
  if (entry.endsWith('.test.mjs')) suites.push(entry);
}

const results = [];
for (const suite of suites) {
  const file = path.join(SCRIPTS_DIR, suite);
  console.log(`\n── ${suite} ${'─'.repeat(Math.max(0, 48 - suite.length))}`);
  const r = spawnSync(process.execPath, [file], { stdio: 'inherit' });
  const ok = r.status === 0 && !r.error;
  if (r.error) console.error(`  ✗ failed to launch ${suite}: ${r.error.message}`);
  results.push({ suite, ok, status: r.status });
}

const failed = results.filter((r) => !r.ok);
console.log(`\n${'='.repeat(56)}`);
console.log('ARMADA test suite');
for (const r of results) {
  console.log(`  ${r.ok ? '✓' : '✗'} ${r.suite}${r.ok ? '' : ` (exit ${r.status})`}`);
}
console.log(
  `\n${results.length - failed.length}/${results.length} suite(s) passed` +
    (failed.length ? ` — ${failed.length} FAILED` : ''),
);

process.exit(failed.length ? 1 : 0);
