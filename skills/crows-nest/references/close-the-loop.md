# crows-nest §5 — close the loop on shipped issues

> Reference for [`crows-nest`](../SKILL.md) §5. Each tick, after the dispatch pass
> ([SKILL.md §2](../SKILL.md#2-one-tick-of-the-unified-scheduler)) or whenever a merge pipeline
> reports a PR merged, the lookout walks its in-flight issues and closes the ones that are genuinely
> done. Section numbers (§5a–§5e) match the labels other skills cross-reference.

> **Multi-repo (crows-nest §1):** every `gh` call below is a **remote** op, so each carries
> `<repoArgs>` = `--repo <activeRepo>` when multi-repo is configured (empty otherwise — the ambient cwd
> repo, exactly as today). This includes the mutating close/reconcile calls (`gh issue close`,
> `gh issue edit`, `gh pr edit`, `gh pr comment`), which act cross-repo just like the §2a scans. The one
> exception is the **local** head-branch reap (`git push origin --delete`, §5d): git acts on the
> *checkout's* origin remote, not `<activeRepo>` — but because build/merge is guarded to the checkout
> repo (§1), the reap only ever runs for that same repo, so it stays correct.

Opening a PR is not finishing an issue. An issue left on `armada:done` after its PR has merged is
the lookout's blind spot: the work shipped but the backlog still shows it open. So each tick — after
the dispatch pass (SKILL.md §2), or whenever a merge pipeline reports a PR merged — the lookout also
walks the **in-flight** issues and closes the ones that are genuinely done. An issue is **done** only
when **both** hold: its linked PR is **merged** *and* its **acceptance criteria are satisfied**. Merge
alone is not enough; a PR can land and still leave an acceptance criterion unmet.

## 5a. List in-flight issues

Walk the issues ARMADA still owns that *might* be finishable — past the build but not yet terminal:

```bash
gh issue list <repoArgs> --state open --label "armada:done" --json number,title,labels,body --limit 50
```

Skip any issue still **in motion** — labelled `armada:underway` or `armada:reviewing`. Those mean a
build or a review pipeline is still running against it; closing one mid-flight would yank work out
from under a subagent. **Never close while `armada:underway` / `armada:reviewing` is set** — wait for
it to clear to `armada:done` first. (Same idempotency guard as SKILL.md §2 /
[ready-pr-watch.md §3](ready-pr-watch.md): a terminal action never races an in-progress one.)

## 5b. Find the linked PR and confirm it merged

shipwright links its PR to the issue with `Closes #<n>` (full) or `Relates to #<n>` (partial). Find
that PR and read its merge state:

```bash
gh pr list <repoArgs> --search "<number> in:body" --state all --json number,body,state,mergedAt,mergeCommit
gh pr view <repoArgs> <pr> --json state,mergedAt,mergeCommit --jq '.state'   # must be "MERGED"
```

- **No merged PR yet** (open, or `state != "MERGED"`) → leave the issue as-is; a later tick re-checks.
- **`Relates to #<n>`** (partial) → the PR only chips at the issue; **do not close.** A partial PR
  merging does not finish the issue — it outlives the PR.
- **`Closes #<n>`** and merged → candidate for closing; proceed to the acceptance-criteria check.

Capture the merge commit (`mergeCommit.oid`, abbreviated) for the closing trail.

## 5c. Confirm the acceptance criteria are satisfied

Do **not** close on merge alone. Read the issue body's acceptance-criteria checklist and confirm it
is addressed, by either of:

- **every `- [ ]` is now `- [x]`** in the issue body (the checklist is fully ticked), **or**
- the merged PR / a closing comment **maps each criterion to where it was met** (e.g. "AC1 → §5b of
  crows-nest; AC2 → label list in commission §4"), so the trail is auditable even when the boxes
  weren't mechanically ticked.

If **any** criterion is unmet or explicitly deferred, **do not close.** Either leave the issue open
with a comment naming the gap, or open a focused follow-up for the remainder. When unsure, leave it
open — a wrongly-closed issue is worse than a stale `armada:done`.

## 5d. Close with a trail

When both gates pass, close the issue with a comment that links the merged PR and maps the criteria,
then reconcile the labels to the terminal state:

```bash
gh issue close <repoArgs> <number> \
  --comment "🔭 crows-nest: shipped in #<pr> (merged <sha>). ACs: <each criterion → where it was met>."
gh issue edit <repoArgs> <number> \
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

### Reap a lingering head branch (fallback safety net)

The merge step already reaps the head branch (see
[review-merge-pipeline.md §4.5 "Branch cleanup on merge"](review-merge-pipeline.md)). This is just a
**fallback** for the case where it didn't — a PR merged outside the pipeline, a merge that predated
the cleanup, or a delete that was refused at the time. When the loop confirms a PR `MERGED`
(§5b), check for and best-effort reap its head branch — **with the same guardrails and fail-soft
posture as the merge step**:

```bash
head=$(gh pr view <repoArgs> <pr> --json headRefName,state --jq 'select(.state=="MERGED")|.headRefName')
# Only if the branch still exists, isn't the base/default, and no other open PR uses it:
if [ -n "$head" ] && [ "$head" != "<baseBranch>" ] \
   && git ls-remote --exit-code --heads origin "$head" >/dev/null 2>&1 \
   && [ "$(gh pr list <repoArgs> --state open --head "$head" --json number --jq 'length')" = "0" ]; then
  git push origin --delete "$head" || echo "branch reap skipped (protection/permission?) — non-fatal"
fi
```

- **Never** delete the base/default or a protected branch; **skip** a branch still backing another
  open PR; treat a refused delete as **logged-and-continue**, never an error. A branch that can't be
  dropped just stays for a human — closing the issue does not depend on the reap succeeding.

## 5e. Report the tick

```
crows-nest close tick: 2 in-flight · #142 "Add CSV export" → shipped (PR #150 merged a1b2c3d, ACs met) · #144 left open (AC3 deferred)
```

## 5f. On-merge auto-reconcile — a fleet PR merged out-of-band

> Detail for [SKILL.md §5.1](../SKILL.md#51-on-merge-auto-reconcile--a-fleet-pr-merged-out-of-band).
> §5a–§5e above reconcile from the **issue** side (walk `armada:done` issues, find their merged PR).
> §5f reconciles from the **PR** side, for the case those miss: a fleet PR that **merged out-of-band**
> and is stranded on a non-terminal `armada:*` state.

The [review-merge pipeline](review-merge-pipeline.md) only reaches `armada:merged` (§3e) when the
lookout **itself** merged the PR — which the auto-mode **self-approval classifier blocks** for ARMADA's
own fleet PRs, even with `autoMerge: true`. So those PRs are merged **by a human** (`gh pr merge`) and
never pass through §3e: the PR stays on `armada:reviewing` / bare `armada`, and the shipped bell never
rang. §5f closes that gap.

### Detect (from the §2a merged scan)

The lookout already pulled recently-merged fleet PRs in the batched scan
([SKILL.md §2a](../SKILL.md#2a-scan-both-tracks-in-one-batched-scan)):

```bash
gh pr list <repoArgs> --label "<triggerLabel>" --state merged \
  --json number,title,labels,mergedAt,closingIssuesReferences,headRefName --limit 30
```

A PR is a **reconcile candidate** iff it is MERGED **and** carries **neither** `armada:merged` nor
`armada:blocked`. The presence of `armada:merged` is the whole idempotency mechanism: it is added on
reconcile (below) and thereafter filters the PR out of this candidate set on every later tick — so the
relabel and the ring fire **exactly once**, and survive a `/loop` restart because the marker is a
GitHub label, not in-memory state. **The guard is symmetric across both merge paths, so the shipped
bell rings exactly once regardless of which reconciles first:** a PR the §3e pipeline already merged
carries `armada:merged` and already rang — skipped here by this guard; and in the reverse case (a tick
fires in the non-atomic gap between the pipeline's `gh pr merge` and its Workflow return, while the PR
is MERGED but still `armada:reviewing`) **this** reconcile wins the race, sets `armada:merged`, and
rings — after which §3e's on-completion reconcile observes `armada:merged` already present and **skips
its own ring** (SKILL.md §3 / [ready-pr-watch §3e](ready-pr-watch.md#3e-record-the-outcome-on-completion)).
Either way the two merge paths never double-ring.

### Reconcile (per candidate, in order)

1. **PR → terminal `armada:merged`**, clearing the transient in-flight state. (The candidate set above
   already excludes `armada:blocked` PRs, so only the transient `armada:reviewing` needs clearing.)

   ```bash
   gh pr edit <repoArgs> <pr> --add-label "armada:merged" --remove-label "armada:reviewing"
   gh pr comment <repoArgs> <pr> --body "🔭 crows-nest: reconciled — merged out-of-band; marked armada:merged."
   ```

2. **Issue → closed + `armada:shipped`.** Resolve the PR's `closingIssuesReferences` / `Closes #<n>`
   and run §5b–§5d for that issue: confirm the acceptance criteria (§5c — merge alone is not enough),
   then close-and-reconcile to the single terminal `armada:shipped` (§5d). Because a merged `Closes`
   PR auto-closes its issue, this is normally the §5d **label reconcile** on an already-closed issue,
   not a fresh close. `Relates to #<n>` (partial) links are **not** closed — same rule as §5b.

3. **Ring the shipped bell once** (SKILL.md §8), `ARMADA_BELL_EVENT=shipped`, worded to what step 2
   resolved: with a shipped closing issue, `⚓ Shipped #<issue> → PR #<pr> merged`; when step 2 found
   **no** resolvable closing issue (unlinked PR, or AC not met so no issue closed), ring about the PR
   only — `⚓ Shipped: PR #<pr> merged` — never naming a `#<issue>` that doesn't exist. Both channels,
   fired **after** steps 1–2 land (§8c).

The head-branch reap of §5d ("Reap a lingering head branch") applies here too — a hand-merged PR is
exactly the "merged outside the pipeline" case that fallback exists for.

### Idempotency invariants

- **Fires once:** step 1's `armada:merged` removes the PR from the candidate set forever after; the
  ring (step 3) is inside the same reconcile branch, so a terminal PR never re-rings.
- **No thrash:** the step only ever *adds* the terminal and *removes* transient labels — it never
  removes a terminal or re-adds a transient, so labels can't oscillate across ticks.
- **Restart-safe:** the guard is a persisted GitHub label, not an ephemeral file — a fresh `/loop`
  process reconstructs the exact same skip decision from the labels alone.
- **Fail-soft:** a `gh` error on one PR is logged and left for the next tick (it reappears in the
  merged scan while still un-terminal); it never blocks the tick or the rest of the batch.

### Report

```
crows-nest reconcile tick: 1 out-of-band merge · PR #150 → armada:merged, #142 → armada:shipped (issue closed), bell rung
```
