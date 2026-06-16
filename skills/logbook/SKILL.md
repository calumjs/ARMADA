---
name: logbook
description: >
  The ARMADA voyage record. Turns a shipped change into a short, narrated, chaptered walkthrough
  video for stakeholders and attaches it to the PR — stack-agnostic and configured per repo. On
  first use in a repo it establishes a reusable staging recipe (launch / stage / reach) saved under
  .armada/logbook/ and reuses it on later runs; it supports web UIs, CLIs/TUIs, and APIs, launching
  the app via the repo's own `commands.run`. Plans 3-6 product-owner-facing chapters, records and
  narrates them with a provider-pluggable, env-keyed, hash-cached TTS pipeline, muxes to one video,
  uploads it as a per-PR GitHub release asset, and comments the link. Trigger when the user says
  "record a walkthrough", "make a demo video", "record a done video for PR X", "record a
  walkthrough video for the stakeholders", or invokes /logbook. Also the walkthrough shipwright
  offers to hand off to for user-visible features.
argument-hint: "<PR number | feature> [--setup]"
allowed-tools: Bash, Read, Write, Edit, Grep, Glob, Skill
---

# logbook — record a narrated "done" walkthrough video

`logbook` is ARMADA's voyage record: it turns a finished, user-visible change into a short narrated
screen-capture — typically ~2:30, chaptered, with a spoken voice-over aimed at stakeholders — and
attaches it to the PR so reviewers and product owners can **watch** the outcome instead of reading a
diff. It is the skill [`shipwright`](../shipwright/SKILL.md) §9 offers to hand off to once a
user-visible feature is built.

`logbook` is **stack-agnostic and configured per repo.** It assumes nothing about the app — not the
language, not a browser, not a login, not a port, not a sample dataset. The original walkthrough
methodology was wired to one specific app; `logbook` instead **derives a repo-specific staging
recipe once, saves it in the repo, and reuses it** on every later recording. That recipe — *how to
launch this app, how to stage it into a demo-ready state, how to reach the feature* — is the thing
that makes one generic recorder work for a web UI, a CLI, or an API.

> **Two modes.** First use in a repo (or `--setup`) runs **§1 setup** to establish the staging
> recipe, then records. Subsequent runs **reuse** the saved recipe and go straight to **§2 record**.

## 0. Discover the project and run the toolchain preflight

Read `.armada/config.json` → `commands.run` (how this repo starts its app) and `baseBranch`. If the
file is absent the repo isn't commissioned — run [`commission`](../commission/SKILL.md) first (it
detects and writes `commands.run`). `logbook` **launches the app via `commands.run`**, never an
assumed `npm start`/`dotnet run`/etc.

Identify the target PR (the argument, or the current branch's PR via `gh pr view --json number`).
The recording attaches to this PR.

### Toolchain preflight — `--setup`

Before recording, run the **bundled recorder's `--setup` preflight**. It is **arch-aware** and
**self-provisioning**: it detects the host OS + architecture (incl. **win-arm64** and **mac-arm64**),
provisions a static `ffmpeg` matched to that host into `.armada/logbook/bin/` (or prints the exact
per-platform install command when no static build exists for the arch — e.g. `brew install ffmpeg`
on macOS), verifies the capture backend for the recipe's surface (e.g. Playwright Chromium for
`web`), and reports each tool as **ready / degraded / missing**:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/logbook-recorder.mjs" --setup --staging .armada/logbook/staging.json
# add --json for a machine-readable report; --dry-run to preview without downloading
```

The recording toolchain it checks:

- A **capture backend** appropriate to the surface (see §1 *Launch/Reach*): a browser driver for
  web, a terminal recorder for CLI/TUI, a request runner for APIs.
- **`ffmpeg`** — muxes audio + video, concatenates chapters, burns in titles/lower-thirds.
- A **TTS provider** reachable via an **environment variable** (see §3). The preflight doesn't just
  check the key is *present* — it **verifies the key authenticates** and that `LOGBOOK_VOICE` resolves
  to the expected `LOGBOOK_VOICE_NAME`, failing loudly (auth error / wrong voice id / name mismatch)
  rather than silently narrating wrong or silent. No key ⇒ **silent captions** (burned-in chapter
  text and narration as subtitles).

**Graceful degradation is the design, not a failure mode.** Every *optional* tool that's absent
**downgrades** rather than blocking — no browser driver ⇒ captioned stills/storyboard; no `ffmpeg` ⇒
silent storyboard; no TTS key ⇒ captions — and the preflight (and the run) **names** what degraded.
`--setup` exits `0` when everything is ready *or* only-degraded; it exits non-zero only when a truly
required capability is missing. If the script isn't present in this install, perform the same checks
by hand and report what's available the same way (see [references/recorder.md](references/recorder.md)).

## 1. Establish (or load) the repo-specific staging recipe

The staging recipe is saved at **`.armada/logbook/staging.json`** (config) alongside any helper
scripts the repo needs under `.armada/logbook/` (e.g. a seed script, a Playwright stage helper) and
the toolchain `--setup` provisions (a host-matched `ffmpeg` under `.armada/logbook/bin/`, narration
clips under `.armada/logbook/cache/`). **If it already exists, load it and skip to §2** unless
invoked with `--setup` — which **both** re-runs the §0 toolchain preflight *and* re-derives / edits
the recipe. It is **edited, not re-derived** each run — set up once, reused thereafter.

If it doesn't exist, derive it **with the user** (this is the one interactive step; ask, don't
guess) and persist it. The recipe has three parts:

### Launch — how to start the app for recording
Start from `commands.run`. Capture any extra flags, env, a ready-signal to wait for (a URL that
returns 200, a log line, a prompt), and the **surface type**:

- **`web`** — a URL to open and drive with a browser driver (Playwright/Puppeteer).
- **`cli` / `tui`** — a terminal to capture (e.g. `asciinema`/VHS, or xterm.js + Playwright for a
  polished terminal); record the shell/command to run.
- **`api`** — no GUI; drive request→response (curl/httpie/a REST client) and render the
  request/response pairs as the visual.

### Stage — how to get to a demo-ready state
The setup the demo needs before the feature is visible, expressed as **repo-owned, parameterised
steps** — never hardcoded credentials or fixtures baked into this skill:

- Authentication / login flow (read credentials from **env**, e.g. `LOGBOOK_DEMO_USER` /
  `LOGBOOK_DEMO_PASS`; never commit them).
- Seed / reset demo data (point at the repo's own seed/reset command or a helper saved under
  `.armada/logbook/`).
- Any required env vars or feature flags, and the entry **surface** (start URL, CLI command, or base
  API URL).

### Reach — the steps to navigate to the feature under demo
The concrete navigation from the staged state to the feature: clicks/routes for web, commands/keys
for CLI/TUI, the request sequence for API. Keep these as data the recorder replays, so a later run
re-records the same path after an edit.

For `web`, `reach` is not navigation-only — drive **live interactions** so the walkthrough is a
**demo, not a slideshow**: on top of `goto` / `click` / `fill` / `wait`, use `hover`, `dblclick`,
`press` (keyboard — e.g. `Control+k` to open a command palette), `dragdrop` (`target` → `to`), and
`scrollTo`. The whole viewport is captured as **real motion**. A chapter can also carry a **`target`**
(or `targets`/`spotlight`) selector to **spotlight the narrated element** — the recorder dims the
rest, rings the element, and holds it for the length of that beat's narration — and `cursor: true`
to drift a synthetic cursor to it. See [references/recorder.md](references/recorder.md) (*Motion
walkthrough*) for the full beat vocabulary and the spotlight-on-stills degrade.

Persist all three to `.armada/logbook/staging.json`, for example:

```jsonc
{
  "surface": "web",                       // "web" | "cli" | "tui" | "api"
  "recordUrl": "https://<pr-preview-or-live-url>",  // optional: record this (a preview/Vercel
                                          // deployment or live site) instead of the worktree dev
                                          // server, which may never paint (issue #91). Also as env
                                          // LOGBOOK_RECORD_URL. Falls back to stage.entry if blank.
  "launch": {
    "command": "<from commands.run>",     // reuse .armada/config.json commands.run
    "extraFlags": [],
    "readySignal": { "type": "httpUrl", "value": "http://localhost:${PORT}/health" },
    "env": ["PORT"]                        // names only — values come from the environment
  },
  "stage": {
    "auth": { "type": "form", "userEnv": "LOGBOOK_DEMO_USER", "passEnv": "LOGBOOK_DEMO_PASS" },
    "seed": "<repo seed/reset command, or .armada/logbook/seed.*>",
    "entry": "http://localhost:${PORT}/"   // start URL | CLI command | API base
  },
  "cursor": true,                          // optional: drift a synthetic cursor to targets
  "reach": [
    { "action": "goto", "target": "/" },
    { "action": "press", "value": "Control+k" },          // open a command palette
    { "action": "fill", "target": "#cmd-input", "value": "invoice" },
    { "action": "dragdrop", "target": "#card-1", "to": "#column-2" }  // live interaction, as motion
  ]
}
```

A chapter in the plan may carry per-beat **`target`/`targets`/`spotlight`** (the selector(s) to
highlight while it narrates) and **`cursor`**; the `reach` `action`s above are recorded as live
motion. See [references/recorder.md](references/recorder.md) (*Motion walkthrough*) for the full
beat vocabulary.

**Document (re)configuration:** tell the user the recipe lives at `.armada/logbook/staging.json`,
that they can hand-edit it, and that `/logbook --setup` re-runs the toolchain preflight (§0) and
re-derives the recipe interactively. `.armada/` is safe to commit (it's config, not secrets) —
**secrets stay in env and are referenced by name only**, and the provisioned `bin/` (host-matched
`ffmpeg`) and `cache/` (narration clips) are machine-/content-specific, so add them to
`.gitignore` rather than committing them.

### The bundled recorder

Once the recipe and toolchain are in place, the capture → TTS → mux work is performed by the
**bundled recorder** at `${CLAUDE_PLUGIN_ROOT}/scripts/logbook-recorder.mjs`, which implements the
contract in [references/recorder.md](references/recorder.md). It consumes the recipe + chapter plan
as data and produces one muxed video — driving a surface-appropriate capture, synthesising
**env-keyed, hash-cached** TTS (caption fallback when no key), and muxing with `ffmpeg`. It's an
**optional accelerator**: if it (or `ffmpeg`/a capture backend) is absent, perform the contract's
steps by hand and degrade to captions/storyboard rather than failing (see §§4–5 and the recorder
reference). Reference it via `${CLAUDE_PLUGIN_ROOT}`, never a relative path — installed plugins are
copied into a cache and relative paths break there.

## 2. Plan the chapters

Plan **3-6 chapters**, one role or action each, targeting **~2:30 total**. Derive them from the PR /
issue and the *Reach* steps: each chapter is a coherent thing a stakeholder cares about (a role
doing a task, an outcome being produced), not a screen-by-screen tour. Present the chapter plan for
a quick confirm before recording — it's cheap to reorder now, expensive after capture.

For each chapter capture: a title, the role/action for the lower-third, the *Reach* steps that drive
it, and the narration script (see §3 for the rules).

## 3. Write narration — product-owner-facing

Narration speaks to **stakeholders**, so it describes **features and outcomes, not implementation**:

- **Say:** what the user can now do, why it matters, the result they see.
- **Ban:** PR/issue numbers, endpoints/URLs, class/function/file names, framework names, ticket IDs
  — anything that reads as engineering rather than product value.
- Keep each chapter's script tight (a few sentences) so the whole video lands near the ~2:30 target.

### Provider-pluggable, env-keyed, hash-cached TTS

Synthesise narration through a **pluggable TTS provider** selected by config/env, with **API keys
read only from the environment — never committed.** The recorder **actually generates** each chapter's
voice (ElevenLabs is the bundled adapter) and caches each clip by a **content hash** of
`(provider, voice, text)`: editing one chapter's script changes only that chapter's hash, so **only
that clip regenerates** — the rest are reused from cache. Before recording it runs the **loud TTS
preflight** (§0): a bad key, an invalid `LOGBOOK_VOICE` id, or a voice whose name ≠ `LOGBOOK_VOICE_NAME`
is reported and degrades **visibly** to captions — never a silent or wrong-voice narration. If no
provider key is present, fall back to silent captions (§0). The bundled recorder implements this; see
[references/recorder.md](references/recorder.md).

## 4. Record each chapter

For each planned chapter, **stage via the recipe** (launch the app with `commands.run`, run the
*Stage* steps), then **drive the *Reach* steps** for that chapter while capturing the surface:

- **web** — Playwright drives the page and captures the viewport as **motion**: live interactions
  (clicks, drags, keyboard, a streamed result appearing) are recorded as video, and each beat
  **spotlights its narrated element** (dim the rest, ring the element, optional cursor drift) **held
  for the length of its narration** so the highlight stays synced to the voice-over. No live video ⇒
  the beat degrades to a **spotlight-annotated still**, and the run names the degrade.
- **cli / tui** — capture the terminal session running the chapter's commands.
- **api** — render request→response pairs as the on-screen visual.

Capture each chapter as its own clip so a later edit re-records just that chapter. Use the recipe's
*ready-signal* to wait for the app before driving it, and tear the app down between runs cleanly. The
spotlight overlay, synthetic cursor, and live-interaction `reach` vocabulary for `web` are detailed
in [references/recorder.md](references/recorder.md) (*Motion walkthrough*).

## 5. Assemble the video

Compose the chapters into **one** video with `ffmpeg`:

- A **chapter divider** card before each chapter (title + role).
- A **persistent lower-third** showing the current chapter title/role.
- **Timestamp-aligned audio:** narration is woven in as **one master track**, each chapter's clip
  delayed (`adelay`) to its real start offset and mixed (`amix`) — so narration lands when its
  chapter begins, with **no long silent tail** (the audio-drift bug of issue #91).
- A **post-record self-check**: a mid-video frame must be **non-blank** and the file must carry a
  **video stream** plus (when narration was expected) a **non-silent audio stream** — a failed check
  is reported loudly so a white-screen/silent render is caught before it's shipped.

The bundled recorder ([references/recorder.md](references/recorder.md)) performs synthesis, caching,
capture orchestration, the aligned mux, and the self-check; keep this skill the procedure and let the
script do the work.

## 6. Attach to the PR — a per-PR release asset

Upload the finished video as a **GitHub release asset scoped to this PR** (release assets host
binaries that PR comments can't), then comment the link on the PR:

```bash
TAG="logbook-pr-${PR}"
gh release create "$TAG" --title "Walkthrough — PR #${PR}" --notes "Narrated walkthrough for #${PR}." 2>/dev/null \
  || gh release edit "$TAG" --title "Walkthrough — PR #${PR}"   # idempotent: reuse the per-PR tag on re-record
gh release upload "$TAG" "<video file>" --clobber
ASSET_URL=$(gh release view "$TAG" --json assets --jq '.assets[] | select(.name | endswith(".mp4")) | .url')

# If the PR body carries a "Requested by @<user>" line (shipwright §7 copies it from the issue when
# someone requested the feature), @-mention them so they're notified there's a demo to watch. Extract
# ONLY the handle with an anchored match, so no other text from the (untrusted) issue is carried in:
REQUESTER=$(gh pr view "$PR" --json body --jq '.body' \
  | grep -oiP '^Requested by @\K[A-Za-z0-9-]{1,39}' | head -n1)
NOTE="🎬 Walkthrough video: ${ASSET_URL}"
[ -n "$REQUESTER" ] && NOTE="${NOTE}

cc @${REQUESTER} — here's the walkthrough of the feature you suggested."
gh pr comment "$PR" --body "$NOTE"
```

**Notify the requester, when the PR names one.** If the PR body carries a `Requested by @<user>` line
(shipwright §7 copies it from the issue), @-mention that handle in the walkthrough comment so they're
notified there's a demo to watch. Use **only** the bare `@<handle>` the anchored match extracts —
never any other text from the (untrusted) issue body.

The per-PR tag (`logbook-pr-<n>`) makes re-recording idempotent — a new take replaces the asset on
the same release rather than littering tags. If release creation is denied by permissions, fall back
to attaching the file to the PR comment / a Gist and say which path was used — don't fail the run.

## 7. Handoff

Report the PR comment link, the video duration and chapter list, which TTS provider (or captions)
was used, and where the staging recipe lives (`.armada/logbook/staging.json`) so the next run reuses
it. Note any degraded path taken (captions instead of voice, comment instead of release).

## Recording: the contract, and an optional bundled accelerator

The capture/synthesis/mux work follows the **contract** in
[references/recorder.md](references/recorder.md): it consumes the staging recipe and the chapter plan
as *data* and produces one muxed video, hardcoding no login/port/app-type/TTS-vendor. The skill
fulfils that contract by driving the host's own tooling — the repo's `commands.run` to launch the
app, a surface-appropriate capture (screen/page recorder for `web`/`tui`, scripted transcript for
`cli`/`api`), the env-keyed TTS provider (or captions when no key is set), and `ffmpeg` to mux.

If a bundled recorder script is **present**, invoke it as a turnkey accelerator instead of running
the steps by hand — **reference it via `${CLAUDE_PLUGIN_ROOT}`**, never a relative path (installed
plugins are copied into a cache, so relative paths break once installed):

```bash
# Optional accelerator — only if the script exists in this install:
node "${CLAUDE_PLUGIN_ROOT}/scripts/logbook-recorder.mjs" --staging .armada/logbook/staging.json --plan <chapters.json>
```

If it isn't present (or `ffmpeg`/a capture backend is unavailable), **degrade gracefully** — perform
the contract's steps directly, and fall back to captions-over-stills or a storyboard rather than
failing. A walkthrough is a nice-to-have; never let its absence block the PR.

## Inputs

- A PR number (or the current branch's PR), or a free-text feature description.
- Optional `--setup` to (re)derive the repo-specific staging recipe interactively.
- The repo's `.armada/config.json` (`commands.run`, `baseBranch`) and, once established,
  `.armada/logbook/staging.json`.
- TTS provider keys **from the environment only** (optional — falls back to captions).

## Output

- One narrated, chaptered walkthrough video (~2:30) with chapter dividers, a persistent role/action
  lower-third, timestamp-aligned narration, and a post-record blank/silent self-check.
- The video uploaded as a **per-PR GitHub release asset** and its link **commented on the PR**.
- A persisted, reusable `.armada/logbook/staging.json` (launch / stage / reach) for the repo.
