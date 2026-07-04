#!/usr/bin/env node
// ARMADA plugin.json version-conflict merge driver.
//
// Every fleet PR bumps `.claude-plugin/plugin.json` `version` (the release rule —
// see the README "Releasing & versioning" section). When two PRs are in flight the
// second to merge collides on that single `version` line. This is a custom git
// *merge driver* that resolves exactly that collision automatically: it 3-way-merges
// the file and, for any conflict that is purely the `version` line, keeps the HIGHER
// semver and drops the conflict markers. Any *other* conflict is left for a human
// (the driver exits non-zero so git records a normal conflict).
//
// Dependency-free (Node built-ins + the `git` binary already on PATH), to match
// validate-skills.mjs / merge-gate.mjs and the rest of scripts/.
//
// Registered via .gitattributes:
//     .claude-plugin/plugin.json merge=semver-higher
// and the one-time per-clone config (see scripts/setup-merge-driver.mjs / README):
//     git config merge.semver-higher.name   "keep the higher plugin.json version"
//     git config merge.semver-higher.driver "node scripts/semver-higher-merge.mjs %O %A %B %P"
//
// git invokes the driver with:  %O = base (ancestor)   %A = ours / current (also the
// OUTPUT file the driver must write)   %B = theirs (other)   %P = pathname.
// Contract: write the merged result into %A, exit 0 on success, non-zero to signal an
// unresolved conflict.
//
// Run standalone (for the test): node scripts/semver-higher-merge.mjs base ours theirs [path]

import { readFileSync, writeFileSync } from 'fs';
import { spawnSync } from 'child_process';

const VERSION_LINE = /^(\s*)"version"\s*:\s*"([^"]+)"(\s*,?)\s*$/;

// Compare two dotted numeric versions. Returns >0 if a>b, <0 if a<b, 0 if equal.
// Numeric per-part where possible; falls back to string compare for non-numeric parts.
export function compareSemver(a, b) {
  const pa = String(a).split('.');
  const pb = String(b).split('.');
  const len = Math.max(pa.length, pb.length);
  for (let i = 0; i < len; i++) {
    const sa = pa[i] ?? '0';
    const sb = pb[i] ?? '0';
    const na = Number(sa);
    const nb = Number(sb);
    if (Number.isInteger(na) && Number.isInteger(nb)) {
      if (na !== nb) return na - nb;
    } else if (sa !== sb) {
      return sa < sb ? -1 : 1;
    }
  }
  return 0;
}

export function highestVersion(versions) {
  return versions.reduce((best, v) => (compareSemver(v, best) > 0 ? v : best));
}

// Resolve conflicts in a 3-way-merged text. `merged` is the output of a textual
// 3-way merge (may contain <<<<<<< / ======= / >>>>>>> markers). Returns
// { text, resolved: true } if every conflict block was a pure version-line collision
// (resolved to the highest version), or { resolved: false } if a non-version conflict
// remains (caller should bail so a human resolves it).
export function resolveConflicts(merged) {
  const lines = merged.split('\n');
  const out = [];
  let i = 0;
  while (i < lines.length) {
    if (!lines[i].startsWith('<<<<<<<')) {
      out.push(lines[i]);
      i++;
      continue;
    }
    // Collect the conflict block: <<<<<<< ... ======= ... >>>>>>>
    // (tolerate a ||||||| base section from diff3-style output).
    const blockLines = [];
    let sawSep = false;
    let j = i + 1;
    let closed = false;
    for (; j < lines.length; j++) {
      const ln = lines[j];
      if (ln.startsWith('=======')) { sawSep = true; continue; }
      if (ln.startsWith('|||||||')) { sawSep = false; continue; }
      if (ln.startsWith('>>>>>>>')) { closed = true; break; }
      blockLines.push(ln);
    }
    if (!closed) return { resolved: false }; // malformed — don't touch it
    // Every content line in the block must be a version line (blank lines allowed).
    const versions = [];
    for (const ln of blockLines) {
      if (ln.trim() === '') continue;
      const m = ln.match(VERSION_LINE);
      if (!m) return { resolved: false }; // a real, non-version conflict — leave it
      versions.push({ indent: m[1], version: m[2], comma: m[3].includes(',') ? ',' : '' });
    }
    if (versions.length === 0) return { resolved: false };
    const winner = highestVersion(versions.map((v) => v.version));
    const shape = versions[0];
    out.push(`${shape.indent}"version": "${winner}"${shape.comma}`);
    i = j + 1;
  }
  return { text: out.join('\n'), resolved: true };
}

function main() {
  const [base, ours, theirs, pathName] = process.argv.slice(2);
  if (!base || !ours || !theirs) {
    console.error('usage: semver-higher-merge.mjs <base> <ours> <theirs> [path]');
    process.exit(2);
  }

  // Do a standard textual 3-way merge via the git binary (already required to be on
  // PATH — git is what invokes us). `git merge-file -p ours base theirs` writes the
  // merged text (with conflict markers, if any) to stdout and returns the conflict
  // count as its exit code.
  const merge = spawnSync('git', ['merge-file', '-p', ours, base, theirs], {
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  });
  if (merge.error) {
    console.error(`semver-higher-merge: could not run git merge-file: ${merge.error.message}`);
    process.exit(2);
  }
  const merged = merge.stdout;

  // No conflicts at all → git already produced a clean merge; write it and succeed.
  if (merge.status === 0) {
    writeFileSync(ours, merged);
    process.exit(0);
  }

  const result = resolveConflicts(merged);
  if (!result.resolved) {
    // A conflict we can't safely auto-resolve. Leave the marked-up merge in place so
    // git records a normal conflict for a human to resolve.
    writeFileSync(ours, merged);
    console.error(
      `semver-higher-merge: ${pathName || 'plugin.json'} has a non-version conflict; leaving it for manual resolution.`
    );
    process.exit(1);
  }

  writeFileSync(ours, result.text);
  process.exit(0);
}

// Only run main() when executed directly (not when imported by the test).
if (import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith('semver-higher-merge.mjs')) {
  main();
}
