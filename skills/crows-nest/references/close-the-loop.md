# crows-nest §5 — close the loop on shipped issues

> Reference for [`crows-nest`](../SKILL.md) §5. Each tick, after the dispatch pass
> ([SKILL.md §2](../SKILL.md#2-one-tick-of-the-unified-scheduler)) or whenever a merge pipeline
> reports a PR merged, the lookout walks its in-flight issues and closes the ones that are genuinely
> done. Section numbers (§5a–§5e) match the labels other skills cross-reference.

Opening a PR is not finishing an issue. An issue left on `armada:done` after its PR has merged is
the lookout's blind spot: the work shipped but the backlog still shows it open. So each tick — after
the dispatch pass (SKILL.md §2), or whenever a merge pipeline reports a PR merged — the lookout also
walks the **in-flight** issues and closes the ones that are genuinely done. An issue is **done** only
when **both** hold: its linked PR is **merged** *and* its **acceptance criteria are satisfied**. Merge
alone is not enough; a PR can land and still leave an acceptance criterion unmet.

## 5a. List in-flight issues

Walk the issues ARMADA still owns that *might* be finishable — past the build but not yet terminal:

```bash
gh issue list --state open --label "armada:done" --json number,title,labels,body --limit 50
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
gh pr list --search "<number> in:body" --state all --json number,body,state,mergedAt,mergeCommit
gh pr view <pr> --json state,mergedAt,mergeCommit --jq '.state'   # must be "MERGED"
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

## 5e. Report the tick

```
crows-nest close tick: 2 in-flight · #142 "Add CSV export" → shipped (PR #150 merged a1b2c3d, ACs met) · #144 left open (AC3 deferred)
```
