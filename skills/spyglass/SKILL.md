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
lightning, rain) when any unit is `armada:blocked`.

The **landscape is procedurally generated** — sea, coastline, and islands from value-noise (fBm) —
and **seeded from the repo identity**, so a given repo gets a stable, recognisable coastline
run-to-run. Water and ships are animated: this is *activity you can watch*, not a static plot.

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
snapshot records it and the view draws the **cartography layer** — a faint chart grid and a compass
rose over the sea. **This is optional and independent.** If the directory is **absent**, spyglass
renders **fully without it**: the layer degrades to **off**, the status panel says
`cartography off`, and nothing errors. spyglass never blocks on or assumes the cartography dir
exists.

## 5. Degrades gracefully

spyglass never hard-fails on a thin or uncommissioned repo:

- **Uncommissioned** (no `.armada/config.json`): renders an **empty sea** and notes
  `uncommissioned — rendering an empty sea`.
- **`gh` unavailable / unauthenticated / query fails**: renders an empty sea and notes the degraded
  reason; it does not crash.
- **No armed issues or PRs**: an empty, calm sea ("an empty sea — no armed issues or PRs").
- **No `.armada/cartography/`**: the cartography layer is omitted, with a note (§4).

## Bundled assets

All rendering ships under the plugin and is referenced via `${CLAUDE_PLUGIN_ROOT}` (per the repo's
plugin-cache rule — relative paths break once a plugin is installed to its cache):

- **`${CLAUDE_PLUGIN_ROOT}/scripts/spyglass-snapshot.mjs`** — the read-only snapshot + classify +
  write + open driver (Node built-ins + `gh` only, dependency-free to match
  `scripts/validate-skills.mjs`).
- **`${CLAUDE_PLUGIN_ROOT}/scripts/spyglass-app.html`** — the self-contained, no-server
  HTML + `<canvas>`/JS visualisation. Copied next to the snapshot at run time so it can fetch
  `./fleet-state.json` locally with no server.

The **only** files written at run time are the snapshot (`fleet-state.json`) and the rendered HTML
(`spyglass.html`), in the scratch/output dir — never the tracked repo.

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
