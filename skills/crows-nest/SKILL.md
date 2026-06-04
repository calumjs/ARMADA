---
name: crows-nest
description: >
  The ARMADA lookout. Keeps two watches over a GitHub repo: a new-issue watch that dispatches
  each labelled issue into the fleet to be built, and a ready-PR watch that drives each labelled
  pull request through a review → address → re-validate → gated-merge pipeline. Runs as a
  recurring watch via /loop: each tick claims the next eligible issue or PR and dispatches it.
  Trigger when the user says "watch for issues", "start the crows-nest", "keep an eye on the
  backlog", "listen for new issues", "watch for ready PRs", "review and merge PRs", "man the
  lookout", or invokes /crows-nest. Accepts an optional trigger label (default from
  .armada/config.json, else "armada") and an optional poll interval.
---

# crows-nest — watch issues and ready PRs, and dispatch them

`crows-nest` is ARMADA's entry point: the lookout that turns a GitHub backlog into a stream of
work for the fleet. It keeps **two watches** and does **one tick of triage** each time it runs;
`/loop` is what makes it run again and again unattended:

> **New-issue watch:** **list new labelled issues** → **claim the next one** → **dispatch it** to
> [`shipwright`](../shipwright/SKILL.md) (or `flagship`) to build → repeat.
>
> **Ready-PR watch:** **list ready labelled PRs** → **claim the next one** → **drive it** through a
> [`muster`](../muster/SKILL.md) review → shipwright address → re-validate → **gated** merge
> pipeline → repeat.

The two watches share the lookout's wiring (label discipline, atomic claim, bounded loop) but key
off different objects and label tracks. The new-issue watch is §2; the ready-PR watch and its
pipeline are §3 and §4; closing the loop on shipped issues is §5. A single `/loop` line can arm them
(§6).

## How the watch is wired (read this first)

These are constraints the design is built around:

1. **A skill cannot type `/loop` itself.** `/loop` is a built-in command and the Skill tool only
   runs skills — model text isn't executed as a command. So `crows-nest`'s job is to **compose the
   exact `/loop` line and hand it to you to run** (§6). Everything after that repeats automatically.
2. **Only act on the trigger label.** The lookout must never grab the whole backlog. It acts solely
   on open issues carrying the configured `triggerLabel` (default `armada`). No label → not its job.
3. **Claiming must be atomic-ish and visible.** Before dispatching, mark the issue claimed (a label
   swap + a comment) so a second tick — or a second human — doesn't pick up the same issue.
4. **Always bound the loop.** Pass `/loop` an interval and let the user stop it. A lookout that
   never sleeps and never reports is just noise.

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

- `armada` — on a PR, shipwright adds this when it opens the PR; it marks the PR as in-fleet and
  eligible for the review pipeline. (Same arming switch as issues: remove it to disarm.)
- `armada:reviewing` — claimed by the ready-PR watch; a review → address → verify → merge pipeline
  is running against it. Mid-pipeline PRs are skipped by future ticks (the idempotency guard).
- `armada:merged` — the pipeline merged it. Only ever set when `autoMerge` is enabled **and** every
  gate passed.
- `armada:blocked` — the pipeline stopped and needs a human: a blocking finding, red CI, no
  convergence within the bounded loop, or `autoMerge` off and the PR is sitting "ready to merge,
  awaiting human".

`armada:reviewing`, `armada:merged`, and the issue-track terminal `armada:shipped` are all created
by [`commission`](../commission/SKILL.md) alongside the other labels.

## 2. One tick of the new-issue watch

Each tick does exactly this, then returns:

### 2a. List eligible issues

```bash
gh issue list --label "<triggerLabel>" --state open \
  --json number,title,labels,createdAt,assignees,author --limit 50
```

Filter **out** any issue that is already:
- labelled `armada:underway`, `armada:done`, or `armada:blocked`, **or**
- has an open PR that references it (`gh pr list --search "<number> in:body" --state open`), **or**
- already has a worktree/branch named for it locally.

That dedup check is what keeps the loop idempotent — a tick that fires while the previous build is
still running must not double-pick.

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

### 2b. Pick the next issue

Order the remaining issues oldest-first (FIFO on `createdAt`) unless a `priority`/`P0` label
suggests otherwise. Process **one issue per tick** by default — sequential is safer for an
unattended loop sharing one working tree. (Only raise concurrency if the user asks and each build
runs in its own worktree.)

If nothing is eligible, log `crows-nest: horizon clear` and return — the loop will check again next
interval. Don't invent work to look busy.

### 2c. Claim it

```bash
gh issue edit <number> --add-label "armada:underway" --remove-label "<triggerLabel>"
gh issue comment <number> --body "🔭 crows-nest: picked up by ARMADA — dispatching to <dispatch target>."
```

### 2d. Dispatch it

Hand the claimed issue to the dispatch target. **How** you dispatch depends on whether the tick is
running autonomously or under a watching human — the two modes trade approval gates for context
isolation:

- **Autonomous (`/loop`) path — dispatch into a subagent.** When the tick is firing under `/loop`,
  the lookout commands and a subagent works. Spawn the dispatch target (`shipwright`, default — or
  `flagship` when that ship is in the fleet) via the **`Agent` tool**, non-interactive, with
  `isolation: "worktree"`. The subagent runs the full build (worktree → implement → validate → open
  PR) in **its own context and its own worktree**, then returns a structured result (below); the
  lookout never carries the build transcript. This keeps the lookout cheap and legible across
  hundreds of ticks, and it's the multi-agent shape ARMADA is named for.

- **Supervised single pick — run inline.** When a human asked for one named issue ("crows-nest,
  grab #142"), run [`shipwright`](../shipwright/SKILL.md) **inline in this turn** so the user keeps
  its approval gates — the plan sign-off (§3 of shipwright) and the base-branch choice (§1a). No
  subagent, because a subagent can't pause to ask.

**The subagent runs `shipwright` non-interactively.** It cannot pause to ask the user, so
shipwright's approval gates collapse to **sensible defaults** (accept the plan, take the default
base branch) rather than prompts. Two guards survive non-interactively and must **not** be
defaulted away:
- **Base branch** — use `baseBranch` from `.armada/config.json` (§1a's logic still applies if the
  issue's target code lives only on a feature branch; pick the safe base, don't merge to resolve it).
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

The lookout maps that result to the claimed-state labels and the issue comment:

- `status: "opened"` → `gh issue edit <issue> --add-label "armada:done" --remove-label "armada:underway"`,
  then `gh issue comment <issue> --body "🔭 crows-nest: PR opened — <pr>"`.
- `status: "blocked"` → `gh issue edit <issue> --add-label "armada:blocked" --remove-label "armada:underway"`,
  then `gh issue comment <issue> --body "🔭 crows-nest: blocked — <reason>"`.

Either way the issue leaves `armada:underway`: never leave one stuck there, or it's invisible to
both the lookout and a human. (On the inline path the running shipwright opens the PR directly;
apply the same label swap and comment from its outcome.)

#### Concurrency stays opt-in

Worktree isolation is what makes the autonomous path safe to parallelise: because each subagent
builds in **its own worktree**, multiple issues could be dispatched in the same tick without
trampling a shared tree. That's the enabler, **not** the default — the one-issue-per-tick rule of
§2b is unchanged. Only raise the per-tick limit (one subagent per issue) when the user explicitly
asks for concurrency.

### 2e. Report the tick

Print a one-line summary so the loop's history is legible:

```
crows-nest tick: 3 eligible · picked #142 "Add CSV export" · dispatched to shipwright · PR #150 opened
```

## 3. One tick of the ready-PR watch

The second watch is a separate tick that operates on **pull requests**, not issues. It can be armed
on its own `/loop` or folded into the same tick as the new-issue watch (§6). Each tick:

### 3a. List eligible PRs

```bash
gh pr list --label "<triggerLabel>" --state open \
  --json number,title,isDraft,labels,headRefName,mergeable,statusCheckRollup,updatedAt --limit 50
```

A PR is **ready** — eligible for the pipeline — when **all** hold:

- it is **open** and **not draft**;
- it carries the `<triggerLabel>` (`armada`) — shipwright adds this when it opens the PR;
- **CI is not failing** — `statusCheckRollup` has no `FAILURE`/`ERROR`/`TIMED_OUT` checks (pending
  is fine to re-check next tick; a green or not-yet-failing rollup passes this stage);
- it isn't **already mid-pipeline** — not labelled `armada:reviewing`, and not already
  `armada:merged` or `armada:blocked` (terminal states a future tick must not re-pick).

Filter out anything that fails a condition. This eligibility check is the ready-PR analogue of §2a's
issue dedup, and `armada:reviewing` is the idempotency guard that stops a second tick double-driving
the same PR.

### 3b. Pick the next PR

Oldest-update-first (FIFO on `updatedAt`), **one PR per tick** by default — the pipeline spawns
subagents and merges, so sequential is safer unattended. If nothing is eligible, log
`crows-nest: harbour clear` and return.

### 3c. Claim it

```bash
gh pr edit <n> --add-label "armada:reviewing"
gh pr comment <n> --body "🔭 crows-nest: ready-PR pipeline started — review → address → re-validate → gated merge."
```

### 3d. Drive the pipeline

Hand the claimed PR to the **review→merge Workflow** (§4). The Workflow returns a single terminal
result the lookout maps to the PR-track labels (§3e). The lookout itself stays thin: it claims,
launches the Workflow, and records the outcome — it does **not** carry the review or build
transcripts (those live in the subagents' own contexts).

### 3e. Record the outcome

Map the Workflow's terminal result to a PR-track label and a comment — a PR must **never** be left
on `armada:reviewing`:

- `merged` → `gh pr edit <n> --remove-label "armada:reviewing" --add-label "armada:merged"`; comment
  the merge commit. (Only reachable with `autoMerge: true` and all gates green.)
- `ready_awaiting_human` → `gh pr edit <n> --remove-label "armada:reviewing"` (leave `armada` on so a
  human sees it); comment "✅ reviewed, addressed, green — **awaiting human merge** (auto-merge off)".
  This is the default terminal state when `autoMerge` is off.
- `blocked` → `gh pr edit <n> --remove-label "armada:reviewing" --add-label "armada:blocked"`; comment
  the reason (blocking finding, red CI, no convergence, non-mergeable, branch protection unmet).

### 3f. Report the tick

```
crows-nest PR tick: 2 ready · picked #150 "Add CSV export" · 1 blocking → addressed · green · awaiting human merge (auto-merge off)
```

## 4. The review→merge pipeline (a Workflow)

Steps 4.1–4.5 are driven as a **Workflow**, not ad-hoc inline turns: a deterministic graph of
stages — **parallel review fan-out → consolidate → address → verify → gated merge** — with explicit
state passed between stages and a single terminal result. A Workflow (rather than a chat loop) is
what gives multi-agent control its determinism: each stage's output is structured, the fan-out is
genuinely parallel, and the merge gate is evaluated from data, not from prose the model might
misread. It reuses the **parallel-reviewers + dedupe** pattern that [`muster`](../muster/SKILL.md)
implements internally.

The pipeline runs against one PR `<n>` already claimed `armada:reviewing` (§3c).

### 4.1 Review (parallel fan-out → consolidate)

Dispatch [`muster`](../muster/SKILL.md) against PR `<n>` as a subagent (via the **`Agent` tool**,
non-interactive, isolated context). `muster` runs its **two lenses in parallel subagents**
(code-review + `codex:codex-rescue`), dedupes by file+title, posts inline comments + a summary on
the PR, and **returns the consolidated structured findings** `{severity,file,line,title,detail}`.

The lookout keeps only the structured return — not the review transcript. The gate is computed from
`summary.blocking`: any blocking finding means the PR cannot merge this round (it must first be
addressed). A **degraded** review (one or both lenses failed) is **not** a green light — treat a
missing review as "not safe to merge", never as "no findings".

### 4.2 Address (subagent)

If there are findings to act on, re-dispatch [`shipwright`](../shipwright/SKILL.md) in
**address-review mode** as a subagent against PR `<n>`, handing it the findings. Shipwright triages
each comment (agree / discuss / disagree + one-line rationale), implements the agreed changes,
re-validates, pushes to the PR branch, and replies per thread — see shipwright's address-review
section. It returns a structured result: what it changed, what it declined and why, and the new
head sha.

If `muster` found nothing actionable, skip straight to verify.

### 4.3 Verify (re-validate)

After an address pass, re-run the project's checks against the updated head and print results:

```bash
<commands.build> && <commands.test> && <commands.lint>   # from .armada/config.json
gh pr checks <n>                                          # CI rollup on the pushed commit
```

Both the local gate and the CI rollup must be green to advance. Pending CI → re-check next tick
(leave `armada:reviewing` on so the tick re-enters here), don't merge on yellow.

### 4.4 Bounded address↔review loop

If the address pass changed code, **re-review** the new head (back to 4.1) so fixes are themselves
reviewed and no blocking finding is left standing. Bound this loop: **`maxReviewRounds` (default 2)**.
On reaching the cap without convergence (blocking findings still open, or checks still red),
**stop** and return `blocked` with "no convergence after N rounds" — do not keep looping or merge
through unresolved blockers.

### 4.5 Gated merge

Compute the merge decision from data. **Merge only if every one of these holds:**

1. `autoMerge: true` in `.armada/config.json` (**default false** — see §7);
2. no unresolved **blocking** finding (`summary.blocking == 0` on the latest review);
3. CI is **green** (`gh pr checks <n>` all passing) — never on red or pending;
4. the PR is **not draft** and GitHub reports it **`mergeable`**;
5. the repo's **branch protections / required reviews are satisfied** (let GitHub be the source of
   truth — if `gh pr merge` is refused for an unmet protection, that's a `blocked`, not a retry).

If all hold, merge with the **configured method** and record `merged`:

```bash
gh pr merge <n> --<mergeMethod>   # merge | squash | rebase, from config (default: repo default)
```

If `autoMerge` is **false** but 2–5 all hold, the PR is genuinely ready — return
`ready_awaiting_human` (stop-before-merge; never merge). If any of 2–5 fail, return `blocked` with
the specific reason. Either way the Workflow yields exactly one terminal result for §3e to label.

## 5. Close the loop — shipped issues

Opening a PR is not finishing an issue. An issue left on `armada:done` after its PR has merged is
the lookout's blind spot: the work shipped but the backlog still shows it open. So each tick — after
the dispatch pass (§2), or whenever a merge pipeline reports a PR merged — the lookout also walks the
**in-flight** issues and closes the ones that are genuinely done. An issue is **done** only when
**both** hold: its linked PR is **merged** *and* its **acceptance criteria are satisfied**. Merge
alone is not enough; a PR can land and still leave an acceptance criterion unmet.

### 5a. List in-flight issues

Walk the issues ARMADA still owns that *might* be finishable — past the build but not yet terminal:

```bash
gh issue list --state open --label "armada:done" --json number,title,labels,body --limit 50
```

Skip any issue still **in motion** — labelled `armada:underway` or `armada:reviewing`. Those mean a
build or a review pipeline is still running against it; closing one mid-flight would yank work out
from under a subagent. **Never close while `armada:underway` / `armada:reviewing` is set** — wait for
it to clear to `armada:done` first. (Same idempotency guard as §2/§3: a terminal action never races
an in-progress one.)

### 5b. Find the linked PR and confirm it merged

shipwright links its PR to the issue with `Closes #<n>` (full) or `Relates to #<n>` (partial). Find
that PR and read its merge state:

```bash
gh pr list --search "<number> in:body" --state all --json number,body,state,mergedAt,mergeCommit
gh pr view <pr> --json state,mergedAt,mergeCommit --jq '.state'   # must be "MERGED"
```

- **No merged PR yet** (open, or `state != "MERGED"`) → leave the issue as-is; a later tick re-checks.
- **`Relates to #<n>`** (partial) → the PR only chips at the issue; **do not close.** A partial PR
  merging does not finish the issue — it outlives the PR.
- **`Closes #<n>`** and merged → candidate for closing; proceed to the acceptance-criteria check.

Capture the merge commit (`mergeCommit.oid`, abbreviated) for the closing trail.

### 5c. Confirm the acceptance criteria are satisfied

Do **not** close on merge alone. Read the issue body's acceptance-criteria checklist and confirm it
is addressed, by either of:

- **every `- [ ]` is now `- [x]`** in the issue body (the checklist is fully ticked), **or**
- the merged PR / a closing comment **maps each criterion to where it was met** (e.g. "AC1 → §5b of
  crows-nest; AC2 → label list in commission §4"), so the trail is auditable even when the boxes
  weren't mechanically ticked.

If **any** criterion is unmet or explicitly deferred, **do not close.** Either leave the issue open
with a comment naming the gap, or open a focused follow-up for the remainder. When unsure, leave it
open — a wrongly-closed issue is worse than a stale `armada:done`.

### 5d. Close with a trail

When both gates pass, close the issue with a comment that links the merged PR and maps the criteria,
then reconcile the labels to the terminal state:

```bash
gh issue close <number> \
  --comment "🔭 crows-nest: shipped in #<pr> (merged <sha>). ACs: <each criterion → where it was met>."
gh issue edit <number> \
  --add-label "armada:shipped" \
  --remove-label "armada:done" --remove-label "armada:underway" --remove-label "armada:reviewing"
```

- **Reconcile, don't error.** A merged `Closes #<n>` PR **auto-closes the issue on merge** to the
  default branch, so the issue may already be closed when the lookout gets here. That's expected:
  **reconcile the labels** (add `armada:shipped`, clear the transient ones) and add the trail comment
  — do **not** treat the already-closed state as an error or try to re-close-then-reopen. `gh issue
  close` on an already-closed issue is a no-op; the comment + label swap is the work that remains.
- **Clear every transient label.** `armada:done`, and defensively `armada:underway` /
  `armada:reviewing`, come off; `armada:shipped` is the single terminal label left. An issue must
  never sit closed while still wearing an in-flight `armada:*` label.

### 5e. Report the tick

```
crows-nest close tick: 2 in-flight · #142 "Add CSV export" → shipped (PR #150 merged a1b2c3d, ACs met) · #144 left open (AC3 deferred)
```

## 6. Arm the loop — hand the /loop line to the user

`crows-nest` can't type `/loop` itself, so compose the command and hand it over. Pick the interval
from the user (default ~5 minutes; faster burns API for little gain on a slow backlog). Arm the
new-issue watch, the ready-PR watch, or both:

```text
# New-issue watch (build the backlog):
/loop 5m Run the crows-nest skill: do one new-issue watch tick for label "armada" — list eligible open issues, claim the next one, and dispatch it to shipwright. If the horizon is clear, report that and wait.

# Ready-PR watch (review → address → gated merge):
/loop 5m Run the crows-nest skill: do one ready-PR watch tick for label "armada" — list ready PRs, claim the next one, and drive it through the review→merge Workflow. If the harbour is clear, report that and wait.
```

Tell the user: *"Paste that to arm the lookout, or I can do single ticks on demand."* Note that
`/loop` with no interval lets the model self-pace, and that they can stop it any time. Remind them
that **auto-merge is off by default**, so the ready-PR watch stops at "awaiting human merge" until
they set `autoMerge: true`. If `/loop` is unavailable, offer to run manual ticks (§2/§3) on demand.

## 7. Stopping and safety

- **Stop** is the user's call (`/loop` is interruptible). The lookout never decides to stop the
  watch on its own; it only reports `horizon clear` / `harbour clear` and waits.
- **Gated auto-merge — off by default.** The ready-PR pipeline introduces merging, which reverses
  ARMADA's original "never merges" rail. That reversal is **deliberate and gated**:
  - `autoMerge` defaults **false**. With it off the pipeline reviews, addresses, and re-validates,
    then **stops at "ready to merge, awaiting human"** — it **never merges**. The original rail is
    the default; you opt in.
  - Even with `autoMerge: true`, the lookout **never** merges on **red CI**, an **unresolved
    blocking finding**, a **draft**, a **non-`mergeable`** PR, or when **branch protections /
    required reviews aren't satisfied** (§4.5). GitHub is the source of truth for protections —
    a refused `gh pr merge` is a `blocked`, not a retry.
  - The address↔review loop is **bounded** (`maxReviewRounds`, default 2); on no convergence the PR
    is labelled `armada:blocked` and handed back. Blocked PRs are always **labelled + commented**,
    never left mid-pipeline on `armada:reviewing`.
- **Label discipline is the safety rail.** The lookout acts only on `triggerLabel`, so you arm
  autonomy by adding `armada` and **disarm it by removing the label** — on an issue or a PR, per
  object, no code change needed. Removing `armada` from a PR takes it out of the ready-PR watch.
- If a tick errors (network, `gh` auth, rate limit), report it and let the next interval retry;
  don't spin-retry inside one tick.

## Inputs

- `label` *(optional)* — the trigger label to watch. Defaults to `.armada/config.json` → `triggerLabel`, else `armada`.
- `watch` *(optional)* — `issues` | `prs` | `both`. Which watch a tick runs. Defaults to `issues`.
- `interval` *(optional)* — poll cadence for the `/loop` line. Default ~5m.
- `dispatch` *(optional)* — `shipwright` | `flagship`. Defaults to config, else `shipwright`.

## Output

- A composed `/loop` command the user can paste to arm the new-issue and/or ready-PR watch.
- Per new-issue tick: eligible count, the issue picked (if any), the dispatch target, the PR.
- Per ready-PR tick: ready count, the PR picked (if any), the pipeline outcome (merged / awaiting
  human / blocked + reason).
- Labels kept in sync — issues `armada` → `armada:underway` → `armada:done` / `armada:blocked`;
  PRs `armada` → `armada:reviewing` → `armada:merged` / `armada:blocked`.
