---
name: foghorn
description: >
  The ARMADA foghorn — the fleet's voice. It SPEAKS fleet activity aloud through a pluggable,
  env-keyed, hash-cached TTS pipeline (the same one logbook uses), booming across the water so you
  HEAR what the fleet is doing without watching labels or the loop. It's a narrator — READ-ONLY
  w.r.t. the fleet: it never claims, merges, or relabels. Four voices: a headless bell-hook
  narration designed to be crows-nest's bellCommand (speaks shipped/blocked/awaiting from the
  ARMADA_BELL_* context, no LLM required); live tick commentary alongside a /loop watch; an
  on-demand spoken fleet status (an audible spyglass, reusing the read-only gh snapshot); and a
  short free-text flavour prompt that steers the tone, defaulting to a gruff, proud nautical
  harbourmaster. Verbosity controls length and a notify-style gate keeps routine ticks quiet. With
  no audio engine it degrades to printing the line — it never errors. Trigger when the user says
  "speak the fleet", "narrate the fleet aloud", "say the fleet status", "turn on the foghorn", "read
  the fleet out loud", "wire the spoken bell", or invokes /foghorn. Supersedes the broken fanfare
  hook. Accepts an optional line, a --flavour, or --status.
argument-hint: "[--status | --line \"...\"] [--flavour \"...\"] [--verbosity terse|normal|rich]"
allowed-tools: Bash, Read, Grep, Glob, Skill
---

# foghorn — speak the fleet's activity aloud

`foghorn` is ARMADA's **voice**. The fleet runs unattended and its whole world is normally either
silent or a focus-suppressed desktop ping — and the old local `fanfare.ps1` hook turned out to be
broken (it built a *silent* WAV). `foghorn` replaces it with the real thing: it **composes a short
spoken sentence and synthesises + plays it aloud**, so a merge, a block, or a green PR awaiting your
word is something you **hear**, focus or not. It is a **narrator** — [`read-only`](../crows-nest/SKILL.md)
w.r.t. the fleet: it never claims, merges, relabels, or comments. It only *says* what already
happened.

It slots into rails that **already exist** and reuses them rather than reinventing:

- [`logbook`](../logbook/SKILL.md)'s **provider-pluggable, env-keyed, hash-cached TTS** pipeline
  (see [its recorder contract](../logbook/references/recorder.md)) — a configured cloud voice when a
  key is present, the **free local OS voice** otherwise.
- [`crows-nest`](../crows-nest/SKILL.md)'s **`bellCommand` hook (§8e)** — the focus-independent local
  command the ship's bell runs at every terminal reconcile, with the `ARMADA_BELL_*` event context
  exported. `foghorn` is the spoken thing you point that hook at.

> **The workhorse is bundled.** All synthesis/playback/composition is done by
> `${CLAUDE_PLUGIN_ROOT}/scripts/foghorn-say.mjs` — reference it via `${CLAUDE_PLUGIN_ROOT}`, never a
> relative path (installed plugins are copied into a cache and relative paths break there). The
> script is **dependency-free at load** (Node built-ins only) so it runs in this no-`package.json`
> repo and in any installed-plugin cache.

## 0. Discover the project

Read `.armada/config.json` → `foghorn.*` (flavour / verbosity / gate) and `baseBranch`. If the file
is absent the repo isn't commissioned — run [`commission`](../commission/SKILL.md) first (it writes
the default `foghorn` keys). `foghorn` works with **zero config** — every key has a default — so a
missing block just means defaults apply.

## 1. The voice engine — pluggable, env-keyed, with a free local fallback

`foghorn` does **not** ship a TTS vendor or assume one. The bundled script selects the engine the
same way logbook does:

- **Cloud voice when keyed.** Set `FOGHORN_TTS_PROVIDER` (e.g. `elevenlabs`, `openai`) and that
  provider's key in the **environment** (`ELEVENLABS_API_KEY`, `OPENAI_API_KEY`, …). Keys are read
  **from env only — never committed, never passed as flags**.
- **Free local OS voice otherwise.** With no provider/key set it falls back to the host's built-in
  voice — **Windows** `System.Speech`/SAPI, **macOS** `say`, **Linux** `espeak`/`espeak-ng` — so it
  speaks out of the box with zero setup and zero cost.
- **Print fallback, never an error.** If there's no audio device or engine at all (headless CI, no
  speaker, no `espeak`), it **prints the line and exits 0**. A missing voice must never fail a tick.

**Hash-cached clips.** Each synthesised clip is keyed by a content hash of **(text + voice +
provider)** and cached under the **gitignored** scratch dir `.armada/foghorn/cache/`. A repeated
phrase ("merged and made fast") is served from cache — no re-synthesis, no latency, no cloud cost.
The local OS voice speaks directly and needs no cache.

## 2. The flavour prompt — tone, with a nautical default

A short, free-text **flavour** steers the *tone and wording* of what foghorn speaks. Set it three
ways (first wins): a `--flavour "..."` arg, the `FOGHORN_FLAVOUR` env var, or the `foghorn.flavour`
config key. **Unset, it defaults to a gruff, proud nautical harbourmaster** calling the fleet's
comings and goings — so it sounds right out of the box.

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/foghorn-say.mjs" --line "..." --flavour "an excitable sports commentator"
# other tastes: "a theatrical pirate"  ·  "a stoic ship's captain"  ·  "BBC shipping forecast, deadpan"
```

The flavour applies in **both** worlds:

- **Agent-driven modes** (live commentary §4, on-demand status §5) — the model composes the spoken
  line *per the flavour* and hands the finished sentence to the script via `--line`.
- **The headless `bellCommand` path** (§3) — there is **no LLM in the loop**, so the flavour selects
  a **templated phrasing register** inside the script (it keyword-sniffs the flavour to a nautical /
  pirate / sports / stoic / terse register). The bell hook therefore **never depends on an LLM being
  available** — it speaks a flavoured line entirely offline.

**Verbosity** (`--verbosity terse|normal|rich`, or `foghorn.verbosity`) controls length: one clause
vs. a sentence vs. a sentence with a flourish. A **notify-style gate** (`foghorn.gate`, or
`FOGHORN_GATE`: `off | blocked | terminal | all`, default `terminal`) keeps **routine events quiet** —
the consequential `shipped`/`blocked` speak; the routine `opened`/`awaiting` stay silent unless you
turn the gate up.

## 3. Function 1 — the bell hook (headless, LLM-free): wire it as `bellCommand`

This is the spoken replacement for the broken `fanfare.ps1`. crows-nest's bell runs its
`bellCommand` at every terminal reconcile (§8e) with the event context exported as
`ARMADA_BELL_EVENT` / `ARMADA_BELL_NUMBER` / `ARMADA_BELL_REASON` / `ARMADA_BELL_MESSAGE`. Point that
hook at `foghorn-say.mjs` and **every merge / block / awaiting is spoken**, focus or not:

```jsonc
// .armada/config.json — the one-line bellCommand to wire foghorn as the spoken bell:
"bellCommand": "node \"${CLAUDE_PLUGIN_ROOT}/scripts/foghorn-say.mjs\""
```

In bell mode the script reads the `ARMADA_BELL_*` env itself, composes a flavoured, templated line
(no `--line` needed, no LLM), applies the gate, and speaks it. It is held to the **identical
ship's-bell discipline as the hook** (crows-nest §8c/§8e), and the script enforces that on its own
side:

- **After the action, side-channel.** crows-nest only runs `bellCommand` after the consequential work
  (the label swap, the comment, the merge) has landed — foghorn just narrates it.
- **Best-effort, swallow + log once.** Any synth/playback failure degrades to printing the line and
  exits 0 — it **never** fails the tick. (The script's top-level catch guarantees exit 0.)
- **Bounded / fire-and-forget.** Playback is launched detached (or a short, self-terminating player)
  so a long utterance can never stall a tick. crows-nest does not wait on it.
- **Quiet by default.** The gate suppresses routine `opened`/`awaiting`; only `shipped`/`blocked`
  speak unless `foghorn.gate` is raised.

Test the wiring without crows-nest by exporting the same env the hook would:

```bash
ARMADA_BELL_EVENT=shipped ARMADA_BELL_NUMBER=17 \
  node "${CLAUDE_PLUGIN_ROOT}/scripts/foghorn-say.mjs"
# add --self-test to see the composed line + cache key without touching the speaker.
```

## 4. Function 2 — live tick commentary alongside a `/loop` watch

Run foghorn as the **commentator** for a running [`crows-nest`](../crows-nest/SKILL.md) watch: as
each scheduler tick reports what it dispatched / held and why, compose a one-line call *per the
flavour* and speak it — *"dispatching #142, holding #143, waiting on #142."* Because a tick line is
already in the agent's context, **you (the model) compose the flavoured line** and hand it to the
script:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/foghorn-say.mjs" --line "Dispatching one-four-two; holding one-four-three, waiting on one-four-two."
```

Keep it to **state changes**, not every poll — the same quiet-by-default instinct as the gate, so a
watch that ticks every 5 minutes doesn't drone. Pair it with the loop, e.g. `/loop 5m` driving the
watch with a foghorn line on each non-empty tick.

## 5. Function 3 — on-demand spoken fleet status (`/foghorn`)

`/foghorn --status` is an **audible spyglass**: it speaks the current fleet state. It reuses the same
**read-only** snapshot — if [`spyglass`](../spyglass/SKILL.md) has written a `fleet-state.json`
(under `.armada/spyglass/` or passed via `--state`), foghorn reads it; otherwise take your own
read-only `gh` snapshot and hand the composed line to `--line`:

```bash
# Reuse spyglass's snapshot if present (degrades to a "run spyglass" line if not):
node "${CLAUDE_PLUGIN_ROOT}/scripts/foghorn-say.mjs" --status --flavour "$FLAVOUR"

# Or compose from your own gh read and speak it explicitly:
node "${CLAUDE_PLUGIN_ROOT}/scripts/foghorn-say.mjs" --line "Harbour report: three issues underway, one PR green and awaiting your word, none fouled."
```

The status readout never mutates anything — it is a *spoken view*, exactly like spyglass is a
*rendered view*.

## 6. Run it

For the agent-driven modes (§4/§5) you compose the line and call `--line`. For a quick spoken status,
`--status`. For the bell, you don't run it — you **wire it** (§3) and crows-nest runs it. Useful
flags: `--flavour`, `--verbosity terse|normal|rich`, `--print-only` (compose + print, no audio),
`--self-test` (compose + cache key, no audio), `--no-cache`. The script prints `--help` for the full
surface.

## 7. Discipline — best-effort, side-channel, never fatal

foghorn obeys the **same ship's-bell contract** as the bell it rides (crows-nest §8c): it runs
**after** the consequential action, as a **side-channel courtesy**; it **swallows failures** (logged
once) and degrades to printing; it is **bounded / fire-and-forget** so an utterance can't stall a
tick; and it is **quiet by default** for routine events. It is **read-only w.r.t. the fleet** — an
additional alert channel like the bell, never a controller, and never a replacement for
`PushNotification` (it's an *extra* voice, the same way `bellCommand` is).

## Inputs

- Optional `--line "<text>"` (an already-composed line), `--status` (spoken fleet readout), or — in
  the bell path — the `ARMADA_BELL_*` env crows-nest exports.
- Optional `--flavour "..."` / `--verbosity terse|normal|rich` (or the `foghorn.flavour` /
  `foghorn.verbosity` / `foghorn.gate` config keys, or `FOGHORN_*` env).
- TTS provider + key **from the environment only** (`FOGHORN_TTS_PROVIDER` + `<PROVIDER>_API_KEY`) —
  optional; falls back to the free local OS voice, then to printing.

## Output

- The composed line **spoken aloud** via a cloud voice (when keyed) or the free local OS voice — or,
  with no audio engine, **printed** (exit 0, never an error).
- Hash-cached clips under the **gitignored** `.armada/foghorn/cache/` so repeated phrases don't
  re-synthesise.
- **No fleet mutation** — foghorn only narrates.
