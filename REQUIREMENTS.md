# ⚓ ARMADA — external requirements & dependencies

ARMADA is **stack-agnostic and degrades gracefully**: only a couple of tools are truly required, and
every optional one has a documented alternative and a defined behaviour when it's absent. This page is
the single reference for **what the fleet uses, why, whether it's required or optional, how to provide
it, and what happens without it** — so you can set up exactly as much as you need.

Two rails run through the whole table:

- **Secrets stay in the environment, never in config.** Any API key is read from the environment (or a
  gitignored repo-local `.env`) only — never `.armada/config.json`, never committed. The *non-secret*
  provider/voice selections live in config; the key never does.
- **Optional means it degrades, not fails.** When an optional tool is missing, the feature that wants it
  takes its named fallback and **says so** — it never silently produces a wrong or empty result, and it
  never blocks the fleet's core build/review/merge flow.

## At a glance

| Tool | Status | Used by | Without it |
| ---- | ------ | ------- | ---------- |
| **`gh`** (GitHub CLI) | **Required** | every skill | ARMADA can't read or move fleet state — nothing works |
| **Node.js** | **Required** | every bundled `scripts/*.mjs` | the pipeline, bell, logbook, spyglass can't run |
| **git** | **Required** | [`shipwright`](skills/shipwright/SKILL.md), [`crows-nest`](skills/crows-nest/SKILL.md) | no isolated worktrees; no build/merge flow |
| **ElevenLabs** (or any TTS) | Optional | [`logbook`](skills/logbook/SKILL.md), [`foghorn`](skills/foghorn/SKILL.md) | silent captions / free local OS voice |
| **Codex** (`codex:codex-rescue`) | Optional | [`muster`](skills/muster/SKILL.md) | single-lens review; merge-gate degrade is `autoMerge`-conditional |
| **`ffmpeg`** | Required **for logbook** | [`logbook`](skills/logbook/SKILL.md) | no muxed video — silent storyboard; rest of fleet unaffected |
| **Playwright + a browser** | Optional **for logbook** | [`logbook`](skills/logbook/SKILL.md), spyglass sea-trial | captioned-stills storyboard instead of motion |

---

## Required

### `gh` — the GitHub CLI

- **What it's for.** ARMADA's entire world is the GitHub issue/PR **label state machine**. Every skill
  reads and writes fleet state through `gh` (and its `gh api`): [`crows-nest`](skills/crows-nest/SKILL.md)
  scans issues/PRs, [`shipwright`](skills/shipwright/SKILL.md) opens PRs, [`muster`](skills/muster/SKILL.md)
  posts reviews, [`spyglass`](skills/spyglass/SKILL.md) snapshots state (read-only), and
  [`commission`](skills/commission/SKILL.md) creates the labels.
- **How to provide it.** Install the GitHub CLI and authenticate: `gh auth login` (commission runs
  `gh auth status` as a preflight). It must be logged in to an account with access to the repo.
- **Alternative.** None — GitHub is the source of truth ARMADA is built on.
- **Without it.** The fleet cannot function. `commission` stops and tells you to run `gh auth login`;
  read-only views like spyglass **degrade to an empty sea** with the reason noted rather than crashing,
  but no work can be dispatched, reviewed, or merged.

### Node.js — the bundled script runtime

- **What it's for.** Every bundled script under `scripts/*.mjs` is Node (ES modules, **dependency-free** —
  Node built-ins + `gh`/`git` only): the crows-nest review/merge pipeline (`review-merge-pipeline.mjs`,
  `merge-gate.mjs`), the [`foghorn`](skills/foghorn/SKILL.md) bell (`foghorn-say.mjs`), the
  [`logbook`](skills/logbook/SKILL.md) recorder (`logbook-recorder.mjs`), and the
  [`spyglass`](skills/spyglass/SKILL.md) snapshots (`spyglass-snapshot.mjs`, `spyglass-run-snapshot.mjs`)
  and their built-in localhost server.
- **How to provide it.** A current Node LTS on `PATH`. No `npm install` step — the scripts pull in **no
  external packages**, matching `scripts/validate-skills.mjs`.
- **Alternative.** None — the scripts are the fleet's machinery.
- **Without it.** Any skill that shells out to a bundled script can't run its automated step (the pipeline,
  the bell, logbook, spyglass). The skills that are pure prompt-flow still work, but the fleet's
  automation does not.

### git — isolated worktrees and the build flow

- **What it's for.** [`shipwright`](skills/shipwright/SKILL.md) builds each issue in an **isolated git
  worktree** and pushes a branch; [`crows-nest`](skills/crows-nest/SKILL.md) drives the branch through
  review→merge; spyglass reads `git worktree list` (read-only) to resolve a run's on-disk path.
- **How to provide it.** A standard git install with a configured GitHub remote (commission checks
  `git rev-parse --is-inside-work-tree` and that a remote exists).
- **Alternative.** None — ARMADA works on git repositories.
- **Without it.** There's no repo to build in; commissioning stops with a clear message.

---

## Optional (documented fallbacks)

### ElevenLabs (or any TTS provider) — spoken narration

- **What it's for.** The **voice** of the fleet. [`logbook`](skills/logbook/SKILL.md) narrates its
  walkthrough videos and [`foghorn`](skills/foghorn/SKILL.md) speaks fleet activity aloud, both through
  the same **provider-pluggable, env-keyed, hash-cached** TTS pipeline. ElevenLabs is the bundled adapter.
- **How to provide it.** Choose a **non-secret** provider/voice in config
  ([`foghorn.provider` / `foghorn.voice`](skills/commission/SKILL.md), e.g. `"elevenlabs"` / `"openai"`),
  and supply that provider's **secret key via the environment only** — `ELEVENLABS_API_KEY`,
  `OPENAI_API_KEY`, … — or a gitignored repo-local `.env` (`.armada/foghorn/.env`). The key is **never**
  written to config or committed. Resolution precedence: `--flag` > env > `foghorn.*` config > default.
- **Alternatives, in order of fidelity.**
  1. **Another cloud TTS** — e.g. OpenAI TTS — same pipeline, a different provider/key.
  2. **The free local OS voice** — Windows `System.Speech`/SAPI, macOS `say`, Linux `espeak`/`espeak-ng`
     — no key, no cost. This is foghorn's default when no provider/key is set.
  3. **Silent burned-in captions** — logbook's fallback: on-screen chapter text instead of narration.
- **Without it.** Nothing breaks. foghorn falls back to the local OS voice, and if even that is absent it
  **prints the line and exits 0** — a missing voice never fails a tick. logbook falls back to **silent
  captions** and **names the degrade** in its report. Narration is an enhancement, never a gate.

### Codex (`codex:codex-rescue`) — muster's second review lens

- **What it's for.** [`muster`](skills/muster/SKILL.md) reviews a PR through **two independent lenses in
  parallel**: a conventions/correctness `code-review` pass (Lens A) and a **`codex:codex-rescue`
  root-cause second opinion** (Lens B). The second lens catches issues the first rationalises away.
- **How to provide it.** Have the Codex CLI / `codex:codex-rescue` agent available (see the Codex plugin's
  `/codex:setup`). Then muster fans out both lenses.
- **Alternative.** The **single-lens `code-review` pass** on its own — a degraded but still-useful review.
- **Without it.** muster runs the one lens it can and returns `degraded: true` with the missing lens
  **named** in the summary — never a silent single-lens read presented as a full review. How the **merge
  gate** reacts is **conditional on [`autoMerge`](skills/crows-nest/SKILL.md)** (`scripts/merge-gate.mjs`
  gate 2, issue #99): under `autoMerge: true` a degrade **hard-blocks** (an unattended merge on a
  half-reviewed PR stays unsafe); under `autoMerge: false` a degraded-but-clean review resolves to
  **`ready_awaiting_human`** with the degrade named, so a person makes the merge call. Either way, no
  autonomous merge ever lands on a single-lens read.

### `ffmpeg` — audio/video muxing (required *for logbook*)

- **What it's for.** [`logbook`](skills/logbook/SKILL.md) uses `ffmpeg` to mux narration + captured video,
  concatenate chapters, and burn in titles/lower-thirds into the single walkthrough video.
- **How to provide it.** **Auto-provisioned by `logbook --setup`**: the recorder's preflight is
  arch-aware and drops a host-matched static `ffmpeg` into `.armada/logbook/bin/` (or prints the exact
  per-platform install command — e.g. `brew install ffmpeg` on macOS — when no static build exists for
  the arch). No manual global install needed in the common case.
- **Alternative.** None for producing a real video — but its absence degrades logbook rather than
  blocking it.
- **Without it.** logbook **degrades to a silent storyboard** (captured stills, no muxed video) and names
  the degrade. It is **required only within logbook** — the rest of the fleet (build, review, merge,
  spyglass, foghorn) is entirely unaffected, and logbook itself is gated off by default
  ([`logbook` config key](skills/commission/SKILL.md), default `"off"`).

### Playwright + a browser — motion capture (optional *for logbook*)

- **What it's for.** For a **web** walkthrough, [`logbook`](skills/logbook/SKILL.md) drives the page with
  Playwright and captures the viewport as **live motion**. The [`spyglass`](skills/spyglass/SKILL.md)
  dev-only sea-trial harness also uses it for visual-regression PNGs.
- **How to provide it.** A Playwright install (resolved even **outside the repo** — a global/scratch
  install). It does **not** require Playwright's own bundled Chromium: a host with a **system browser**
  (Edge/Chrome) records live motion too — point it at a specific browser via `executablePath` / `channel`
  (issue #103). `logbook --setup` verifies the capture backend.
- **Alternatives.**
  1. **A system browser via `executablePath` / `channel`** — no Playwright-Chromium download needed (#103).
  2. **A captioned-stills storyboard** — the non-motion fallback: screenshots with chapter captions.
- **Without it.** logbook downgrades from motion to a **captioned-stills storyboard** and names the
  degrade; if `ffmpeg` is also missing it becomes a silent storyboard. Nothing outside logbook depends on
  Playwright.

---

## Notes on the spyglass dashboard's local server

[`spyglass`](skills/spyglass/SKILL.md)'s dashboards fetch their snapshot (`./run-state.json` /
`./fleet-state.json`) to auto-refresh, which browsers **block under a `file://` origin**. So on `--open`
the driver serves its scratch output dir over a **minimal localhost http server** (Node's built-in
`http`, bound to `127.0.0.1` on an ephemeral port, GET-only, contained to that dir) and opens that URL —
**no extra dependency**, and the read-only guarantee is unchanged (it serves only files it already wrote).
See spyglass §1a. This is why the dashboard renders live instead of hanging on "waiting for
run-state.json …".

## Notes on the quartermaster cost governor

[`quartermaster`](skills/quartermaster/SKILL.md) governs the fleet's spend against optional
`budget.perRunUSD` / `budget.perDayUSD` keys in `.armada/config.json` (both absent = ungoverned, the
default). It needs **no extra tooling** — it reads the same read-only cost signals spyglass consumes
(`out/costs/<run>.json`, written by the cost-postmortem producer when crows-nest's `costs` key is on,
the default). It never fetches or writes anything, and **degrades open**: no budget → allow; no cost
data → allow + warn — so a budget can never block the fleet on missing data. crows-nest consults
`quartermaster check` before dispatching new builds.

## See also

- [`commission`](skills/commission/SKILL.md) — writes `.armada/config.json`, including the non-secret
  `foghorn.provider`/`foghorn.voice`, the `logbook`, `spyglass`, and `budget` keys.
- [Per-repo configuration](README.md#per-repo-configuration) — the full config shape and every key.
- [Safety](README.md#safety) — the `autoMerge` gate the Codex degrade is conditional on.
