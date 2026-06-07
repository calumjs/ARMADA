---
name: crows-nest
description: >
  The ARMADA lookout. A single, maximally parallel scheduler that watches two tracks over a GitHub
  repo at once: a new-issue track that dispatches each labelled issue into the fleet to be built,
  and a ready-PR track that drives each labelled pull request through a review → address →
  re-validate → gated-merge pipeline. Runs as a recurring watch via /loop: each tick scans both
  tracks in one batched scan, builds a dependency/conflict graph spanning them, and dispatches every
  independent runnable unit — builds and reviews together — concurrently up to a bound, serialising
  only where a true dependency or file-level conflict forces it. Trigger when the user says "watch
  for issues", "start the crows-nest", "keep an eye on the backlog", "listen for new issues", "watch
  for ready PRs", "review and merge PRs", "man the lookout", or invokes /crows-nest. Accepts an
  optional trigger label (default from .armada/config.json, else "armada") and an optional poll
  interval.
argument-hint: "[label] [interval]"
allowed-tools: Bash, Read, Grep, Glob, Skill, Agent, Workflow, PushNotification
---

# crows-nest — a unified, maximally parallel scheduler for issues and PRs

`crows-nest` is ARMADA's entry point: the lookout that turns a GitHub backlog into a stream of
work for the fleet. It is **one scheduler running two tracks at once** — and each tick it does
**one round of unified triage**, not one item; `/loop` is what makes it run again and again
unattended:

> **One tick:** **scan both tracks in one batched scan** (armed issues *and* armed PRs) →
> **build a dependency/conflict graph spanning both** → **dispatch every independent runnable unit
> concurrently** — builds *and* reviews together, up to a bound — **hold** the rest with a reason →
> **report the unified schedule** → repeat.
>
> - **Issue track:** an eligible issue → [`shipwright`](../shipwright/SKILL.md) (or `flagship`)
>   builds it in a background, worktree-isolated subagent → a PR opens.
> - **PR track:** a ready PR → a [`muster`](../muster/SKILL.md) review → shipwright address →
>   re-validate → **gated** merge pipeline.

**The two tracks run together — concurrently — not one drained before the other.** Builds and PR
reviews are in flight at the same time, and within each track multiple units run at once (multiple
builds, multiple reviews), bounded by the concurrency caps. Serialisation is the **exception** a
dependency or a file-level conflict has to justify, never the default.

The unified scheduler is §2: §2a scans both tracks, §2b builds the cross-track graph, §2c schedules
for maximum parallelism, §2d dispatches issue builds, §2e reports. The ready-PR **pipeline** a
scheduled PR runs through is §3 and §4; closing the loop on shipped issues is §5. A single `/loop`
line arms the scheduler (§6).

## How the scheduler is wired (read this first)

These are constraints the design is built around:

1. **A skill cannot type `/loop` itself.** `/loop` is a built-in command and the Skill tool only
   runs skills — model text isn't executed as a command. So `crows-nest`'s job is to **compose the
   exact `/loop` line and hand it to you to run** (§6). Everything after that repeats automatically.
2. **Only act on the trigger label.** The lookout must never grab the whole backlog. It acts solely
   on open issues *and* PRs carrying the configured `triggerLabel` (default `armada`). No label →
   not its job.
3. **Claiming must be atomic-ish and visible.** Before dispatching, mark the unit claimed (a label
   swap/add + a comment) so a second tick — or a second human — doesn't pick up the same issue or
   PR. The claim labels (`armada:underway` / `armada:reviewing`) are the in-flight guard that makes
   concurrency safe: an already-claimed unit is invisible to every later tick, so a slow build or a
   long review never gets double-picked while it runs.
4. **Parallel by default, serial by exception.** The scheduler's job is to keep **as many
   independent units in flight as the bounds allow**, across both tracks at once. It serialises two
   units **only** when the cross-track graph (§2b) says it must — a true dependency, a same-file
   conflict, or a merge that would invalidate another in-flight PR's base. Everything else launches
   concurrently.
5. **Always bound — concurrency and the loop both.** Background fan-out is capped
   (`maxConcurrentBuilds` for builds, `maxConcurrentReviews` for reviews) so a busy backlog can't
   spawn an unbounded swarm; the overflow is held for later ticks. And pass `/loop` an interval and
   let the user stop it. A lookout that never sleeps and never reports is just noise.

## 1. Resolve config and scope

Read `.armada/config.json` from the target repo:

- `triggerLabel` — the label to watch (default `armada`).
- `dispatch` — how to hand off a claimed issue: `"shipwright"` (one build pass, default) or
  `"flagship"` (autonomous drive-to-merge loop).
- `baseBranch` — default base for new work.
- `commands` — the project's `build`/`test`/`lint` (the ready-PR pipeline re-validates with these).
- `authors` — optional allowlist of issue authors the lookout may act on (default `""` = anyone).
  Read it now; you apply it in §2a. Accepted forms:
  - **Blank / omitted / empty `""`** → the filter is **off**; process issues from anyone (current
    behaviour — existing setups are unaffected).
  - **A single username** — e.g. `"calumjs"` → only that author.
  - **A comma-separated list** — e.g. `"calumjs, dependabot[bot]"` → any author in the list
    (surrounding whitespace around each name is trimmed).
  - **A JSON array** — e.g. `["alice", "bob"]` → same as the comma-separated form. The string form
    is the documented/primary shape; the array is accepted for convenience.
- `autoMerge` — whether the ready-PR pipeline may perform the final merge. **Default `false`**: with
  it off the pipeline reviews, addresses, and re-validates but **stops before merging** (§4.5). Only
  `true` lets the lookout merge, and only when every other gate passes. See [Safety](#7-stopping-and-safety).
- `notify` — the **ship's bell**: which terminal/exception fleet events emit a one-line
  `PushNotification`, so you're *told* what the fleet did instead of polling labels. One of
  `"off" | "blocked" | "terminal" | "all"`, **default `"terminal"`**:
  - `"off"` — never notify (silent; back to watching labels by hand).
  - `"blocked"` — only when a unit hits `armada:blocked` (the event you most need to hear about).
  - `"terminal"` *(default)* — **shipped + blocked**: a PR merged / an issue shipped, **and** any block.
  - `"all"` — the terminal events **plus** the optional progress events: "build opened a PR" and
    "reviewed & awaiting human merge" (§8).

  Read it now; you ring the bell at the reconciliation points (§2d, §3e, §5), all governed by the
  single ship's-bell convention in §8.
- `bellCommand` — an **optional local command hook** the ship's bell runs **in addition to**
  `PushNotification`, at the **same** reconcile points (§2d, §3e, §5) and gated by the **same**
  `notify` level. A string; **default `""` (off)** — nothing runs unless the operator opts in, so
  existing setups are unchanged. It exists because `PushNotification` is **suppressed whenever the
  terminal has focus** (it suppresses *both* the desktop notification *and* the mobile push), so an
  operator sitting on the `/loop` gets nothing on a merge or block; a local command closes that gap
  with a focus-independent, optionally-audible alert. When set, crows-nest runs it via its `Bash`
  tool with the bell line as an argument and the event exposed via env vars — best-effort, bounded,
  side-channel, never able to block or fail the tick. The full convention (the arg/env contract, the
  platform examples, the discipline) is §8e. Read it now; you fire it everywhere the bell rings.
- `cartography` — gates [`cartographer`](../cartographer/SKILL.md), which learns *per-repo* heuristics
  from completed runs into `.armada/cartography/`. One of `"off" | "proposal" | "on"`, **default
  `"off"`**: at the **same reconcile points** the bell rings (§2d, §3e, §5) the lookout **records**
  each completed run into a pending accumulator, then — under the **same best-effort side-channel
  discipline** (§8c) — dispatches cartographer **once per fleet-run at an idle point** over the whole
  batch (a single, serial writer), so a busy backlog gets **one** cartography update, not one per
  reconcile. Active **only when this key is not `"off"`**. Default `"off"` = never auto-runs (manual
  `/cartographer` still works); `"proposal"` = batches then only proposes a diff; `"on"` = batches
  then commits one learning into the active PR. The full convention is §8d.
- `lighthouse` — gates [`lighthouse`](../lighthouse/SKILL.md), the fleet's autonomous **reconnaissance**:
  it surveys the repo for *future* work and charters it (unarmed). A block with `enabled` (**default
  `false`** = opt-in), `autoArm` (default `false`), the trigger thresholds (`intervalHours`,
  `commitsSinceScan`, `minIdleToDispatch`) and a `budget`. The lookout dispatches lighthouse as
  **opportunistic, low-priority background work** — **only** when `enabled` is true, the runnable
  frontier is free (existing build/review work always wins), **and** a trigger condition holds. It's a
  fire-and-forget background dispatch under the same best-effort discipline as cartographer; it never
  preempts real work or holds a tick. The full convention is §2f.
- `maxConcurrentBuilds` — how many background **builds** (issue track) may be in flight at once
  (**default 1**). The autonomous path dispatches builds in the background (§2d), so a tick never
  blocks on one; this caps how many run in parallel and queues the overflow. Default 1 = one build
  at a time (still non-blocking); raise it to fan out across more isolated worktrees.
- `maxConcurrentReviews` — how many background **review→merge pipelines** (PR track) may be in
  flight at once (**default 1**). The scheduler launches PR pipelines in the background too (§3/§4),
  so a tick never blocks on one; this caps how many PRs are driven concurrently and queues the
  overflow. Default 1 = one pipeline at a time (still non-blocking); raise it to review several PRs
  at once. This is **independent of** `maxConcurrentBuilds` — builds and reviews each have their own
  budget, so the issue track and the PR track run **concurrently**, neither starving the other.
  (Each `muster` review already fans its two lenses out in parallel internally; this bound is on top
  of that — how many *PRs* are reviewed at once.)

**If the config or the labels are missing, the repo isn't commissioned** — run the
[`commission`](../commission/SKILL.md) skill first (it detects commands, writes the config, and
creates the labels), then continue. Don't fall back to silent defaults: an uncommissioned repo
usually has no `armada` label, so the watch would find nothing and look broken.

Confirm the watch parameters with the user **once** before arming the loop — label, dispatch
target, interval, and the claimed-state convention below. This is the only human checkpoint, so
make it count.

### Claimed-state convention

The lookout tracks state purely through labels so it survives restarts. There are **two label
tracks** — one for issues moving through the build, one for PRs moving through the review pipeline:

**Issue track (the new-issue watch, §2):**

- `armada` — eligible, not yet picked up.
- `armada:underway` — claimed; a tick is building it (or it has an open branch/PR).
- `armada:done` — a PR has been opened (set by the dispatched skill / on handoff). **Not terminal**:
  the issue stays open until its PR merges and its acceptance criteria are confirmed.
- `armada:shipped` — **terminal.** The linked PR merged *and* the acceptance criteria are satisfied;
  the close-the-loop watch (§5) closed the issue. Created by [`commission`](../commission/SKILL.md).
- `armada:blocked` — the fleet gave up; needs a human. Skipped by future ticks.

**PR track (the ready-PR watch, §3):**

- `armada` — on a PR, shipwright **auto-arms** by adding this when it opens the PR (no manual
  PR-arming step); it marks the PR as in-fleet and eligible for the review pipeline. Only PRs ARMADA
  itself opens are auto-armed — arbitrary human PRs are left alone unless a human arms them. (Same
  arming switch as issues: remove it to disarm.)
- `armada:reviewing` — claimed by the ready-PR watch; a review → address → verify → merge pipeline
  is running against it. Mid-pipeline PRs are skipped by future ticks (the idempotency guard).
- `armada:merged` — the pipeline merged it. Only ever set when `autoMerge` is enabled **and** every
  gate passed.
- `armada:blocked` — the pipeline stopped and needs a human: a blocking finding, red CI, no
  convergence within the bounded loop, or a non-`mergeable`/branch-protection failure. (With
  `autoMerge` off, a reviewed-and-green PR is **not** blocked — that's the `ready_awaiting_human`
  terminal of §3e/§4.5, which keeps `armada` and never adds `armada:blocked`.)

`armada:reviewing`, `armada:merged`, and the issue-track terminal `armada:shipped` are all created
by [`commission`](../commission/SKILL.md) alongside the other labels.

## 2. One tick of the unified scheduler

Each tick scans **both tracks at once**, graphs them **together**, dispatches every independent
runnable unit it can — builds *and* reviews, concurrently, up to the bounds — holds the rest with a
reason, reports the unified schedule, and **returns** (it never blocks on an in-flight build or
review). The steps:

> **2a** scan both tracks (one batched scan) → **2b** build the cross-track dependency/conflict
> graph → **2c** schedule for maximum parallelism → **2d** dispatch issue builds (and §3 dispatches
> PR pipelines) → **2e** report.

### 2a. Scan both tracks in one batched scan

Pull armed issues *and* armed PRs together, in as few `gh` calls as possible — one issue list and
one PR list per tick, each `--json`-projected so the whole scan is two round-trips, not a fan of
per-item calls:

```bash
gh issue list --label "<triggerLabel>" --state open \
  --json number,title,labels,createdAt,assignees,author,body --limit 50
gh pr list --label "<triggerLabel>" --state open \
  --json number,title,isDraft,labels,headRefName,baseRefName,files,body,mergeable,statusCheckRollup,updatedAt --limit 50
```

Project everything the graph (§2b) and the eligibility gates need in these two calls — including
PR `files` (for same-file conflict detection) and `body` (for explicit dependency signals) — so the
graph is built **once** from this single scan, with no redundant round-trips per item.

**Issue eligibility.** Filter **out** any issue that is already:
- labelled `armada:underway`, `armada:done`, or `armada:blocked`, **or**
- has an open PR that references it (detectable from the PR `body` set already pulled above —
  no extra `gh pr list --search` round-trip needed), **or**
- already has a worktree/branch named for it locally.

**PR eligibility** is the ready-PR gate from §3a — open, not draft, carries `<triggerLabel>`, CI not
failing, and not already `armada:reviewing` / `armada:merged` / `armada:blocked`. Evaluate it here
against the same scan rather than re-listing.

Those dedup checks keep the loop idempotent — a tick that fires while a previous build or review is
still running must not double-pick. An already-claimed unit (`armada:underway` / `armada:reviewing`)
is filtered out here, so it stays invisible to every intervening tick until its background dispatch
completes and reconciles (§2d / §3e).

#### Author allowlist

After the dedup filter above, apply the `authors` allowlist from §1 (config → `authors`):

- **If `authors` is blank / omitted / empty (`""`) → skip this filter entirely** and process
  everyone. This is the default and means existing setups behave exactly as before.
- Otherwise, normalise `authors` into a list of allowed logins:
  - a string → split on commas and trim whitespace around each name (`"calumjs, dependabot[bot]"`
    → `["calumjs", "dependabot[bot]"]`);
  - a JSON array → use its elements as-is (after trimming);
  - drop any empty entries that result.
- Keep an issue only if its `issue.author.login` matches an allowed login **case-insensitively**
  (lower-case both sides before comparing, so `"CalumJS"` matches `"calumjs"`).
- Issues whose author isn't in the allowlist are **excluded from this tick but left untouched** —
  do **not** label them `armada:blocked` (they aren't broken; they're just out of scope for this
  operator). They keep their `triggerLabel` so a different policy could pick them up later. You may
  log them **at most once** per tick for visibility, e.g.
  `crows-nest: 2 issue(s) skipped (author not in allowlist)` — don't comment on the issues
  themselves and don't repeat the note every interval.

This is a second gate on top of the trigger label: the label decides *which* issues are in play;
`authors` decides *whose* issues the lookout will act on.

### 2b. Build the cross-track dependency/conflict graph

From the single scan (§2a), build **one graph over both tracks at once** — issues and PRs are nodes
in the same graph, because a dependency can cross tracks (a PR can depend on an issue's build, an
issue can extend a PR). The graph's edges are the **only** thing that forces serialisation; absent
an edge, two units are independent and run concurrently. Derive edges from:

- **Explicit signals** (cheap, unambiguous — read from the `body` text already pulled in §2a):
  - `depends on #N`, `blocked by #N`, `extends #N`, `builds on #N`, `after #N` → a hard
    prerequisite edge: this unit can't start until `#N`'s work has landed.
  - GitHub's own linked-issue / linked-PR references and "Closes #N" relationships.
- **Implicit signals** (judgment — inferred, stated as the *reason* so it's auditable):
  - **Same file/skill surface (conflict-prone).** Two units that touch the **same files** are
    conflict-prone; building both in parallel risks a merge conflict. Use issue text/paths and PR
    `files` from §2a to detect overlap. A same-file edge **serialises** the pair (build one, let it
    land, then the other rebases cleanly) rather than racing them.
  - **Foundation work others build on.** A unit that lays a base others extend (data model, shared
    surface) is a prerequisite for its dependents even without an explicit `depends on`.
  - **A PR whose base is about to move.** If an in-flight merge will change another open PR's base
    branch, that PR's review/merge should wait for — or be re-based after — the merge, so it isn't
    reviewed against a base that's about to shift. This is a cross-unit edge from the merging PR to
    the dependent PR.

Record each edge with its **reason** (`explicit: depends on #N` / `implicit: same file
skills/foo/SKILL.md` / `implicit: base #12 about to move`). The reason is what §2e reports for held
units and what makes a judgment call reviewable rather than opaque.

**FIFO fallback when there are no signals.** If a unit has no edges, it's independent — there's
nothing to order it against, so it falls back to plain FIFO (issues oldest-first on `createdAt`, PRs
oldest-update-first on `updatedAt`), exactly as before. The graph only *adds* ordering where a
signal justifies it; with no signals at all the scheduler degrades to the original FIFO behaviour.

### 2c. Schedule for maximum parallelism across both tracks

Walk the graph and select the **runnable frontier**: every unit with **no unsatisfied prerequisite
edge** (its dependencies have landed) and **no same-file conflict with a unit already in flight**.
Then **de-conflict the frontier against itself**: if two selected candidates share a same-file
conflict edge, they must not be dispatched in the same tick — keep the FIFO-earlier one (or the
priority unit) and **hold the other** with reason `implicit: same file <path>` (§2e), so a
same-file pair is never dispatched concurrently whether the other side is already in flight *or*
merely a co-candidate this tick. The surviving frontier is dispatched **concurrently**, across both
tracks at once, up to the per-track bounds:

- **Issue builds** fill up to `maxConcurrentBuilds` (minus builds already in flight) — §2d.
- **PR review→merge pipelines** fill up to `maxConcurrentReviews` (minus pipelines already in
  flight) — dispatched via §3 as background Workflows.

The two budgets are **independent**, so builds and reviews run **at the same time** — the issue
track is never drained before the PR track starts, and neither starves the other. Within a track,
the frontier is ordered FIFO (oldest-first) and priority labels (`priority`/`P0`) jump the queue.

**Order merges to minimise forced rebases.** When the frontier holds several PRs that *will* merge,
order them so a merge that changes another PR's base lands **first**, and PRs sharing a file are
sequenced rather than merged in a race — so each subsequent PR rebases against an already-updated
base instead of being invalidated mid-flight. (The actual rebase, when needed, is the pipeline's
make-mergeable stage, §4.4b; the scheduler's job is just to *order* the merges to minimise it.)

**Hold the rest, with a reason.** Every unit **not** on the frontier is **held** — not dropped:
- **blocked by a prerequisite** → "waiting on #N" (the edge from §2b);
- **same-file conflict with an in-flight unit** → "conflicts with #M on `<file>`";
- **base about to move** → "base #K merging first";
- **over the bound** → "queued (N/​M builds|reviews in flight)".

Held units keep their current labels (an undispatched issue stays on `<triggerLabel>`, an
undispatched PR stays eligible) so a later tick re-evaluates them once the blocker clears. **A held
unit is never lost and never silently skipped** — it's reported in §2e with its reason, and the loop
picks it up next interval when its prerequisite has landed or a slot frees.

If the frontier is empty and nothing is in flight, log `crows-nest: horizon clear · harbour clear`
and return — the loop checks again next interval. Don't invent work to look busy.

### 2d. Dispatch the scheduled issue builds

For each issue on the frontier (§2c), within the `maxConcurrentBuilds` budget:

#### 2d.i Claim it

```bash
gh issue edit <number> --add-label "armada:underway" --remove-label "<triggerLabel>"
gh issue comment <number> --body "🔭 crows-nest: picked up by ARMADA — dispatching to <dispatch target>."
```

#### 2d.ii Dispatch it

Hand the claimed issue to the dispatch target. **How** you dispatch depends on whether the tick is
running autonomously or under a watching human — the two modes trade approval gates for context
isolation:

- **Autonomous (`/loop`) path — dispatch into a *background* subagent.** When the tick is firing
  under `/loop`, the lookout commands and a subagent works. Spawn the dispatch target (`shipwright`,
  default — or `flagship` when that ship is in the fleet) via the **`Agent` tool**, non-interactive,
  with `isolation: "worktree"` **and `run_in_background: true`**. The build (worktree → implement →
  validate → open PR) takes many minutes; running it in the background means the tick **kicks off
  the build and returns immediately** instead of blocking the whole `/loop` tick until the build
  finishes. The subagent runs in **its own context and its own worktree**, so the lookout never
  carries the build transcript and concurrent builds don't fight over files. This keeps the watch
  live — the lookout goes straight back to watching (and may dispatch other frontier issues up to
  `maxConcurrentBuilds`, §2c, plus PR pipelines up to `maxConcurrentReviews`) — keeps it cheap and
  legible across hundreds of ticks, and is the
  multi-agent shape ARMADA is named for. A slow or stuck build no longer freezes the loop: it runs
  off to one side while ticks keep firing. The completion is handled **asynchronously** when the
  background build returns its structured result — see *Reconciling a background completion* below.

  **If `isolation: "worktree"` is unavailable, fall back to a manual worktree — don't lose
  isolation.** The Agent tool's worktree isolation can fail (e.g. *"not in a git repository …
  configure WorktreeCreate hooks"* when the repo was created mid-session). When it does, **do not**
  silently dispatch the build into the shared checkout — that lets concurrent builds trample one
  tree. Instead, have the dispatch target create an **isolated worktree by hand** and work there,
  exactly as [`shipwright`](../shipwright/SKILL.md) §4(b) describes: branch off the **remote** base
  and remove the worktree on completion —

  ```bash
  git fetch origin <baseBranch>
  git worktree add -b <number>-<short-description> <worktree-path> origin/<baseBranch>
  # … build in <worktree-path> …
  git worktree remove <worktree-path> || git worktree remove --force <worktree-path> || true
  git worktree prune
  ```

  **On Windows, pass a forward-slash, sibling worktree path** (`../<n>-<desc>` or
  `C:/.../<n>-<desc>`) — a backslash path (`C:\…\wt-2`) gets mangled by the shell and creates the
  worktree **nested inside the repo** instead of as a sibling, and cleanup must tolerate Windows
  file-lock leftovers (best-effort `remove --force` then `prune`). Either way — Agent isolation or
  the manual fallback — the build runs in **its own worktree**, so the isolation guarantee holds.

- **Supervised single pick — run inline.** When a human asked for one named issue ("crows-nest,
  grab #142"), run [`shipwright`](../shipwright/SKILL.md) **inline in this turn** so the user keeps
  its approval gates — the plan sign-off (§3 of shipwright) and the base-branch choice (§1a of
  shipwright). No subagent, because a subagent can't pause to ask.

**The subagent runs `shipwright` non-interactively.** It cannot pause to ask the user, so
shipwright's approval gates collapse to **sensible defaults** (accept the plan, take the default
base branch) rather than prompts. Two guards survive non-interactively and must **not** be
defaulted away:
- **Base branch** — use `baseBranch` from `.armada/config.json` (shipwright §1a's logic still applies
  if the issue's target code lives only on a feature branch; pick the safe base, don't merge to resolve it).
- **No destructive migrations** — never run a data-destructive schema/data migration unattended;
  if the only path forward needs one, return `blocked` rather than guessing.

#### Subagent return contract

The subagent reports back a single structured result the lookout maps to labels:

```json
{
  "issue":  142,
  "pr":     "https://github.com/<org>/<repo>/pull/150",
  "branch": "142-add-csv-export",
  "status": "opened",            // "opened" | "blocked"
  "reason": "one-line summary or, when blocked, why a human is needed"
}
```

#### Reconciling a background completion

On the autonomous path the result arrives **asynchronously**, not inline: the tick that dispatched
the build has long since returned, so the reconciliation runs when the background build **completes**
(the `Agent` tool surfaces its return). Until then the issue stays `armada:underway` — the in-flight
guard (§2a) already keeps that issue out of every intervening tick, so a long build simply sits
`armada:underway` while the watch keeps ticking on the rest of the backlog. When a background build
finishes, crows-nest takes its structured result and maps it to the claimed-state labels and the
issue comment.

**crows-nest — the foreground lookout — owns every host-issue comment.** A dispatched subagent
(`shipwright` build, the review pipeline) **never** comments on the issue it was handed; it returns
its structured result and the lookout posts the issue comment here, exactly as it reconciles labels.
This is deliberate: a subagent commenting on an issue it didn't open is an external write the
harness's auto-mode classifier consistently **denies**, so the comment failed on essentially every
dispatched build and littered run summaries with "issue-comment blocked by classifier" noise. Because
the foreground lookout already posts the same comment from the subagent's result, the subagent's call
was both blocked *and* redundant — so it's gone. (Host-issue comments only — the pipeline still posts
PR comments on its *own* PR; those aren't classifier-blocked.) Map the result like so:

- `status: "opened"` → `gh issue edit <issue> --add-label "armada:done" --remove-label "armada:underway"`,
  then `gh issue comment <issue> --body "🔭 crows-nest: PR opened — <pr>"`. **Ring the bell** for the
  *opened* event (§8) — fired **only** when `notify: "all"`: `⚓ #<issue> → PR opened: <pr>`.
- `status: "blocked"` → `gh issue edit <issue> --add-label "armada:blocked" --remove-label "armada:underway"`,
  then `gh issue comment <issue> --body "🔭 crows-nest: blocked — <reason>"`. **Ring the bell** for the
  *blocked* event (§8) — fired when `notify` is `"blocked"`, `"terminal"`, or `"all"`:
  `⛔ #<issue> blocked: <reason>`.

Each ring here is **both** channels of the bell: the `PushNotification` *and*, when `bellCommand` is
set, the local command hook (§8e) — the *opened* ring fires the hook with `ARMADA_BELL_EVENT=opened`,
the *blocked* ring with `ARMADA_BELL_EVENT=blocked`. Both run under the same `notify` gate and the
same best-effort discipline (§8c); fire them only after the label swap and comment above have landed.

Either way the issue leaves `armada:underway`: never leave one stuck there, or it's invisible to
both the lookout and a human. (On the inline path — the supervised single pick — the running
shipwright is foreground and opens the PR directly in the turn; apply the same label swap and
comment from its outcome.)

After this reconcile — and after the bell rings — **record this run for the batched cartography
pass** if the `cartography` key isn't `"off"` (§8d): append the just-opened PR to the pending
accumulator (§8d.i). cartographer is **not** dispatched here — it runs **once per fleet-run** at an
idle point (§8d.ii), so a busy backlog doesn't emit one cartography PR per build. Recording is cheap
and synchronous; it never blocks or fails this reconcile.

#### Concurrency is bounded, not unbounded — per track

Background dispatch is what lets the lookout run several builds *and* several reviews at once without
blocking, and worktree isolation is what makes that safe — each subagent works in **its own
worktree**, so concurrent units don't trample a shared tree. But background fan-out must still be
**bounded**, or a busy backlog could spawn an unbounded swarm. Each track has its **own** cap, so
the two run concurrently without either starving the other:

- `maxConcurrentBuilds` (config, **default 1**) caps background **builds** (issue track): a tick
  dispatches up to `(maxConcurrentBuilds − builds-in-flight)` frontier issues and **holds the rest**
  for later ticks (they keep their claim state — an undispatched issue stays on `<triggerLabel>`,
  only a dispatched one moves to `armada:underway`).
- `maxConcurrentReviews` (config, **default 1**) caps background **review→merge pipelines** (PR
  track): a tick launches up to `(maxConcurrentReviews − reviews-in-flight)` frontier PRs (§3) and
  holds the rest (an undispatched PR stays eligible; a claimed one moves to `armada:reviewing`).

With both defaults at 1 the behaviour is one build *and* one review at a time — sequential within
each track, but the two tracks still run **together**, and every dispatch is non-blocking so the
watch never freezes behind one. Raise either cap to fan that track out across more isolated
background subagents.

shipwright's **own** internal fan-out — the parallel slices of a stacked PR series (shipwright §3b,
[references/stacked-prs.md](../shipwright/references/stacked-prs.md)) — should likewise spawn its
slice builders as **background** agents rather than blocking serially on each, for the same reason:
one slice shouldn't stall the others.

### 2e. Report the unified schedule

Print a one-line summary so the loop's history is legible. On the autonomous path the tick reports
what it **dispatched** across **both tracks** plus what it **held and why** (a dispatched build's PR
isn't known yet — that lands later via the completion reconcile, §2d; a dispatched review's outcome
lands via §3e):

```
crows-nest tick: 5 units (3 issues, 2 PRs) · dispatched build #142 "Add CSV export" + review #150 "Fix auth" (background) · held: #143 (waiting on #142) · #151 (base #150 merging first) · #144 queued (1/1 builds in flight) · watch live
```

The schedule line must always surface three things: **builds running**, **reviews running**, and
**held + why** — so a glance at the loop history shows the full picture across both tracks. Separate
lines are logged when a background unit completes and is reconciled:

```
crows-nest: #142 build completed → PR #150 opened (armada:done)
crows-nest: #150 review pipeline completed → merged (armada:merged)
```

### 2f. Opportunistic background recon — dispatch lighthouse when capacity is free

Every dispatch above is **reactive** — it acts on work a human already filed (issues) or a PR that
already exists. [`lighthouse`](../lighthouse/SKILL.md) is the fleet's **proactive** ship: it surveys
the repo for *future* work and charters it. crows-nest can dispatch it **autonomously**, but **only
as the lowest-priority, spare-capacity background activity** — it must **never** preempt, block, or
compete with real build/review work, and **never hold a tick**. It is a fire-and-forget background
dispatch under the **identical best-effort/side-channel discipline as cartographer (§8d) and the
ship's bell (§8c)**: bounded, never fatal, reconciled when it returns.

Dispatch lighthouse on a tick **only when every one of these holds**:

1. **`lighthouse.enabled` is `true`.** Read the `lighthouse` block from `.armada/config.json`
   (§1). **Default `false`** → crows-nest **never** auto-dispatches lighthouse (manual `/lighthouse`
   still works for a human any time). This is the master switch, exactly like `cartography` and
   `autoMerge` — off by default, opt-in.
2. **Existing work always wins — the runnable frontier is free.** Dispatch lighthouse **only** when
   the frontier this tick is empty: **horizon clear · harbour clear** (§2c — no issue build and no PR
   review is runnable *or* in flight). This is the hard, non-negotiable invariant: if **any** build or
   review is runnable or in flight, **skip or defer lighthouse this tick**, full stop. There is **no**
   "utilisation below a threshold" relaxation — lighthouse is the last thing the fleet does, never a
   competitor for a concurrency slot, so it runs only when both tracks are fully quiet. The
   `lighthouse.minIdleToDispatch` flag is the **boolean guard** for this rule (commission writes it as
   a boolean, default `true`): left `true`, auto-dispatch requires the frontier fully idle as above.
   The default is the only supported value — the flag exists so an operator can explicitly *tighten*
   the gate, never loosen it; nothing about it ever permits lighthouse to run while a build or review
   is runnable or in flight. lighthouse uses **no** `maxConcurrentBuilds` / `maxConcurrentReviews`
   budget; it only ever runs when those tracks are quiet.
3. **A trigger condition holds — there's a reason to survey.** Idle alone isn't enough. Dispatch only
   when at least one of these is true (cheap to check from `git`/`gh` state):
   - `lighthouse.intervalHours` has elapsed since the **last lighthouse run** (track it via the last
     lighthouse-filed issue's timestamp, or a recon marker);
   - `lighthouse.commitsSinceScan` commits have landed on `baseBranch` since the last scan;
   - a **major merge/release** just completed this tick (a PR reached `armada:merged`, §3e).

When all three hold, dispatch lighthouse exactly like the §2d/§8d background subagents — via the
`Agent` tool with `run_in_background: true`, in its own context, **after** the tick's consequential
work has landed — and **return immediately**; the tick never waits on it. lighthouse files its
(unarmed, `--no-arm`) backlog issues itself and reports; crows-nest does **not** claim, arm, or
relabel anything for it. If lighthouse errors, finds nothing, or isn't available, the tick is
**completely unaffected** — swallow any failure (log at most once, prefixed `crows-nest recon:`) and
carry on. A failed recon never turns a green tick red, and lighthouse's generated issues stay
**unarmed** unless `lighthouse.autoArm` is on (lighthouse §5c) — so nothing it discovers is ever
auto-built without a human arming it.

**Why opportunistic and not on a timer:** binding lighthouse to free capacity means the fleet only
spends cycles *generating* work when it has no *committed* work to do. The instant a real issue or PR
appears, the next tick's frontier is non-empty and lighthouse is skipped — existing work wins, every
time.

## 3. The PR track — dispatch ready PRs into the review→merge pipeline

The PR track is **not a separate tick** — it's scheduled in the same unified tick as the issue track
(§2), from the same batched scan. For each **PR on the frontier** (§2c) the scheduler claims it and
launches its review→merge pipeline (§4) as a **background** Workflow, then returns. PR pipelines run
**concurrently with issue builds and with each other**, bounded by `maxConcurrentReviews` — the
lookout doesn't drain the issue track before starting reviews.

The full track — eligibility (§3a), selection (§3b), claim (§3c), background dispatch (§3d), outcome
reconciliation (§3e), and reporting (§3f) — lives in
**[references/ready-pr-watch.md](references/ready-pr-watch.md)**. The shape to keep in mind:

> A ready PR (open, not draft, carries `<triggerLabel>`, CI not failing, not already mid-pipeline) is
> claimed `armada:reviewing`, driven through the §4 pipeline as a background Workflow, then reconciled
> on completion to `armada:merged` / `ready_awaiting_human` / `armada:blocked` — a PR is **never** left
> on `armada:reviewing`.

**Ring the ship's bell on the PR track's terminal outcomes** (§8) when reconciling a completed
pipeline (§3e):

- `armada:merged` → a *shipped* event: `⚓ Shipped: PR #<pr> merged` — fired when `notify` is
  `"terminal"` or `"all"`.
- `armada:blocked` → a *blocked* event, **with the reason**: `⛔ PR #<pr> blocked: <reason>` — fired
  when `notify` is `"blocked"`, `"terminal"`, or `"all"`.
- `ready_awaiting_human` is **not** a terminal failure and **not** a routine clear — it's a
  green-but-gated stop. Treat it as a *blocked-class* "needs a human" event for the bell: ring it
  only at `notify: "all"` (`🔔 PR #<pr> ready — awaiting human merge`), and stay silent at the
  narrower levels so a deliberate `autoMerge: false` setup isn't pinged on every green PR.

Each of these rings fires **both** bell channels — the `PushNotification` *and*, when `bellCommand`
is set, the local command hook (§8e), under the same `notify` gate. Map the event to
`ARMADA_BELL_EVENT`: `shipped` for the merged ring, `blocked` for the blocked ring, `awaiting` for
`ready_awaiting_human`. Fire the hook only **after** the pipeline's consequential action (the merge,
the label swap, the comment) has already landed — never before (§8c).

After reconciling a completed pipeline — and after the bell rings — **record this PR for the batched
cartography pass** if the `cartography` key isn't `"off"` (§8d): append it to the pending accumulator
(§8d.i). The addressed PR's muster + human review comments are the richest correction evidence, but
cartographer is **not** dispatched here — it runs **once per fleet-run** at an idle point (§8d.ii)
over the whole batch, so concurrent pipelines don't each spawn a racing cartography update on the
same `.armada/cartography/` files. Recording is cheap and synchronous; it never blocks or fails this
reconcile.

## 4. The review→merge pipeline (a Workflow)

A scheduled PR (§3) runs through a deterministic **Workflow**: **parallel review fan-out → consolidate
→ address → verify → make-mergeable → gated merge → reap merged branch**, with explicit state between
stages and a single terminal result. It implements the **parallel-reviewers + dedupe** pattern that
[`muster`](../muster/SKILL.md) specifies — but because this pipeline is itself dispatched as a
**subagent** (and a subagent can't spawn nested agents), the **pipeline launches muster's two lenses
as two *top-level* agents** and consolidates them, rather than dispatching one `muster` subagent that
tries (and fails) to fan out into a single-lens/degraded review ([#76](https://github.com/calumjs/ARMADA/issues/76)).

**This Workflow is bundled as a script, not prose the model re-derives each tick** — that's what
makes it deterministic and keeps only its *output* in the lookout's context:

- **`${CLAUDE_PLUGIN_ROOT}/scripts/review-merge-pipeline.mjs`** fans out the **two review lenses**
  (`code-review` + `codex:codex-rescue`) as top-level agents and `shipwright` via `agent()` with
  **structured-output schemas**, consolidates the lenses (naming any degrade), runs the bounded
  address↔review loop, make-mergeable, and the gated merge.
- **`${CLAUDE_PLUGIN_ROOT}/scripts/merge-gate.mjs`** computes the merge decision (`merge` |
  `ready_awaiting_human` | `blocked`) **from the run-state JSON** — the model acts on its output and
  never eyeballs the 5-point gate. (Bundled files are referenced via `${CLAUDE_PLUGIN_ROOT}` because
  plugins are copied to a cache, so relative paths break.)

The full pipeline — review (§4.1), address (§4.2), verify (§4.3), the bounded address↔review loop
(§4.4), make-mergeable / auto-rebase (§4.4b), and the gated merge (§4.5) — lives in
**[references/review-merge-pipeline.md](references/review-merge-pipeline.md)**. The gates that matter:

> Merge only when **`autoMerge: true`**, **no unresolved blocking finding**, **CI green**, the PR is
> **not draft and `mergeable`**, and **branch protections are satisfied** (§4.5). With `autoMerge: false`
> a fully-green PR returns `ready_awaiting_human` — the pipeline **never merges**. The address↔review
> loop is bounded (`maxReviewRounds`); auto-rebase (§4.4b) runs only when `autoMerge: true`, is bounded
> and re-validated, force-pushes only fleet-owned branches, and falls back to `blocked` — never a forced
> merge. On a successful merge the head branch is **reaped** (remote + local worktree/branch),
> best-effort and never able to fail the merge, and **never** when the branch still backs another open
> PR — see §4.5 "Branch cleanup on merge".

## 5. Close the loop — shipped issues

Opening a PR is not finishing an issue. An issue left on `armada:done` after its PR has merged is the
lookout's blind spot: the work shipped but the backlog still shows it open. So each tick — after the
dispatch pass (§2), or whenever a merge pipeline reports a PR merged — the lookout also walks the
**in-flight** issues and closes the ones that are genuinely done.

The full close-the-loop procedure — listing in-flight issues (§5a), finding and confirming the merged
PR (§5b), confirming the acceptance criteria (§5c), closing with a trail (§5d), and reporting (§5e) —
lives in **[references/close-the-loop.md](references/close-the-loop.md)**. The rule that gates it:

> An issue is **done** only when **both** hold: its linked `Closes #<n>` PR is **merged** *and* its
> **acceptance criteria are satisfied**. Merge alone is not enough. Never close while `armada:underway`
> / `armada:reviewing` is set; on close, reconcile to the single terminal label `armada:shipped`.

When an issue closes as `armada:shipped` (§5d), **ring the ship's bell** for the *shipped* event
(§8) — fired when `notify` is `"terminal"` or `"all"`:
`⚓ Shipped #<issue> → PR #<pr> merged`. This ring, too, fires **both** bell channels — the
`PushNotification` *and*, when `bellCommand` is set, the local command hook (§8e) with
`ARMADA_BELL_EVENT=shipped` — under the same gate and the same after-the-fact discipline (§8c): fire
the hook only after the issue has already been closed and labelled.

After closing the loop — and after the bell rings — **record this shipped run for the batched
cartography pass** if the `cartography` key isn't `"off"` (§8d): append it to the pending accumulator
(§8d.i). The full resolution path (issue → PR → review → merge) is the richest evidence for per-repo
heuristics, but cartographer is **not** dispatched here — it runs **once per fleet-run** at an idle
point (§8d.ii) over the accumulated set, de-duped against the same run already recorded at its
PR-merge reconcile. Recording is cheap and synchronous; it never blocks or fails the close.

## 6. Arm the loop — hand the /loop line to the user

`crows-nest` can't type `/loop` itself, so compose the command and hand it over. Pick the interval
from the user (default ~5 minutes; faster burns API for little gain on a slow backlog). The
**default and recommended** line runs the **unified scheduler** — both tracks in one tick:

```text
# Unified scheduler (recommended) — both tracks, maximally parallel:
/loop 5m Run the crows-nest skill: do one unified scheduler tick for label "armada" — scan open issues AND ready PRs in one batched scan, build the cross-track dependency/conflict graph, dispatch every independent runnable unit (builds and reviews) concurrently up to maxConcurrentBuilds / maxConcurrentReviews, hold the rest with a reason, and report the unified schedule. If both horizon and harbour are clear, report that and wait.
```

If you want to drive a single track for some reason (e.g. builds only while you triage PRs by
hand), the scheduler still works scoped to one track via the `watch` input:

```text
# Issue track only:
/loop 5m Run the crows-nest skill: do one scheduler tick for label "armada", watch=issues — scan and dispatch eligible issue builds up to maxConcurrentBuilds, hold the rest with a reason, report. If the horizon is clear, report that and wait.

# PR track only:
/loop 5m Run the crows-nest skill: do one scheduler tick for label "armada", watch=prs — scan and dispatch ready PR pipelines up to maxConcurrentReviews, hold the rest with a reason, report. If the harbour is clear, report that and wait.
```

Tell the user: *"Paste the unified line to arm the lookout, or I can do single ticks on demand."*
Note that `/loop` with no interval lets the model self-pace, and that they can stop it any time.
Remind them that **auto-merge is off by default**, so the PR track stops at "awaiting human merge"
until they set `autoMerge: true`. If `/loop` is unavailable, offer to run manual ticks (§2) on
demand.

## 7. Stopping and safety

- **Stop** is the user's call (`/loop` is interruptible). The lookout never decides to stop the
  watch on its own; it only reports `horizon clear` / `harbour clear` and waits.
- **Gated auto-merge — off by default.** The ready-PR pipeline introduces merging, which reverses
  ARMADA's original "never merges" rail. That reversal is **deliberate and gated**:
  - `autoMerge` defaults **false**. With it off the pipeline reviews, addresses, and re-validates,
    then **stops at "ready to merge, awaiting human"** — it **never merges**. The original rail is
    the default; you opt in.
  - **`autoMerge` is the sole gate on the final merge.** Because review and address never merge,
    ARMADA-created PRs are **auto-armed** by shipwright on creation (no manual PR-arming step) — the
    pipeline reviews and addresses them regardless of `autoMerge`, and only the merge itself waits on
    the gate. One gate is enough; there is no second human "arm this PR" step to clear.
  - Even with `autoMerge: true`, the lookout **never** merges on **red CI**, an **unresolved
    blocking finding**, a **draft**, a **non-`mergeable`** PR, or when **branch protections /
    required reviews aren't satisfied** (§4.5). GitHub is the source of truth for protections —
    a refused `gh pr merge` is a `blocked`, not a retry.
  - The address↔review loop is **bounded** (`maxReviewRounds`, default 2); on no convergence the PR
    is labelled `armada:blocked` and handed back. Blocked PRs are always **labelled + commented**,
    never left mid-pipeline on `armada:reviewing`.
  - **Auto-rebase is gated on `autoMerge` too, and equally fenced.** With `autoMerge: true` a `BEHIND`
    or `CONFLICTING` PR is made mergeable automatically (§4.4b) — updated or rebased-and-resolved by a
    shipwright subagent — instead of being parked for a human. With `autoMerge: false` the branch is
    **left untouched**: the pipeline surfaces "needs rebase" and hands back. The auto-rebase is
    **bounded** (`maxRebaseRounds`, default 1), **re-validated and re-reviewed** before the merge gate,
    force-pushes only **fleet-owned** branches (with `--force-with-lease`; a branch carrying non-ARMADA
    commits is never force-pushed), and **falls back to `armada:blocked`** — never a forced merge —
    when conflicts aren't confidently resolvable, validation fails post-rebase, or the cap is hit.
- **Background dispatch keeps the watch live — at the cost of inline approval.** The autonomous
  path runs each build in a **background** subagent (§2d) so a slow or stuck build can't freeze the
  loop and the lookout can fan out up to `maxConcurrentBuilds`. The tradeoff is the same one the
  subagent dispatch already makes: a background agent **can't prompt the user mid-build**, so
  shipwright's approval gates collapse to **autonomous defaults** (accept the plan, take the default
  base). The two non-negotiable guards survive unchanged and must **not** be defaulted away — use
  `baseBranch` from config (don't merge a feature branch to resolve a base, shipwright §1a) and **never run a
  destructive migration unattended** (return `blocked` instead, §2d). Concurrency is **bounded**
  (`maxConcurrentBuilds`, default 1) so background fan-out never becomes an unbounded swarm.
- **Label discipline is the safety rail.** The lookout acts only on `triggerLabel`, so you arm
  autonomy by adding `armada` and **disarm it by removing the label** — on an issue or a PR, per
  object, no code change needed. Removing `armada` from a PR takes it out of the ready-PR watch.
- If a tick errors (network, `gh` auth, rate limit), report it and let the next interval retry;
  don't spin-retry inside one tick.
- **Self-improvement loop.** When a tick hits a defect in ARMADA *itself* — the lookout's own
  guidance was wrong or missing, a guard didn't fire, or it had to **guess** because a step was
  absent (as opposed to a target-project failure, which is handled normally) — file a fix through
  [`charter`](../charter/SKILL.md) §9: against the configured `armadaRepo`, de-duped, labelled
  `fleet-defect`, and **unarmed by default** (armed only if `autoArmSelfFixes` is true, since a
  self-armed fleet-defect can rewrite and — with `autoMerge` — merge the lookout's own skill
  unattended). It's best-effort and side-channel: note it in the tick summary, **never** block or
  derail the watch on it.

## 8. The ship's bell — notify on fleet events

The fleet runs unattended, so meaningful outcomes — a PR merged, a unit blocked — would otherwise go
unnoticed until you next poll the `armada:*` labels. The **ship's bell** closes that gap: at the
terminal/exception reconciliation points the lookout already passes through (§2d, §3e, §5), it emits
**one line** via the `PushNotification` tool so you're *told* what happened. This is the single,
shared convention every ring above refers back to — read it once here.

The bell has **two channels**, fired together at every ring: the always-on `PushNotification`
(§8a–§8c) and an **optional local command hook**, `bellCommand` (§8e). They are complementary, not
alternatives — the hook runs **in addition to** `PushNotification`, never instead of it.

**Why a second channel.** `PushNotification` is **suppressed whenever the terminal has focus** — and
that suppresses *both* the desktop notification *and* the mobile push. So an operator sitting on the
crows-nest `/loop`, watching it tick, gets **nothing** on a merge or a block; the bell only ever
lands when they've switched away. (A diagnostic `PushNotification` in that state returns *"Not sent —
terminal has focus. Terminal + mobile suppressed."*) There's also no way to make the `PushNotification`
itself *audible* — and it doesn't raise Claude Code's `Notification` hook, so an OS-sound fanfare wired
to that hook never fires. The `bellCommand` hook (§8e) closes the gap: a focus-independent,
optionally-audible local command the bell invokes directly. Operators who want an audible/desktop alert
that works *while watching the loop* set `bellCommand`; the `PushNotification` still serves the
switched-away case. This caveat is **harness-side** — ARMADA can't change `PushNotification`'s
focus-suppression — so the local hook is the lever ARMADA *does* control.

### 8a. What rings, and at which `notify` level

The bell fires **only** on the events below, governed by `notify` from §1 (default `"terminal"`).
Each line is one sentence and actionable — what happened, the issue/PR number, and (for a block) the
reason:

| Event | When it fires | `notify` levels | Example line |
| :--- | :--- | :--- | :--- |
| **Shipped** | a PR merged (`armada:merged`, §3e) or an issue shipped (`armada:shipped`, §5) | `terminal`, `all` | `⚓ Shipped #12 → PR #17 merged` |
| **Blocked** | any unit hits `armada:blocked` (§2d / §3e) — CI red, unresolved blocking finding, no convergence, rebase couldn't resolve, destructive-migration refusal, etc. | `blocked`, `terminal`, `all` | `⛔ #9 blocked: CI red on head` |
| **Opened** *(optional)* | a build opened a PR (`armada:done`, §2d) | `all` only | `⚓ #14 → PR opened: #21` |
| **Awaiting human** *(optional)* | a green PR stops at the merge gate (`ready_awaiting_human`, `autoMerge: false`, §3e) | `all` only | `🔔 PR #21 ready — awaiting human merge` |

A **blocked** ring **must include the reason** (the `reason` from the subagent/pipeline result) — a
bare "blocked" isn't actionable. Map the `notify` level to the set of events once, at the top of the
tick, and gate each ring against it:

- `"off"` → ring nothing.
- `"blocked"` → ring **Blocked** only.
- `"terminal"` *(default)* → ring **Shipped** and **Blocked**.
- `"all"` → ring **Shipped**, **Blocked**, **Opened**, and **Awaiting human**.

This single `notify`→events mapping gates **both** bell channels identically: whatever the level
admits to `PushNotification` it also admits to the `bellCommand` hook (§8e), so the two channels never
diverge — `"off"` runs neither, `"blocked"` fires both only on blocks, and so on.

### 8b. What never rings (no noise)

The bell is for terminal/exception events, **never** for routine progress. Do **not** ring on:

- routine clear ticks — `horizon clear` / `harbour clear` (§2c) never notify;
- per-step / mid-pipeline progress — claiming a unit (`armada:underway` / `armada:reviewing`),
  dispatching a build, a review round, an address pass, a rebase attempt;
- the per-tick **schedule line** (§2e) and the reconcile **log lines** (§2e) — those stay as logs.

This is the guardrail: a watch that pings on every tick trains you to mute it, so the bell only
sounds when something actually finished or actually needs you.

### 8c. Degrade gracefully — best-effort, side-channel, never fatal

A notification is a **side-channel courtesy**, never part of the build/review/merge outcome. So:

- **If `PushNotification` isn't available** in the run context (the tool isn't present, or the call
  throws), **fall back to a logged line** in the tick output — the same one-liner, prefixed
  `crows-nest bell:` — and carry on. A missing notifier degrades to a log, it never errors the tick.
- **A failed ring never affects the outcome.** Wrap the ring so any failure is swallowed (logged at
  most once) — the label swap, the PR comment, the merge, and the issue close have **already
  happened** before the bell rings; the bell is the last, optional step. Never re-order it ahead of
  the consequential action, and never let it block, retry-spin, or fail the tick.
- **Best-effort de-dup.** Each terminal event rings **once** — it fires at the reconciliation that
  sets the terminal label, and the in-flight guards (§2a) mean a reconciled unit isn't re-picked, so
  the same event won't re-ring on a later tick.

### 8d. Cartographer — accumulate learnings, then map once per fleet-run (batched)

[`cartographer`](../cartographer/SKILL.md) is the ship that mines completed runs for reusable
*per-repo* heuristics and maintains the knowledge base under `.armada/cartography/` so future builds
specialise to the repo. It runs under the **identical best-effort, side-channel ship's-bell
discipline as §8c** — it must **never block, derail, or fail the tick**.

**What it must NOT do: fire once per reconcile.** The naive wiring dispatches cartographer at *every*
terminal reconcile (§2d / §3e / §5). On a busy backlog that means one cartography update **per
issue/PR** — an 8-feature, 3-fix run would emit **11+** cartography PRs (or 11+ commits competing for
the active PR), each touching the **same** `.armada/cartography/` files, so they **race and conflict
with each other** and **flood the review lane**. The fix is to **accumulate** the runs each reconcile
completes and dispatch cartographer **once per fleet-run**, batched, over the whole accumulated set.

#### 8d.i Accumulate, don't dispatch, at each reconcile point

At each of the **three terminal reconcile points** the bell rings — **build-completion (§2d)**,
**PR-pipeline outcome (§3e)**, **issue-shipped (§5)** — do **not** dispatch cartographer inline.
Instead, when `cartography` isn't `"off"`, **record the just-completed run** into a per-fleet-run
**pending-cartography accumulator** and carry straight on:

- The accumulator is a small in-memory list the lookout keeps across the ticks of one `/loop`
  session — one entry per completed run, each `{ kind: "build" | "pr" | "shipped", number, ref }`
  (the issue/PR number and its branch/PR ref) so the batched cartographer (§8d.ii) knows exactly
  which runs to analyse. De-dup by `number` so the same run recorded at two reconcile points (its PR
  merged *and* its issue shipped) is analysed once.
- Recording is **after the consequential action, never before** — the label swap, the PR comment, the
  merge, the issue close have already landed; appending to the accumulator is the last, optional step
  of the reconcile, exactly like the bell ring. It is cheap and synchronous (no subagent), so it
  **never** holds the tick or fails it.

This replaces the per-reconcile dispatch entirely: a reconcile **enqueues**, it does not map.

#### 8d.ii Dispatch cartographer once, at an idle point, over the whole batch

Dispatch cartographer **once per fleet-run**, when the run reaches an **idle point** — the
**frontier is clear** (`horizon clear · harbour clear`, §2c: no build or review runnable or in
flight) **and the accumulator is non-empty**. That is the natural end-of-run drain: all the work
that produced learnings has landed, nothing is mid-flight to add more, so one batched pass captures
the whole run. Then:

- Spawn **one** cartographer via the `Agent` tool with `run_in_background: true` in its own context,
  handed the **entire accumulated batch** (§8d.i) to analyse together — it dedupes/updates/prunes
  across all of them and emits **one** knowledge-update PR (or one commit / one proposed diff), per
  cartographer §9/§9a. **Clear the accumulator** the moment it's handed off, so the next fleet-run
  starts fresh and a run isn't re-analysed.
- **Single-writer — never two cartographers at once.** Because every cartography pass writes the same
  `.armada/cartography/` files, two concurrent passes would race. So treat cartographer as
  **strictly serial**: track a `cartographyInFlight` flag for the session and **never dispatch a
  second cartographer while one is still running**. If an idle point is reached while a cartography
  pass is in flight, **leave the accumulator intact** and let the *next* idle point drain it once the
  in-flight pass returns (clear the flag on its completion). One writer, one batched PR, no race.
- If the `/loop` is **stopped** (or the user ends the session) with the accumulator non-empty and no
  idle point yet reached, that residue can be mapped by a manual `/cartographer` over those runs — it
  is never silently lost, but it is also never forced through mid-run.

#### 8d.iii Gating, isolation, and the discipline (unchanged)

- **Gated by the `cartography` config key (§1).** Read `cartography` from `.armada/config.json`:
  - `"off"` *(default)* → **never accumulate and never dispatch.** The tick behaves exactly as before;
    learning is opt-in. (Manual `/cartographer` still works for a human any time.)
  - `"proposal"` → accumulate, then at the idle point dispatch a batched pass that only **proposes** a
    single cartography diff for human approval — it never commits silently.
  - `"on"` → accumulate, then dispatch a batched pass that commits **one** knowledge update into the
    **active PR** (or opens **one** dedicated cartography PR when there's no active PR) so it rides the
    muster review + `autoMerge` gate (cartographer §9).
- **Background, bounded, isolated, single-writer.** One cartographer in flight at a time (§8d.ii),
  spawned in its own context, handed the batch. It never holds the tick open and never fans out a
  swarm — at most **one** cartography PR per fleet-run, not one per reconcile.
- **Never fatal.** If cartographer errors, finds nothing, isn't available, or the key is off, the tick
  is **completely unaffected** — swallow any failure (log at most once, prefixed
  `crows-nest cartography:`), clear the in-flight flag, and carry on. A failed map update must never
  turn a green tick red.
- **Distinct from the fleet-defect loop (§7).** Cartographer learns about the **host repo** and writes
  `.armada/cartography/`; the fleet-defect loop learns about **ARMADA itself** and files a
  `fleet-defect` against `armadaRepo`. The two are independent — §7 is **unchanged** by this.

### 8e. The local command hook — `bellCommand`

The bell's **second channel**: a configurable local command the lookout runs at the **same three
reconcile points** the `PushNotification` bell rings — **build-completion (§2d)**, **PR-pipeline
outcome (§3e)**, **issue-shipped (§5)** — gated by the **same `notify` level** (§8a), **in addition
to** the `PushNotification`, never replacing it. Its reason for existing is the focus-suppression
caveat documented at the top of §8: `PushNotification` is muted while the terminal has focus, so an
operator watching the `/loop` gets no alert; a local command is focus-independent and can be audible.

**Gated by the `bellCommand` config key (§1).** Read `bellCommand` from `.armada/config.json`:

- **Default `""` (empty / off)** → **run nothing.** The bell behaves exactly as before — just the
  `PushNotification` — and existing setups are unchanged. This is the safe default.
- **A non-empty string** → it's a shell command. At each ring the `notify` gate admits (§8a), run it
  **once** via the `Bash` tool, after the `PushNotification`, as the last optional step of the
  reconcile.

**The event context the hook receives.** So one script can react differently per event, every
invocation passes the bell context two ways — as a positional **argument** and as **environment
variables**:

- **Argument** — the bell line itself (the same one-sentence message `PushNotification` would send,
  e.g. `⚓ Shipped #12 → PR #17 merged`) is passed as the **first argument** to the command.
- **Environment variables** — set on the command's environment:
  - `ARMADA_BELL_EVENT` — the event kind: one of `shipped` | `blocked` | `opened` | `awaiting`.
  - `ARMADA_BELL_NUMBER` — the issue or PR number the event concerns (e.g. `17`).
  - `ARMADA_BELL_REASON` — the block reason for a `blocked` event; empty for the others.
  - `ARMADA_BELL_MESSAGE` — the full bell line (same value as the argument), for scripts that prefer
    to read the env.

Concretely, the run is `bellCommand "<bell line>"` with those four env vars exported — for example
(a non-empty `bellCommand` of `powershell.exe -File fanfare.ps1`):

```bash
ARMADA_BELL_EVENT=shipped ARMADA_BELL_NUMBER=17 ARMADA_BELL_REASON="" \
ARMADA_BELL_MESSAGE="⚓ Shipped #12 → PR #17 merged" \
  powershell.exe -File fanfare.ps1 "⚓ Shipped #12 → PR #17 merged"
```

**Same discipline as §8c — best-effort, side-channel, never fatal.** The hook is held to the
**identical** contract as the `PushNotification` ring:

- **After the consequential action, never before.** Run `bellCommand` only **after** the reconcile's
  real work has landed — the label swap, the PR comment, the merge, the issue close — exactly like
  the `PushNotification` ring. It is the last, optional step; never re-order it ahead of the outcome.
- **Failure swallowed, logged at most once.** A missing, slow, or failing `bellCommand` **never**
  blocks the tick, **never** retries or spins, and **never** fails the reconcile — same contract as a
  missing `PushNotification`. Swallow any non-zero exit or error and log it **at most once**, prefixed
  `crows-nest bell:` (e.g. `crows-nest bell: bellCommand exited 1 — ignored`). A failed hook must
  never turn a green tick red.
- **Bounded / non-hanging.** A hook must not stall the loop, so run it **fire-and-forget or
  time-bounded** — start it detached (so a long-playing sound or an accidental prompt can't hold the
  tick open) or cap it with a short timeout and move on. **`bellCommand` is expected to return
  promptly**; the lookout does not wait on it and does not read its output. On a platform where you
  can't background a process from the `Bash` tool, wrap it in a short timeout (a few seconds) rather
  than blocking. Either way the tick proceeds the moment the hook is launched.
- **Best-effort de-dup.** Like the `PushNotification` ring, the hook fires **once** per terminal
  event — at the reconciliation that sets the terminal label — and the in-flight guards (§2a) keep a
  reconciled unit from re-ringing on a later tick.

**Cross-platform by construction.** The value is an **operator-supplied** command — ARMADA ships **no
sound asset and assumes no OS**. The operator points it at whatever raises an alert on their machine:

```jsonc
// Windows — a PowerShell fanfare script:
"bellCommand": "powershell.exe -File C:\\armada\\fanfare.ps1"
// macOS — play a system sound:
"bellCommand": "afplay /System/Library/Sounds/Glass.aiff"
// Linux — play a wav via PulseAudio:
"bellCommand": "paplay /usr/share/sounds/freedesktop/stereo/complete.oga"
```

The command receives the bell line as its first argument and the `ARMADA_BELL_*` env vars (above), so
a single script can branch on `$ARMADA_BELL_EVENT` to play different sounds for shipped vs. blocked.

## Inputs

- `label` *(optional)* — the trigger label to watch. Defaults to `.armada/config.json` → `triggerLabel`, else `armada`.
- `watch` *(optional)* — `both` | `issues` | `prs`. Which track(s) a scheduler tick covers.
  **Defaults to `both`** — the unified scheduler scans and dispatches both tracks at once; scope to a
  single track only when explicitly asked.
- `interval` *(optional)* — poll cadence for the `/loop` line. Default ~5m.
- `dispatch` *(optional)* — `shipwright` | `flagship`. Defaults to config, else `shipwright`.

## Output

- A composed `/loop` command the user can paste to arm the unified scheduler (or a single track).
- Per tick: a **unified schedule line** — units scanned across both tracks, what was dispatched
  (builds running / reviews running), and what was held + why (§2e).
- On each background completion: the reconciled outcome — a build's PR opened, or a PR pipeline's
  merge / awaiting-human / blocked result.
- Labels kept in sync — issues `armada` → `armada:underway` → `armada:done` / `armada:blocked`;
  PRs `armada` → `armada:reviewing` → `armada:merged` / `armada:blocked`.
- On terminal/exception events (shipped / blocked, plus opened / awaiting-human at `notify: "all"`):
  a one-line **ship's bell** `PushNotification` per the `notify` level — degrading to a logged line
  when the notifier is unavailable, never fatal to the tick (§8) — **and**, when `bellCommand` is set
  (default `""` = off), a focus-independent local command hook fired alongside it under the same gate
  and the same best-effort/bounded discipline (§8e).
