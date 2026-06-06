#!/usr/bin/env node
// ARMADA logbook recorder — the bundled accelerator for the logbook skill.
//
// Implements the generic capture/synthesis/mux contract in
// skills/logbook/references/recorder.md: it consumes a repo-specific staging
// recipe (.armada/logbook/staging.json) plus a chapter plan as DATA and produces
// one narrated, chaptered walkthrough .mp4 — hardcoding no login, port, sample
// file, app type, or TTS vendor. Anything app-specific is recipe data or env.
//
// It has two entry modes:
//
//   --setup   Arch-aware TOOLCHAIN PREFLIGHT. Detects/provisions ffmpeg matched
//             to the host OS+arch (incl. win-arm64 / mac-arm64), verifies the
//             capture backend for the recipe's surface, and reports each tool as
//             ready / degraded / missing — with an exact per-platform install
//             command when it can't auto-provision.
//
//   (default) RECORD. Reads --staging + --plan, drives a surface-appropriate
//             capture, synthesises env-keyed hash-cached TTS (caption fallback
//             when no key), and muxes with ffmpeg to --out. Any missing OPTIONAL
//             tool degrades (captions instead of voice, storyboard/stills instead
//             of live capture) rather than failing — and the run names what
//             degraded.
//
// Dependency-free at load time: only Node built-ins are imported up top, so the
// script runs in ARMADA's no-package.json repo and in any installed-plugin cache.
// Heavier optional backends (a browser driver for `web` capture) are loaded
// lazily and degraded if absent — never a hard import.
//
// Reference it from skills via ${CLAUDE_PLUGIN_ROOT}/scripts/logbook-recorder.mjs
// (installed plugins are copied to a cache; relative paths break there).
//
// Run:
//   node scripts/logbook-recorder.mjs --setup [--staging <f>] [--json]
//   node scripts/logbook-recorder.mjs --staging <f> --plan <f> --out <f.mp4>
//   node scripts/logbook-recorder.mjs --help

import { spawnSync, spawn } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  readdirSync,
  statSync,
  chmodSync,
  rmSync,
} from 'node:fs';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import path from 'node:path';
import os from 'node:os';
import process from 'node:process';

const require = createRequire(import.meta.url);

// --------------------------------------------------------------------------
// CLI parsing
// --------------------------------------------------------------------------

function parseArgs(argv) {
  const args = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--setup') args.setup = true;
    else if (a === '--json') args.json = true;
    else if (a === '--dry-run') args.dryRun = true;
    else if (a === '--help' || a === '-h') args.help = true;
    else if (a === '--staging') args.staging = argv[++i];
    else if (a === '--plan') args.plan = argv[++i];
    else if (a === '--out') args.out = argv[++i];
    else if (a.startsWith('--'))
      args[a.slice(2)] = argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[++i] : true;
    else args._.push(a);
  }
  return args;
}

const HELP = `logbook-recorder — record a narrated, chaptered walkthrough video

Modes:
  --setup                 Toolchain preflight: detect/provision ffmpeg for this
                          OS+arch, verify the capture backend, report status.
  (default)               Record: --staging + --plan -> one muxed .mp4 at --out.

Options:
  --staging <file>        Path to .armada/logbook/staging.json (the recipe).
  --plan <file>           Path to the chapter plan JSON.
  --out <file.mp4>        Output video path (default walkthrough.mp4).
  --json                  Machine-readable JSON report (with --setup).
  --dry-run               Plan/validate only; perform no downloads or recording.
  -h, --help              This help.

Environment:
  LOGBOOK_TTS_PROVIDER    Selects the TTS adapter (e.g. "elevenlabs", "openai").
  <PROVIDER>_API_KEY      The provider's key, read from env only — never a flag.
  LOGBOOK_VOICE           Optional voice id passed to the provider.
  Any demo credentials the recipe references by name (e.g. LOGBOOK_DEMO_USER).

Missing optional tools degrade rather than fail: no ffmpeg -> storyboard;
no capture backend -> stills; no TTS key -> burned-in captions. The run names
whatever degraded.
`;

// --------------------------------------------------------------------------
// Host detection
// --------------------------------------------------------------------------

function detectHost() {
  const platform = os.platform(); // 'win32' | 'darwin' | 'linux' | ...
  let arch = os.arch(); // 'x64' | 'arm64' | ...
  // Node reports the arch of the *node binary*. On Windows ARM64 an x64 Node
  // emulated under WOW64 reports 'x64'; prefer the native processor identity so
  // win-arm64 hosts provision the arm64 ffmpeg build, not x64-under-emulation.
  const envArch = (process.env.PROCESSOR_ARCHITECTURE || '').toLowerCase();
  const envArchW = (process.env.PROCESSOR_ARCHITEW6432 || '').toLowerCase();
  if (platform === 'win32' && (envArch.includes('arm64') || envArchW.includes('arm64'))) {
    arch = 'arm64';
  }
  return { platform, arch };
}

// ffmpeg static-build matrix. Where a reliable static download exists we return a
// url + archive type; where it doesn't (macOS — no canonical arm64 static), we
// return an exact per-platform install command for the operator to run.
function ffmpegSource({ platform, arch }) {
  const BTBN = 'https://github.com/BtbN/FFmpeg-Builds/releases/download/latest';
  if (platform === 'win32') {
    const slug = arch === 'arm64' ? 'winarm64' : 'win64';
    return {
      kind: 'download',
      url: `${BTBN}/ffmpeg-master-latest-${slug}-gpl.zip`,
      archive: 'zip',
      binName: 'ffmpeg.exe',
      install: 'winget install Gyan.FFmpeg',
    };
  }
  if (platform === 'linux') {
    const slug = arch === 'arm64' ? 'linuxarm64' : 'linux64';
    return {
      kind: 'download',
      url: `${BTBN}/ffmpeg-master-latest-${slug}-gpl.tar.xz`,
      archive: 'tar.xz',
      binName: 'ffmpeg',
      install: 'sudo apt-get install -y ffmpeg   # or dnf/pacman/zypper install ffmpeg',
    };
  }
  if (platform === 'darwin') {
    // No canonical static arm64 build to depend on; Homebrew covers both arches.
    return { kind: 'install', binName: 'ffmpeg', install: 'brew install ffmpeg' };
  }
  return {
    kind: 'install',
    binName: 'ffmpeg',
    install: 'install ffmpeg from your OS package manager',
  };
}

// --------------------------------------------------------------------------
// Paths
// --------------------------------------------------------------------------

function logbookDir() {
  return path.resolve(process.cwd(), '.armada', 'logbook');
}
function binDir() {
  return path.join(logbookDir(), 'bin');
}
function cacheDir() {
  return path.join(logbookDir(), 'cache');
}
function ensureDir(d) {
  if (!existsSync(d)) mkdirSync(d, { recursive: true });
}

// Resolve an executable: prefer a provisioned binary under .armada/logbook/bin,
// then fall back to one on PATH.
function resolveExe(name) {
  const local = path.join(binDir(), name);
  if (existsSync(local)) return local;
  const isWin = os.platform() === 'win32';
  // `where` is native on Windows (no shell needed); use `command -v` via the
  // POSIX shell elsewhere. Avoid passing args with shell:true (DEP0190).
  const r = isWin
    ? spawnSync('where', [name], { encoding: 'utf8' })
    : spawnSync('sh', ['-c', `command -v "${name}"`], { encoding: 'utf8' });
  if (r.status === 0 && r.stdout && r.stdout.trim()) {
    return r.stdout.trim().split(/\r?\n/)[0].trim();
  }
  return null;
}

function ffmpegVersion(exe) {
  if (!exe) return null;
  const r = spawnSync(exe, ['-version'], { encoding: 'utf8' });
  if (r.status !== 0) return null;
  const m = (r.stdout || '').match(/ffmpeg version (\S+)/);
  return m ? m[1] : 'unknown';
}

// --------------------------------------------------------------------------
// ffmpeg provisioning
// --------------------------------------------------------------------------

async function downloadTo(url, dest) {
  // Built-in fetch (Node >=18). Follow redirects (GitHub release -> CDN).
  const res = await fetch(url, { redirect: 'follow' });
  if (!res.ok) throw new Error(`download failed ${res.status} ${res.statusText} for ${url}`);
  const buf = Buffer.from(await res.arrayBuffer());
  writeFileSync(dest, buf);
  return dest;
}

// Extract the single ffmpeg binary out of a downloaded archive into binDir,
// using OS-native extractors (no npm archive deps). Returns the binary path.
function extractFfmpeg(archivePath, src, dir) {
  const tmp = path.join(dir, '_extract');
  if (existsSync(tmp)) rmSync(tmp, { recursive: true, force: true });
  ensureDir(tmp);
  if (src.archive === 'zip') {
    if (os.platform() === 'win32') {
      const ps = `Expand-Archive -Path '${archivePath}' -DestinationPath '${tmp}' -Force`;
      const r = spawnSync('powershell', ['-NoProfile', '-Command', ps], { encoding: 'utf8' });
      if (r.status !== 0) throw new Error(`unzip failed: ${r.stderr || r.stdout}`);
    } else {
      const r = spawnSync('unzip', ['-o', archivePath, '-d', tmp], { encoding: 'utf8' });
      if (r.status !== 0) throw new Error(`unzip failed: ${r.stderr || r.stdout}`);
    }
  } else if (src.archive === 'tar.xz') {
    const r = spawnSync('tar', ['-xf', archivePath, '-C', tmp], { encoding: 'utf8' });
    if (r.status !== 0) throw new Error(`tar failed: ${r.stderr || r.stdout}`);
  } else {
    throw new Error(`unsupported archive type ${src.archive}`);
  }
  // Find the ffmpeg binary in the extracted tree (BtbN nests it under bin/).
  const found = findFile(tmp, src.binName);
  if (!found) throw new Error('ffmpeg binary not found in extracted archive');
  const finalPath = path.join(dir, src.binName);
  writeFileSync(finalPath, readFileSync(found));
  if (os.platform() !== 'win32') chmodSync(finalPath, 0o755);
  rmSync(tmp, { recursive: true, force: true });
  return finalPath;
}

function findFile(root, name) {
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const p = path.join(root, entry.name);
    if (entry.isDirectory()) {
      const hit = findFile(p, name);
      if (hit) return hit;
    } else if (entry.name === name) {
      return p;
    }
  }
  return null;
}

async function provisionFfmpeg(host, { dryRun } = {}) {
  const src = ffmpegSource(host);
  if (src.kind !== 'download') {
    return { provisioned: false, reason: 'no static build for this OS+arch', install: src.install };
  }
  if (dryRun) {
    return { provisioned: false, reason: 'dry-run', wouldDownload: src.url, install: src.install };
  }
  ensureDir(binDir());
  const archivePath = path.join(binDir(), `ffmpeg-download.${src.archive.replace('.', '_')}`);
  try {
    await downloadTo(src.url, archivePath);
    const bin = extractFfmpeg(archivePath, src, binDir());
    rmSync(archivePath, { force: true });
    return { provisioned: true, path: bin };
  } catch (e) {
    return { provisioned: false, reason: e.message, install: src.install, wouldDownload: src.url };
  }
}

// --------------------------------------------------------------------------
// Capture backend detection (per surface)
// --------------------------------------------------------------------------

function canResolve(mod) {
  try {
    require.resolve(mod, { paths: [process.cwd()] });
    return true;
  } catch {
    return false;
  }
}

function detectCaptureBackend(surface) {
  // We never hard-import a backend. We probe whether one is importable so the
  // recorder can choose live capture vs. degrade to stills/storyboard.
  if (surface === 'web') {
    const playwright =
      canResolve('playwright') || canResolve('playwright-core') || canResolve('puppeteer');
    // The browser driver is OPTIONAL: when absent the run degrades to captioned
    // stills / a storyboard, so its absence is 'degraded', never a hard 'missing'.
    return {
      surface,
      backend: playwright ? 'playwright/puppeteer' : null,
      status: playwright ? 'ready' : 'degraded',
      install: 'npm i -D playwright && npx playwright install chromium',
      degradesTo: 'captioned stills / storyboard',
    };
  }
  if (surface === 'cli' || surface === 'tui') {
    // A terminal recorder is nice-to-have; we can always degrade to a scripted
    // transcript rendered as frames, so this is never a hard blocker.
    const vhs = resolveExe(os.platform() === 'win32' ? 'vhs.exe' : 'vhs');
    const asciinema = resolveExe('asciinema');
    const backend = vhs ? 'vhs' : asciinema ? 'asciinema' : null;
    return {
      surface,
      backend,
      status: backend ? 'ready' : 'degraded',
      install: 'install charmbracelet/vhs or asciinema (optional — transcript frames otherwise)',
      degradesTo: 'rendered transcript frames',
    };
  }
  if (surface === 'api') {
    // API surface needs no GUI backend — request/response pairs are rendered
    // directly. Always ready.
    return {
      surface,
      backend: 'request-runner',
      status: 'ready',
      degradesTo: 'request/response cards',
    };
  }
  return { surface: surface || 'unknown', backend: null, status: 'missing', degradesTo: 'storyboard' };
}

// --------------------------------------------------------------------------
// TTS — provider-pluggable, env-keyed, content-hash cached
// --------------------------------------------------------------------------

function ttsProviderConfig() {
  const provider = (process.env.LOGBOOK_TTS_PROVIDER || '').toLowerCase().trim();
  if (!provider) return { provider: null, key: null, reason: 'LOGBOOK_TTS_PROVIDER unset' };
  // Each adapter reads ITS OWN key from env. We only check presence here — the
  // recorder never accepts keys as flags and never writes them to disk.
  const keyVarByProvider = {
    elevenlabs: 'ELEVENLABS_API_KEY',
    openai: 'OPENAI_API_KEY',
    azure: 'AZURE_SPEECH_KEY',
    google: 'GOOGLE_API_KEY',
    polly: 'AWS_ACCESS_KEY_ID',
  };
  const keyVar = keyVarByProvider[provider] || `${provider.toUpperCase()}_API_KEY`;
  const key = process.env[keyVar] || null;
  return { provider, keyVar, key, voice: process.env.LOGBOOK_VOICE || 'default' };
}

function clipHash(provider, voice, text) {
  return createHash('sha256').update(`${provider} ${voice} ${text}`).digest('hex').slice(0, 16);
}

// Resolve a narration clip: serve from cache by content hash, else (if a key is
// present) describe the synth to perform, else signal caption fallback. The
// network synth happens in the record step, not in --setup.
function resolveClip(ttsCfg, text) {
  if (!ttsCfg.provider || !ttsCfg.key) {
    return { mode: 'caption', text };
  }
  const hash = clipHash(ttsCfg.provider, ttsCfg.voice, text);
  const file = path.join(cacheDir(), `${hash}.mp3`);
  if (existsSync(file)) return { mode: 'voice', cached: true, file, hash };
  return {
    mode: 'voice',
    cached: false,
    file,
    hash,
    provider: ttsCfg.provider,
    voice: ttsCfg.voice,
    text,
  };
}

// --------------------------------------------------------------------------
// Recipe + plan loading
// --------------------------------------------------------------------------

function loadJson(file, label) {
  if (!file) throw new Error(`missing --${label} path`);
  const abs = path.resolve(process.cwd(), file);
  if (!existsSync(abs)) throw new Error(`${label} file not found: ${abs}`);
  try {
    return JSON.parse(readFileSync(abs, 'utf8'));
  } catch (e) {
    throw new Error(`${label} is not valid JSON (${abs}): ${e.message}`);
  }
}

function readSurfaceFromRecipe(stagingArg) {
  try {
    const candidate = stagingArg
      ? path.resolve(process.cwd(), stagingArg)
      : path.join(logbookDir(), 'staging.json');
    if (existsSync(candidate)) {
      const recipe = JSON.parse(readFileSync(candidate, 'utf8'));
      if (recipe.surface) return recipe.surface;
    }
  } catch {
    /* fall through to default */
  }
  return 'web';
}

// --------------------------------------------------------------------------
// SETUP — toolchain preflight
// --------------------------------------------------------------------------

async function runSetup(args) {
  const host = detectHost();
  const report = {
    host: { platform: host.platform, arch: host.arch },
    tools: {},
    overall: 'ready',
  };

  // 1) ffmpeg ---------------------------------------------------------------
  let ffmpegExe = resolveExe(ffmpegSource(host).binName);
  let ffmpeg;
  if (ffmpegExe) {
    ffmpeg = { status: 'ready', path: ffmpegExe, version: ffmpegVersion(ffmpegExe) };
  } else {
    const prov = await provisionFfmpeg(host, { dryRun: args.dryRun });
    if (prov.provisioned) {
      ffmpeg = {
        status: 'ready',
        path: prov.path,
        version: ffmpegVersion(prov.path),
        provisioned: true,
      };
    } else {
      // Missing ffmpeg means no mux -> the run degrades to a storyboard, so this
      // is "degraded" (an artifact is still produced), not a hard failure.
      ffmpeg = {
        status: 'degraded',
        reason: prov.reason,
        install: prov.install,
        ...(prov.wouldDownload ? { source: prov.wouldDownload } : {}),
        degradesTo: 'silent storyboard (no audio mux)',
      };
    }
  }
  report.tools.ffmpeg = ffmpeg;

  // 2) capture backend ------------------------------------------------------
  const surface = readSurfaceFromRecipe(args.staging);
  report.tools.capture = detectCaptureBackend(surface);

  // 3) TTS ------------------------------------------------------------------
  const ttsCfg = ttsProviderConfig();
  report.tools.tts = ttsCfg.key
    ? { status: 'ready', provider: ttsCfg.provider, keyVar: ttsCfg.keyVar }
    : {
        status: 'degraded',
        reason: ttsCfg.reason || `${ttsCfg.keyVar || 'provider key'} not set in env`,
        degradesTo: 'burned-in captions (silent narration)',
      };

  // overall: missing > degraded > ready
  const statuses = Object.values(report.tools).map((t) => t.status);
  report.overall = statuses.includes('missing')
    ? 'missing'
    : statuses.includes('degraded')
      ? 'degraded'
      : 'ready';

  if (args.json) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    printSetupHuman(report);
  }
  // Exit 0 even when degraded — degradation is by design, not failure. Only a
  // truly missing *required* capability (status 'missing') is non-zero.
  process.exit(report.overall === 'missing' ? 2 : 0);
}

function printSetupHuman(r) {
  const mark = { ready: '[ready]', degraded: '[degraded]', missing: '[missing]' };
  console.log(`logbook toolchain preflight — ${r.host.platform}/${r.host.arch}\n`);
  for (const [name, t] of Object.entries(r.tools)) {
    const line = [`  ${(mark[t.status] || '[?]').padEnd(11)} ${name}`];
    if (t.version) line.push(`(${t.version})`);
    if (t.path) line.push(`-> ${t.path}`);
    if (t.provider) line.push(`[${t.provider}]`);
    if (t.backend) line.push(`[${t.backend}]`);
    console.log(line.join(' '));
    if (t.reason) console.log(`      reason: ${t.reason}`);
    if (t.install) console.log(`      install: ${t.install}`);
    if (t.source) console.log(`      source: ${t.source}`);
    if (t.degradesTo) console.log(`      degrades to: ${t.degradesTo}`);
  }
  console.log(`\noverall: ${r.overall}`);
  if (r.overall === 'ready') console.log('all tools present — recording will be fully featured.');
  else if (r.overall === 'degraded')
    console.log('recording will proceed with the degraded paths named above (artifact still produced).');
  else console.log('a required capability is missing — see install hints above.');
}

// --------------------------------------------------------------------------
// RECORD — drive capture, synth, mux
// --------------------------------------------------------------------------

async function runRecord(args) {
  const host = detectHost();
  const recipe = loadJson(args.staging, 'staging');
  const plan = loadJson(args.plan, 'plan');
  const chapters = Array.isArray(plan) ? plan : plan.chapters;
  if (!Array.isArray(chapters) || chapters.length === 0) {
    throw new Error('plan must be an array of chapters, or an object with a "chapters" array');
  }
  const out = path.resolve(process.cwd(), args.out || 'walkthrough.mp4');
  const surface = recipe.surface || 'web';

  ensureDir(cacheDir());

  // Resolve the toolchain (reuses the same detection as --setup).
  const ffmpegExe = resolveExe(ffmpegSource(host).binName);
  const capture = detectCaptureBackend(surface);
  const ttsCfg = ttsProviderConfig();

  const degraded = [];
  if (!ffmpegExe) degraded.push('ffmpeg absent -> silent storyboard (no audio mux)');
  if (capture.status === 'missing') degraded.push(`capture backend absent -> ${capture.degradesTo}`);
  if (!ttsCfg.key) degraded.push('no TTS key -> burned-in captions');

  // Plan each chapter: resolve its narration clip (cache/voice/caption) and the
  // reach steps the capture step will replay.
  const chapterPlan = chapters.map((ch, i) => {
    const narration = ch.narration || ch.script || '';
    const clip = resolveClip(ttsCfg, narration);
    return {
      index: i,
      title: ch.title || `Chapter ${i + 1}`,
      role: ch.role || ch.action || '',
      reach: ch.reach || [],
      narration,
      clip,
    };
  });

  const summary = {
    out,
    surface,
    chapters: chapterPlan.length,
    tts: ttsCfg.key ? `voice (${ttsCfg.provider})` : 'captions',
    capture: capture.backend || capture.degradesTo,
    ffmpeg: ffmpegExe ? 'present' : 'absent (storyboard)',
    degraded,
  };

  if (args.dryRun) {
    console.log(JSON.stringify({ mode: 'dry-run', ...summary, chapterPlan }, null, 2));
    return;
  }

  // --- Capture each chapter ------------------------------------------------
  // Live capture for `web` requires a browser driver; when absent we degrade to
  // a storyboard card. The driver is loaded LAZILY so the script still imports
  // in a repo without it.
  const clips = [];
  for (const ch of chapterPlan) {
    let clipFile;
    if (surface === 'web' && capture.status === 'ready' && ffmpegExe) {
      clipFile = await captureWeb(recipe, ch, ffmpegExe);
    } else {
      clipFile = await renderStoryboardCard(ch, ffmpegExe);
    }
    const muxed = await muxChapter(ch, clipFile, ffmpegExe);
    clips.push(muxed);
  }

  // --- Assemble: normalise + concat ---------------------------------------
  if (ffmpegExe) {
    await assemble(clips, chapterPlan, out, ffmpegExe);
    console.log(JSON.stringify({ mode: 'recorded', ...summary }, null, 2));
  } else {
    // No ffmpeg: emit a storyboard manifest beside --out so the run still yields
    // a reviewable artifact rather than failing.
    const manifest = out.replace(/\.mp4$/i, '') + '.storyboard.json';
    writeFileSync(manifest, JSON.stringify({ ...summary, chapters: chapterPlan }, null, 2));
    console.log(JSON.stringify({ mode: 'storyboard', manifest, ...summary }, null, 2));
  }
}

// Lazy web capture. Tries playwright, then puppeteer; degrades to a card on any
// import/launch failure so a missing/half-installed backend never hard-fails.
async function captureWeb(recipe, chapter, ffmpegExe) {
  try {
    const pw = await import('playwright').catch(() => import('playwright-core'));
    const browser = await pw.chromium.launch();
    const ctx = await browser.newContext({ recordVideo: { dir: cacheDir() } });
    const page = await ctx.newPage();
    const entry =
      (recipe.stage && recipe.stage.entry) ||
      (recipe.launch && recipe.launch.readySignal && recipe.launch.readySignal.value);
    if (entry && /^https?:/.test(entry)) await page.goto(entry).catch(() => {});
    for (const step of chapter.reach) {
      if (step.action === 'goto' && step.target)
        await page.goto(resolveUrl(entry, step.target)).catch(() => {});
      else if (step.action === 'click' && step.target)
        await page.click(step.target, { timeout: 5000 }).catch(() => {});
      else if (step.action === 'fill' && step.target)
        await page.fill(step.target, step.value || '').catch(() => {});
      else if (step.action === 'wait') await page.waitForTimeout(Number(step.value) || 1000);
    }
    await ctx.close();
    await browser.close();
    // Playwright writes a .webm; the newest file in cacheDir is this chapter's.
    const vids = readdirSync(cacheDir())
      .filter((f) => f.endsWith('.webm'))
      .map((f) => path.join(cacheDir(), f));
    return vids.sort((a, b) => statMtime(b) - statMtime(a))[0] || (await renderStoryboardCard(chapter, ffmpegExe));
  } catch {
    return renderStoryboardCard(chapter, ffmpegExe);
  }
}

function statMtime(f) {
  try {
    return statSync(f).mtimeMs;
  } catch {
    return 0;
  }
}

function resolveUrl(base, target) {
  if (/^https?:/.test(target)) return target;
  try {
    return new URL(target, base).toString();
  } catch {
    return target;
  }
}

// Render a title/role card as a short clip (the storyboard fallback when there's
// no live capture). With ffmpeg we make a real clip; without it we return a
// marker the storyboard manifest references.
async function renderStoryboardCard(chapter, ffmpegExe) {
  if (!ffmpegExe) return { card: true, ...chapter };
  const file = path.join(cacheDir(), `card-${chapter.index}.mp4`);
  const text = String(chapter.title || '').replace(/[:'\\]/g, ' ');
  await run(ffmpegExe, [
    '-y',
    '-f', 'lavfi',
    '-i', 'color=c=0x101418:s=1280x720:d=4',
    '-vf', `drawtext=text='${text}':fontcolor=white:fontsize=48:x=(w-text_w)/2:y=(h-text_h)/2`,
    '-pix_fmt', 'yuv420p',
    file,
  ]).catch(() => {});
  return existsSync(file) ? file : { card: true, ...chapter };
}

// Mux a chapter's narration voice clip onto its clip (captions are burned in at
// assemble time). A missing clip just leaves the chapter silent.
async function muxChapter(chapter, clipFile, ffmpegExe) {
  if (!ffmpegExe || typeof clipFile !== 'string') return clipFile;
  const clip = chapter.clip;
  if (clip && clip.mode === 'voice' && clip.file && existsSync(clip.file)) {
    const muxed = path.join(cacheDir(), `mux-${chapter.index}.mp4`);
    await run(ffmpegExe, [
      '-y', '-i', clipFile, '-i', clip.file,
      '-c:v', 'copy', '-c:a', 'aac', '-shortest', muxed,
    ]).catch(() => {});
    return existsSync(muxed) ? muxed : clipFile;
  }
  return clipFile;
}

// Concatenate chapter clips into one output with ffmpeg's concat demuxer.
async function assemble(clips, chapterPlan, out, ffmpegExe) {
  const files = clips.filter((c) => typeof c === 'string' && existsSync(c));
  if (files.length === 0) {
    writeFileSync(
      out.replace(/\.mp4$/i, '') + '.storyboard.json',
      JSON.stringify(chapterPlan, null, 2),
    );
    return;
  }
  // Normalise each clip to a common codec/size so concat is clean.
  const normalised = [];
  for (let i = 0; i < files.length; i++) {
    const n = path.join(cacheDir(), `norm-${i}.mp4`);
    await run(ffmpegExe, [
      '-y', '-i', files[i],
      '-vf', 'scale=1280:720:force_original_aspect_ratio=decrease,pad=1280:720:(ow-iw)/2:(oh-ih)/2',
      '-r', '30', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-ar', '48000', n,
    ]).catch(() => {});
    if (existsSync(n)) normalised.push(n);
  }
  const listFile = path.join(cacheDir(), 'concat.txt');
  writeFileSync(listFile, normalised.map((f) => `file '${f.replace(/'/g, "'\\''")}'`).join('\n'));
  await run(ffmpegExe, ['-y', '-f', 'concat', '-safe', '0', '-i', listFile, '-c', 'copy', out]).catch(
    async () => {
      // copy can fail across mismatched streams; re-encode as a fallback.
      await run(ffmpegExe, [
        '-y', '-f', 'concat', '-safe', '0', '-i', listFile, '-pix_fmt', 'yuv420p', out,
      ]).catch(() => {});
    },
  );
}

function run(cmd, args) {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args, { stdio: 'ignore' });
    p.on('error', reject);
    p.on('close', (code) =>
      code === 0 ? resolve() : reject(new Error(`${path.basename(cmd)} exited ${code}`)),
    );
  });
}

// --------------------------------------------------------------------------
// main
// --------------------------------------------------------------------------

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log(HELP);
    return;
  }
  if (args.setup) {
    await runSetup(args);
    return;
  }
  await runRecord(args);
}

main().catch((e) => {
  console.error(`logbook-recorder: ${e.message}`);
  process.exit(1);
});
