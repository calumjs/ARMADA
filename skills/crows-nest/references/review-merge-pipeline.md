# crows-nest §4 — the review→merge pipeline (a Workflow)

> Reference for [`crows-nest`](../SKILL.md) §4, dispatched by the PR track
> ([ready-pr-watch.md §3d](ready-pr-watch.md)). Section numbers (§4, §4.1–§4.5, §4.4b) match the
> labels other skills cross-reference (e.g. shipwright's "make-mergeable stage (§4.4b)").

Steps 4.1–4.5 are driven as a **Workflow**, not ad-hoc inline turns: a deterministic graph of
stages — **parallel review fan-out → consolidate → address → verify → make-mergeable → gated merge** — with explicit
state passed between stages and a single terminal result. A Workflow (rather than a chat loop) is
what gives multi-agent control its determinism: each stage's output is structured, the fan-out is
genuinely parallel, and the merge gate is evaluated from data, not from prose the model might
misread. It reuses the **parallel-reviewers + dedupe** pattern that [`muster`](../../muster/SKILL.md)
implements internally.

**The Workflow is bundled, not re-derived.** The stage graph below is encoded as an actual script,
not just the prose here — so the orchestration is the same every run and only its structured
*output* enters the lookout's context:

- **`${CLAUDE_PLUGIN_ROOT}/scripts/review-merge-pipeline.mjs`** — the Workflow itself. It fans out the
  reviewers/builders via `agent()` with **explicit structured-output schemas** (`REVIEW_SCHEMA`,
  `ADDRESS_SCHEMA`, `REBASE_SCHEMA` — the `{severity,file,line,title,detail}` finding shape and the
  address/rebase return contracts), consolidates, runs the bounded address↔review loop, the
  make-mergeable stage, and the gated merge. Inspect the stage graph and the schemas it drives with
  `node ${CLAUDE_PLUGIN_ROOT}/scripts/review-merge-pipeline.mjs --plan` / `--schemas`.
- **`${CLAUDE_PLUGIN_ROOT}/scripts/merge-gate.mjs`** — the merge gate (§4.5's five points + §4.4's
  convergence bound) computed **from data**. The pipeline pipes it the run-state JSON and acts on its
  `decision` (`merge` | `ready_awaiting_human` | `blocked`); **the model never eyeballs the gate.**

> **Always reference the bundled files via `${CLAUDE_PLUGIN_ROOT}/...`.** Plugins are copied into a
> cache, so a relative path breaks once installed — the `${CLAUDE_PLUGIN_ROOT}` prefix resolves to
> wherever the plugin actually landed.

The pipeline runs against one PR `<n>` already claimed `armada:reviewing`
([ready-pr-watch.md §3c](ready-pr-watch.md)). The sections below describe each stage the bundled
Workflow drives — they are the spec the script implements, not a second path the model walks by hand.

## 4.1 Review (parallel fan-out → consolidate)

Dispatch [`muster`](../../muster/SKILL.md) against PR `<n>` as a subagent (via the **`Agent` tool**,
non-interactive, isolated context). `muster` runs its **two lenses in parallel subagents**
(code-review + `codex:codex-rescue`), dedupes by file+title, posts inline comments + a summary on
the PR, and **returns the consolidated structured findings** `{severity,file,line,title,detail}`.

The lookout keeps only the structured return — not the review transcript. The gate is computed from
`summary.blocking`: any blocking finding means the PR cannot merge this round (it must first be
addressed). A **degraded** review (one or both lenses failed) is **not** a green light — treat a
missing review as "not safe to merge", never as "no findings".

## 4.2 Address (subagent)

If there are findings to act on, re-dispatch [`shipwright`](../../shipwright/SKILL.md) in
**address-review mode** as a subagent against PR `<n>`, handing it the findings. Shipwright triages
each comment (agree / discuss / disagree + one-line rationale), implements the agreed changes,
re-validates, pushes to the PR branch, and replies per thread — see shipwright's
[address-review mode](../../shipwright/references/address-review-mode.md). It returns a structured
result: what it changed, what it declined and why, and the new head sha.

If `muster` found nothing actionable, skip straight to verify.

## 4.3 Verify (re-validate)

After an address pass, re-run the project's checks against the updated head and print results:

```bash
<commands.build> && <commands.test> && <commands.lint>   # from .armada/config.json
gh pr checks <n>                                          # CI rollup on the pushed commit
```

Both the local gate and the CI rollup must be green to advance. Pending CI → re-check next tick
(leave `armada:reviewing` on so the tick re-enters here), don't merge on yellow.

## 4.4 Bounded address↔review loop

If the address pass changed code, **re-review** the new head (back to 4.1) so fixes are themselves
reviewed and no blocking finding is left standing. Bound this loop: **`maxReviewRounds` (default 2)**.
On reaching the cap without convergence (blocking findings still open, or checks still red),
**stop** and return `blocked` with "no convergence after N rounds" — do not keep looping or merge
through unresolved blockers.

## 4.4b Make-mergeable — auto-rebase a stale or conflicting PR (only when `autoMerge: true`)

A PR that has passed review and validation can still be **un-mergeable** because its branch drifted
from the base while the pipeline ran — GitHub reports `mergeable: BEHIND` (just stale) or
`mergeable: CONFLICTING` (real conflicts). With `autoMerge: false` that's a hand-back: surface
"needs rebase" and let a human do it (it falls through to §4.5's gate-4 → `blocked`, **don't touch
the branch**). But with `autoMerge: true` the operator has opted into autonomous landing, so parking
on a stale branch for a human defeats the point — the pipeline should **make it mergeable itself**
before the gate, then carry on.

Run this stage **only when `autoMerge: true`** and GitHub reports the PR `BEHIND` or `CONFLICTING`
(read `mergeable` from [ready-pr-watch.md §3a](ready-pr-watch.md); a `mergeable: MERGEABLE` PR skips
this stage entirely):

1. **`BEHIND` (stale, no conflicts)** → update the branch from the base. This is the cheap case —
   no conflict resolution, just bring the head up to date (e.g. `gh pr update-branch <n>`, or a
   shipwright dispatch that rebases and force-pushes when the repo prefers a linear history).
2. **`CONFLICTING`** → **dispatch [`shipwright`](../../shipwright/SKILL.md) in rebase mode** (§12 of
   shipwright) as a subagent (via the **`Agent` tool**, non-interactive, isolated, on the PR's own
   worktree). It rebases the PR branch onto the **configured `baseBranch`**, **resolves the conflicts
   integrating both sides** (never dropping the base's changes), **re-runs build/test/lint** to prove
   the resolution is sound, and **force-pushes with `--force-with-lease`** to the PR's own branch. It
   returns a structured result: `resolved` (with the new head sha) or `unresolved` (with the reason).

**This stage is bounded and fenced — it never force-merges a guess:**

- **Bound the attempts.** Cap rebase/resolve at **`maxRebaseRounds` (default 1, falling back to
  `maxReviewRounds`)**. A rebase that comes back `unresolved`, or that re-conflicts after the cap, is
  **not retried indefinitely** — it stops and falls back to `blocked`.
- **Re-validate after every rebase.** A rebase that produces a clean tree but **breaks the build/
  test/lint must `block`, not merge** — a mechanically-clean conflict resolution can still be
  semantically wrong. The post-rebase head only advances if §4.3's gate is green against it.
- **Re-review the post-rebase diff.** A rebase can introduce new problems, so after a successful
  resolve, loop back to **§4.1 review** on the new head (counts against `maxReviewRounds`) before the
  merge gate — fixes from a rebase are themselves reviewed, never merged unseen.
- **Force-push only fleet-owned branches.** `--force-with-lease` is acceptable here **because it's
  ARMADA's own branch**. If the PR branch carries **non-ARMADA commits** (a human pushed to it),
  **do not force-push** — fall back to `blocked` and let a human rebase, rather than risk clobbering
  their work.
- **Fall back to `blocked`, never force-merge.** If conflicts aren't mechanically resolvable with
  confidence, validation fails post-rebase, the attempt cap is hit, or the branch isn't safely
  fleet-owned, return `blocked` with a clear rationale (which conflict, which check failed). Respect
  branch protections throughout; the merge itself still goes through §4.5's gate with the configured
  `mergeMethod`.

After a successful make-mergeable pass the head is updated, re-validated, and re-reviewed — proceed
to §4.5, where GitHub should now report the PR `mergeable`.

## 4.5 Gated merge

The merge decision is **computed from data by `${CLAUDE_PLUGIN_ROOT}/scripts/merge-gate.mjs`**, not
read off this prose. The pipeline assembles the run-state JSON and pipes it to the script, which
returns exactly one `decision` — `merge` | `ready_awaiting_human` | `blocked` — with the reasons.
**The model acts on that output; it never re-evaluates the gate by hand** (re-interpreting a
5-point gate from English each run is exactly the fragility this script removes).

The state the gate is fed (every field gathered earlier in the pipeline):

```jsonc
{
  "pr": <n>,
  "autoMerge": <config.autoMerge>,          // default false — opt-in only
  "mergeMethod": "<config.mergeMethod>",     // merge | squash | rebase
  "review":   { "blocking": <summary.blocking>, "degraded": <muster degraded?> },
  "ci":       "green" | "pending" | "red",   // from `gh pr checks <n>`
  "isDraft":  <bool>,
  "mergeable": "MERGEABLE" | "BEHIND" | "CONFLICTING" | "UNKNOWN",  // `gh pr view <n> --json mergeable`
  "protectionsSatisfied": <bool>,            // GitHub is the source of truth
  "rounds": <address↔review rounds elapsed>,
  "maxReviewRounds": <config.maxReviewRounds, default 2>
}
```

```bash
echo "$STATE_JSON" | node "${CLAUDE_PLUGIN_ROOT}/scripts/merge-gate.mjs"
# → { "decision": "merge" | "ready_awaiting_human" | "blocked", "reasons": [...], "mergeMethod": ... }
# exit 0 = merge · 10 = ready_awaiting_human · 20 = blocked
```

The script encodes — and **fails closed on** — exactly the five-point gate plus the convergence
bound, so the documented behaviour is the implementation:

1. `autoMerge: true` in `.armada/config.json` (**default false** — see
   [SKILL.md §7](../SKILL.md#7-stopping-and-safety));
2. no unresolved **blocking** finding (`summary.blocking == 0`) and the review was **not degraded**
   (a missing/degraded review is treated as not-safe, never as "no findings");
3. CI is **green** (`gh pr checks <n>` all passing) — never on red or pending;
4. the PR is **not draft** and GitHub reports it **`mergeable`** — with `autoMerge: true` a `BEHIND`
   or `CONFLICTING` PR is first run through **make-mergeable (§4.4b)**; if it still isn't mergeable
   after that bounded attempt, this gate fails → `blocked`. With `autoMerge: false` a non-`mergeable`
   PR fails here untouched ("needs rebase", hand back to a human);
5. the repo's **branch protections / required reviews are satisfied** (let GitHub be the source of
   truth — if `gh pr merge` is refused for an unmet protection, that's a `blocked`, not a retry);

plus the **convergence bound** (§4.4): if blocking findings or red CI persist once `rounds` reaches
`maxReviewRounds`, the gate returns `blocked` ("no convergence after N rounds") rather than looping.

Acting on the decision:

- **`merge`** → merge with the **configured method**, **reap the merged head branch**, and record
  `merged`:

  ```bash
  gh pr merge <n> --<mergeMethod>   # merge | squash | rebase, from config — then reap (below)
  ```
- **`ready_awaiting_human`** (gates 2–5 hold but `autoMerge` is off) → stop before merge; never
  merge.
- **`blocked`** → return the specific reason from the gate output.

Either way the Workflow yields exactly one terminal result for
[ready-pr-watch.md §3e](ready-pr-watch.md) to label.

### Branch cleanup on merge — reap the head branch (best-effort, fail-soft)

A merge that leaves its head branch behind lets stale branches pile up (we once hand-deleted 8 at
once). So the **merge step reaps the merged head branch as part of finishing the PR**, not as a
later chore. This is encoded in `runReviewMergePipeline`'s merge action (the `reapMergedBranch`
helper) so it runs identically every time:

The merge call deliberately **omits** `--delete-branch` — the reap owns deletion instead, because it
applies a guard `--delete-branch` can't (see the open-PR guardrail below). It works for **squash- and
rebase-merges** too because it keys off the PR's `MERGED` state, **not** `git branch --merged` (which
mis-reports a squash-merged branch as unmerged).

1. **Remote.** Once the guardrails clear, `git push origin --delete <head>` drops the remote head
   branch, fail-soft.
2. **Local — fail-soft reap.** Any local leftovers are cleaned: if a **worktree** still has the
   branch checked out it's removed **first** (a checked-out branch can't be deleted), then the local
   branch is force-deleted (`git branch -D` — a squash/rebase merge leaves the local branch looking
   "unmerged" to git).

**Guardrails — the cleanup never deletes the wrong thing and never fails the merge:**

- **Only `MERGED` PRs, only the head branch.** It re-reads the PR state and reaps only its
  `headRefName`; a non-`MERGED` PR is left alone.
- **Never the base/default or a protected branch.** If the head ref equals the configured
  `baseBranch` (or `master`/`main`) it is skipped outright.
- **Never a branch that still backs another open PR.** Before deleting, it checks
  `gh pr list --head <head> --state open`; if another open PR shares the head branch (or the check
  can't be confirmed) the reap is skipped, so a shared branch is never orphaned. This is exactly the
  guard `gh pr merge --delete-branch` lacks, and the reason the merge omits that flag.
- **Best-effort and fail-soft — a failed delete never fails the merge.** Deleting the *remote*
  branch can be refused by branch protections or a permission layer; the branch may also still be
  checked out in a worktree. **None of these abort the merge or the pipeline** — the PR is already
  merged. Each failure is logged into the merge trail (e.g. "remote branch delete refused
  (protection?)", "worktree remove failed (left in place)") and the Workflow carries on. The whole
  reap is wrapped so even an unexpected error degrades to a logged note, never a thrown failure.

A branch the cleanup can't drop (protection, or a worktree it couldn't remove) simply remains for a
human — the lifecycle is **best-effort, not guaranteed-deletable**.
