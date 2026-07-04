---
name: spyglass
description: >
  The ARMADA lookout's instrument — a live, procedurally-charted view of the fleet. Renders the
  whole armada:* label state machine that crows-nest runs as a beautiful, animated sea-chart in the
  browser: the horizon (new-issue track), the harbour (ready-PR pipeline), the crows-nest vantage
  (the scheduler's current tick — what's dispatched / held and why), and an optional cartography
  layer (the repo's learned chart). It reads the SAME GitHub state crows-nest scans (§2a) into a
  fleet-state.json and never mutates anything — it is a view, not a controller. Ships move through
  their real states; the coastline is procedurally generated and seeded from repo identity (stable
  run-to-run); weather reflects fleet health (storms when units are blocked). Trigger when the user
  says "show the fleet", "open spyglass", "visualise the armada", "watch the fleet on a chart",
  "fleet dashboard", "what's the fleet doing", or invokes /spyglass. Accepts an optional trigger
  label (defaults to .armada/config.json) and an optional watch cadence for continuous liveness.
argument-hint: "[label] [--watch <seconds>]"
allowed-tools: Bash, Read, Grep, Glob, Skill
---

# spyglass — a live, procedurally-charted view of the fleet

`spyglass` is the lookout's instrument. ARMADA runs unattended and its whole world is encoded in the
`armada:*` label state machine on issues and PRs — but you can only normally *see* it by reading
label lists or scanning [`crows-nest`](../crows-nest/SKILL.md) tick lines. `spyglass` makes that
world **visible**: it snapshots the fleet's GitHub state and renders it as a live, animated,
procedurally-generated sea-chart in the browser, with ships moving through their real states.

> **One run:** **snapshot** the fleet's GitHub state (the same read-only `gh issue list` /
> `gh pr list` queries crows-nest uses in §2a) → **classify** every issue/PR into a ship on the
> chart by its real `armada:*` label → **write** `fleet-state.json` + the bundled view into a
> scratch/output dir → **open** the self-contained HTML in the OS default browser. The page polls
> the snapshot, so re-running (or `--watch`) keeps the view live.

**spyglass is a *view*, not a controller.** It is **read-only with respect to the fleet** — it runs
only `gh ... list` and never claims, labels, merges, or relabels anything. That is crows-nest's job.
Its `allowed-tools` deliberately exclude `Write`/`Edit`: the *only* files it produces are the
snapshot and the rendered HTML, written by the bundled script into a scratch/output dir, **never the
tracked repo**.

## The metaphor — four zones

The chart maps the fleet's two tracks plus the scheduler's vantage and the learned chart:

- **Horizon** — the **new-issue track**. Issues sail in from the far horizon toward port as they
  progress through their build.
- **Harbour** — the **ready-PR pipeline**. PRs arrive in harbour, work the docks under review, and
  dock to unload when they merge.
- **Crows-nest vantage** — the scheduler's **current tick**: what *would* be dispatched vs held this
  round, and the hold reason — a read-only narration of the §2c frontier, never a dispatch.
- **Cartography** — the repo's **learned chart** (chart styling + knowledge from
  `.armada/cartography/`). **Optional**: it enriches the view if present and **degrades to off**
  (with a note) when absent. See §4.

### Ships map to real label states

Every ship's appearance is driven by the unit's real `armada:*` label — there is a visible legend on
the chart. Held units show their hold reason (crows-nest §2c):

| Unit  | Label              | On the chart                          |
| ----- | ------------------ | ------------------------------------- |
| issue | `armada`           | drifts on the horizon (queued)        |
| issue | `armada:underway`  | set sail — building                   |
| issue | `armada:done`      | reached port — built, PR opening      |
| PR    | `armada`           | arrived in harbour (ready)            |
| PR    | `armada:reviewing` | working the docks — under review      |
| PR    | `armada:merged`    | docking / unloading — merging         |
| PR    | `armada:shipped`   | safely arrived                        |
| any   | `armada:blocked`   | a wrecked / storm-bound ship          |

**Fleet health reads at a glance.** The sky/sea weather reflects overall state: **calm** seas when
the fleet is healthy, **choppy** water when work is in flight, and a **storm** (rough water,
seizure-safe lightning, rain) when any unit is `armada:blocked`.

The **landscape is procedurally generated** — sea, coastline, and islands — and **seeded from the
repo identity**, so a given repo gets a stable, recognisable coastline run-to-run. The view is
research-grounded and *alive*:

- a **layered sum-of-sines ocean** (≈14 cascading travelling waves) with moving crests, **specular
  glints**, **foam** at the peaks, and a subsurface depth gradient — not a flat plane;
- an ambient **wind/current particle-trail layer** (the earth.nullschool method) for faint drifting
  spray;
- **ships with Kelvin-V wakes** and bow spray that **bob and pitch with the local wave height**, and
  travel their journey with **eased enter / update / exit** motion (new units fade-and-grow in,
  shipped/merged ones sail off and fade);
- an optional **portolan cartography layer** — compass roses with a **rhumb-line network** (main
  winds bold, half/quarter winds subtler), a graticule, parchment tint, and a cartouche;
- **interaction**: hover / click / keyboard-focus a ship for a **detail card** (number, title,
  state, age, link to the issue/PR), plus an **activity readout** (per-zone counts, a recent-
  throughput sparkline, and a "tide" backlog mark).

### Accessibility (non-negotiable)

spyglass honours **`prefers-reduced-motion`** — it drops to a calm, near-static render (no drifting
particles, no wave motion, instant state changes) conveying the same information. It uses a
**colour-blind-safe palette** with **non-colour encoding** (each state has a distinct hull shape,
flag, heading, and a printed label, not colour alone), provides a **text/ARIA scene summary** for
screen readers, makes ships **keyboard-focusable**, and never flashes faster than 3/s. The canvas is
**devicePixelRatio-crisp**, drawn on a `requestAnimationFrame` loop that throttles gracefully when
many units are on screen.

## 0. Discover config (degrades gracefully)

Read `.armada/config.json` → `triggerLabel` (default `armada`). The label argument overrides it.
If the file is **absent**, the repo isn't commissioned — spyglass does **not** error: it renders an
**empty sea** and says so. (You may mention [`commission`](../commission/SKILL.md), but spyglass
itself never requires it.)

## 1. Snapshot + open the view

The snapshot, classification, write, and browser-open are all done by the bundled script. Reference
it via `${CLAUDE_PLUGIN_ROOT}` — **never a relative path** — because installed plugins are copied
into a cache where relative paths break (the bundled HTML app is copied next to the snapshot so it
can fetch `./fleet-state.json` with no server):

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/spyglass-snapshot.mjs" [--label <triggerLabel>] [--open]
```

The script:

1. Resolves the repo (via `gh repo view`) and the trigger label (arg → config → `armada`).
2. Runs the **same §2a read-only queries** crows-nest uses:
   ```bash
   gh issue list --label "<triggerLabel>" --state open \
     --json number,title,labels,createdAt,assignees,author,body --limit 50
   gh pr list --label "<triggerLabel>" --state open \
     --json number,title,isDraft,labels,headRefName,baseRefName,mergeable,statusCheckRollup,updatedAt --limit 50
   ```
3. Classifies each issue/PR into a ship by its `armada:*` label (the table above) and derives the
   **crows-nest tick** (dispatched vs held + reasons) and the **weather** (storm if anything is
   blocked) — all read-only, mutating nothing.
4. Writes `fleet-state.json` + copies the bundled `spyglass.html` into a scratch dir
   (`<os-tmp>/armada-spyglass/<repo-slug>/` by default, override with `--out <dir>`) — **never the
   tracked repo**.
5. Opens the rendered HTML in the OS default browser (`--open`, the default for a one-shot run;
   suppress with `--no-open`).

It prints the snapshot summary, and the paths to the JSON and HTML, e.g.:

```
spyglass: horizon 3 · harbour 2 · dispatch 2 · hold 1 · blocked 0 · weather choppy · cartography off
spyglass: snapshot → /tmp/armada-spyglass/calumjs-ARMADA/fleet-state.json
spyglass: view    → /tmp/armada-spyglass/calumjs-ARMADA/spyglass.html
```

## 2. Manual invocation — `/spyglass`

`/spyglass` (`/armada:spyglass`) is a one-shot: it snapshots the current state and opens the view.
It accepts an **optional trigger label** (defaults to `.armada/config.json`, else `armada`):

```bash
# default label, open the view
node "${CLAUDE_PLUGIN_ROOT}/scripts/spyglass-snapshot.mjs" --open

# a different fleet label
node "${CLAUDE_PLUGIN_ROOT}/scripts/spyglass-snapshot.mjs" --label my-fleet --open
```

## 3. Live — keep the view tracking the fleet

The page **auto-refreshes**: the bundled app polls `./fleet-state.json` every few seconds, so any
fresh snapshot is picked up without a reload. Two ways to keep the snapshot fresh:

- **One process, watch cadence** — re-snapshot on a timer (opens the view once, then refreshes the
  JSON in place):
  ```bash
  node "${CLAUDE_PLUGIN_ROOT}/scripts/spyglass-snapshot.mjs" --watch 15
  ```
- **Alongside a crows-nest watch via `/loop`** — pair a recurring re-snapshot with the lookout so
  the chart tracks the fleet in near-real-time as crows-nest works it:
  ```
  /loop 15s node "${CLAUDE_PLUGIN_ROOT}/scripts/spyglass-snapshot.mjs" --no-open
  ```
  Run this beside a `/crows-nest` watch (in another loop / session): crows-nest moves the labels,
  spyglass re-snapshots them, and the already-open browser view animates the change. The first
  `--open` (or a single manual `/spyglass`) opens the window; the loop just keeps the data live.

## 4. Cartography layer — optional enrichment

If `.armada/cartography/` is present (the repo's learned chart, e.g. from a cartographer skill), the
snapshot records it and the view draws the **portolan cartography layer** — a parchment tint, a
faint graticule, **compass roses with a rhumb-line network** (main winds bold, half/quarter winds
subtler, per the historical convention), a decorative cartouche, and a few learned-heuristic
annotations from the chart files. **This is optional and independent.** If the directory is
**absent**, spyglass renders **fully without it**: the layer degrades to **off**, the status panel
says `cartography off`, the "Cartography — learned chart" label is hidden (so it never collides with
the bottom-left vantage panel, per #52), and nothing errors. spyglass never blocks on or assumes the
cartography dir exists.

## 5. Degrades gracefully

spyglass never hard-fails on a thin or uncommissioned repo:

- **Uncommissioned** (no `.armada/config.json`): renders an **empty sea** and notes
  `uncommissioned — rendering an empty sea`.
- **`gh` unavailable / unauthenticated / query fails**: renders an empty sea and notes the degraded
  reason; it does not crash.
- **No armed issues or PRs**: an empty, calm sea ("an empty sea — no armed issues or PRs").
- **No `.armada/cartography/`**: the cartography layer is omitted, with a note (§4).

## 6. Per-run operations dashboard (companion mode)

The sea-chart shows the **whole fleet at a glance**; its companion the **per-run operations
dashboard** zooms in on the **in-flight runs**. It defaults to a scannable **multi-run overview** —
every concurrent run as a compact summary row under a fleet **status roll-up** — and lets the
operator **expand** any row into the full per-run detail card (a 12-stage pipeline, its
worktree/branch/folder metadata, its logbook **"done video"**, and a **per-model cost table**). So a
busy fleet reads at a glance and you drill into a single run on demand. It is the natural companion
to the chart (issue #101) and shares spyglass's core promise: it is **READ-ONLY with respect to the
fleet**.

> **One run:** **snapshot** the same live GitHub state the chart reads (the §2a `gh issue list` /
> `gh pr list` queries) → **correlate** each issue with the PR that closes it → **enrich** each run
> with local read-only detail (its git worktree path, its `out/costs/<run>.json` cost post-mortem,
> its logbook done-video release asset) → **map** the coarse `armada:*` labels onto the 12 finer
> operator stages → **write** `run-state.json` + the bundled dashboard app into a scratch/output dir
> → **open** it in the browser. The page polls the snapshot, so re-running (or `--watch`) keeps it
> live.

```bash
# one-shot: snapshot in-flight runs and open the dashboard
node "${CLAUDE_PLUGIN_ROOT}/scripts/spyglass-run-snapshot.mjs" --open

# keep it live (re-snapshot on a cadence; the open window auto-refreshes)
node "${CLAUDE_PLUGIN_ROOT}/scripts/spyglass-run-snapshot.mjs" --watch 15

# alongside a crows-nest watch via /loop (open once, keep the data fresh)
/loop 15s node "${CLAUDE_PLUGIN_ROOT}/scripts/spyglass-run-snapshot.mjs" --no-open
```

It takes the **same flags** as the chart driver (`--label`, `--out`, `--repo`, `--open`/`--no-open`,
`--watch <seconds>`); the default output dir is `<os-tmp>/armada-spyglass-run/<repo-slug>/`.

### Read-only — enforced and documented

The dashboard makes **zero mutations**. Every source it touches is a read:

- **GitHub:** `gh repo view`, `gh issue list`, `gh pr list`, and GET-only `gh api .../releases`.
  There is **no** `gh` write anywhere — no label, comment, review, merge, or close. (The driver's
  code contains only `... list` / `repo view` / `api ... releases` invocations.)
- **Local disk:** `git worktree list` (to resolve a run's on-disk worktree path) and
  `out/costs/<run>.json` (the cost post-mortem, **consumed** when present). It **never produces**
  `out/costs/*.json` — that is out of scope (a separate concern).

The only files it writes are the snapshot (`run-state.json`) and the copied app
(`spyglass-run.html`), in the scratch/output dir — **never the tracked repo**.

### Multi-run overview — the default view

When the fleet is busy the dashboard opens on the **overview**, not a stack of full cards:

- **Status roll-up header** — the fleet at a glance: **total in-flight**, a count **per group**
  (**building · reviewing · awaiting-merge · blocked · done**), and **total cost** across all runs.
  The blocked chip flags red when non-zero; empty groups dim. It **recomputes on every poll** as runs
  appear, move group, or leave.
- **Compact summary rows** — one row per concurrent run (the default, no scrolling through full
  cards): **issue #**, **title**, its **current stage**, a live **status label**, a **compact
  12-segment stage/progress indicator** (done filled, active outlined, blocked red), and **running
  cost**. Legible with many concurrent runs (6+); a blocked run's status reads red.
- **Expand on demand** — any summary row **expands** into the full per-run detail card below it and
  **collapses** again. It is **click + keyboard accessible** (each row is a `role="button"`,
  `tabindex="0"` with `aria-expanded`; **Enter**/**Space** toggles) and rows **expand independently**
  — open as many as you like. Expanded state is **preserved across the live poll** and pruned when a
  run leaves the fleet.
- **Graceful empty state** — an idle fleet (or an uncommissioned/failing `gh`) shows the calm "no
  runs to show" / "no in-flight runs" state, exactly as the chart does.

The roll-up **groups** are derived from the 12 operator stages (see the mapping table below):
**building** = Feasibility…AI review (pre-PR + build/test + the pre-submit self-review);
**awaiting-merge** = PR submitted / Watching PR / Approved (open, waiting on the gate);
**reviewing** = Feedback (the muster + address-review loop); **done** = Merged / Harvest; and
**blocked** overrides all of them for any blocked run. The snapshot emits each run's `group` and a
top-level `rollup` object (counts + `inFlight` + `totalCost`), **additively — schema 1, back-compat**
(an older snapshot with no `group`/`rollup` is regrouped client-side).

### Each run expands to a detail card

Modelled on the reference mock (dark two-column card, cost table below):

- **Header** — issue `#number`, run title, a **segmented 12-stage progress bar** (done segments
  filled, the active one outlined, blocked runs flagged red), a live **status label** (e.g.
  "Watching PR"), **elapsed** time (since the issue/PR opened), and **running cost**.
- **Left — the stage pipeline** — the 12 stages, each with a **status dot** (done / active /
  upcoming, or blocked). Stages: **Feasibility, Scoping, Planning, Building, Testing, AI review, PR
  submitted, Watching PR, Feedback, Approved, Merged, Harvest**.
- **Right — the metadata panel** — the **issue link**, the **branch** (with a copy action), the
  **worktree** and **folder** paths (each with open / copy-path actions), and an embedded **done
  video** player (the logbook walkthrough release asset, standard `<video controls>`). Every field
  **degrades gracefully** when absent (branch/worktree `n/a`, "no done video yet", etc.).
- **Cost table** — one row per model with **MODEL · IN · OUT · CACHE R · CACHE W · ≈ COST**, plus a
  footer summarising **session/subagent/codex counts**, the **match mode**, the *"API-equivalent
  estimate, not billing"* caveat, and a pointer to `out/costs/<run>.json`. It reads that file **when
  present** and shows a graceful **`n/a`/empty** state when absent.

### Stage mapping — 12 finer stages from the coarse `armada:*` labels

The 12 operator stages are finer than the `armada:*` label state machine crows-nest runs, so several
are **inferred** from PR draft/CI/review sub-state. The active stage marks earlier stages **done**
and later stages **upcoming**; `armada:blocked` overrides the active dot to **blocked**:

| Unit + state                              | Active stage    | Done (implied)        |
| ----------------------------------------- | --------------- | --------------------- |
| issue `armada` (queued, unclaimed)        | **Feasibility** | —                     |
| issue `armada:underway` (shipwright building) | **Building**    | Feasibility→Planning  |
| issue `armada:done` (built, PR opening)   | **PR submitted**| Feasibility→AI review |
| PR draft (`isDraft`)                      | **PR submitted**| Feasibility→AI review |
| PR `armada` ready (crows-nest will pick up) | **Watching PR** | …→PR submitted        |
| PR `armada` ready + `reviewDecision APPROVED` | **Approved**    | …→Feedback            |
| PR `armada:reviewing` (muster / address-review) | **Feedback**    | …→Watching PR         |
| PR `armada:merged` (gated merge in progress) | **Merged**      | …→Approved            |
| PR `armada:shipped` (merged & done → cartographer) | **Harvest**     | …→Merged (complete)   |
| any `armada:blocked`                      | *(last reached)* — **blocked** | up to that stage |

Feasibility/Scoping/Planning collapse onto the pre-build/build labels (a queued issue sits at
Feasibility; an underway issue has cleared scoping+planning into Building); AI review is the
pre-submit self-review that precedes **PR submitted**; **Feedback** is the muster review +
address-review loop on the open PR; **Harvest** is the post-merge cartographer learning pass.

### Cost post-mortem schema (consumed, not produced)

When a future feature writes `out/costs/<run>.json` (keyed by the run's **branch**, e.g.
`out/costs/hubx-6676-atx-insert-at-cursor.json`), the dashboard consumes this shape (all fields
tolerant/optional — missing values render `n/a`):

```json
{
  "run": "hubx-6676-atx-insert-at-cursor",
  "models": [
    { "model": "opus-4-8", "in": 29000, "out": 704, "cacheRead": 74000, "cacheWrite": 41000, "cost": 0.61 },
    { "model": "gpt-5.4", "in": 113000, "out": 6000, "cacheRead": 86000, "cacheWrite": 0, "cost": null }
  ],
  "sessions": 1, "subagents": 0, "codex": 3,
  "matchMode": "heuristic", "unpriced": ["gpt-5.4"], "totalCost": 0.61
}
```

When the file is **absent**, the cost table shows an empty `n/a` state and the footer still points at
the conventional `out/costs/<run>.json` path.

### Degrades gracefully

Same posture as the chart (§5): an uncommissioned repo, an unauthenticated/failing `gh`, or no armed
issues/PRs all render a calm **"no runs to show"** empty state rather than crashing; the dashboard
honours **`prefers-reduced-motion`** (drops the active-dot glow).

## Bundled assets

All rendering ships under the plugin and is referenced via `${CLAUDE_PLUGIN_ROOT}` (per the repo's
plugin-cache rule — relative paths break once a plugin is installed to its cache):

- **`${CLAUDE_PLUGIN_ROOT}/scripts/spyglass-snapshot.mjs`** — the read-only snapshot + classify +
  write + open driver (Node built-ins + `gh` only, dependency-free to match
  `scripts/validate-skills.mjs`).
- **`${CLAUDE_PLUGIN_ROOT}/scripts/spyglass-app.html`** — the self-contained, no-server
  HTML + `<canvas>`/JS visualisation (vanilla canvas/JS, **no external/CDN libraries, no build
  step**). Copied next to the snapshot at run time so it can fetch `./fleet-state.json` locally with
  no server.

Per-run operations dashboard (companion mode, §6):

- **`${CLAUDE_PLUGIN_ROOT}/scripts/spyglass-run-snapshot.mjs`** — the read-only per-run snapshot +
  correlate + enrich + write + open driver (Node built-ins + `gh`/`git` only, dependency-free).
- **`${CLAUDE_PLUGIN_ROOT}/scripts/spyglass-run-app.html`** — the self-contained, no-server dark
  dashboard (vanilla HTML/CSS/JS, **no external/CDN libraries, no build step**). Copied next to its
  snapshot at run time so it can fetch `./run-state.json` locally with no server.

The **only** files written at run time are the snapshots (`fleet-state.json` / `run-state.json`) and
the rendered HTML (`spyglass.html` / `spyglass-run.html`), in the scratch/output dir — never the
tracked repo.

### Dev-only sea-trial harness (not shipped into the view)

Because "beautiful" can't be asserted blind, a repeatable visual-regression harness ships alongside
the app for re-running the closed visual-feedback loop on demand (and on future spyglass changes).
It is **read-only** (it never touches GitHub or the repo) and writes only PNGs + a scratch copy of
the app into an output dir — it is **not** loaded into the rendered view:

- **`${CLAUDE_PLUGIN_ROOT}/scripts/spyglass-fixtures.mjs`** — deterministic synthetic snapshots
  (calm/1 unit, busy/choppy, storm-with-blocked, cartography on, narrow, empty) matching the same
  schema the snapshot script writes, for states the live fleet doesn't currently exhibit.
- **`${CLAUDE_PLUGIN_ROOT}/scripts/spyglass-trial.mjs`** — serves the output dir over a throwaway
  localhost server (file:// blocks the app's `fetch`) and drives the already-available Playwright
  CLI to capture each canonical state at a wide and a narrow viewport plus a **reduced-motion**
  render. It **waits for the server to be listening and answering** before each capture, uses a
  bounded navigation timeout and awaits the app's first paint, **retries** a transient failure, and
  verifies every PNG is written and non-empty. Run
  `node "${CLAUDE_PLUGIN_ROOT}/scripts/spyglass-trial.mjs"` and it writes all states' PNGs into
  `<out>/captures` (default out dir under the OS temp dir).
  - **Browser channel:** it drives an already-installed Chromium-family channel — default
    `--channel msedge` (Microsoft Edge); pass `--channel chrome` for Google Chrome. The harness adds
    no browser/runtime dependency of its own; the channel must already be present.
  - **Other flags:** `--only <names>` (subset of fixtures), `--out <dir>` (scratch/output dir),
    `--snapshot <fleet-state.json>` (also trial a real read-only snapshot), `--retries <n>`
    (per-capture retry budget, default 2), `--timeout <ms>` (navigation/action timeout, default
    30000), `--settle <ms>` (post-load settle).
  - **Exit code:** `0` only if **every** expected PNG was captured and is non-empty; on any failure
    it prints the underlying Playwright error and **exits non-zero** — a broken trial never passes
    silently.

## Inputs

- Optional trigger label (positional, defaults to `.armada/config.json` → `triggerLabel`, else
  `armada`).
- Optional `--watch <seconds>` cadence for continuous liveness; `--out <dir>` to override the output
  dir; `--repo <owner/name>` to chart a different repo; `--no-open` to suppress the browser open.

## Output

- A read-only `fleet-state.json` snapshot of the fleet (issues, PRs, the crows-nest tick, weather,
  cartography presence, repo seed) and the rendered `spyglass.html`, written to a scratch/output dir.
- The self-contained chart opened in the OS default browser: four labelled zones, a state legend,
  procedurally-seeded animated landscape, ships at their real `armada:*` states, weather reflecting
  fleet health, and live auto-refresh polling of the snapshot.
