# crows-nest §3 — the PR track: dispatch ready PRs into the review→merge pipeline

> Reference for [`crows-nest`](../SKILL.md) §3. The body keeps the hot path (config/scope §1,
> the unified tick §2, arming the loop §6, safety §7); this file holds the ready-PR track's
> detail. Section numbers (§3, §3a–§3f) match the labels other skills cross-reference.

The PR track is **not a separate tick** — it's scheduled in the same unified tick as the issue track
([SKILL.md §2](../SKILL.md#2-one-tick-of-the-unified-scheduler)), from the same batched scan. §3 is
what the scheduler does for each **PR on the frontier** (SKILL.md §2c): claim it and launch its
review→merge pipeline ([review-merge-pipeline.md §4](review-merge-pipeline.md)) as a **background**
Workflow, then return. PR pipelines run **concurrently with issue builds and with each other**,
bounded by `maxConcurrentReviews` — the lookout doesn't drain the issue track before starting reviews.

## 3a. Eligibility (evaluated in the §2a scan)

The ready-PR gate is applied during the unified scan (SKILL.md §2a), not as a second `gh pr list`. A
PR is **ready** — eligible for the frontier — when **all** hold:

- it is **open** and **not draft**;
- it carries the `<triggerLabel>` (`armada`) — shipwright auto-arms it with this when it opens the
  PR, so ARMADA-created PRs enter the pipeline automatically with no manual PR-arming gate;
- **CI is not failing** — `statusCheckRollup` has no `FAILURE`/`ERROR`/`TIMED_OUT` checks (pending
  is fine to re-check next tick; a green or not-yet-failing rollup passes this stage);
- it isn't **already mid-pipeline** — not labelled `armada:reviewing`, and not already
  `armada:merged` or `armada:blocked` (terminal states a future tick must not re-pick).

This is the ready-PR analogue of SKILL.md §2a's issue dedup, and `armada:reviewing` is the
idempotency guard that stops a second tick double-driving the same PR. The graph (SKILL.md §2b) may
still **hold** a ready PR behind a base-about-to-move or same-file edge even when it passes this gate
— those held PRs are reported in SKILL.md §2e, not dispatched.

## 3b. Selection (the §2c frontier, up to `maxConcurrentReviews`)

The scheduler (SKILL.md §2c) selects which ready PRs to launch this tick — the frontier PRs,
oldest-update-first (FIFO on `updatedAt`), up to `(maxConcurrentReviews − reviews-in-flight)`.
**Multiple PRs are reviewed concurrently** when the budget allows and the graph permits; the rest are
held for later ticks. If no PR is on the frontier and none is in flight, the SKILL.md §2e report notes
the harbour is clear.

## 3c. Claim it

```bash
gh pr edit <n> --add-label "armada:reviewing"
gh pr comment <n> --body "🔭 crows-nest: ready-PR pipeline started — review → address → re-validate → gated merge."
```

## 3d. Drive the pipeline (background Workflow)

Hand the claimed PR to the **review→merge Workflow** ([review-merge-pipeline.md §4](review-merge-pipeline.md)),
launched as a **background** dispatch (via the **`Agent` tool**, non-interactive, isolated context,
`run_in_background: true`) — exactly as issue builds run in SKILL.md §2d. Launching it in the
background means the tick **kicks off the pipeline and returns immediately** instead of blocking the
whole `/loop` tick until the review-address-merge finishes (which takes many minutes). The lookout
goes straight back to scheduling — dispatching more PR pipelines up to `maxConcurrentReviews` and more
issue builds up to `maxConcurrentBuilds`, all concurrently. The Workflow returns a single terminal
result the lookout maps to the PR-track labels when it **completes** (§3e). The lookout itself stays
thin: it claims, launches the Workflow, and records the outcome — it does **not** carry the review or
build transcripts (those live in the subagents' own contexts).

## 3e. Record the outcome (on completion)

The pipeline result arrives **asynchronously** — the tick that launched it has long since returned,
so this reconcile runs when the background Workflow **completes** (the `Agent` tool surfaces its
return). Until then the PR stays `armada:reviewing`, and the in-flight guard (SKILL.md §2a / §3a)
keeps it out of every intervening tick. On completion, map the Workflow's terminal result to a
PR-track label and a comment — a PR must **never** be left on `armada:reviewing`:

- `merged` → `gh pr edit <n> --remove-label "armada:reviewing" --add-label "armada:merged"`; comment
  the merge commit. (Only reachable with `autoMerge: true` and all gates green.)
- `ready_awaiting_human` → `gh pr edit <n> --remove-label "armada:reviewing"` (leave `armada` on so a
  human sees it); comment "✅ reviewed, addressed, green — **awaiting human merge** (auto-merge off)".
  This is the default terminal state when `autoMerge` is off.
- `blocked` → `gh pr edit <n> --remove-label "armada:reviewing" --add-label "armada:blocked"`; comment
  the reason (blocking finding, red CI, no convergence, non-mergeable, branch protection unmet).

## 3f. Report

The PR track's dispatch is reported as part of the **unified schedule line** (SKILL.md §2e), alongside
the issue builds dispatched the same tick — builds running, reviews running, held + why, in one line.
The per-PR pipeline outcome is logged separately when its background Workflow completes (§3e):

```
crows-nest: #150 review pipeline completed → awaiting human merge (auto-merge off)
```
