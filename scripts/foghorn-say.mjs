#!/usr/bin/env node
// ARMADA foghorn — speak the fleet's activity aloud.
//
// The fleet's VOICE: it composes a short spoken sentence from a line (or the
// ARMADA_BELL_* event context crows-nest's bellCommand hook exports) and
// SYNTHESISES + PLAYS it cross-platform — booming across the water so you HEAR
// what the fleet is doing without watching labels or the loop. foghorn is a
// narrator: READ-ONLY w.r.t. the fleet — it never claims, merges, or relabels.
//
// It reuses logbook's TTS design (skills/logbook/references/recorder.md):
//   * a PLUGGABLE TTS provider selected by env — a configured cloud voice
//     (e.g. ElevenLabs) when its key is present, falling back to the FREE LOCAL
//     OS voice (Windows SAPI/System.Speech, macOS `say`, Linux `espeak`) when
//     no key is set;
//   * HASH-CACHED clips keyed by (text + voice + provider) under a gitignored
//     scratch dir, so a repeated phrase never re-synthesises (latency + cost).
//
// Graceful degradation is the design: if no audio device / engine is available
// it DEGRADES TO PRINTING the line and exits 0 — it never errors. This makes it
// safe as a crows-nest `bellCommand` (best-effort, side-channel, fire-and-forget;
// crows-nest §8c/§8e): a missing voice must never fail a tick.
//
// Dependency-free at load: only Node built-ins are imported up top, so it runs
// in ARMADA's no-package.json repo and in any installed-plugin cache. Reference
// it from skills via ${CLAUDE_PLUGIN_ROOT}/scripts/foghorn-say.mjs (installed
// plugins are copied to a cache; relative paths break there).
//
// Modes:
//   (bell)    Read ARMADA_BELL_EVENT/NUMBER/REASON/MESSAGE -> compose -> speak.
//             This is the headless bellCommand path: NO LLM in the loop, so the
//             flavour selects a templated phrasing/voice-style only.
//   --line    Speak a literal/explicit line (already composed by an agent in the
//             live-commentary or on-demand modes, where the model wrote the line
//             per the flavour). Skips composition; just synth+play.
//   --status  Speak an on-demand fleet status from a fleet-state.json snapshot
//             (spyglass's, if present) or a passed --state file.
//
// Run:
//   node scripts/foghorn-say.mjs                 # bell mode (reads ARMADA_BELL_*)
//   node scripts/foghorn-say.mjs --line "..."    # speak an explicit line
//   node scripts/foghorn-say.mjs --status [--state <fleet-state.json>]
//   node scripts/foghorn-say.mjs --self-test     # compose + cache, no audio
//   node scripts/foghorn-say.mjs --help

import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';
import os from 'node:os';
import process from 'node:process';

// --------------------------------------------------------------------------
// CLI parsing
// --------------------------------------------------------------------------

function parseArgs(argv) {
  const args = { _: [] };
  // Read the value for a valued flag, but only consume the next token when it
  // looks like a real value — a following token that starts with '--' is the
  // NEXT flag, not this flag's value, so we leave it for the loop to parse.
  // This keeps `--provider --check` from swallowing `--check` (which would
  // bypass doctor mode's no-audio guarantee). Returns undefined when no value
  // follows (e.g. the flag is the last arg); callers treat that as "unset".
  const valueFor = (i) =>
    argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : undefined;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--help' || a === '-h') args.help = true;
    else if (a === '--status') args.status = true;
    else if (a === '--self-test') args.selfTest = true;
    else if (a === '--check' || a === '--doctor') args.check = true;
    else if (a === '--print-only') args.printOnly = true;
    else if (a === '--no-cache') args.noCache = true;
    else if (a === '--line') { const v = valueFor(i); if (v !== undefined) { args.line = v; i++; } }
    else if (a === '--event') { const v = valueFor(i); if (v !== undefined) { args.event = v; i++; } }
    else if (a === '--number') { const v = valueFor(i); if (v !== undefined) { args.number = v; i++; } }
    else if (a === '--reason') { const v = valueFor(i); if (v !== undefined) { args.reason = v; i++; } }
    else if (a === '--flavour' || a === '--flavor') { const v = valueFor(i); if (v !== undefined) { args.flavour = v; i++; } }
    else if (a === '--verbosity') { const v = valueFor(i); if (v !== undefined) { args.verbosity = v; i++; } }
    else if (a === '--state') { const v = valueFor(i); if (v !== undefined) { args.state = v; i++; } }
    else if (a === '--voice') { const v = valueFor(i); if (v !== undefined) { args.voice = v; i++; } }
    else if (a === '--provider') { const v = valueFor(i); if (v !== undefined) { args.provider = v; i++; } }
    else if (a.startsWith('--')) args[a.slice(2)] = argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[++i] : true;
    else args._.push(a);
  }
  return args;
}

const HELP = `foghorn-say — speak the fleet's activity aloud

Modes:
  (default)               Bell mode: read ARMADA_BELL_EVENT/NUMBER/REASON/MESSAGE,
                          compose a spoken line per the flavour, synth + play.
  --line "<text>"         Speak an explicit, already-composed line (agent modes).
  --status                Speak an on-demand fleet status from a fleet-state.json
                          snapshot (spyglass's .armada/spyglass/fleet-state.json,
                          or --state <file>).
  --self-test             Compose + cache only; never touch the audio device.
  --check                 Doctor mode: print what foghorn RESOLVED — provider,
                          voice, whether the key is present (masked, never the
                          value), the cache dir, and the chosen player — and
                          synthesise/play NOTHING. Answers "why isn't it using
                          my voice?" in one command.

Options:
  --flavour "<text>"      Free-text tone prompt steering wording/voice-style.
                          Default: a gruff, proud nautical harbourmaster.
                          (Also read from config foghorn.flavour / env FOGHORN_FLAVOUR.)
  --verbosity <level>     terse | normal | rich. Default normal (config foghorn.verbosity).
  --event/--number/--reason
                          Override the ARMADA_BELL_* context (testing).
  --provider <id>         TTS provider id (e.g. elevenlabs, openai). Empty/unset
                          falls back to the free local OS voice.
  --voice <id>            Voice id passed to the provider.
  --print-only            Compose + print the line; never synthesise/play.
  --no-cache              Bypass the clip cache (always re-synthesise).
  -h, --help              This help.

Provider/voice resolution (first wins): --flag (--provider / --voice) > env
(FOGHORN_TTS_PROVIDER / FOGHORN_VOICE) > config (foghorn.provider / foghorn.voice
in .armada/config.json) > default. So a NON-SECRET cloud-voice setup can live in
config and survive restarts with no env at all. The SECRET key is read from the
ENV ONLY (e.g. ELEVENLABS_API_KEY) — never from config.

Repo-local .env: before resolving, a local env file is loaded if present
(.armada/foghorn/.env, then repo-root .env) into process.env WITHOUT overriding
already-set vars. This lets the key (and any FOGHORN_*) be supplied per-repo
without depending on OS env propagation. Both .env paths are gitignored.

With no provider/key set it falls back to the FREE LOCAL OS voice (Windows SAPI /
macOS say / Linux espeak). With no audio engine at all it prints the line and
exits 0 — it never errors, so it is safe as a crows-nest bellCommand.
`;

// --------------------------------------------------------------------------
// Config + flavour resolution (config key -> env -> arg, arg wins)
// --------------------------------------------------------------------------

const DEFAULT_FLAVOUR =
  'a gruff, proud nautical harbourmaster calling the fleet’s comings and goings across the water';

function readConfig() {
  try {
    const p = path.join(process.cwd(), '.armada', 'config.json');
    if (existsSync(p)) return JSON.parse(readFileSync(p, 'utf8')) || {};
  } catch {
    /* config is optional — degrade to defaults */
  }
  return {};
}

// --------------------------------------------------------------------------
// Repo-local .env loader — dependency-free (no `dotenv`), a tiny built-in parser.
//
// Why: on Windows, `setx`/User env vars only propagate to FRESHLY-launched
// process trees, so a running app (and the bell it spawns) keeps seeing stale
// env — a correctly-configured cloud voice silently falls back to the local OS
// voice. Loading a repo-local .env into process.env lets the key (and any
// FOGHORN_*) be supplied PER-REPO without depending on OS env propagation.
//
// Files (loaded in order): .armada/foghorn/.env, then repo-root .env. An
// already-set var is NEVER overridden — real OS env still wins over the file,
// and the first file loaded wins over the second. Both paths are gitignored, so
// the SECRET key stays out of version control.
// --------------------------------------------------------------------------

// Parse a single .env line into [key, value] or null. Supports `KEY=value`,
// optional `export ` prefix, `#` comments, blank lines, and single/double
// quoted values (quotes stripped). Deliberately small — no interpolation.
function parseEnvLine(line) {
  const s = line.trim();
  if (!s || s.startsWith('#')) return null;
  const m = s.replace(/^export\s+/, '').match(/^([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
  if (!m) return null;
  let val = m[2].trim();
  if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
    val = val.slice(1, -1);
  } else {
    // Unquoted: strip a trailing inline comment ( value # comment ).
    const hash = val.indexOf(' #');
    if (hash !== -1) val = val.slice(0, hash).trim();
  }
  return [m[1], val];
}

// Load one .env file into process.env without overriding already-set vars.
// Returns the list of keys it set (for the doctor report), or [] if absent.
function loadEnvFile(file) {
  const set = [];
  try {
    if (!existsSync(file)) return set;
    for (const line of readFileSync(file, 'utf8').split(/\r?\n/)) {
      const kv = parseEnvLine(line);
      if (!kv) continue;
      const [k, v] = kv;
      if (process.env[k] === undefined) {
        process.env[k] = v;
        set.push(k);
      }
    }
  } catch {
    /* a malformed/unreadable .env must never fail foghorn — skip it */
  }
  return set;
}

// Load the repo-local env files (first wins; real env always wins over both).
// Returns { files: [{path, keys}] } describing what was loaded, for --check.
function loadLocalEnv() {
  const candidates = [
    path.join(process.cwd(), '.armada', 'foghorn', '.env'),
    path.join(process.cwd(), '.env'),
  ];
  const files = [];
  for (const f of candidates) {
    if (existsSync(f)) files.push({ path: f, keys: loadEnvFile(f) });
  }
  return { files };
}

function resolveFlavour(args, cfg) {
  return (
    args.flavour ||
    process.env.FOGHORN_FLAVOUR ||
    cfg.foghorn?.flavour ||
    DEFAULT_FLAVOUR
  );
}

function resolveVerbosity(args, cfg) {
  const v = (args.verbosity || process.env.FOGHORN_VERBOSITY || cfg.foghorn?.verbosity || 'normal')
    .toString()
    .toLowerCase()
    .trim();
  return ['terse', 'normal', 'rich'].includes(v) ? v : 'normal';
}

// The gate (notify-style) keeps routine events quiet by default. Routine =
// "opened"/"awaiting"; consequential = "shipped"/"blocked". Mirrors crows-nest
// §8a: off | blocked | terminal | all.
function resolveGate(cfg) {
  const g = (process.env.FOGHORN_GATE || cfg.foghorn?.gate || 'terminal').toString().toLowerCase().trim();
  return ['off', 'blocked', 'terminal', 'all'].includes(g) ? g : 'terminal';
}

function gateAdmits(gate, event) {
  if (gate === 'off') return false;
  if (gate === 'all') return true;
  if (gate === 'blocked') return event === 'blocked';
  // 'terminal' (default): the consequential events — shipped + blocked.
  if (gate === 'terminal') return event === 'shipped' || event === 'blocked';
  return true;
}

// --------------------------------------------------------------------------
// Bell-context composition — TEMPLATED, never depends on an LLM.
//
// The flavour selects a phrasing register; verbosity selects length. This is
// the headless bellCommand path: there is no agent in the loop, so the line is
// composed from templates here. (Agent-driven modes compose the line per the
// flavour with the model and pass it via --line, skipping this.)
// --------------------------------------------------------------------------

// Map a free-text flavour to a small set of named registers by keyword sniffing,
// so a flavour string still steers phrasing/voice-style with no LLM available.
// Unknown flavours fall back to the nautical register (the themed default).
function flavourRegister(flavour) {
  const f = (flavour || '').toLowerCase();
  if (/pirate|buccaneer|corsair|arr/.test(f)) return 'pirate';
  if (/sport|commentator|excit|race|derby/.test(f)) return 'sports';
  if (/stoic|captain|calm|deadpan|forecast|bbc|shipping/.test(f)) return 'stoic';
  if (/robot|terse|minimal|laconic|machine/.test(f)) return 'terse';
  return 'nautical';
}

// Phrase banks per register x event. Each returns the core sentence; verbosity
// and the noun (issue/PR number) are layered on by composeBell.
const PHRASES = {
  nautical: {
    shipped: (n) => `Hear ye! ${n} is home and berthed — merged and made fast.`,
    blocked: (n, r) => `Trouble on the water — ${n} is fouled and needs a hand${r ? `: ${r}` : ''}.`,
    awaiting: (n) => `${n} rides at anchor in the harbour, green and waiting on your word to merge.`,
    opened: (n) => `A fresh hull takes to the water — ${n} is launched for review.`,
  },
  pirate: {
    shipped: (n) => `Yarr! ${n} be plundered and stowed — merged, ye scurvy dogs!`,
    blocked: (n, r) => `Blast it — ${n} be run aground${r ? `: ${r}` : ''}. Needs a hand afore she sinks.`,
    awaiting: (n) => `${n} waits in the cove, ripe for the takin' — say the word to merge.`,
    opened: (n) => `A new prize sets sail — ${n} be up for the lookin'.`,
  },
  sports: {
    shipped: (n) => `And it's IN! ${n} crosses the line — merged, what a finish!`,
    blocked: (n, r) => `Oh, trouble! ${n} is down and out${r ? `: ${r}` : ''} — the fleet needs a sub.`,
    awaiting: (n) => `${n} is on the spot, green light, just waiting for the final whistle to merge.`,
    opened: (n) => `Here comes a new contender — ${n} steps up for review.`,
  },
  stoic: {
    shipped: (n) => `${n}: merged.`,
    blocked: (n, r) => `${n}: blocked${r ? `. ${r}` : ''}.`,
    awaiting: (n) => `${n}: green, awaiting merge.`,
    opened: (n) => `${n}: opened for review.`,
  },
  terse: {
    shipped: (n) => `${n} merged.`,
    blocked: (n, r) => `${n} blocked${r ? `: ${r}` : ''}.`,
    awaiting: (n) => `${n} awaiting merge.`,
    opened: (n) => `${n} opened.`,
  },
};

function nounFor(event, number) {
  if (!number) return 'a pull request';
  // shipped/awaiting/opened concern PRs; blocked can be either — keep it generic.
  return event === 'blocked' ? `#${number}` : `pull request #${number}`;
}

function composeBell(ctx, flavour, verbosity) {
  const event = (ctx.event || '').toLowerCase();
  const reg = flavourRegister(flavour);
  const bank = PHRASES[reg] || PHRASES.nautical;
  const maker = bank[event];
  const noun = nounFor(event, ctx.number);
  // Unknown event: fall back to the raw bell message if present.
  let line = maker ? maker(noun, ctx.reason) : (ctx.message || `Fleet event: ${event || 'unknown'}.`);

  if (verbosity === 'terse') {
    // One short clause — strip trailing flourish after the first sentence.
    line = line.split(/(?<=[.!])\s/)[0];
  } else if (verbosity === 'rich' && reg === 'nautical') {
    const flourish = {
      shipped: ' Ring the bell — another safe passage.',
      blocked: ' All hands, look lively.',
      awaiting: ' She’ll not sail herself.',
      opened: ' Fair winds to her.',
    }[event];
    if (flourish) line += flourish;
  }
  return line;
}

// --------------------------------------------------------------------------
// On-demand fleet status composition (--status). Read-only: consumes a
// fleet-state.json snapshot (spyglass's, if present) and speaks a summary.
// --------------------------------------------------------------------------

function findFleetState(stateArg) {
  const candidates = [
    stateArg,
    path.join(process.cwd(), '.armada', 'spyglass', 'fleet-state.json'),
    path.join(process.cwd(), '.armada', 'fleet-state.json'),
  ].filter(Boolean);
  for (const c of candidates) {
    const abs = path.resolve(process.cwd(), c);
    if (existsSync(abs)) {
      try {
        return { state: JSON.parse(readFileSync(abs, 'utf8')), source: abs };
      } catch {
        /* malformed — try the next candidate */
      }
    }
  }
  return { state: null, source: null };
}

function composeStatus(state, flavour) {
  const reg = flavourRegister(flavour);
  const issues = Array.isArray(state?.issues) ? state.issues : [];
  const prs = Array.isArray(state?.prs) ? state.prs : [];
  const blocked = [...issues, ...prs].filter((u) => /blocked/i.test(u.ship || u.state || '')).length;
  const inFlight = issues.length;
  const open = prs.length;

  const lead = {
    nautical: 'Harbour report',
    pirate: 'Avast — here be the fleet',
    sports: 'Here’s your fleet update',
    stoic: 'Fleet status',
    terse: 'Status',
  }[reg] || 'Harbour report';

  const parts = [];
  parts.push(`${inFlight} issue${inFlight === 1 ? '' : 's'} underway, ${open} pull request${open === 1 ? '' : 's'} in the harbour`);
  if (blocked > 0) parts.push(`${blocked} fouled and waiting on a hand`);
  else parts.push('none fouled — fair seas');
  return `${lead}: ` + parts.join(', ') + '.';
}

// --------------------------------------------------------------------------
// Provider-pluggable, env-keyed TTS (mirrors logbook recorder).
// --------------------------------------------------------------------------

const KEY_VAR_BY_PROVIDER = {
  elevenlabs: 'ELEVENLABS_API_KEY',
  openai: 'OPENAI_API_KEY',
  azure: 'AZURE_SPEECH_KEY',
  google: 'GOOGLE_API_KEY',
  polly: 'AWS_ACCESS_KEY_ID',
};

// Resolve the TTS provider/voice with precedence: --flag > env > config > default.
//   provider: --provider > FOGHORN_TTS_PROVIDER > foghorn.provider > '' (local)
//   voice:    --voice > FOGHORN_VOICE > foghorn.voice > 'default'
// The SECRET key is read from the ENV ONLY (never from config) — keeping the key
// out of committed config while letting the non-secret provider/voice live there
// and survive restarts with no OS env propagation. The .env loader (loadLocalEnv)
// runs first so the key can also be supplied per-repo via .armada/foghorn/.env.
// First non-EMPTY wins: trim each candidate and skip whitespace-only values so
// a blank `--provider "  "` (or blank env/config) doesn't block a real value
// further down the chain. Returns { value, source } so --check can label the
// source by what actually resolved, not by the raw (possibly-blank) flag.
function firstNonEmpty(candidates) {
  for (const [raw, source] of candidates) {
    const v = (raw ?? '').trim();
    if (v) return { value: v, source };
  }
  return { value: '', source: null };
}

function resolveProvider(args, cfg) {
  const { value, source } = firstNonEmpty([
    [args.provider, '--provider'],
    [process.env.FOGHORN_TTS_PROVIDER, 'env FOGHORN_TTS_PROVIDER'],
    [cfg?.foghorn?.provider, 'config foghorn.provider'],
  ]);
  return { value: value.toLowerCase(), source: value ? source : 'default (local)' };
}

function resolveVoice(args, cfg) {
  const { value, source } = firstNonEmpty([
    [args.voice, '--voice'],
    [process.env.FOGHORN_VOICE, 'env FOGHORN_VOICE'],
    [cfg?.foghorn?.voice, 'config foghorn.voice'],
  ]);
  return { value: value || 'default', source: value ? source : 'default' };
}

function ttsProviderConfig(args, cfg) {
  const provider = resolveProvider(args, cfg).value;
  const voice = resolveVoice(args, cfg).value;
  if (!provider) {
    return { provider: null, key: null, voice, reason: 'no provider (FOGHORN_TTS_PROVIDER / foghorn.provider unset)' };
  }
  const keyVar = KEY_VAR_BY_PROVIDER[provider] || `${provider.toUpperCase()}_API_KEY`;
  return { provider, keyVar, key: process.env[keyVar] || null, voice };
}

// --------------------------------------------------------------------------
// Scratch / cache dir — GITIGNORED. Keyed by (text + voice + provider).
// --------------------------------------------------------------------------

function cacheDir() {
  return path.resolve(process.cwd(), '.armada', 'foghorn', 'cache');
}
function ensureDir(d) {
  if (!existsSync(d)) mkdirSync(d, { recursive: true });
}
function clipHash(provider, voice, text) {
  return createHash('sha256').update(`${provider || 'local'} ${voice} ${text}`).digest('hex').slice(0, 16);
}

function resolveExe(name) {
  const isWin = os.platform() === 'win32';
  const r = isWin
    ? spawnSync('where', [name], { encoding: 'utf8' })
    : spawnSync('sh', ['-c', `command -v "${name}"`], { encoding: 'utf8' });
  if (r.status === 0 && r.stdout && r.stdout.trim()) return r.stdout.trim().split(/\r?\n/)[0].trim();
  return null;
}

// --------------------------------------------------------------------------
// Synthesis: cloud provider (when keyed) -> cached audio file; else null and the
// caller uses the local OS voice path (which speaks directly, no file).
// --------------------------------------------------------------------------

async function synthesizeCloud(tts, text, args) {
  const hash = clipHash(tts.provider, tts.voice, text);
  const file = path.join(cacheDir(), `${hash}.mp3`);
  if (!args.noCache && existsSync(file)) return { file, cached: true };
  ensureDir(cacheDir());
  try {
    if (tts.provider === 'elevenlabs') {
      const voiceId = tts.voice && tts.voice !== 'default' ? tts.voice : '21m00Tcm4TlvDq8ikWAM';
      const res = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${voiceId}`, {
        method: 'POST',
        headers: { 'xi-api-key': tts.key, 'content-type': 'application/json', accept: 'audio/mpeg' },
        body: JSON.stringify({ text, model_id: 'eleven_turbo_v2' }),
      });
      if (!res.ok) throw new Error(`elevenlabs ${res.status}`);
      writeFileSync(file, Buffer.from(await res.arrayBuffer()));
      return { file, cached: false };
    }
    if (tts.provider === 'openai') {
      const res = await fetch('https://api.openai.com/v1/audio/speech', {
        method: 'POST',
        headers: { authorization: `Bearer ${tts.key}`, 'content-type': 'application/json' },
        body: JSON.stringify({ model: 'gpt-4o-mini-tts', voice: tts.voice === 'default' ? 'onyx' : tts.voice, input: text }),
      });
      if (!res.ok) throw new Error(`openai ${res.status}`);
      writeFileSync(file, Buffer.from(await res.arrayBuffer()));
      return { file, cached: false };
    }
    // Unknown provider adapter: signal local fallback rather than failing.
    return { file: null, reason: `no adapter for provider '${tts.provider}'` };
  } catch (e) {
    // Cloud synth failed (network/key/quota): degrade to the local voice.
    return { file: null, reason: e.message };
  }
}

// Play a synthesised audio file with a host-appropriate, fire-and-forget player.
// Returns true if a player was launched, false if none is available.
function playFile(file) {
  const plat = os.platform();
  let cmd = null;
  let cmdArgs = [];
  if (plat === 'win32') {
    // Play mp3 via System.Windows.Media.MediaPlayer (PresentationCore, in-box).
    // BOUNDED by design: we open the clip, wait briefly for its NaturalDuration,
    // then sleep for that length (plus a short tail) clamped to a HARD CAP — so
    // the player can NEVER busy-wait forever the way the old WMPlayer.OCX
    // `while ($p.playState -ne 1)` loop could when WMP never raised Stopped.
    cmd = 'powershell';
    cmdArgs = ['-NoProfile', '-Command', windowsPlayScript(file)];
  } else if (plat === 'darwin') {
    cmd = resolveExe('afplay');
    cmdArgs = [file];
  } else {
    cmd = resolveExe('paplay') || resolveExe('aplay') || resolveExe('ffplay') || resolveExe('mpg123');
    if (cmd && /ffplay/.test(cmd)) cmdArgs = ['-nodisp', '-autoexit', '-loglevel', 'quiet', file];
    else cmdArgs = [file];
  }
  if (!cmd) return false;
  try {
    // Fire-and-forget on EVERY platform: detach + unref so the parent process
    // (foghorn-say, possibly a crows-nest bellCommand) returns promptly and is
    // never held open by the player child — satisfies the §8e "never stall a
    // tick" contract even if audio can't actually play.
    const p = spawn(cmd, cmdArgs, { stdio: 'ignore', detached: true, windowsHide: true });
    p.unref();
    p.on('error', () => {});
    return true;
  } catch {
    return false;
  }
}

// Hard upper bound (seconds) on how long the Windows player may run. Backstops
// any clip: even if NaturalDuration never resolves, the player self-terminates
// by this cap, so it can never spin indefinitely.
const WIN_PLAY_CAP_SECONDS = 30;

// Build the bounded PowerShell one-liner that plays `file` via MediaPlayer.
// Single-quoted PS literal: escape embedded quotes by doubling them.
function windowsPlayScript(file) {
  const psFile = file.replace(/'/g, "''");
  return [
    'Add-Type -AssemblyName PresentationCore;',
    '$p = New-Object System.Windows.Media.MediaPlayer;',
    `$p.Open([uri]'${psFile}');`,
    // Wait up to ~2s (20 * 100ms) for the media to open and expose its duration.
    '$dur = $null;',
    'for ($i = 0; $i -lt 20; $i++) {',
    '  if ($p.NaturalDuration.HasTimeSpan) { $dur = $p.NaturalDuration.TimeSpan; break }',
    '  Start-Sleep -Milliseconds 100',
    '};',
    '$p.Play();',
    // Bounded wait: clip length + 0.5s tail, clamped to the hard cap. If the
    // duration never resolved, fall back to the cap so we still exit.
    `$cap = ${WIN_PLAY_CAP_SECONDS};`,
    'if ($dur) { $wait = [Math]::Min($dur.TotalSeconds + 0.5, $cap) } else { $wait = $cap };',
    'Start-Sleep -Seconds $wait;',
    '$p.Stop(); $p.Close()',
  ].join(' ');
}

// Speak with the FREE LOCAL OS voice (no cloud key). Windows SAPI/System.Speech,
// macOS `say`, Linux `espeak`. Returns true if an engine spoke, false otherwise.
function speakLocal(text, voice) {
  const plat = os.platform();
  const safe = text.replace(/[`$]/g, ' ');
  try {
    if (plat === 'win32') {
      const ps = `Add-Type -AssemblyName System.Speech; $s=New-Object System.Speech.Synthesis.SpeechSynthesizer; ` +
        (voice && voice !== 'default' ? `try{$s.SelectVoice('${voice.replace(/'/g, "''")}')}catch{}; ` : '') +
        `$s.Speak('${safe.replace(/'/g, "''")}')`;
      const p = spawn('powershell', ['-NoProfile', '-Command', ps], { stdio: 'ignore' });
      p.on('error', () => {});
      return true;
    }
    if (plat === 'darwin') {
      if (!resolveExe('say')) return false;
      const a = voice && voice !== 'default' ? ['-v', voice, safe] : [safe];
      const p = spawn('say', a, { stdio: 'ignore', detached: true });
      p.unref();
      p.on('error', () => {});
      return true;
    }
    // linux / other
    const espeak = resolveExe('espeak-ng') || resolveExe('espeak');
    if (!espeak) return false;
    const p = spawn(espeak, [safe], { stdio: 'ignore', detached: true });
    p.unref();
    p.on('error', () => {});
    return true;
  } catch {
    return false;
  }
}

// --------------------------------------------------------------------------
// Speak orchestration: cloud (cached file -> player) -> local OS voice ->
// print-only. Always resolves; never throws. Returns the path taken.
// --------------------------------------------------------------------------

async function speak(text, args, cfg) {
  if (args.printOnly) {
    process.stdout.write(`foghorn: ${text}\n`);
    return 'print';
  }
  const tts = ttsProviderConfig(args, cfg);
  // 1) Cloud provider with a key -> synth (hash-cached) + play.
  if (tts.provider && tts.key) {
    const synth = await synthesizeCloud(tts, text, args);
    if (synth.file && playFile(synth.file)) {
      return synth.cached ? 'cloud-cached' : 'cloud';
    }
    // fall through to local on synth/play failure
  }
  // 2) Free local OS voice.
  if (speakLocal(text, tts.voice)) return 'local';
  // 3) No audio engine at all -> PRINT the line (never error).
  process.stdout.write(`foghorn: ${text}\n`);
  return 'print';
}

// --------------------------------------------------------------------------
// Bell context from ARMADA_BELL_* env (the crows-nest §8e hook contract),
// overridable by flags for testing.
// --------------------------------------------------------------------------

function bellContext(args) {
  const positional = args._.length ? args._.join(' ') : '';
  return {
    event: (args.event || process.env.ARMADA_BELL_EVENT || '').toLowerCase(),
    number: args.number || process.env.ARMADA_BELL_NUMBER || '',
    reason: args.reason || process.env.ARMADA_BELL_REASON || '',
    message: process.env.ARMADA_BELL_MESSAGE || positional || '',
  };
}

// --------------------------------------------------------------------------
// --check (doctor): print what foghorn RESOLVED and synthesise/play NOTHING.
// Answers "why isn't it using my voice?" in one command — the masked key tells
// you the key is seen without ever printing its value.
// --------------------------------------------------------------------------

// Mask a secret: never print the value. Show only that it is present and a
// short, non-reversible hint (first 2 + last 2 chars for a long-enough key).
function maskKey(key) {
  if (!key) return null;
  const k = String(key);
  if (k.length <= 6) return '*'.repeat(k.length);
  return `${k.slice(0, 2)}…${k.slice(-2)} (${k.length} chars)`;
}

// Report which host audio player WOULD be chosen for a cloud clip, without
// launching it. Mirrors playFile()'s selection logic (read-only).
function chosenPlayer() {
  const plat = os.platform();
  if (plat === 'win32') return 'powershell System.Windows.Media.MediaPlayer';
  if (plat === 'darwin') return resolveExe('afplay') ? 'afplay' : 'none (afplay not found)';
  const p = resolveExe('paplay') || resolveExe('aplay') || resolveExe('ffplay') || resolveExe('mpg123');
  return p || 'none (paplay/aplay/ffplay/mpg123 not found)';
}

// Report the local OS voice engine that WOULD speak when no cloud key is set.
function chosenLocalVoice() {
  const plat = os.platform();
  if (plat === 'win32') return 'Windows System.Speech (SAPI)';
  if (plat === 'darwin') return resolveExe('say') ? 'macOS say' : 'none (say not found)';
  const e = resolveExe('espeak-ng') || resolveExe('espeak');
  return e ? `${e}` : 'none (espeak/espeak-ng not found)';
}

function runCheck(args, cfg, env) {
  const tts = ttsProviderConfig(args, cfg);
  const flavour = resolveFlavour(args, cfg);
  const verbosity = resolveVerbosity(args, cfg);
  const gate = resolveGate(cfg);
  const usingCloud = !!(tts.provider && tts.key);

  const report = {
    mode: 'check',
    resolved: {
      provider: tts.provider || '(none — free local OS voice)',
      // Source labels reflect what ACTUALLY resolved (trimmed, non-empty),
      // not the raw flag — so a blank `--provider "  "` that fell back to
      // env/config/local is reported as such, not as '--provider'.
      providerSource: resolveProvider(args, cfg).source,
      voice: tts.voice,
      voiceSource: resolveVoice(args, cfg).source,
      keyVar: tts.keyVar || null,
      keyPresent: !!tts.key,
      keyMasked: maskKey(tts.key),
      flavour,
      register: flavourRegister(flavour),
      verbosity,
      gate,
    },
    willUse: usingCloud
      ? `cloud voice (${tts.provider})`
      : tts.provider
        ? `local OS voice — provider '${tts.provider}' set but key ${tts.keyVar} is MISSING`
        : 'free local OS voice (no provider configured)',
    cacheDir: cacheDir(),
    player: usingCloud ? chosenPlayer() : `local voice: ${chosenLocalVoice()}`,
    envFilesLoaded: env.files.map((f) => ({ path: f.path, setKeys: f.keys })),
  };
  process.stdout.write(JSON.stringify(report, null, 2) + '\n');
  // Doctor synthesises/plays NOTHING.
}

// --------------------------------------------------------------------------
// main
// --------------------------------------------------------------------------

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    process.stdout.write(HELP);
    return;
  }
  const cfg = readConfig();
  // Load the repo-local .env BEFORE resolving anything — so a key (or any
  // FOGHORN_*) supplied via .armada/foghorn/.env or repo-root .env is in
  // process.env for provider/voice/key resolution, without depending on OS env
  // propagation. Already-set (real OS) env always wins over the file.
  const env = loadLocalEnv();
  const flavour = resolveFlavour(args, cfg);
  const verbosity = resolveVerbosity(args, cfg);

  // --check: doctor mode — print what foghorn resolved; synthesise/play nothing.
  if (args.check) {
    runCheck(args, cfg, env);
    return;
  }

  // --line: an explicit, already-composed line (agent-driven modes).
  if (args.line) {
    await speak(args.line, args, cfg);
    return;
  }

  // --status: on-demand spoken fleet status from a read-only snapshot.
  if (args.status) {
    const { state, source } = findFleetState(args.state);
    let line;
    if (state) {
      line = composeStatus(state, flavour);
    } else {
      line = flavourRegister(flavour) === 'nautical'
        ? 'Harbour report: no fresh snapshot to hand — run spyglass for a reading.'
        : 'Fleet status: no snapshot available.';
    }
    if (source) process.stderr.write(`foghorn: status from ${source}\n`);
    await speak(line, args, cfg);
    return;
  }

  // Default: bell mode — read ARMADA_BELL_* and compose a templated line.
  const ctx = bellContext(args);
  if (!ctx.event && !ctx.message) {
    process.stderr.write('foghorn: no ARMADA_BELL_* context and no --line/--status; nothing to say.\n');
    return; // exit 0 — silence is not an error
  }

  // notify-style gate: keep routine events quiet by default.
  const gate = resolveGate(cfg);
  if (ctx.event && !gateAdmits(gate, ctx.event)) {
    process.stderr.write(`foghorn: gate '${gate}' suppressed routine event '${ctx.event}'.\n`);
    return; // quiet by design
  }

  const line = composeBell(ctx, flavour, verbosity);

  if (args.selfTest) {
    // Compose + warm the cache (when keyed) without touching the audio device.
    const tts = ttsProviderConfig(args, cfg);
    const report = { mode: 'bell', register: flavourRegister(flavour), verbosity, gate, line };
    if (tts.provider && tts.key) report.cacheHash = clipHash(tts.provider, tts.voice, line);
    process.stdout.write(JSON.stringify(report, null, 2) + '\n');
    return;
  }

  await speak(line, args, cfg);
}

// Top-level: NEVER fail. foghorn is a best-effort side-channel narrator — a
// missing voice must never fail a crows-nest tick. Swallow, log once, exit 0.
main().catch((e) => {
  process.stderr.write(`foghorn: ${e.message} — degraded (ignored)\n`);
  process.exit(0);
});
