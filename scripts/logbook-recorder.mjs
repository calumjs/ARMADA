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
  LOGBOOK_VOICE_NAME      Optional expected voice NAME; the preflight fetches the
                          voice id and fails loudly if its real name differs
                          (catches "id points at the wrong voice").
  LOGBOOK_RECORD_URL      Optional URL to record against (a PR preview/Vercel or
                          the live site) — preferred over the worktree dev server,
                          which may never paint. Falls back to the dev server if
                          this URL warms up blank. Also settable as recipe.recordUrl.
  Any demo credentials the recipe references by name (e.g. LOGBOOK_DEMO_USER).

Motion walkthrough (web): a chapter may carry "target"/"spotlight" selector(s) to
highlight while it narrates (dim the rest + ring the element, held for the narration
clip's duration) and "cursor": true to drift a synthetic cursor to it. Reach steps
support live interactions recorded as motion: goto, click, dblclick, hover, fill,
press (keyboard, e.g. a command palette), dragdrop (target -> to), scrollTo, wait.

Missing optional tools degrade rather than fail: no ffmpeg -> storyboard;
no capture backend / blank capture -> spotlight-annotated still; no TTS key ->
burned-in captions. The run names whatever degraded.
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
  return {
    provider,
    keyVar,
    key,
    voice: process.env.LOGBOOK_VOICE || 'default',
    // The human-readable name the operator EXPECTS this voice id to resolve to
    // (e.g. "calum"). When set, the preflight (verifyTts) fetches the voice by id
    // and asserts its real name matches — catching the "voice id points at a
    // different voice than configured" failure (issue #91: a cowboy narrator
    // instead of the configured voice, with no warning).
    voiceName: process.env.LOGBOOK_VOICE_NAME || null,
  };
}

// --------------------------------------------------------------------------
// TTS preflight — verify the key WORKS and the voice id resolves to the
// expected name, loudly. Presence of a key is not proof it authenticates, and a
// valid key can still point LOGBOOK_VOICE at the wrong voice. Both failures were
// silent before (issue #91): an expired key degraded to no audio with no notice,
// and a mismatched id narrated in the wrong voice. verifyTts turns both into a
// clear, named result the caller surfaces (degrade visibly, never silently).
//
// Best-effort and bounded: a network blip or an un-implemented provider check
// returns { ok: true, checked: false } rather than failing the run — we only
// HARD-fail on a definitive auth rejection or a confirmed name mismatch.
async function verifyTts(ttsCfg, { timeoutMs = 8000 } = {}) {
  if (!ttsCfg.provider) return { ok: false, checked: false, reason: ttsCfg.reason || 'no TTS provider' };
  if (!ttsCfg.key) return { ok: false, checked: false, reason: `${ttsCfg.keyVar || 'provider key'} not set in env` };

  // Only ElevenLabs has a verified adapter here; other providers report
  // "key present, unverified" so they degrade-by-absence behaviour is unchanged
  // (we never silently claim a non-ElevenLabs voice is correct).
  if (ttsCfg.provider !== 'elevenlabs') {
    return { ok: true, checked: false, reason: `key present (no preflight adapter for ${ttsCfg.provider})` };
  }

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  // Don't let the abort timer keep the event loop alive on its own.
  if (timer.unref) timer.unref();
  try {
    // Fetch the configured voice by id. This both authenticates the key and lets
    // us compare the returned voice name to the expected LOGBOOK_VOICE_NAME.
    const voiceId = ttsCfg.voice && ttsCfg.voice !== 'default' ? ttsCfg.voice : null;
    const url = voiceId
      ? `https://api.elevenlabs.io/v1/voices/${encodeURIComponent(voiceId)}`
      : 'https://api.elevenlabs.io/v1/voices';
    const res = await fetch(url, {
      headers: { 'xi-api-key': ttsCfg.key, accept: 'application/json' },
      signal: ctrl.signal,
    });
    if (res.status === 401 || res.status === 403) {
      return { ok: false, checked: true, reason: `auth-failed (HTTP ${res.status} — key rejected by ElevenLabs)` };
    }
    if (voiceId && (res.status === 404 || res.status === 400 || res.status === 422)) {
      // The configured voice id doesn't exist / isn't valid on this account
      // (ElevenLabs answers a bad id with 400/404/422) — a definitive id failure,
      // not a transient blip. Fail loudly so it degrades to captions rather than
      // erroring mid-record.
      return { ok: false, checked: true, reason: `voice-not-found (id ${voiceId} returned HTTP ${res.status} — LOGBOOK_VOICE is wrong)` };
    }
    if (!res.ok) {
      // A non-auth error (rate limit, 5xx) is inconclusive — don't claim wrong/silent,
      // but don't block either; treat as unverified.
      return { ok: true, checked: false, reason: `voice lookup inconclusive (HTTP ${res.status})` };
    }
    const body = await res.json().catch(() => null);
    const gotName = voiceId
      ? body && (body.name || (body.voice && body.voice.name))
      : null;
    // Name check only when both a specific voice id AND an expected name are set.
    if (voiceId && ttsCfg.voiceName) {
      if (!gotName) {
        return { ok: false, checked: true, reason: `name-unresolved (voice id ${voiceId} returned no name to verify against "${ttsCfg.voiceName}")` };
      }
      if (gotName.trim().toLowerCase() !== ttsCfg.voiceName.trim().toLowerCase()) {
        return {
          ok: false,
          checked: true,
          reason: `name-mismatch (voice id ${voiceId} is "${gotName}", expected "${ttsCfg.voiceName}")`,
          got: gotName,
          want: ttsCfg.voiceName,
        };
      }
      return { ok: true, checked: true, reason: `verified: "${gotName}"`, got: gotName };
    }
    // Key authenticates; no name assertion requested.
    return {
      ok: true,
      checked: true,
      reason: voiceId
        ? `key valid; voice id resolves${gotName ? ` ("${gotName}")` : ''} (set LOGBOOK_VOICE_NAME to assert the name)`
        : 'key valid (set LOGBOOK_VOICE to a specific voice id to verify it)',
      ...(gotName ? { got: gotName } : {}),
    };
  } catch (e) {
    // Network failure / timeout: inconclusive, not a definitive auth failure.
    return { ok: true, checked: false, reason: `voice lookup failed (${e.name === 'AbortError' ? 'timeout' : e.message})` };
  } finally {
    clearTimeout(timer);
  }
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

// Synthesize one narration clip to its content-hashed cache file (issue #91). The
// bundled recorder previously NEVER generated voice — it only reused pre-cached
// clips — so a valid key still produced a SILENT walkthrough. This is the missing
// synth step: for ElevenLabs (the only verified adapter here) it POSTs the text to
// the text-to-speech endpoint and writes the returned mp3 to clip.file, keyed by
// the (provider, voice, text) hash so an unchanged chapter is reused next run.
// Best-effort: returns false (caller degrades that chapter to silent/caption)
// rather than throwing on any failure. A real voice id (LOGBOOK_VOICE) is required.
async function synthesizeClip(ttsCfg, clip, { timeoutMs = 30000 } = {}) {
  if (ttsCfg.provider !== 'elevenlabs') return false;
  const voiceId = ttsCfg.voice && ttsCfg.voice !== 'default' ? ttsCfg.voice : null;
  if (!voiceId || !clip || !clip.text) return false;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  if (timer.unref) timer.unref();
  try {
    const model = process.env.LOGBOOK_TTS_MODEL || 'eleven_multilingual_v2';
    const res = await fetch(
      `https://api.elevenlabs.io/v1/text-to-speech/${encodeURIComponent(voiceId)}`,
      {
        method: 'POST',
        headers: {
          'xi-api-key': ttsCfg.key,
          'content-type': 'application/json',
          accept: 'audio/mpeg',
        },
        body: JSON.stringify({
          text: clip.text,
          model_id: model,
          voice_settings: { stability: 0.5, similarity_boost: 0.75 },
        }),
        signal: ctrl.signal,
      },
    );
    if (!res.ok) return false;
    const buf = Buffer.from(await res.arrayBuffer());
    if (!buf.length) return false;
    ensureDir(cacheDir());
    writeFileSync(clip.file, buf);
    clip.cached = true;
    return true;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
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

// Resolve which URL to record against, and a fallback (issue #91). A worktree dev
// server (`npm run dev` inside a fresh, not-fully-set-up build worktree) is the
// least reliable surface to record — it may never paint, yielding a white-screen
// video. Prefer a URL that is known to render: the PR's Vercel/preview deployment
// or the live site, supplied via `LOGBOOK_RECORD_URL` (env) or `recipe.recordUrl`.
// Returns { preferred, fallback }: `preferred` is recorded first; if it comes back
// blank the caller falls back to `fallback` (the dev-server entry) — so a missing
// or broken preview never silently produces a blank capture.
function resolveRecordEntry(recipe) {
  const devEntry =
    (recipe.stage && recipe.stage.entry) ||
    (recipe.launch && recipe.launch.readySignal && recipe.launch.readySignal.value) ||
    null;
  const preferredRaw = (process.env.LOGBOOK_RECORD_URL || recipe.recordUrl || '').trim() || null;
  const preferred = preferredRaw || devEntry;
  // Only offer a fallback when it's a real, distinct URL to switch to.
  const fallback = preferred && devEntry && devEntry !== preferred ? devEntry : null;
  return { preferred, fallback };
}

// Does the current page actually carry rendered content (not a blank/white pre-paint
// viewport)? Mirrors waitForContentfulPaint's body-content backstop — used to decide
// whether to switch from a blank preferred URL to the dev-server fallback (issue #91).
async function pageHasContent(page) {
  return page
    .evaluate(() => {
      const body = document.body;
      if (!body) return false;
      const text = (body.innerText || '').trim();
      return text.length > 0 || body.childElementCount > 1;
    })
    .catch(() => false);
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
  // Don't just check the key is PRESENT — verify it AUTHENTICATES and that the
  // voice id resolves to the expected name (issue #91). A loud preflight here is
  // what turns "narrated in the wrong voice / silently no audio" into a reported
  // degrade before a single frame is recorded.
  const ttsCfg = ttsProviderConfig();
  const ttsVerdict = await verifyTts(ttsCfg);
  if (ttsVerdict.ok) {
    report.tools.tts = {
      status: 'ready',
      provider: ttsCfg.provider,
      keyVar: ttsCfg.keyVar,
      ...(ttsCfg.voice && ttsCfg.voice !== 'default' ? { voice: ttsCfg.voice } : {}),
      ...(ttsCfg.voiceName ? { voiceName: ttsCfg.voiceName } : {}),
      verified: !!ttsVerdict.checked,
      reason: ttsVerdict.reason,
    };
  } else {
    report.tools.tts = {
      status: 'degraded',
      provider: ttsCfg.provider || undefined,
      keyVar: ttsCfg.keyVar || undefined,
      reason: ttsVerdict.reason,
      degradesTo: 'burned-in captions (silent narration)',
    };
  }

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
  // truly missing *required* capability (status 'missing') is non-zero. Set the
  // exit CODE rather than calling process.exit() so the event loop drains the TTS
  // preflight's network handle cleanly — a hard exit() races socket teardown and
  // trips a libuv assertion on Windows (UV_HANDLE_CLOSING).
  process.exitCode = report.overall === 'missing' ? 2 : 0;
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

  // Loud TTS preflight (issue #91): a present key is not proof it authenticates,
  // and a valid key can still point LOGBOOK_VOICE at the wrong voice. Verify both
  // BEFORE recording; on a definitive auth failure or a confirmed name mismatch,
  // degrade VISIBLY to captions (named in the run summary) instead of silently
  // narrating in the wrong voice or producing a silent track. `ttsActive` is what
  // the chapter clips resolve against — nulling its key forces caption mode.
  let ttsActive = ttsCfg;
  if (ttsCfg.provider && ttsCfg.key) {
    const verdict = await verifyTts(ttsCfg);
    if (!verdict.ok) {
      degraded.push(`TTS preflight failed -> burned-in captions (${verdict.reason})`);
      ttsActive = { ...ttsCfg, key: null };
    }
  }

  // Capture degrades are discovered DURING capture — a chapter whose clip came
  // back empty/near-static because the app hadn't painted yet — so they can't be
  // known up front like the toolchain degrades above. captureWeb pushes a named
  // entry here when a chapter falls back to a storyboard card, and we fold them
  // into the run summary so a blank-frames capture is REPORTED per §0 rather than
  // silently swallowed into the final video (issue #68).
  const captureDegraded = [];

  // Plan each chapter: resolve its narration clip (cache/voice/caption) and the
  // reach steps the capture step will replay.
  const chapterPlan = chapters.map((ch, i) => {
    const narration = ch.narration || ch.script || '';
    const clip = resolveClip(ttsActive, narration);
    return {
      index: i,
      title: ch.title || `Chapter ${i + 1}`,
      role: ch.role || ch.action || '',
      reach: ch.reach || [],
      // Motion-walkthrough fields (issue #69): the element(s) to spotlight while this
      // beat narrates, and whether to drift a synthetic cursor. Carried through so the
      // capture step can target/highlight/guide.
      target: ch.target,
      targets: ch.targets,
      spotlight: ch.spotlight,
      cursor: ch.cursor,
      narration,
      clip,
    };
  });

  // Synthesize any uncached narration clips up front (issue #91): generate + cache
  // voice BEFORE capture so the spotlight holds read each beat's real narration
  // duration, and so the timestamp-aligned master track has clips to mix. Without
  // this the recorder only ever reused pre-cached clips and a valid key still
  // yielded a silent video. Best-effort and named: a chapter whose synth fails
  // simply stays silent, reported in the run summary.
  let synthesised = 0;
  if (ttsActive.key) {
    let synthFailures = 0;
    for (const ch of chapterPlan) {
      const c = ch.clip;
      if (c && c.mode === 'voice' && !c.cached && c.text && !existsSync(c.file)) {
        if (await synthesizeClip(ttsActive, c)) synthesised++;
        else synthFailures++;
      }
    }
    if (synthFailures > 0) {
      degraded.push(
        `TTS synthesis failed for ${synthFailures} chapter(s) -> those chapters silent` +
          (ttsActive.voice === 'default' ? ' (LOGBOOK_VOICE not set to a voice id)' : ''),
      );
    }
  }

  const summary = {
    out,
    surface,
    chapters: chapterPlan.length,
    tts: ttsActive.key ? `voice (${ttsActive.provider})` : 'captions',
    synthesised,
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
      clipFile = await captureWeb(recipe, ch, ffmpegExe, captureDegraded);
    } else {
      // No live capture backend for a web surface ⇒ a storyboard-card deck. Per
      // AC2 this deck is only ever an explicitly-NAMED fallback, never a silent
      // default — so name it here (the captureWeb path names its own degrades).
      if (surface === 'web') {
        const msg = `chapter ${ch.index} ("${ch.title}") no live capture backend -> storyboard card`;
        if (!captureDegraded.includes(msg)) captureDegraded.push(msg);
      }
      clipFile = await renderStoryboardCard(ch, ffmpegExe);
    }
    // Keep the video-only clip; narration is woven in at assemble time as a single
    // timestamp-aligned master track (issue #91, AC4) rather than per-chapter muxed.
    clips.push(clipFile);
  }

  // Fold any capture-time degrades discovered above into the summary so they ride
  // alongside the toolchain degrades and surface in the printed report (§0).
  if (captureDegraded.length) {
    summary.degraded = [...degraded, ...captureDegraded];
    summary.captureDegraded = captureDegraded;
  }

  // --- Assemble: divider cards + lower-thirds, concat, aligned audio, self-check
  if (ffmpegExe) {
    const result = await assemble(clips, chapterPlan, out, ffmpegExe);
    summary.selfCheck = result.selfCheck;
    if (result.selfCheck && !result.selfCheck.pass) {
      // A failed self-check is a REPORTED degrade, not a silent pass: fold it into
      // the summary and warn on stderr so a blank/silent render is caught here
      // (issue #91, AC5) rather than shipped as a walkthrough.
      summary.degraded = [...(summary.degraded || degraded), `post-record self-check FAILED: ${result.selfCheck.reason}`];
    }
    console.log(JSON.stringify({ mode: 'recorded', ...summary }, null, 2));
    if (result.selfCheck && !result.selfCheck.pass) {
      console.error(`logbook-recorder: WARNING — post-record self-check failed: ${result.selfCheck.reason}`);
    }
  } else {
    // No ffmpeg: emit a storyboard manifest beside --out so the run still yields
    // a reviewable artifact rather than failing.
    const manifest = out.replace(/\.mp4$/i, '') + '.storyboard.json';
    writeFileSync(manifest, JSON.stringify({ ...summary, chapters: chapterPlan }, null, 2));
    console.log(JSON.stringify({ mode: 'storyboard', manifest, ...summary }, null, 2));
  }
}

// Wait for a route to be genuinely PAINTED before we start (or rely on) a capture
// of it. An HTTP 200 / the `load` event is not enough on a dev server: Next.js (and
// any dev-mode bundler) compiles the route on first request, so the page can be
// blank for seconds AFTER navigation resolves. This was the root cause of issue
// #68 — the recorder began capturing into that blank window and produced a
// titles-only storyboard. We wait for three things in order:
//   1. network to settle (the dev compile + initial data fetches finish),
//   2. a real first-contentful-paint (the browser reports an `first-contentful-paint`
//      paint entry), and
//   3. the document body to actually carry rendered content (non-trivial visible
//      text/markup), as a backstop for apps that never emit an FCP entry.
// Each wait is bounded and best-effort: if the page legitimately has little content
// we don't hang, we just proceed — the empty-clip check downstream is the honest
// degrade signal.
async function waitForContentfulPaint(page, { timeout = 15000 } = {}) {
  // 1) Let the dev compile and initial requests settle.
  await page.waitForLoadState('networkidle', { timeout }).catch(() => {});
  // 2) Wait for an actual first-contentful-paint AND visible body content. We poll
  //    inside the page so we catch whichever lands first / last.
  await page
    .waitForFunction(
      () => {
        const painted = performance
          .getEntriesByType('paint')
          .some((e) => e.name === 'first-contentful-paint' && e.startTime > 0);
        const body = document.body;
        const text = body ? (body.innerText || '').trim() : '';
        const hasContent = !!body && (text.length > 0 || body.childElementCount > 1);
        return painted && hasContent;
      },
      { timeout, polling: 250 },
    )
    .catch(() => {});
}

// --------------------------------------------------------------------------
// Motion walkthrough: narration-synced hold, spotlight overlay, synthetic cursor,
// and live interactions (issue #69)
// --------------------------------------------------------------------------

// How long to hold a beat's spotlight/interaction on screen. The acceptance
// criterion is that the on-screen highlight lasts as long as that beat's narration
// audio — so when a voice clip exists we read its real duration (via ffprobe/ffmpeg,
// best-effort) and hold for that; otherwise we fall back to a readable default. The
// hold is clamped so a missing/odd duration can never wedge the capture open.
const SPOTLIGHT_MIN_HOLD_MS = 1500;
const SPOTLIGHT_MAX_HOLD_MS = 20000;
const SPOTLIGHT_DEFAULT_HOLD_MS = 3500;

function clamp(n, lo, hi) {
  return Math.max(lo, Math.min(hi, n));
}

// Probe a narration clip's duration in seconds using ffprobe (preferred) or ffmpeg's
// stderr banner (fallback). Best-effort and dependency-free — returns null if neither
// is available or the probe fails, and the caller then uses the default hold.
function clipDurationSeconds(clipFile, ffmpegExe) {
  if (!clipFile || !existsSync(clipFile)) return null;
  // ffprobe usually sits next to ffmpeg; try a provisioned/PATH copy.
  const probeName = os.platform() === 'win32' ? 'ffprobe.exe' : 'ffprobe';
  const probe = resolveExe(probeName);
  if (probe) {
    const r = spawnSync(
      probe,
      ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', clipFile],
      { encoding: 'utf8' },
    );
    const d = parseFloat((r.stdout || '').trim());
    if (Number.isFinite(d) && d > 0) return d;
  }
  // Fallback: parse ffmpeg's "Duration: HH:MM:SS.xx" banner from stderr.
  if (ffmpegExe) {
    const r = spawnSync(ffmpegExe, ['-i', clipFile], { encoding: 'utf8' });
    const m = (r.stderr || '').match(/Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/);
    if (m) {
      const secs = Number(m[1]) * 3600 + Number(m[2]) * 60 + parseFloat(m[3]);
      if (Number.isFinite(secs) && secs > 0) return secs;
    }
  }
  return null;
}

// Resolve how long this beat should hold its spotlight/interaction on screen: the
// narration clip's real duration when we have a voice clip, else the default. Always
// clamped to a sane window so the capture can't hang.
function beatHoldMs(chapter, ffmpegExe) {
  const clip = chapter.clip;
  let ms = SPOTLIGHT_DEFAULT_HOLD_MS;
  if (clip && clip.mode === 'voice' && clip.file) {
    const secs = clipDurationSeconds(clip.file, ffmpegExe);
    if (secs) ms = Math.round(secs * 1000);
  }
  return clamp(ms, SPOTLIGHT_MIN_HOLD_MS, SPOTLIGHT_MAX_HOLD_MS);
}

// Normalise a beat's target(s) into an array of selector strings. A beat can carry
// `target`/`targets`/`spotlight` as a single selector or a list.
function beatTargets(chapter) {
  const raw = chapter.spotlight ?? chapter.targets ?? chapter.target;
  if (!raw) return [];
  return (Array.isArray(raw) ? raw : [raw]).filter((s) => typeof s === 'string' && s.trim());
}

// Inject the spotlight stylesheet + a synthetic cursor element ONCE per page. The
// overlay is a fixed full-viewport dim backdrop with a transparent "hole" punched
// over the target via a box-shadow ring; the cursor is an absolutely-positioned dot
// that we animate toward a target for visual guidance. All injected into the page —
// no new npm dependency. Idempotent: re-injection is a no-op.
async function ensureSpotlightChrome(page, withCursor) {
  await page
    .evaluate((cursor) => {
      if (!document.getElementById('armada-logbook-style')) {
        const style = document.createElement('style');
        style.id = 'armada-logbook-style';
        style.textContent = `
          #armada-logbook-spot{position:fixed;inset:0;pointer-events:none;z-index:2147483646;
            opacity:0;transition:opacity .35s ease;border-radius:8px;
            box-shadow:0 0 0 9999px rgba(8,12,20,.62);outline:3px solid #4da3ff;
            outline-offset:2px;}
          #armada-logbook-spot.on{opacity:1;}
          #armada-logbook-ring{position:fixed;pointer-events:none;z-index:2147483647;
            border:3px solid #4da3ff;border-radius:10px;box-shadow:0 0 18px 4px rgba(77,163,255,.8);
            opacity:0;transition:opacity .35s ease, top .4s ease, left .4s ease,
            width .4s ease, height .4s ease;}
          #armada-logbook-ring.on{opacity:1;}
          #armada-logbook-cursor{position:fixed;width:22px;height:22px;z-index:2147483647;
            pointer-events:none;left:0;top:0;opacity:0;transition:left .6s ease, top .6s ease,
            opacity .3s ease, transform .12s ease;
            background:no-repeat center/contain url("data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24'><path d='M4 2l16 9-7 1 4 8-3 1-4-8-6 4z' fill='white' stroke='black' stroke-width='1.2'/></svg>");
            filter:drop-shadow(0 1px 2px rgba(0,0,0,.5));}
          #armada-logbook-cursor.on{opacity:1;}
          #armada-logbook-cursor.tap{transform:scale(.8);}`;
        document.head.appendChild(style);
      }
      if (!document.getElementById('armada-logbook-spot')) {
        const spot = document.createElement('div');
        spot.id = 'armada-logbook-spot';
        document.body.appendChild(spot);
        const ring = document.createElement('div');
        ring.id = 'armada-logbook-ring';
        document.body.appendChild(ring);
      }
      if (cursor && !document.getElementById('armada-logbook-cursor')) {
        const c = document.createElement('div');
        c.id = 'armada-logbook-cursor';
        document.body.appendChild(c);
      }
    }, !!withCursor)
    .catch(() => {});
}

// Spotlight a target selector: scroll it into view, then position the dim backdrop's
// "hole" and the glowing ring over its bounding box and fade them in. Returns whether
// a target was found (so the caller can still hold the beat even if it wasn't).
async function spotlightTarget(page, selector) {
  return page
    .evaluate((sel) => {
      const el = document.querySelector(sel);
      const spot = document.getElementById('armada-logbook-spot');
      const ring = document.getElementById('armada-logbook-ring');
      if (!el || !spot || !ring) return false;
      el.scrollIntoView({ block: 'center', inline: 'center', behavior: 'smooth' });
      const r = el.getBoundingClientRect();
      const pad = 6;
      const box = {
        left: Math.max(0, r.left - pad),
        top: Math.max(0, r.top - pad),
        width: r.width + pad * 2,
        height: r.height + pad * 2,
      };
      for (const node of [spot, ring]) {
        node.style.left = box.left + 'px';
        node.style.top = box.top + 'px';
        node.style.width = box.width + 'px';
        node.style.height = box.height + 'px';
        node.classList.add('on');
      }
      return true;
    }, selector)
    .catch(() => false);
}

// Hide the spotlight backdrop + ring between beats so an un-targeted beat shows the
// app unobscured.
async function clearSpotlight(page) {
  await page
    .evaluate(() => {
      for (const id of ['armada-logbook-spot', 'armada-logbook-ring']) {
        const n = document.getElementById(id);
        if (n) n.classList.remove('on');
      }
    })
    .catch(() => {});
}

// Drift the synthetic cursor toward a selector (centre of its box) and optionally
// animate a tap. Best-effort visual guidance — never throws, never blocks the click
// that actually drives the app.
async function moveCursorTo(page, selector, { tap = false } = {}) {
  await page
    .evaluate(
      ({ sel, tap }) => {
        const c = document.getElementById('armada-logbook-cursor');
        const el = sel && document.querySelector(sel);
        if (!c || !el) return;
        const r = el.getBoundingClientRect();
        c.classList.add('on');
        c.style.left = r.left + r.width / 2 + 'px';
        c.style.top = r.top + r.height / 2 + 'px';
        if (tap) {
          c.classList.add('tap');
          setTimeout(() => c.classList.remove('tap'), 160);
        }
      },
      { sel: selector, tap },
    )
    .catch(() => {});
}

// Lazy web capture. Tries playwright, then puppeteer; degrades to a card on any
// import/launch failure so a missing/half-installed backend never hard-fails.
//
// Readiness discipline (issue #68): before the *recorded* pass we (a) drive a
// throwaway WARM-UP navigation in a non-recording context so first-compile latency
// in dev mode never lands inside the recording, then (b) in the recording context
// wait for the recipe readySignal AND a contentful paint before driving the reach
// steps. After capture we (c) sanity-check the produced clip and, if it's
// empty/near-static, fall back to a storyboard card and NAME the capture degrade in
// `captureDegraded` rather than silently muxing blank frames.
//
// Motion walkthrough (issue #69): the reach vocabulary carries live interactions
// (hover/dblclick/press/dragdrop/scrollTo on top of goto/click/fill/wait), all
// recorded as real motion; a beat can carry target selector(s) to SPOTLIGHT — the
// recorder scrolls each into view, dims the rest, rings the element, optionally
// drifts a synthetic cursor to it, and HOLDS for the beat's narration-clip duration so
// the highlight stays synced to the voice-over. With no live video this same spotlight
// is drawn onto an annotated still (see captureWebStill) and the degrade is named.
async function captureWeb(recipe, chapter, ffmpegExe, captureDegraded = []) {
  // Prefer a URL that actually renders (preview/live) over the worktree dev server,
  // with the dev server as the fallback (issue #91). `entry` is mutable: if the
  // preferred URL warms up blank we switch to the fallback before recording.
  const { preferred, fallback } = resolveRecordEntry(recipe);
  let entry = preferred;
  // Routes this chapter touches: the entry plus any goto targets in its reach.
  const routesFor = (base) => {
    const r = [];
    if (base && /^https?:/.test(base)) r.push(base);
    for (const step of chapter.reach) {
      if (step.action === 'goto' && step.target) r.push(resolveUrl(base, step.target));
    }
    return r;
  };
  let routes = routesFor(entry);

  // Capture degrade when there is no live page to annotate (e.g. the backend failed to
  // launch): name the degrade (issue #68 convention) and fall back to a storyboard
  // card. The empty/no-clip path uses degradeWithStill(), which prefers a
  // spotlight-annotated still grabbed from the live page (issue #69).
  const degrade = (reason) => {
    const msg = `chapter ${chapter.index} ("${chapter.title}") capture degraded -> storyboard card (${reason})`;
    if (!captureDegraded.includes(msg)) captureDegraded.push(msg);
    return renderStoryboardCard(chapter, ffmpegExe);
  };

  try {
    const pw = await import('playwright').catch(() => import('playwright-core'));
    const browser = await pw.chromium.launch();

    // (a) WARM-UP — prime each route in a throwaway, NON-recording context so the
    // dev server's first-compile (which can take seconds and renders blank) happens
    // OUTSIDE the capture. We wait for a contentful paint on each so the warmed
    // route is actually compiled before the recorded pass revisits it.
    try {
      const warmCtx = await browser.newContext();
      const warmPage = await warmCtx.newPage();
      // Warm the entry first and ASSERT it actually paints. If the preferred URL
      // comes back blank (a dead preview, a not-yet-deployed URL) and we have a
      // dev-server fallback, switch to it before recording — never record a URL we
      // just observed blank (issue #91, AC1).
      if (entry && /^https?:/.test(entry)) {
        await warmPage.goto(entry, { waitUntil: 'load', timeout: 30000 }).catch(() => {});
        await waitForContentfulPaint(warmPage);
        const painted = await pageHasContent(warmPage);
        if (!painted && fallback) {
          const msg = `chapter ${chapter.index} ("${chapter.title}") preferred record URL blank -> fell back to dev server (${entry} -> ${fallback})`;
          if (!captureDegraded.includes(msg)) captureDegraded.push(msg);
          entry = fallback;
          routes = routesFor(entry);
        }
      }
      // Prime every route this chapter touches (with the resolved entry) so dev-mode
      // first-compile latency happens outside the recorded pass.
      for (const url of routes) {
        await warmPage.goto(url, { waitUntil: 'load', timeout: 30000 }).catch(() => {});
        await waitForContentfulPaint(warmPage);
      }
      await warmCtx.close();
    } catch {
      /* warm-up is best-effort; the recorded pass still gates on readiness below */
    }

    // (b) RECORD — fresh recording context, gated on readiness at every navigation.
    const ctx = await browser.newContext({ recordVideo: { dir: cacheDir() } });
    const page = await ctx.newPage();
    const wantCursor = !!(chapter.cursor ?? recipe.cursor);
    if (entry && /^https?:/.test(entry)) {
      await page.goto(entry, { waitUntil: 'load', timeout: 30000 }).catch(() => {});
      await waitForContentfulPaint(page);
    }
    await ensureSpotlightChrome(page, wantCursor);
    // Replay the reach steps as LIVE motion. goto/click/fill/wait are preserved;
    // hover/dblclick/press/scrollTo/dragdrop add real interactions that the video
    // captures as motion (issue #69). A synthetic cursor (when enabled) drifts to the
    // target of each pointer step for visual guidance before the real action fires.
    for (const step of chapter.reach) {
      const t = step.target;
      if (step.action === 'goto' && t) {
        await page.goto(resolveUrl(entry, t), { waitUntil: 'load', timeout: 30000 }).catch(() => {});
        await waitForContentfulPaint(page);
        await ensureSpotlightChrome(page, wantCursor); // chrome is per-document; re-inject after nav
      } else if (step.action === 'click' && t) {
        if (wantCursor) await moveCursorTo(page, t, { tap: true });
        await page.click(t, { timeout: 5000 }).catch(() => {});
        // A click can trigger a client-side route/transition; let it settle.
        await page.waitForLoadState('networkidle', { timeout: 5000 }).catch(() => {});
      } else if (step.action === 'dblclick' && t) {
        if (wantCursor) await moveCursorTo(page, t, { tap: true });
        await page.dblclick(t, { timeout: 5000 }).catch(() => {});
        await page.waitForLoadState('networkidle', { timeout: 5000 }).catch(() => {});
      } else if (step.action === 'hover' && t) {
        if (wantCursor) await moveCursorTo(page, t);
        await page.hover(t, { timeout: 5000 }).catch(() => {});
      } else if (step.action === 'fill' && t) {
        if (wantCursor) await moveCursorTo(page, t);
        await page.fill(t, step.value || '').catch(() => {});
      } else if (step.action === 'press') {
        // Keyboard input — e.g. opening a command palette (Control+K) or submitting.
        // `target` is optional: focus it first when given, else press globally.
        if (t) await page.focus(t).catch(() => {});
        await page.keyboard.press(String(step.value || step.keys || 'Enter')).catch(() => {});
        await page.waitForLoadState('networkidle', { timeout: 5000 }).catch(() => {});
      } else if (step.action === 'dragdrop' && t && (step.to || step.dest)) {
        // Drag one element onto another and let the streamed result settle — captured
        // as motion. Playwright's dragAndDrop interpolates the pointer move.
        if (wantCursor) await moveCursorTo(page, t);
        await page.dragAndDrop(t, step.to || step.dest, { timeout: 8000 }).catch(() => {});
        await page.waitForLoadState('networkidle', { timeout: 5000 }).catch(() => {});
      } else if (step.action === 'scrollTo' && t) {
        await page
          .evaluate((sel) => {
            const el = document.querySelector(sel);
            if (el) el.scrollIntoView({ block: 'center', behavior: 'smooth' });
          }, t)
          .catch(() => {});
        await page.waitForTimeout(600);
      } else if (step.action === 'wait') {
        await page.waitForTimeout(Number(step.value) || 1000);
      }
    }
    // (b2) SPOTLIGHT — after the interactions land, draw the per-beat spotlight on the
    // target element(s) and HOLD for the narration-clip's duration so the highlight is
    // synced to the voice-over (or a readable default when captions). Cycle through
    // multiple targets, splitting the hold evenly. With no target the hold still keeps
    // the final interacted state on screen for the narration's length.
    const targets = beatTargets(chapter);
    const holdMs = beatHoldMs(chapter, ffmpegExe);
    if (targets.length) {
      const per = Math.max(SPOTLIGHT_MIN_HOLD_MS, Math.round(holdMs / targets.length));
      for (const sel of targets) {
        if (wantCursor) await moveCursorTo(page, sel);
        await spotlightTarget(page, sel);
        await page.waitForTimeout(per);
        await clearSpotlight(page);
      }
    } else {
      await page.waitForTimeout(holdMs);
    }

    // Grab a spotlight-annotated still from the LIVE page before we close the context
    // (the webm only finalises on close, and the page is gone afterwards). We use this
    // still only if the recorded clip turns out empty/near-static — so an honest
    // degrade still shows the narrated element highlighted, not a bare title card.
    let fallbackStill = null;
    if (targets[0]) await spotlightTarget(page, targets[0]);
    fallbackStill = await captureWebStill(page, chapter, ffmpegExe).catch(() => null);

    await ctx.close();
    await browser.close();

    // Playwright writes a .webm; the newest file in cacheDir is this chapter's.
    const vids = readdirSync(cacheDir())
      .filter((f) => f.endsWith('.webm'))
      .map((f) => path.join(cacheDir(), f));
    const clip = vids.sort((a, b) => statMtime(b) - statMtime(a))[0];
    if (!clip) return degradeWithStill('no clip produced', fallbackStill);
    // (c) Empty/near-static sanity check: a clip that captured a real painted app
    // is materially larger than one of a blank/near-static viewport. A blank webm
    // compresses to almost nothing, so a too-small file means we recorded the
    // pre-paint blank window — report it as a capture degrade instead of muxing it.
    if (isEmptyClip(clip)) return degradeWithStill('clip is empty/near-static (app not painted)', fallbackStill);
    return clip;
  } catch (e) {
    // The page may be gone here; degrade to a storyboard card and name it.
    return degrade(`capture backend error: ${e.message || e}`);
  }

  // Name an empty/no-clip degrade and prefer the spotlight-annotated still we grabbed
  // from the live page (issue #69) over a bare storyboard card (issue #68 names it).
  function degradeWithStill(reason, still) {
    const target = still ? 'annotated still (spotlight overlay)' : 'storyboard card';
    const msg = `chapter ${chapter.index} ("${chapter.title}") capture degraded -> ${target} (${reason})`;
    if (!captureDegraded.includes(msg)) captureDegraded.push(msg);
    return still || renderStoryboardCard(chapter, ffmpegExe);
  }
}

// Take a screenshot of the live page (with whatever spotlight overlay is currently on)
// and render it as a short still clip — the annotated-still degrade for issue #69. The
// PNG is turned into a held video frame via ffmpeg so it concatenates with real clips;
// with no ffmpeg we return the PNG marker so the storyboard manifest can reference it.
async function captureWebStill(page, chapter, ffmpegExe) {
  if (!page) return null;
  const png = path.join(cacheDir(), `still-${chapter.index}.png`);
  await page.screenshot({ path: png, fullPage: false }).catch(() => {});
  if (!existsSync(png)) return null;
  if (!ffmpegExe) return { still: true, png, ...chapter };
  const out = path.join(cacheDir(), `still-${chapter.index}.mp4`);
  // Hold the still for the narration-clip's duration (or default) so the annotated
  // frame stays synced to the voice-over, mirroring the live-spotlight hold.
  const holdSecs = Math.round(beatHoldMs(chapter, ffmpegExe) / 1000) || 4;
  await run(ffmpegExe, [
    '-y', '-loop', '1', '-i', png, '-t', String(holdSecs),
    '-vf', 'scale=1280:720:force_original_aspect_ratio=decrease,pad=1280:720:(ow-iw)/2:(oh-ih)/2',
    '-r', '30', '-pix_fmt', 'yuv420p', out,
  ]).catch(() => {});
  return existsSync(out) ? out : { still: true, png, ...chapter };
}

// Heuristic emptiness check for a captured webm. A recording of a blank or static
// viewport (e.g. the pre-paint dev-compile window) carries almost no inter-frame
// change and compresses to a tiny file; a recording of a real, painted, navigated
// app is materially larger. We treat a clip under a small byte floor as empty.
// Bytes are a robust, dependency-free proxy here — we already require ffmpeg/the
// browser, but not a frame-diffing decode, so size keeps the check cheap and the
// script Node-built-ins-only at load time.
const EMPTY_CLIP_BYTES = 24 * 1024; // 24 KiB — well below any genuine multi-second app clip
function isEmptyClip(file) {
  try {
    return statSync(file).size < EMPTY_CLIP_BYTES;
  } catch {
    return true;
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

// Escape text for ffmpeg's drawtext filter (which treats :, %, \, and ' specially).
// We map the apostrophe to a typographic one to dodge shell/filter quoting entirely,
// strip newlines, and bound the length so a card stays readable.
function ffSafeText(s) {
  return String(s || '')
    .replace(/\\/g, ' ')
    .replace(/[:%]/g, ' ')
    .replace(/'/g, '’')
    .replace(/[\r\n]+/g, ' ')
    .trim()
    .slice(0, 120);
}

// Render a short chapter-divider card (title + role) — production polish (issue #91).
async function renderDividerCard(chapter, ffmpegExe, secs = 1.4) {
  if (!ffmpegExe) return null;
  const file = path.join(cacheDir(), `divider-${chapter.index}.mp4`);
  const title = ffSafeText(chapter.title || `Chapter ${chapter.index + 1}`);
  const role = ffSafeText(chapter.role || '');
  const vf = [
    `drawtext=text='${title}':fontcolor=white:fontsize=54:x=(w-text_w)/2:y=(h-text_h)/2-30`,
    role
      ? `drawtext=text='${role}':fontcolor=0xbcd3ee:fontsize=28:x=(w-text_w)/2:y=(h-text_h)/2+45`
      : null,
  ]
    .filter(Boolean)
    .join(',');
  await run(ffmpegExe, [
    '-y', '-f', 'lavfi', '-i', `color=c=0x0b0f16:s=1280x720:d=${secs}`,
    '-vf', vf, '-r', '30', '-pix_fmt', 'yuv420p', file,
  ]).catch(() => {});
  return existsSync(file) ? file : null;
}

// Normalise a clip to the common 1280x720/30fps/yuv420p shape so segments concat
// cleanly, dropping any source audio (audio is added later as one aligned master
// track). When `lowerThird` is set, burn in a persistent lower-third (issue #91).
async function normaliseClip(file, tag, ffmpegExe, lowerThird) {
  const n = path.join(cacheDir(), `norm-${tag}.mp4`);
  const base =
    'scale=1280:720:force_original_aspect_ratio=decrease,pad=1280:720:(ow-iw)/2:(oh-ih)/2,format=yuv420p';
  const vf = lowerThird
    ? `${base},drawtext=text='${ffSafeText(lowerThird)}':fontcolor=white:fontsize=26:x=40:y=h-72:box=1:boxcolor=0x0b0f16@0.6:boxborderw=14`
    : base;
  await run(ffmpegExe, [
    '-y', '-i', file, '-an', '-vf', vf, '-r', '30', '-pix_fmt', 'yuv420p', n,
  ]).catch(() => {});
  return existsSync(n) ? n : null;
}

// Build ONE master audio track from per-chapter narration clips, each delayed to
// its real start offset on the timeline (adelay) and mixed (amix). This is the fix
// for audio drift (issue #91, AC4): naive per-chapter mux + concat left a long
// silent tail when a clip outran its narration; aligning by timestamp lands each
// narration exactly when its chapter begins. Returns the master path, or null.
async function buildAlignedAudio(voiced, ffmpegExe) {
  if (!voiced.length) return null;
  const master = path.join(cacheDir(), 'master-audio.m4a');
  const inputs = [];
  const filters = [];
  voiced.forEach((v, i) => {
    inputs.push('-i', v.file);
    filters.push(`[${i}:a]adelay=${v.offsetMs}|${v.offsetMs}[a${i}]`);
  });
  const mixIns = voiced.map((_, i) => `[a${i}]`).join('');
  const filterComplex = `${filters.join(';')};${mixIns}amix=inputs=${voiced.length}:normalize=0:dropout_transition=0[mix]`;
  await run(ffmpegExe, [
    '-y', ...inputs,
    '-filter_complex', filterComplex,
    '-map', '[mix]', '-c:a', 'aac', '-ar', '48000', master,
  ]).catch(() => {});
  return existsSync(master) ? master : null;
}

function matchNum(txt, re) {
  const m = txt.match(re);
  return m ? Number(m[1]) : null;
}

// Sample one frame at `t` seconds and read its luma stats (YAVG/YMIN/YMAX) via
// ffmpeg's signalstats filter. Used to detect a blank/near-white capture. Returns
// null on any failure — best-effort, ffmpeg-only.
function frameLuma(file, t, ffmpegExe) {
  if (!ffmpegExe) return null;
  const r = spawnSync(
    ffmpegExe,
    ['-v', 'info', '-ss', String(t), '-i', file, '-frames:v', '1', '-vf', 'signalstats,metadata=print', '-f', 'null', '-'],
    { encoding: 'utf8' },
  );
  const txt = (r.stderr || '') + (r.stdout || '');
  const yavg = matchNum(txt, /signalstats\.YAVG=([\d.]+)/);
  if (yavg === null) return null;
  const ymin = matchNum(txt, /signalstats\.YMIN=([\d.]+)/);
  const ymax = matchNum(txt, /signalstats\.YMAX=([\d.]+)/);
  return { yavg, ymin: ymin ?? yavg, ymax: ymax ?? yavg };
}

// Mean volume in dB via ffmpeg's volumedetect. null on failure.
function meanVolumeDb(file, ffmpegExe) {
  if (!ffmpegExe) return null;
  const r = spawnSync(ffmpegExe, ['-i', file, '-af', 'volumedetect', '-f', 'null', '-'], {
    encoding: 'utf8',
  });
  return matchNum(r.stderr || '', /mean_volume:\s*(-?[\d.]+) dB/);
}

// Post-record self-check (issue #91, AC5): sample a mid-video frame and assert it
// is NOT blank/near-white, and assert the file carries a video stream and — when
// narration was expected — a NON-SILENT audio stream. Returns a structured verdict
// the caller reports loudly; never throws. This is the guard that would have caught
// every failure mode in the issue (white screen, no voice, silent track).
function postRecordSelfCheck(out, ffmpegExe, { expectAudio } = {}) {
  if (!out || !existsSync(out)) {
    return { pass: false, frame: 'absent', audio: 'absent', reason: 'output file not produced' };
  }
  const verdict = { pass: true, frame: 'unknown', audio: 'unknown', reason: '' };
  const note = (m) => (verdict.reason = verdict.reason ? `${verdict.reason}; ${m}` : m);

  const dur = clipDurationSeconds(out, ffmpegExe) || 0;
  const mid = dur > 0 ? Math.max(0.1, dur / 2) : 0.1;

  // Streams present?
  const probe = resolveExe(os.platform() === 'win32' ? 'ffprobe.exe' : 'ffprobe');
  let hasVideo = true;
  let hasAudio = false;
  if (probe) {
    const r = spawnSync(
      probe,
      ['-v', 'error', '-show_entries', 'stream=codec_type', '-of', 'csv=p=0', out],
      { encoding: 'utf8' },
    );
    const types = (r.stdout || '').split(/\r?\n/).map((s) => s.trim());
    hasVideo = types.includes('video');
    hasAudio = types.includes('audio');
  }
  if (!hasVideo) {
    verdict.pass = false;
    verdict.frame = 'no-video-stream';
    note('no video stream in output');
  }

  // Mid-frame not blank/near-white.
  const luma = frameLuma(out, mid, ffmpegExe);
  if (luma) {
    // A blank/near-white capture is both very bright AND near-flat (no content
    // variance). A legitimately bright/white-background app still renders content
    // (text, controls), so its frame won't be flat — require BOTH to avoid a
    // false-positive "blank" on a light UI.
    const range = (luma.ymax ?? luma.yavg) - (luma.ymin ?? luma.yavg);
    const nearWhite = luma.yavg >= 235;
    const flat = range <= 8;
    if (nearWhite && flat) {
      verdict.pass = false;
      verdict.frame = 'blank/near-white';
      note(`mid-frame appears blank (YAVG=${luma.yavg}, range=${range})`);
    } else {
      verdict.frame = 'ok';
    }
  } else {
    verdict.frame = 'unverified';
  }

  // Audio non-silent when narration was expected.
  if (expectAudio) {
    if (!hasAudio) {
      verdict.pass = false;
      verdict.audio = 'absent';
      note('expected narration but output has no audio stream');
    } else {
      const mv = meanVolumeDb(out, ffmpegExe);
      if (mv === null) {
        verdict.audio = 'present (level unverified)';
      } else if (mv <= -70) {
        verdict.pass = false;
        verdict.audio = 'silent';
        note(`audio stream is silent (mean ${mv} dB)`);
      } else {
        verdict.audio = 'ok';
      }
    }
  } else {
    verdict.audio = hasAudio ? 'present' : 'n/a (captions)';
  }

  if (verdict.pass && !verdict.reason) note(`frame ${verdict.frame}, audio ${verdict.audio}`);
  return verdict;
}

// Assemble the captured clips into one walkthrough: a divider card + lower-third
// per chapter, concatenated to a master video, with ONE timestamp-aligned master
// audio track muxed on (issue #91). `clips[i]` pairs with `chapterPlan[i]`. Returns
// a { selfCheck } verdict from the post-record check.
async function assemble(clips, chapterPlan, out, ffmpegExe) {
  const segments = []; // { video, audioClip, durMs }
  let anyVoice = false;

  for (let i = 0; i < chapterPlan.length; i++) {
    const ch = chapterPlan[i];
    const clipFile = clips[i];
    if (typeof clipFile !== 'string' || !existsSync(clipFile)) continue;

    // Divider card before each chapter.
    const divider = await renderDividerCard(ch, ffmpegExe);
    if (divider) {
      const dnorm = await normaliseClip(divider, `div-${i}`, ffmpegExe, null);
      if (dnorm) {
        segments.push({
          video: dnorm,
          audioClip: null,
          durMs: (clipDurationSeconds(dnorm, ffmpegExe) || 1.4) * 1000,
        });
      }
    }

    // Chapter clip with a persistent lower-third (title — role).
    const lower = ch.role ? `${ch.title} — ${ch.role}` : ch.title;
    const cnorm = await normaliseClip(clipFile, String(i), ffmpegExe, lower);
    if (!cnorm) continue;
    const audioClip =
      ch.clip && ch.clip.mode === 'voice' && ch.clip.file && existsSync(ch.clip.file)
        ? ch.clip.file
        : null;
    if (audioClip) anyVoice = true;
    segments.push({
      video: cnorm,
      audioClip,
      durMs: (clipDurationSeconds(cnorm, ffmpegExe) || 4) * 1000,
    });
  }

  if (segments.length === 0) {
    writeFileSync(out.replace(/\.mp4$/i, '') + '.storyboard.json', JSON.stringify(chapterPlan, null, 2));
    return { selfCheck: { pass: false, frame: 'absent', audio: 'absent', reason: 'no usable clips to assemble' } };
  }

  // Concatenate the (silent) video segments into the master timeline.
  const listFile = path.join(cacheDir(), 'concat.txt');
  writeFileSync(listFile, segments.map((s) => `file '${s.video.replace(/'/g, "'\\''")}'`).join('\n'));
  const silentVideo = path.join(cacheDir(), 'master-video.mp4');
  await run(ffmpegExe, ['-y', '-f', 'concat', '-safe', '0', '-i', listFile, '-c', 'copy', silentVideo]).catch(
    async () => {
      await run(ffmpegExe, [
        '-y', '-f', 'concat', '-safe', '0', '-i', listFile, '-r', '30', '-pix_fmt', 'yuv420p', silentVideo,
      ]).catch(() => {});
    },
  );
  if (!existsSync(silentVideo)) {
    return { selfCheck: { pass: false, frame: 'absent', audio: 'absent', reason: 'video concat failed' } };
  }

  // Build + mux the timestamp-aligned master audio track when any chapter has voice.
  let finalDone = false;
  if (anyVoice) {
    const voiced = [];
    let offsetMs = 0;
    for (const s of segments) {
      if (s.audioClip) voiced.push({ file: s.audioClip, offsetMs: Math.round(offsetMs) });
      offsetMs += s.durMs;
    }
    const masterAudio = await buildAlignedAudio(voiced, ffmpegExe);
    if (masterAudio && existsSync(masterAudio)) {
      // Map video from the silent master + audio from the aligned track. No
      // -shortest: keep the full video timeline; narration simply ends with its
      // last clip (no silent-tail padding, no video truncation).
      await run(ffmpegExe, [
        '-y', '-i', silentVideo, '-i', masterAudio,
        '-map', '0:v:0', '-map', '1:a:0',
        '-c:v', 'copy', '-c:a', 'aac', '-ar', '48000', out,
      ]).catch(() => {});
      finalDone = existsSync(out);
    }
  }
  if (!finalDone) {
    // Captions-only / no voice: the silent master video is the deliverable.
    await run(ffmpegExe, ['-y', '-i', silentVideo, '-c', 'copy', out]).catch(() => {});
    if (!existsSync(out)) {
      writeFileSync(out.replace(/\.mp4$/i, '') + '.storyboard.json', JSON.stringify(chapterPlan, null, 2));
    }
  }

  return { selfCheck: postRecordSelfCheck(out, ffmpegExe, { expectAudio: anyVoice }) };
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
