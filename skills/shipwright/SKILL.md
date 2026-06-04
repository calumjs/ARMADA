---
name: shipwright
description: >
  The ARMADA builder. Works a single GitHub issue end-to-end: research, plan, implement in an
  isolated git worktree, validate with the project's own build/test/lint commands, and open a PR.
  Trigger when the user says "work on issue", "pick up #123", "build this issue", "implement
  #123", "start on the backlog item", references a GitHub issue number to implement, or invokes
  /shipwright. Also the default target that crows-nest dispatches to. Has an address-review mode:
  given a PR and its review comments, it triages each (agree/discuss/disagree), implements the
  agreed changes, re-validates, pushes, and replies per thread — triggered by "address review
  comments", "respond to the review", "fix the PR feedback". Accepts a GitHub issue number, a
  free-text description, or a PR number plus review findings. Stack-agnostic — it runs whatever
  build/test commands the repo configures.
---

# shipwright — build one issue into a PR

End-to-end workflow for picking up an issue, planning it, building it in an isolated worktree, and
opening a pull request. `shipwright` is stack-agnostic: it discovers the project's commands from
`.armada/config.json` (or infers them) rather than assuming any language or framework.

**shipwright runs in one of two modes:**

- **Build mode** (default, §0–§10) — take an issue and produce a PR.
- **Address-review mode** (§11) — take an **existing PR plus its review comments** and respond to
  them: triage each, implement the agreed changes, re-validate, push, and reply per thread. This is
  the stage [`crows-nest`](../crows-nest/SKILL.md) dispatches inside its ready-PR pipeline, after
  [`muster`](../muster/SKILL.md) has reviewed. If you're invoked with a PR number and review
  findings rather than an issue, jump to §11.

## 0. Discover the project's commands

Read `.armada/config.json` → `commands` for `build` / `test` / `lint` / `format` / `run` and
`baseBranch`. If the file is absent the repo isn't commissioned — run
[`commission`](../commission/SKILL.md) first (it detects and writes these). If you're mid-flight
without it, infer from the repo and **state your inference before relying on it**:

- `package.json` → `scripts` (`build`, `test`, `lint`)
- `Makefile` → targets (`make build`, `make test`)
- `*.csproj` / `*.sln` → `dotnet build` / `dotnet test` / `dotnet format`
- `Cargo.toml` → `cargo build` / `cargo test` / `cargo clippy` / `cargo fmt`
- `pyproject.toml` / `tox.ini` → `pytest`, `ruff`, etc.

If you can't determine a command and it matters, ask once rather than guessing.

## 1. Identify the issue

Accept **either**:
- A GitHub issue number (e.g. `#42` or `42`) — fetch with `gh issue view <number>`.
- A free-text description — search with `gh issue list --search "<query>"`.

If free text matches no issue, confirm with the user before proceeding without one.

### 1a. Determine the right base branch

Don't assume `main`. Some issues target code that lives on a long-lived feature branch and hasn't
merged yet — branching off main would leave you with nothing to fix. For each file path or symbol
the issue mentions:

```bash
# Does the file exist on the default base?
git ls-tree origin/<baseBranch> -- <path/from/issue>

# If not, find which branch has it:
git branch -a --contains $(git log --all --oneline -- <path/from/issue> | head -1 | awk '{print $1}')

# If the issue references a recent PR, check what it targeted:
gh pr view <pr-number> --json baseRefName,headRefName,state,mergeCommit
```

If the target code only exists on a non-default branch, surface it with options: (a) branch off
the feature branch, (b) merge feature→base first then branch off base, (c) cherry-pick onto a
fresh branch (rare). Wait for the user's call.

Present a scope summary and get confirmation before building:

```
## Issue: <title>
- **Issue:** #<number> (or "no linked issue")
- **Summary:** <1-3 sentences>
- **Acceptance criteria:** <bullet list>
- **Base branch:** <base — and why, if not the default>

Proceed?
```

## 2. Research and gather context

Run these in parallel where possible:

- **Read the issue fully** — description, comments, labels, linked issues/PRs.
- **Read project docs** — `README`, `CLAUDE.md`/`AGENTS.md`, `docs/`, architecture/decision records
  (`docs/adr/` or similar). Note any documented decision that constrains the approach.
- **Read the existing code** in the affected area. Understand the patterns, related modules, tests,
  and the files that will need changes. Find where tests live and how they're run.
- **Run any audit the issue calls out *first*.** If the issue says "this is only safe if X holds"
  or "audit Y before merging", treat that as research — its findings often reshape the plan (the
  change may be inert in real data, or the gaps may dwarf the headline change).

## 3. Plan implementation

Present a structured plan for approval:

```
## Implementation Plan: <title>

### Context
<What you learned from docs, decisions, and the code>

### Approach
<High-level approach and rationale>

### Files to create/modify
- `path/to/file` — <what changes>

### Acceptance criteria mapping
- [ ] Criterion 1 → <how it will be met>

### Testing strategy
- <tests to add/update and how they run>

### Risks / open questions
- <unknowns or risks>
```

Wait for approval. Adjust on feedback.

### 3b. Decompose large issues into a stacked PR series

Most issues ship as one PR. **Large ones should ship as a stack.** Trigger decomposition when the
change touches multiple distinct surfaces, the diff would plausibly exceed ~2,000 lines, or the PR
body would need to be organised into "slices" to be readable. A monster PR is slower to land (one
blocker holds the whole thing), harder to review carefully, and riskier to revert.

If slicing:
- **Each slice = one branch, one PR, one focused capability.**
- **Slices stack — a slice's base is the previous slice's head, not the base branch.** This keeps
  each PR's diff small and reviewable in isolation.
- **Identify the foundation first** (usually data model + base surface); co-equal siblings branch
  off it and can be worked in parallel (their own worktrees). Cross-cutting / hardening passes go
  last as their own slices.
- For non-trivial stacks (4+ slices), keep a long-lived `<issue>-rollup` branch that merges each
  slice's head as it stabilises — it's both the continuous-integration surface and the eventual
  single merge unit. Fixes land on the slice branch, never the rollup.

Present the slice tree (slice numbers, branch names, base for each, one-line purpose) and **get
sign-off before writing code** — it's the most expensive thing to redo.

## 4. Create a worktree

Build in an isolated worktree so multiple issues can be worked in parallel.

If the harness exposes the `EnterWorktree` tool, use it (creates the worktree and switches the
session into it in one step):

```
EnterWorktree(name: "<number>-<short-description>")
```

Otherwise fall back to git:

```bash
git worktree add ../<number>-<short-description> -b <number>-<short-description>
cd ../<number>-<short-description>
```

Rename the branch to follow the repo's convention if needed (check `git branch -a` for patterns
like `feature/<number>-...`, `fix/<number>-...`). Then sync with the base branch — worktrees
inherit from `HEAD` at creation, which may be stale:

```bash
git pull origin <baseBranch>
```

**All code changes happen in the worktree, never the main checkout.** If the project needs a
dependency install in a fresh tree (e.g. `npm ci`, `bundle install`, restoring packages), do it
in the worktree.

## 5. Implement

Follow the approved plan. **Match the surrounding code** — its naming, structure, error handling,
and idioms are the convention; read neighbouring files before inventing a new pattern. Specifics:

- Keep changes scoped to the issue. Don't fix unrelated debt unless asked (note it instead).
- Update docs alongside code when the change affects documented behaviour (API reference,
  architecture notes, README usage).
- **Commit frequently** — small, logical commits, not one giant batch.

### Data migrations / schema changes

If the change alters persisted data or schema, review any generated migration **before
committing**. Auto-generated "drop old → create new" ordering is data-destructive when you're
restructuring. For data-preserving changes: create the new shape first, copy data across, then drop
the old — and mirror the round-trip in the down/rollback path so it's reversible.

## 6. Validate

Before opening a PR, run the project's checks and **print the outputs**:

```bash
<commands.build>      # must exit 0
<commands.test>       # must exit 0 — no new failures vs the base-branch baseline
<commands.lint>       # clean
<commands.format>     # then: git diff --exit-code   (no diff)
```

### Establish a baseline before chasing "new" failures

If tests fail with surprising results, check whether they already fail on the base branch **before
assuming you caused it**. The worktree shares git history, so run the same filter from the main
checkout on the base branch. Pre-existing failures are not yours — note them as pre-existing in the
PR body and move on. Assuming inherited failures are yours can burn 30+ minutes on the wrong root
cause.

### Pre-commit hooks and inherited lint debt

If a pre-commit hook lints whole files (not just your lines) and blocks on pre-existing debt you
didn't introduce: verify it's pre-existing (`git show origin/<base>:<path>` / `git blame`), then
suppress narrowly with a justified inline disable comment to keep the diff focused. Don't expand the
PR to fix unrelated debt, and don't bypass the hook with `--no-verify`.

## 7. Open the pull request

```bash
git push -u origin <branch>
```

Write the PR body from [references/pr-template.md](references/pr-template.md): what changed and why,
key decisions with rationale, how each acceptance criterion is met, testing performed, and
screenshots for UI changes. Link the issue:

- `Closes #<number>` if fully addressed; `Relates to #<number>` if partial.

```bash
gh pr create --title "<concise title>" --body "$(cat <<'EOF'
<PR body>
EOF
)"
gh issue comment <number> --body "Implementation PR: #<pr-number> — <one-line summary>"
```

### Auto-arm the PR for the ready-PR watch

A PR ARMADA opens is part of the fleet's work, so **arm it for review on creation** — add the
configured `triggerLabel` (`triggerLabel` from `.armada/config.json`, default `armada`) to the PR
so [`crows-nest`](../crows-nest/SKILL.md)'s ready-PR watch (§3) picks it up with no manual labelling
step:

```bash
gh pr edit <pr-number> --add-label "<triggerLabel>"   # default "armada"
```

This is deliberate and safe: the ready-PR pipeline's only *consequential* action is the final
merge, and that is **already gated by `autoMerge` (default `false`)** — review and address never
merge. So one gate is enough; auto-arming doesn't add risk, it just removes a redundant second gate.
Specifically:

- **Only arm PRs ARMADA itself opens** (build mode). Don't reach out and label arbitrary human PRs.
- With `autoMerge: false` the pipeline reviews → addresses → re-validates and **stops before
  merging** anyway; with `autoMerge: true` the user has already opted into autonomous merge. The
  sole gate on the final merge is `autoMerge`.
- A human can still **disarm** the PR by removing the `<triggerLabel>` label — the arming switch
  works both ways, per object.

If an automated reviewer (e.g. Copilot) is configured and can be requested via CLI, request it;
if not, note it in the handoff so the user can add it manually — don't block on it.

## 8. Handoff

Share the PR URL, summarise what was done and any follow-ups, and note if a new architecture
decision should be recorded. The worktree stays available for review iteration.

## 9. Optionally offer a walkthrough video

For user-visible features — new workflows, multi-step UX, role-based behaviour, anything harder to
read than to watch — offer a short demo video via `logbook` (when it's in the fleet). **Skip** for
refactors, dependency bumps, infra-only changes, or one-line fixes. Phrase it as one question and
don't auto-record:

> "Want me to record a short walkthrough video for the stakeholders?"

Default to skipping if unsure — over-offering trains the user to mute the suggestion.

## 10. Suggest skill improvements

After each issue, reflect: steps that were missing or mis-ordered, conventions worth documenting,
friction worth automating. Present suggestions and, if approved, open a PR against this skill.

## 11. Address-review mode — respond to review comments on a PR

When shipwright is dispatched against an **existing PR with review comments** (by
[`crows-nest`](../crows-nest/SKILL.md)'s pipeline after a [`muster`](../muster/SKILL.md) review, or
by a human pointing it at a PR), it switches from building to **addressing review**. The goal is a
considered response to every comment — not blind compliance. A reviewer can be wrong; shipwright's
job is to engage honestly, fix what's genuinely wrong, and say why when it disagrees.

> **Fetch every comment** → **triage each (agree / discuss / disagree + one-line rationale)** →
> **implement the agreed changes** → **re-validate** → **push** → **reply per thread**.

### 11a. Check out the PR branch

Work on the PR's **own branch**, not a fresh one — the replies and pushes must land on the PR.
Use the existing worktree if the PR came from one this session, else add a worktree on its head:

```bash
gh pr checkout <n>        # or: git worktree add ../<n>-address <prHeadRef>
git pull --ff-only        # make sure you're on the latest pushed head
```

### 11b. Fetch every review comment

Gather both the inline review comments and any top-level review summaries — don't miss threads:

```bash
gh api repos/{owner}/{repo}/pulls/<n>/comments --paginate   # inline review comments (file+line+id)
gh api repos/{owner}/{repo}/pulls/<n>/reviews  --paginate    # review summaries / state
gh pr view <n> --json comments                               # issue-style PR comments
```

If you were handed `muster`'s structured findings directly, reconcile them with the posted comments
so each finding maps to the thread you'll reply on (match by file + line + title). Every comment
gets a triage decision — none is silently skipped.

### 11c. Triage each comment

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

### 11d. Implement the agreed changes

Implement every **agree** (and any **discuss** where you and the reviewer would clearly land on a
fix). Match the surrounding code as in §5. **Commit in small logical commits** referencing what
they address (`address review: escape quotes in CSV export (#150 thread)`), so the diff maps back to
the threads.

### 11e. Re-validate

Run the project's checks and **print the outputs** — same gate as §6:

```bash
<commands.build> && <commands.test> && <commands.lint>   # must be green
git diff --exit-code                                     # after format, no stray diff
```

Don't push a red tree. If a fix can't be made green, that comment becomes a `discuss`/`disagree`
with the reason, not a broken push.

### 11f. Push and reply per thread

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

### 11g. Return the structured result

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

## Inputs

- A GitHub issue number **or** a free-text description (build mode), **or** a PR number plus its
  review comments/findings (address-review mode, §11).
- Optional: a base branch override.

## Output

- **Build mode:** an isolated worktree with the implementation committed; an open, non-draft PR
  linking the issue with a structured summary body, **armed with the `triggerLabel` so the ready-PR
  watch picks it up automatically**; a comment on the issue linking the PR.
- **Address-review mode:** the agreed changes pushed to the PR branch; a per-thread reply on every
  review comment (triaged agree/discuss/disagree, threads left unresolved); a structured result for
  the lookout to re-review and gate on.
