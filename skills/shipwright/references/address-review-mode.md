# shipwright — address-review mode

This is shipwright's **address-review mode**: respond to review comments on an existing PR. It's
the stage [`crows-nest`](../../crows-nest/SKILL.md)'s ready-PR pipeline dispatches after a
[`muster`](../../muster/SKILL.md) review (see crows-nest's
[review→merge pipeline](../../crows-nest/references/review-merge-pipeline.md), §4.2), or a human
pointing shipwright at a PR. The build-mode body lives in [SKILL.md](../SKILL.md); jump here when
you're invoked with a PR number and review findings rather than an issue.

When shipwright is dispatched against an **existing PR with review comments**, it switches from
building to **addressing review**. The goal is a considered response to every comment — not blind
compliance. A reviewer can be wrong; shipwright's job is to engage honestly, fix what's genuinely
wrong, and say why when it disagrees.

> **Fetch every comment** → **triage each (agree / discuss / disagree + one-line rationale)** →
> **implement the agreed changes** → **re-validate** → **push** → **reply per thread**.

## 11a. Check out the PR branch

Work on the PR's **own branch**, not a fresh one — the replies and pushes must land on the PR.
Use the existing worktree if the PR came from one this session, else add a worktree on its head:

```bash
gh pr checkout <n>        # or: git worktree add ../<n>-address <prHeadRef>
git pull --ff-only        # make sure you're on the latest pushed head
```

## 11b. Fetch every review comment

Gather both the inline review comments and any top-level review summaries — don't miss threads:

```bash
gh api repos/{owner}/{repo}/pulls/<n>/comments --paginate   # inline review comments (file+line+id)
gh api repos/{owner}/{repo}/pulls/<n>/reviews  --paginate    # review summaries / state
gh pr view <n> --json comments                               # issue-style PR comments
```

If you were handed `muster`'s structured findings directly, reconcile them with the posted comments
so each finding maps to the thread you'll reply on (match by file + line + title). Every comment
gets a triage decision — none is silently skipped.

## 11c. Triage each comment

For each comment, decide one of three and record a **one-line rationale**:

- **agree** — the comment is right; you'll implement the change.
- **discuss** — partly right, needs clarification, or there's a better fix than the one suggested;
  you'll propose an alternative in the reply rather than implement as-literally-stated.
- **disagree** — the comment is wrong or out of scope; you'll decline with a reason (and, for a
  **blocking** finding you disagree with, this is where you make the case — an unresolved blocking
  finding stops the gated merge, so a disagreement on one is a genuine hand-back-to-human, not a
  unilateral override).

Keep scope discipline: address what the review raised, don't gold-plate adjacent code. Note any
genuinely out-of-scope-but-valid point as a follow-up rather than expanding the PR.

## 11d. Implement the agreed changes

Implement every **agree** (and any **discuss** where you and the reviewer would clearly land on a
fix). Match the surrounding code as in [SKILL.md §5](../SKILL.md). **Commit in small logical
commits** referencing what they address (`address review: escape quotes in CSV export (#150
thread)`), so the diff maps back to the threads.

## 11e. Re-validate

Run the project's checks and **print the outputs** — same gate as [SKILL.md §6](../SKILL.md):

```bash
<commands.build> && <commands.test> && <commands.lint>   # must be green
git diff --exit-code                                     # after format, no stray diff
```

Don't push a red tree. If a fix can't be made green, that comment becomes a `discuss`/`disagree`
with the reason, not a broken push.

## 11f. Push and reply per thread

```bash
git push                       # to the PR's own branch — updates the PR in place
```

Then **reply to each thread** so the reviewer sees a response on every point. Reply on the specific
comment thread (`in_reply_to`), don't just leave one blanket comment:

```bash
gh api repos/{owner}/{repo}/pulls/<n>/comments \
  -f body="Fixed in <sha> — <one line>."   -F in_reply_to=<comment_id>
# or, when declining:
gh api repos/{owner}/{repo}/pulls/<n>/comments \
  -f body="Declined: <one-line rationale>." -F in_reply_to=<comment_id>
# discuss:
gh api repos/{owner}/{repo}/pulls/<n>/comments \
  -f body="Suggest instead <alternative> — <why>. Let me know."  -F in_reply_to=<comment_id>
```

**Do not resolve threads** — resolving is the reviewer's call. Shipwright replies and leaves the
thread open unless the repo is explicitly configured to let the builder resolve. Post a short
top-level summary too (`gh pr comment <n>`): how many agreed/implemented, discussed, declined, and
the new head sha.

## 11g. Return the structured result

In the pipeline, return a machine-readable result to the lookout so it can re-review / gate:

```json
{
  "pr": 150,
  "headSha": "<new head sha>",
  "addressed": [ { "thread": 998, "decision": "agree",    "fixedIn": "<sha>" } ],
  "declined":  [ { "thread": 999, "decision": "disagree", "rationale": "out of scope; tracked as follow-up" } ],
  "validation": "pass",
  "blockingDisagreement": false
}
```

`blockingDisagreement: true` (you disagreed with a *blocking* finding) signals the lookout to hand
back to a human rather than merge — shipwright never merges, and never resolves a blocking finding
by fiat.
