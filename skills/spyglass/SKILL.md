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
dashboard** zooms in on the **in-flight runs**, ARMADA-nautical themed to match it. It defaults to a
scannable **multi-run overview** — every concurrent run as a compact **voyage row** under a fleet
**totals manifest** — and lets the operator **expand** any row into the full per-run **log card** (the
run's real pipeline, its worktree/branch/folder metadata, its logbook **"done video"**, and a
**per-model cost ledger** with real numbers). So a busy fleet reads at a glance and you drill into a
single run on demand. It is the natural companion to the chart (issue #101) and shares spyglass's core
promise: it is **READ-ONLY with respect to the fleet**.

It also keeps completed runs **on the board**: a **recent-voyages lane** (a "harbour" of completed
voyages) below the in-flight runs, so a run doesn't vanish the moment it merges/ships — you see both
what's under way and what recently landed (issue #113). See **Recent voyages** below.

Each run is drawn as a **voyage**: a vessel sailing ARMADA's genuine `armada:*` pipeline from harbour
to port. The stages are the fleet's **real, observable states** — not the inspiration mock's invented
list (issue #109's accuracy directive replaced the mock's Feasibility/Scoping/Planning/Testing/AI
review/PR submitted/Watching PR/Feedback/Approved/Harvest with what ARMADA actually does).

> **One run:** **snapshot** the same live GitHub state the chart reads (the §2a `gh issue list` /
> `gh pr list` queries) — **plus** a bounded recent-window scan of recently **closed** issues and
> **merged**/closed PRs, so terminal runs have data to render → **correlate** each issue with the PR that closes it → **enrich** each run
> with local read-only detail (its git worktree path from `git worktree list` *and* the crows-nest
> run→worktree map for in-flight builds with no PR yet, its `out/costs/<run>.json` cost post-mortem,
> its logbook done-video release asset) → **map** the `armada:*` labels (+ PR draft/CI/review
> sub-state) onto ARMADA's real voyage stages → **write** `run-state.json` + the bundled dashboard app
> into a scratch/output dir → **open** it in the browser. The page polls the snapshot, so re-running
> (or `--watch`) keeps it live — cost climbs and elapsed ticks as the run progresses.

```bash
# one-shot: snapshot in-flight runs and open the dashboard
node "${CLAUDE_PLUGIN_ROOT}/scripts/spyglass-run-snapshot.mjs" --open

# keep it live (re-snapshot on a cadence; the open window auto-refreshes)
node "${CLAUDE_PLUGIN_ROOT}/scripts/spyglass-run-snapshot.mjs" --watch 15

# alongside a crows-nest watch via /loop (open once, keep the data fresh)
/loop 15s node "${CLAUDE_PLUGIN_ROOT}/scripts/spyglass-run-snapshot.mjs" --no-open
```

It takes the **same flags** as the chart driver (`--label`, `--out`, `--repo`, `--open`/`--no-open`,
`--watch <seconds>`), plus the recent-voyages window (`--recent-hours <N>`, `--recent-cap <N>`); the
default output dir is `<os-tmp>/armada-spyglass-run/<repo-slug>/`.

#### Driver guardrails — keep a live board from silently freezing (#133)

Two startup guardrails stop the failure mode where a dashboard quietly shows a **days-old** snapshot
(several stale `--watch` drivers overwriting the same file, and the web server serving a **different**
directory than the driver wrote to — nothing errors, the board just lies):

- **Single-driver lock.** A `--watch` driver takes an exclusive lock (`.spyglass-run.lock`, holding
  `pid` + `startedAt`) in its `--out` dir. A **second** watcher against the same `--out` **refuses to
  start** and names the live pid; a holder whose pid is **dead** (a crashed driver's stale lock) is
  **transparently taken over**; the lock is released on clean exit. A **one-shot** (non-`--watch`)
  snapshot neither takes nor is blocked by the lock — it writes once and exits.
- **Served-dir sanity check.** `--served-root <dir>` (or `SPYGLASS_SERVED_ROOT` / `spyglass.servedRoot`,
  or a conservative auto-detect of a running static server) names the directory actually served over
  HTTP. If `--out` is **not** that directory the driver **warns loudly** on startup, and **refuses**
  under `--strict`. Auto-detect only recognises unambiguous static servers and never raises a false
  alarm — when the served root can't be determined it stays silent.

The lock file lives in the scratch/output dir, so both guardrails preserve the driver's read-only
invariant (**never the tracked repo**).

### Read-only — enforced and documented

The dashboard makes **zero mutations**. Every source it touches is a read:

- **GitHub:** `gh repo view`, `gh issue list` (open **and** recently `--state closed`), `gh pr list`
  (open **and** recently `--state merged` / `--state closed`), and GET-only `gh api .../releases`.
  There is **no** `gh` write anywhere — no label, comment, review, merge, or close. (The driver's
  code contains only `... list` / `repo view` / `api ... releases` invocations.) The recent-window
  scan (#113) adds only more **read** list queries — it stays inside the same read-verb allowlist.
- **Local disk (reads only):** `git worktree list` (to resolve a run's on-disk worktree path);
  `out/costs/_runs.json` (the crows-nest-written run→(branch, worktree) map, so an **in-flight** run's
  branch/worktree/folder resolve **before** a PR exists); `out/costs/<run>.json` (the per-model
  cost post-mortem, **consumed** when present); and `out/costs/_schedule.json` (the crows-nest
  scheduler-state — the waiting-runs dependency graph, **consumed** when present; see **The horizon**
  below). The **driver never PRODUCES** any of these — it only reads them. The producer is **crows-nest-side** (`spyglass-cost-postmortem.mjs`, crows-nest §8g),
  writing **only** under `out/costs/` (gitignored). Keeping the writer out of the read-only driver is
  what preserves the driver's zero-mutation guarantee.

The only files the driver writes are the snapshot (`run-state.json`) and the copied app
(`spyglass-run.html`), in the scratch/output dir — **never the tracked repo**.

### Multi-run overview — the default view

When the fleet is busy the dashboard opens on the **overview**, not a stack of full cards:

- **Fleet totals manifest** — the fleet at a glance: **total in-flight** ("N voyages"), a gauge
  **per group** (**queued · building · reviewing · awaiting · done · blocked**), and **fleet cost**
  (the summed API-equivalent estimate). The blocked gauge flags red when non-zero; empty gauges dim. A
  **weather badge** (calm / choppy / storm) reflects fleet health — storm when any run is blocked. It
  **recomputes on every poll** as runs appear, move group, or leave.
- **Compact voyage rows** — one row per concurrent run (the default, no scrolling through full cards):
  a **vessel** tinted by state, **issue #**, **title**, the **voyage bar** (one leg per real stage —
  done legs brass-filled, the active leg outlined with a bobbing ship marker, a blocked leg red), a
  live **status label**, live **running cost**, and **live-ticking elapsed**. The cost is **honest
  about phase** (#115): a still-building run reads **`~$X est`** (a live elapsed-based **estimate**,
  not a misleading `$0.00`) or **`accruing…`** when no rate is set; a recorded-but-partial figure reads
  **`$X`** tagged *so far*; only a reconciled run reads a plain **`$X`** (final). Legible with many
  concurrent runs (6+); a blocked run reads red. **Sort** by furthest-along / cost / age.
- **Click through to GitHub (#127).** Each row's **number** links to its GitHub **issue** (or its **PR**
  when there's no issue) and its **title** links to the **PR** when one exists (else the issue) — opened
  in a **new tab** (`target=_blank`, `rel=noopener`). It's **read-only** (just deep links, no mutation),
  keyboard-accessible (the links are natively focusable; **Enter** follows them), and following a link
  never toggles the row's card — the rest of the row still expands. The **horizon** hulls and the
  **recent-voyages** rows are click-through the same way.
- **Expand on demand** — any voyage row **expands** into the full per-run **log card** below it and
  **collapses** again. It is **click + keyboard accessible** (each row is a `role="button"`,
  `tabindex="0"` with `aria-expanded`; **Enter**/**Space** toggles) and rows **expand independently**
  — open as many as you like. Expanded state is **preserved across the live poll** and pruned when a
  run leaves the fleet.
- **Graceful empty state** — an idle fleet shows a calm **"an empty harbour"**; an
  uncommissioned/failing `gh` shows **"no runs to chart"** with the degraded reason, exactly as the
  chart does.

The manifest **groups** are derived from the real voyage stages (see the mapping table below):
**queued** = Queued; **building** = Building; **reviewing** = PR opened + In review; **awaiting-merge**
= Awaiting merge; **done** = Merged + Shipped; and **blocked** overrides all of them for any blocked
run. The snapshot emits each run's `group` and a top-level `rollup` object (counts per group +
`inFlight` + `totalCost` + `costKnown` + `estIncluded` + `recent` + `shippedToday` + `waiting` +
`eligible` + `held`), **additively — schema 5** (an older snapshot is regrouped client-side against the
same rule; a schema-2 snapshot with no `recentRuns` simply shows no harbour lane; a pre-4 snapshot
without the cost estimate fields just shows recorded cost or `n/a`, never a wrong figure; a pre-5
snapshot without the `scheduler` block simply shows no horizon graph — the waiting runs stay in the
voyage list as before). The waiting-runs **`scheduler`** block (schema 5, #111) is documented under
**The horizon** below. **`estIncluded`** flags that `totalCost` folds in
non-final (estimated / accruing) figures, so the manifest caveats it (**`~$X · incl. live estimates`**)
rather than presenting a moving number as settled.

### Recent voyages — completed runs stay on the board (#113)

A run used to **vanish the moment it merged/shipped** — the dashboard only showed in-flight runs. Now
completed runs stay visible in a distinct **recent-voyages lane** below the in-flight runs: a "harbour"
of completed voyages, visually set apart (a **brass seam** down the left, ships **at anchor** — no bob),
matching the same ARMADA nautical theme.

- **Bounded recent-window scan (read-only).** In addition to the open/in-flight set, the driver scans a
  **bounded** window of recently **closed** issues (`gh issue list --state closed`) and **merged**/closed
  PRs (`gh pr list --state merged` / `--state closed`), filters them to the fleet (trigger label or an
  `armada:*` state label) and de-dupes against the in-flight set, so terminal runs have data to render.
  Every added query is a **read** — the read-only guarantee holds.
- **Bounded + configurable — nothing grows without limit.** A **cap** and a **time window**, resolved
  with the repo's precedence **`--flag` > env > `.armada/config.json` > default**:
  - `--recent-hours <N>` / `SPYGLASS_RECENT_HOURS` / `spyglass.recentWindowHours` — the time window
    (default **24**; `<=0` disables the time filter, leaving the cap as the sole bound).
  - `--recent-cap <N>` / `SPYGLASS_RECENT_CAP` / `spyglass.recentCap` — the max runs kept in the harbour
    (default **12**; `<=0` turns the recent lane **off** entirely and skips the closed/merged queries).
  Runs sort **newest-completed first**; the oldest **age out** past the cap or outside the window.
- **Accurate terminal outcome.** Each completed run shows **Merged / Shipped / Blocked**, derived from
  the **same state model** (`recentOutcome`, in lockstep with `stageForIssue` / `stageForPr`): a merged
  PR whose issue closed as completed → **Shipped**; `armada:merged` / a merged PR → **Merged**;
  `armada:blocked` or a PR **closed without merging** → **Blocked**. The expanded card adds an
  **outcome** row, a **merge-commit** link (`https://github.com/<repo>/commit/<oid>`, copyable), *when
  it landed* ("shipped 2h ago"), and the run's **final cost** from `out/costs/<run>.json` when present.
- **The roll-up counts shipped-today.** The manifest bar shows a **shipped today** gauge and the lane
  header reads *"N in the harbour · M shipped today · last Kh"*. `rollup.shippedToday` counts
  non-blocked terminal runs completed since local midnight. The gauge is a **celebratory ticker** (#127):
  when the count **rises** on a poll (a fresh landing), it **pops with a green flourish** for a moment
  before settling — so a merge lands with a beat of fanfare. First paint is calm (nothing to compare).
- **Live in-flight → harbour on merge.** On the existing poll, a run that merges **animates out** of the
  in-flight lane and into the harbour, earning the **"just shipped ⚓" glow** — plus a brief **celebratory
  pennant** that rises off the row (#127) — there (the transition is detected across both lanes), then
  **ages out** on a later poll. Expanded state is preserved across the
  hop. **Graceful empty states:** an idle fleet with recent arrivals shows the runs under a calm "no
  voyages under way" note; a truly empty board (no in-flight, no recent) shows **"an empty harbour"**.

### Each run expands to a log card

A dark two-column log card, the cost ledger below:

- **Left — the voyage** — the real stages, each with a **status dot** (done / active / upcoming, or
  blocked) and a one-line caption of what ARMADA actually does there. A ⛵ marker sits on the active
  leg (⚓ when shipped, ⚠ when blocked).
- **Right — the metadata panel** — the **issue / PR** deep links, the **branch** (with a copy action),
  the **worktree** and **folder** paths (each with open / copy-path actions), and an embedded **done
  video** player (the logbook walkthrough release asset, standard `<video controls>`). Every field
  **degrades gracefully** when absent (branch `n/a — not dispatched yet`, worktree `n/a — no local
  worktree`, "no walkthrough recorded yet").
- **Cost ledger** — one row per model with **MODEL · IN · OUT · CACHE R · CACHE W · ≈ COST**, a
  **phase banner** stating whether the figure is *estimating from elapsed* (in-flight, no usage yet),
  *recorded so far — accruing* (real-so-far, not final), or *final — reconciled at ship* (#115), plus a
  footer summarising **session / subagent / codex counts**, the *"API-equivalent estimate, not
  billing"* caveat, any **unpriced** models, and a pointer to `out/costs/<run>.json`. It reads that
  file **when present**; when absent for a still-building run it shows the elapsed-based estimate and a
  graceful empty state naming it.

### Stage mapping — ARMADA's real voyage stages from the `armada:*` labels

The seven stages are ARMADA's **genuine, observable** pipeline — every one is derivable from the
`armada:*` labels plus PR draft/CI/review sub-state (nothing invented, nothing the dashboard can't
detect). The active stage marks earlier stages **done** and later stages **upcoming**; `armada:blocked`
overrides the active dot to **blocked**. Kept in **lockstep** with `stageForIssue` / `stageForPr` /
`groupForStage` in `spyglass-run-snapshot.mjs`:

| Unit + state                                       | Active stage        | Group          |
| -------------------------------------------------- | ------------------- | -------------- |
| issue `armada` (armed, unclaimed)                  | **Queued**          | queued         |
| issue `armada:underway` (shipwright building)      | **Building**        | building       |
| issue `armada:done` / a **draft** PR               | **PR opened**       | reviewing      |
| ready PR carrying `armada`, not yet claimed        | **PR opened**       | reviewing      |
| PR `armada:reviewing` (muster review)              | **In review**       | reviewing      |
| PR `armada:reviewing` + `reviewDecision CHANGES_REQUESTED` | **In review** — status "Addressing" | reviewing |
| ready PR + `reviewDecision APPROVED`, not merged   | **Awaiting merge**  | awaiting-merge |
| `armada:merged` (gated merge landed)               | **Merged**          | done           |
| `armada:shipped` (closed; logbook + cartography)   | **Shipped**         | done           |
| any `armada:blocked`                               | *(approximate)* — **blocked** | blocked |

`Building` collapses shipwright's research → plan → implement → validate — the dashboard renders that
as the stage caption, **not** as sub-steps it claims to detect (labels don't expose sub-step state).
`In review` covers muster's 2-lens review and the shipwright address rounds; "Addressing" is the one
review sub-state we **can** observe (a change request on the PR). `Awaiting merge` is the
`ready_awaiting_human` terminal (reviewed + green, `autoMerge` off), distinguished by an APPROVED
review decision.

**`armada:blocked` is lossy — the approximation is documented, in lockstep.** crows-nest **drops the
prior state label** when it sets `armada:blocked` (see [pitfalls](../../.armada/cartography/pitfalls.md),
#106), so the exact last-reached stage isn't recoverable from labels. The dashboard approximates from
the unit **kind**: a blocked **issue** with no PR was `armada:underway` → **Building**; a blocked **PR**
reached the review pipeline → **In review**. The SKILL wording here and the `stageForIssue` /
`stageForPr` code state the **same** approximation (fixing the doc-vs-impl-lockstep defect #106 flagged).

### Cost post-mortem — produced by crows-nest, consumed here

The cost table shows **real numbers**, produced crows-nest-side by
`scripts/spyglass-cost-postmortem.mjs` at the reconcile points (crows-nest §8g): as each dispatched
subagent completes, crows-nest hands its token usage to the producer, which **accumulates** a per-model
breakdown into `out/costs/<run>.json` (keyed by the run's **branch**, else its issue number) with an
**API-equivalent cost estimate** (a heuristic — the fleet runs on subscriptions/relays, not per-token
API billing). The dashboard **reads** this shape (all fields tolerant/optional — missing values render
`n/a`):

```json
{
  "run": "109-live-cost-metadata-armada-theme",
  "models": [
    { "model": "claude-opus-4-8", "in": 41000, "out": 3704, "cacheRead": 124000, "cacheWrite": 49000, "cost": 0.67 },
    { "model": "gpt-5.4",         "in": 113000, "out": 6000, "cacheRead": 0, "cacheWrite": 0, "cost": null }
  ],
  "sessions": 1, "subagents": 3, "codex": 3,
  "matchMode": "heuristic", "unpriced": ["gpt-5.4"], "totalCost": 0.67,
  "final": true, "estimated": false, "updatedAt": "…"
}
```

The producer's baked price table reflects the models ARMADA truly uses — Claude **Opus** (build /
review) and **Sonnet** / **Haiku** at their per-1M API rates (cache-read ≈ 0.1×, cache-write ≈ 1.25×
input); **codex / GPT** (the codex-rescue second lens) is intentionally **UNPRICED** — its tokens are
shown but cost renders `n/a` and its id goes to `unpriced[]`. Cost is **re-priced from the accumulated
token axes** on every write, so repeated reconciles accumulate tokens without double-counting cost.
When the file is **absent**, the ledger shows an empty state and the footer still points at the
conventional `out/costs/<run>.json` path.

#### Estimated (in-flight) vs final (reconciled) — the `$0.00` fix (#115)

The producer only writes at crows-nest's **reconcile points**, and the harness surfaces a background
subagent's token usage **only in its completion notification** — there is no mid-build usage stream. So
a **currently-building** run has no `out/costs/<run>.json` yet and used to read a misleading **`$0.00`**.
Two things fix this, keeping the dashboard **strictly read-only**:

- **A `final` flag on the file (producer-side).** `final: false` = real usage **recorded so far**, but
  the run is still **accruing** (more at review / address / ship); the ship reconcile writes it with
  **`--final`** (crows-nest §8g.ii) to latch **`final: true`** = the settled figure. `estimated` is
  always **`false`** in the file — the recorded numbers are real; the file never holds an estimate.
- **A live elapsed-based estimate (read-only, driver + dashboard).** For a run that is **actively
  working** (Building / In review) with no reconcile file yet, the read-only driver derives an
  **estimate** from the one live signal available without any write — **elapsed build time** (the
  crows-nest dispatch clock, *not* the run's age, so idle queue time doesn't inflate it) × a coarse
  **burn rate** (`estRatePerMin`, resolved `--est-burn` > `SPYGLASS_EST_BURN_PER_MIN` >
  `spyglass.estBurnUsdPerMin` > default `~$0.03/min`; `<=0` disables it → the row reads `accruing…`).
  The snapshot carries `estRatePerMin` top-level so the **dashboard live-ticks** the estimate every
  second off `cost.costSince`, and it **converges to the real figure** the instant the producer writes
  real usage. Each run's cost object carries `final` / `accruing` / `estimated` / `estTotalCost`, and
  the fleet `rollup.totalCost` folds estimates in with `estIncluded: true` so the manifest caveats it.
  The estimate is a **display derivation** — never written back; the read-only guarantee holds.

The dashboard shows the phase everywhere: the compact row (`~$X est` / `accruing…` / `$X so far` /
final `$X`), a **phase banner** on the ledger card, and the caveated **fleet cost**. A **queued** run
(not yet building) shows `—`, not an estimate — nothing is burning yet.

**A completed run shows its final cost, or `—` — never a misleading `$0.00` (#121).** A
terminal (shipped / merged / blocked) run reads the **final** figure from `out/costs/<run>.json`
when a *priced* cost was recorded; when the file is **absent**, or present but has **no priced
usage** (an all-unpriced codex/gpt run — the producer writes `totalCost: null`, never a `0`
sum), the row degrades to a graceful **`—`**. The dashboard **never** renders `$0.00` for a
terminal run: a recorded total that is not a *positive* number is treated as no-data (`—`), and
a genuine sub-cent cost reads **`<$0.01`** rather than rounding to `$0.00`. This is enforced
**read-only, dashboard-side** — it holds whether or not the crows-nest producer finalised the
file (crows-nest §8g.ii finalises at ship where it can; the view degrades regardless).

### The horizon — a dependency-graph of the waiting runs (#111)

The overview shows what's **under way**; the **horizon** shows what's **waiting** and **why**. Instead
of a flat, ambiguous list of queued issues, the waiting runs render as a **dependency graph** — the
same cross-track dependency/conflict graph [`crows-nest`](../crows-nest/SKILL.md) builds every tick
(§2b/§2c) — so an operator sees at a glance **what's runnable now vs held behind a prerequisite**, and
the order the fleet will work them. It sits between the manifest and the in-flight voyages; the waiting
runs move **out** of the voyage list into the graph (no double-listing). Read-only, live-updating on the
poll, ARMADA-themed to match the overview.

- **Nodes = queued/held runs** (+ any still-in-flight prerequisite they wait on), laid out in
  **dependency-depth columns** (prerequisites left, dependents right). **Directed edges** are the §2b
  relationships: hard prerequisites (`depends on #N` / `blocked by #N`), **same-file** and
  **shared-lockfile** conflicts (serialise), and **base-about-to-move** — each styled (solid / dashed /
  dotted) with a legend, and an SVG arrowhead pointing at the prerequisite.
- **Accurate Eligible / Held status — NOT the mock's "Feasibility".** Each node shows a real status from
  the scheduler state: **Eligible** (armed, no unsatisfied edge — on the **runnable frontier**) or
  **Held**, carrying the **reason** verbatim from crows-nest §2e — *"waiting on #N"* / *"conflicts with
  #M on `<file>`"* / *"lockfile merge #M first"* / *"base #K merging first"* / *"queued: N/M builds in
  flight"*. A referenced prerequisite still in flight shows its own real stage (**Building** / **In
  review**).
- **The runnable frontier is visually distinguished.** Eligible hulls **glow brass** ("⛵ clear to
  sail"); held hulls are **dimmed with an amber seam** and their reason chips — "these can start now;
  those wait on these".

**Where the graph comes from — producer first, inference as graceful degrade.** The scheduler state
(edges + held reasons) is **crows-nest-internal**, not in GitHub labels. The producer that exposes it
read-only is `spyglass-cost-postmortem.mjs schedule` (crows-nest §2c/§8g), which writes
`out/costs/_schedule.json`; the **strictly read-only** driver **consumes** that file when present
(`source: "producer"`, authoritative). When it's **absent**, the driver does **not** fabricate — it
degrades to a **best-effort** graph inferred from the issue/PR bodies + file overlap it already
fetched (`source: "inferred"`, clearly badged **"best-effort graph"** on the panel), dropping ubiquitous
repo-meta files so prose overlap doesn't wire spurious edges. With **no** waiting runs the panel is
hidden; with waiting runs but **no** edges it degrades further to a **flat frontier list** ("every hull
is clear to sail"). It never renders a graph it can't substantiate.

The snapshot carries a top-level **`scheduler`** block (additive; `rollup` gains `waiting` / `eligible` /
`held`). Its shape — and the `_schedule.json` the producer writes — is:

```json
{
  "scheduler": {
    "present": true,
    "source": "producer",            // "producer" | "inferred" | "none"
    "note": null,                    // best-effort caveat when inferred
    "maxConcurrentBuilds": 3,
    "inFlightBuilds": 1,
    "nodes": [
      { "unit": "issue", "number": 142, "title": "Add CSV export",
        "waiting": true, "eligible": true, "held": false, "status": "Eligible",
        "reasons": [], "files": [] },
      { "unit": "issue", "number": 143, "title": "Wire the export button",
        "waiting": true, "eligible": false, "held": true, "status": "Held",
        "reasons": ["waiting on #142"], "files": [] }
    ],
    "edges": [
      { "from": 143, "to": 142, "kind": "depends", "file": null,
        "reason": "waiting on #142", "satisfied": false }
    ]
  }
}
```

The producer accepts the graph crows-nest built (`schedule --nodes-json … --edges-json … --max-builds N
--in-flight N`, or a whole doc on stdin) and writes exactly the `nodes` / `edges` the driver reads;
`kind` is one of `depends` / `same-file` / `lockfile` / `base`. Keep the schema in **lockstep** with
`buildScheduler` in `spyglass-run-snapshot.mjs`, `renderHorizon` in `spyglass-run-app.html`, and the
`schedule` subcommand in `spyglass-cost-postmortem.mjs`.

### ARMADA nautical theme + live motion

The dashboard matches the spyglass **sea-chart identity**: a brass / wood / deep-sea palette, a serif
**ARMADA** wordmark with an anchor, per-run **vessel iconography** (a sloop tinted by state), and the
**voyage** metaphor for the pipeline (harbour → open sea → port). Tasteful live motion — a thin animated
**sea swell** under the masthead, a **live-ticking elapsed** timer (updated every second, independent of
the 4-second poll), a bobbing ship marker on the active leg, a **"just shipped ⚓" glow** on a
merge/ship transition, and a **storm** cue (red vessel) when a run blocks. A couple of operator touches:
**sort** by furthest-along / cost / age, issue/PR **deep links**, **copy/open** on branch+worktree+folder,
and an optional **foghorn chime** on ship/block — **OFF by default** (an opt-in toggle; a dependency-free
WebAudio blast, no bundled audio asset). It stays legible with many concurrent runs and honours
**`prefers-reduced-motion`** (drops the swell/bob/glow, instant state changes).

### Degrades gracefully

Same posture as the chart (§5): an uncommissioned repo, an unauthenticated/failing `gh`, or no armed
issues/PRs all render a calm **"no runs to show"** empty state rather than crashing; the dashboard
honours **`prefers-reduced-motion`** (drops the active-dot glow).

### Version stamp + auto-reload — a new spyglass refreshes the tab itself

The snapshot carries an **`appVersion`** stamp — a short content hash of the shipped
`spyglass-run-app.html`, recomputed each snapshot (read-only, additive) — so a UI change ships a new
value. The app captures the `appVersion` it **booted** with on first load and, on each poll, compares
the fetched stamp to it; when it **changes**, the page **reloads itself** (a plain `location.reload()`,
preserving the served URL) after a one-poll debounce so a mid-deploy snapshot can't thrash. This is the
whole point for a **passive/streamed tab** (a YouTube/kiosk tab reached by a one-time `page.goto`, with
no interaction) and the local watch tab: both pick up a newly-shipped dashboard with **no manual F5 or
stream restart**. It's a **version-change** trigger only — an ordinary data poll never reloads — and it
**degrades safely**: if `appVersion` is absent (an older snapshot) the app data-polls exactly as before
and never reloads, so there is no reload loop.

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
  correlate + enrich + write + open driver (Node built-ins + `gh`/`git` only, dependency-free). Reads
  the crows-nest run→worktree map + cost post-mortem; **produces neither**.
- **`${CLAUDE_PLUGIN_ROOT}/scripts/spyglass-run-app.html`** — the self-contained, no-server
  ARMADA-nautical dashboard (vanilla HTML/CSS/JS, **no external/CDN libraries, no build step**). Copied
  next to its snapshot at run time so it can fetch `./run-state.json` locally with no server.
- **`${CLAUDE_PLUGIN_ROOT}/scripts/spyglass-cost-postmortem.mjs`** — the **crows-nest-side** cost
  post-mortem producer + run-map writer (crows-nest §8g). The one thing that WRITES the cost /
  in-flight-metadata the read-only driver consumes; it writes **only** under `out/costs/` (gitignored),
  never the tracked tree. Dependency-free.

The **only** files written at run time are the snapshots (`fleet-state.json` / `run-state.json`) and
the rendered HTML (`spyglass.html` / `spyglass-run.html`), in the scratch/output dir — never the
tracked repo.

### Dev-only sea-trial harness (not shipped into the view)

Because "beautiful" can't be asserted blind, a repeatable visual-regression harness ships alongside
the app for re-running the closed visual-feedback loop on demand (and on future spyglass changes).
It is **read-only** (it never touches GitHub or the repo) and writes only PNGs + a scratch copy of
the app into an output dir — it is **not** loaded into the rendered view:

- **`${CLAUDE_PLUGIN_ROOT}/scripts/spyglass-fixtures.mjs`** — deterministic synthetic **sea-chart**
  snapshots (`fleet-state.json`, schema 2: calm/1 unit, busy/choppy, storm-with-blocked, cartography
  on, narrow, empty) matching the same schema the snapshot script writes, for states the live fleet
  doesn't currently exhibit.
- **`${CLAUDE_PLUGIN_ROOT}/scripts/spyglass-run-fixtures.mjs`** — the equivalent for the per-**run**
  operations dashboard: a deterministic `run-state.json` (schema 4) covering every pipeline group
  (queued → building → reviewing → awaiting-merge → done), a **blocked** overlay, a **recent-voyages**
  lane, per-model **cost** breakdowns (final vs. accruing) and a **done-video**, so the run dashboard
  can be demoed/tested without hand-authoring one or hitting `gh`. A materialised copy is committed at
  **`scripts/fixtures/run-state.json`** — `node spyglass-run-fixtures.mjs --out <dir>` (or `--write`)
  writes only the `run-state.json`; serve that dir alongside a copy of `spyglass-run-app.html` (e.g. via
  `spyglass-trial.mjs`) to point the run app at it. READ-ONLY dev/test aid; not loaded into the live view.
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
