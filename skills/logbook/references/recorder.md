# logbook recorder — the generic capture/synthesis/mux contract

This is the **contract** the [`logbook`](../SKILL.md) skill fulfils, whether it runs the steps
directly with host tooling (`commands.run` + a capture backend + TTS + `ffmpeg`) or hands off to an
optional bundled script that implements the same contract. It is **generic**: it takes a
repo-specific staging recipe and a chapter plan as *data* and produces one video — it hardcodes
**no** login, no port, no sample file, no app type, and no TTS vendor. Anything app-specific comes
from `.armada/logbook/staging.json` (the recipe) or the environment.

> **If a bundled implementation is present**, reference it via
> `${CLAUDE_PLUGIN_ROOT}/scripts/logbook-recorder.mjs`, never a relative path — installed plugins are
> copied into a cache and relative paths break there. The script is an **optional accelerator**, not
> a hard dependency: if it (or `ffmpeg`/a capture backend) is absent, perform these steps directly
> and degrade to captions/storyboard. (The repo-local `node scripts/validate-skills.mjs` is a
> separate thing — ARMADA's own test gate, run against this checkout, not via the installed plugin.)

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
| `web` | browser driver (Playwright/Puppeteer) records the viewport | the `reach` clicks/routes |
| `cli` / `tui` | terminal recorder (asciinema/VHS, or xterm.js + Playwright for a polished frame) | the `reach` commands/keys |
| `api` | renders request→response pairs as the on-screen visual | the `reach` request sequence |

For each chapter the recorder **stages via the recipe** (launches the app with the recipe's `launch`
command — which reuses `.armada/config.json` `commands.run` — waits for the `readySignal`, runs the
`stage` steps), then **replays that chapter's `reach`** while capturing. Each chapter is captured as
its own clip so an edit re-records just that chapter. The app is torn down cleanly between chapters.

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
