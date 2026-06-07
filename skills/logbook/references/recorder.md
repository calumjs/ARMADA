# logbook recorder — the generic capture/synthesis/mux contract

This is the **contract** the [`logbook`](../SKILL.md) skill fulfils, whether it runs the steps
directly with host tooling (`commands.run` + a capture backend + TTS + `ffmpeg`) or hands off to an
optional bundled script that implements the same contract. It is **generic**: it takes a
repo-specific staging recipe and a chapter plan as *data* and produces one video — it hardcodes
**no** login, no port, no sample file, no app type, and no TTS vendor. Anything app-specific comes
from `.armada/logbook/staging.json` (the recipe) or the environment.

> **A bundled implementation ships** at `${CLAUDE_PLUGIN_ROOT}/scripts/logbook-recorder.mjs` — always
> reference it via `${CLAUDE_PLUGIN_ROOT}`, never a relative path (installed plugins are copied into a
> cache and relative paths break there). It also exposes an arch-aware `--setup` toolchain preflight
> (provisions a host-matched `ffmpeg`, verifies the capture backend, reports ready/degraded/missing —
> see SKILL §0). The script is an **optional accelerator**, not a hard dependency: if it (or
> `ffmpeg`/a capture backend) is absent, perform these steps directly and degrade to
> captions/storyboard. (The repo-local `node scripts/validate-skills.mjs` is a separate thing —
> ARMADA's own test gate, run against this checkout, not via the installed plugin.)

```bash
# Optional accelerator if present; otherwise drive the equivalent steps below by hand:
node "${CLAUDE_PLUGIN_ROOT}/scripts/logbook-recorder.mjs" \
  --staging .armada/logbook/staging.json \
  --plan    <chapters.json> \
  --out      walkthrough-pr-<n>.mp4
```

## Inputs

- **`--staging`** — the repo-specific recipe (`launch` / `stage` / `reach`, see SKILL §1). Tells the
  recorder how to start *this* app, get it demo-ready, and reach each feature. The recorder reads
  `surface` (`web` | `cli` | `tui` | `api`) to choose its capture backend.
- **`--plan`** — the chapter plan: an ordered list of `{ title, role, reach, narration }` (SKILL
  §2-3). 3-6 chapters, ~2:30 total.
- **Environment** — TTS provider key(s) and any demo credentials the recipe references **by name**
  (e.g. `LOGBOOK_DEMO_USER`). The recorder reads these from `process.env`; it never accepts secrets
  as flags and never writes them to disk.

## Provider-pluggable TTS

The TTS layer is an **interface, not a vendor**. A provider is selected by config/env (e.g.
`LOGBOOK_TTS_PROVIDER`) and supplies one method — `synthesize(text, voice) -> audio`. Adding a
provider means adding an adapter, not editing the recorder. Each adapter reads **its own API key from
the environment only**:

- No key committed, ever — keys come from `process.env.<PROVIDER>_API_KEY` (or the provider's
  documented var).
- If the selected provider has no key in the environment, the recorder **falls back to silent
  captions** (burned-in narration text) and reports the fallback — it never blocks the whole video on
  a missing voice key.

## Content-hash clip cache

Every narration clip is cached by a **content hash of `(provider, voice, text)`**, stored under
`.armada/logbook/cache/<hash>.<ext>`:

- On synth, compute the hash; if a cached clip exists, **reuse it** — no API call.
- Editing one chapter's script changes only that chapter's hash, so **only that chapter
  regenerates**; untouched chapters are served from cache. This makes iterating on narration cheap.
- The cache keys on content, not chapter index, so reordering chapters never invalidates clips.

## Per-surface capture

The recorder picks a capture backend from the recipe's `surface` — it does **not** assume a browser:

| `surface` | Capture backend | Drives via |
| :--- | :--- | :--- |
| `web` | browser driver (Playwright/Puppeteer) records the viewport as motion | the `reach` interactions (goto/click/dblclick/hover/fill/press/dragdrop/scrollTo) + per-beat spotlight |
| `cli` / `tui` | terminal recorder (asciinema/VHS, or xterm.js + Playwright for a polished frame) | the `reach` commands/keys |
| `api` | renders request→response pairs as the on-screen visual | the `reach` request sequence |

For each chapter the recorder **stages via the recipe** (launches the app with the recipe's `launch`
command — which reuses `.armada/config.json` `commands.run` — waits for the `readySignal`, runs the
`stage` steps), then **replays that chapter's `reach`** while capturing. Each chapter is captured as
its own clip so an edit re-records just that chapter. The app is torn down cleanly between chapters.

### Capture readiness — wait for paint, warm the route, and report blank captures

An HTTP `200`/the page `load` event is **not** proof the app is on screen. On a dev server
(Next.js and any dev-mode bundler) the route is **compiled on first request**, so the viewport can
stay blank for seconds *after* navigation resolves. If a capture starts in that window it records
the blank pre-paint state and falls back to caption cards — producing a **titles-only storyboard**
rather than a real walkthrough. The recorder therefore enforces a capture-readiness discipline for
the `web` surface:

- **Wait for a contentful paint, not just a 200.** After each navigation the recorder waits for the
  recipe `readySignal`, for the network to settle, and for a genuine **first-contentful-paint**
  (with a visible-body backstop) before it relies on the captured frames — not merely the `load`
  event.
- **Warm each route before the recorded pass.** Every route a chapter touches is primed with one
  throwaway navigation in a **non-recording** context first, so dev-mode first-compile latency
  happens *outside* the recording and never lands inside the captured clip.
- **Report a blank capture as a degrade — don't swallow it.** After capture the recorder
  sanity-checks the clip; an empty/near-static clip (one that recorded the pre-paint blank window)
  is **reported as a capture degrade** in the run summary (named per the §0 degrade convention,
  alongside any TTS/ffmpeg degrades) and falls back to a **spotlight-annotated still** (see Motion
  walkthrough, below) — it is never silently muxed into the final video. A produced video of real
  content chapters is therefore materially larger than a pure caption-card storyboard, a sanity
  check that real frames were captured.

## Motion walkthrough — spotlight the narrated element, capture live interactions

A walkthrough should feel like a **demo, not a slideshow** — it draws the viewer's eye to the
element being narrated and shows the app **in motion** (Loom/Arcade-style), not a sequence of static
screenshots with a caption bar. For the `web` surface the recorder makes each beat a moment of
guided motion:

- **Per-beat target + spotlight overlay.** A chapter beat may carry a **`target`** (a CSS selector)
  — or **`targets`/`spotlight`** for several. During that beat the recorder **scrolls each target
  into view** and renders a **spotlight overlay**: a dimmed full-viewport backdrop with a transparent
  hole and a **glowing ring** punched over the element's bounding box. The overlay is **held for the
  duration of that beat's narration audio** — the recorder reads the cached narration clip's real
  duration (ffprobe/ffmpeg, best-effort) and holds for exactly that, so the highlight stays **synced
  to the voice-over** (a readable default, clamped to a sane window, when the beat is caption-only).
  With several targets the hold is split evenly and the spotlight steps through them.
- **Live interactions recorded as motion.** The `reach` vocabulary is not navigation-only. On top of
  `goto` / `click` / `fill` / `wait` it supports **`hover`**, **`dblclick`**, **`press`** (keyboard —
  e.g. `Control+k` to open a command palette, then `fill` to type, then watch a streamed result
  appear), **`dragdrop`** (`target` → `to`/`dest`, e.g. drag a card between columns), and
  **`scrollTo`**. The whole recording context is captured as **real video**, so these interactions
  land as motion, not stills. Each step that can trigger a transition settles on `networkidle` before
  the next.
- **Optional synthetic cursor.** Set **`cursor: true`** on a beat (or once on the recipe) and the
  recorder injects a synthetic cursor that **drifts to** each pointer step's target and animates a
  **tap** on clicks — visual guidance toward the element the narration is about. It's best-effort
  chrome layered over the real interaction; it never blocks the action that actually drives the app.
- **Degrades to an annotated still — with the spotlight, named.** With no live video (no browser
  driver, or a capture that came back blank), the beat degrades to an **annotated still**: a
  screenshot **with the same spotlight overlay drawn** on the target, held for the narration's length
  — so even the degraded path highlights the narrated element rather than showing a bare title card.
  The degrade is **named** in the run summary per the §0 convention (e.g. `chapter 2 (...) capture
  degraded -> annotated still (spotlight overlay) (...)`).

All overlay/cursor chrome is injected into the page (a stylesheet + a few elements via the browser
driver's `evaluate`/`screenshot`) — **no new third-party dependency**; the browser driver stays the
only (already-optional, lazily-loaded) backend.

The spotlight/cursor/interaction fields are **recipe + plan data** (`target` / `targets` /
`spotlight` / `cursor` on a chapter; the interaction `action`s in `reach`), so a later run re-records
the same guided motion after an edit — consistent with the "reach is data the recorder replays"
rule above.

## Assemble — one video with `ffmpeg`

The recorder muxes and concatenates with `ffmpeg`:

1. Mux each chapter clip against its narration (or caption track).
2. Insert a **chapter divider** card (chapter title) between chapters.
3. Burn in a **persistent lower-third** with the current role/action.
4. Add **bookends** — an **agenda** card (chapter list) at the start and a **recap** card at the end.
5. Concatenate to a single output file (`--out`).

## Output

- One `.mp4` at `--out`, ready for [`logbook`](../SKILL.md) §6 to upload as a per-PR GitHub release
  asset and link on the PR.
- A populated `.armada/logbook/cache/` so the next run regenerates only edited chapters.

## What this recorder must NOT do

- **No hardcoded logins, ports, or sample files** — all of that is recipe data or env.
- **No committed API keys** — env only; missing key ⇒ caption fallback.
- **No assumed app type** — `surface` selects the backend; non-web is first-class.
- **No vendor lock-in** — TTS is an adapter interface, swappable by config/env.
