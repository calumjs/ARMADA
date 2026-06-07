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
argument-hint: "<issue-number | description | PR# + findings>"
allowed-tools: Bash, Read, Write, Edit, Grep, Glob, Skill, Agent, EnterWorktree, ExitWorktree
---

# shipwright — build one issue into a PR

End-to-end workflow for picking up an issue, planning it, building it in an isolated worktree, and
opening a pull request. `shipwright` is stack-agnostic: it discovers the project's commands from
`.armada/config.json` (or infers them) rather than assuming any language or framework.

**shipwright runs in one of three modes:**

- **Build mode** (default, §0–§10) — take an issue and produce a PR. For **bug-type** issues this
  mode carries a **reproduce → fix → verify** loop: reproduce the reported symptom on the unpatched
  code first (§2a), then confirm the repro is gone after the fix using the same method (§6a). A green
  build/test/lint is **not** sufficient evidence a bug is fixed.
- **Address-review mode** (§11) — take an **existing PR plus its review comments** and respond to
  them: triage each, implement the agreed changes, re-validate, push, and reply per thread. This is
  the stage [`crows-nest`](../crows-nest/SKILL.md) dispatches inside its ready-PR pipeline, after
  [`muster`](../muster/SKILL.md) has reviewed. If you're invoked with a PR number and review
  findings rather than an issue, jump to §11.
- **Rebase mode** (§12) — take an **existing PR that GitHub reports `BEHIND` or `CONFLICTING`** and
  make it mergeable: rebase its branch onto the configured base, resolve conflicts integrating both
  sides, re-validate, and force-push (with `--force-with-lease`) to the PR's own branch. This is the
  make-mergeable stage [`crows-nest`](../crows-nest/references/review-merge-pipeline.md) dispatches in its ready-PR pipeline
  (§4.4b) **only when `autoMerge: true`**. If you're invoked to rebase/make-mergeable a PR rather
  than to build or to address review, jump to §12.

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
- **Read the repo's cartography** — `.armada/cartography/` (`architecture.md`, `conventions.md`,
  `pitfalls.md`, `workflows.md`, `testing.md`, `glossary.md`, or a single `cartography.md`), the
  per-repo heuristics [`cartographer`](../cartographer/SKILL.md) accumulates from past runs. These are
  **actionable `heuristic / evidence / confidence` entries** the fleet learned about *this* repo, and
  applying them is the payoff for keeping the map: a **workflow** heuristic ("run `npm run generate`
  before the build") becomes a planned step, a **pitfall** ("don't edit `*.gen.ts`") fences the
  change, and a **convention** ("use `FooService`, not the raw client") shapes the implementation to
  match the grain of the repo. Apply High-confidence heuristics by default; treat Low-confidence ones
  as considerations, not hard constraints. If the directory is absent, the repo just hasn't been
  mapped yet — carry on.
- **Read the existing code** in the affected area. Understand the patterns, related modules, tests,
  and the files that will need changes. Find where tests live and how they're run.
- **Run any audit the issue calls out *first*.** If the issue says "this is only safe if X holds"
  or "audit Y before merging", treat that as research — its findings often reshape the plan (the
  change may be inert in real data, or the gaps may dwarf the headline change).

## 2a. Reproduce first — for bug-type issues (reproduce → fix → verify)

**This step is mandatory when the issue is a bug** — anything labelled `bug`/`defect`/`fleet-defect`,
or whose body reports a *symptom that should not happen* (a console warning, a crash, a hydration
mismatch, a wrong value rendered, a failing interaction). It is the antidote to the failure this
guard exists for: a plausible fix that **passes lint/build/test but doesn't remove the actual bug**,
because local green gates only prove the code compiles and the existing tests pass — not that the
reported symptom is gone. Reproducing first turns "the symptom" into concrete, re-runnable evidence,
and gives you a ground-truth oracle to verify the fix against in §6a.

Do this **before** planning the fix (§3), on the **unpatched** base-branch code, so the evidence is
of the bug as reported:

1. **Pin the symptom.** From the issue, identify the precise observable: the exact console
   warning/error text, the failing assertion, the wrong on-screen value, the broken interaction — the
   thing that must be *gone* for the bug to be fixed. If the issue is vague, narrow it to a concrete,
   checkable observable before proceeding.
2. **Reproduce it with the same method muster would use** — match the bug's nature:
   - **Runtime / UI bug** (hydration mismatch, console warning, broken interaction, wrong render):
     **run the app** (`commands.run`) and drive it with a **headless browser** (e.g. Playwright),
     reproducing the exact steps and capturing the symptom — console logs, a screenshot, the failing
     DOM state. This is the same browser ground-truth muster applies; doing it here shifts that check
     **left** so a wrong fix is caught in the build, not at review.
   - **Logic / data / API bug:** write or run a **failing test** (or a scripted call) that exercises
     the reported path and fails on the unpatched code in the way the issue describes. A new
     regression test that fails-before/passes-after is the strongest evidence and should be added to
     the suite where it fits.
   - **Build / tooling bug:** capture the failing command output.
3. **Capture the evidence.** Save the before-state — the warning text, the failing test output, the
   screenshot/log — so it can go in the PR body (§7). This is the "before" half of the before/after.
4. **If you cannot reproduce the symptom, stop and say so explicitly.** Do **not** invent a fix and
   assert it works. State plainly in the PR body (and your handoff) that the symptom could not be
   reproduced with the steps given, what you tried, and what additional information or environment
   would be needed. A non-reproducing bug issue is a legitimate outcome to surface — it is **not** an
   excuse to ship an unverified change as if it were a fix. If, despite not reproducing, you still
   make a speculative change, label it as speculative and `Relates to #<n>` (not `Closes`), since you
   have no evidence it removes the symptom.

Carry the reproduction method forward — you will re-run **the exact same method** in §6a to prove the
fix removed the symptom. (For non-bug / feature issues, skip this step and proceed to §3.)

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

Most issues ship as one PR. **Large ones should ship as a stack** — sliced into stacked branches,
each a focused, independently reviewable PR. Trigger decomposition when the change touches multiple
distinct surfaces, the diff would plausibly exceed ~2,000 lines, or the PR body would need "slices"
to be readable. When it fires, slice the work, present the slice tree, and **get sign-off before
writing code** — see [references/stacked-prs.md](references/stacked-prs.md) for the full slicing
procedure (slice = branch = PR, slices stack, foundation first, rollup branch for 4+ slices).

## 4. Create a worktree

Build in an isolated worktree so multiple issues can be worked in parallel.

There are **two ways to get an isolated worktree**, in order of preference. Whichever you use, the
guarantee is the same: code changes land in a tree that is *yours*, not the shared checkout.

**(a) Agent-tool isolation (preferred).** If the harness exposes the `EnterWorktree` tool, use it
(creates the worktree and switches the session into it in one step):

```
EnterWorktree(name: "<number>-<short-description>")
```

When a background subagent is spawned with `isolation: "worktree"` (the path
[`crows-nest`](../crows-nest/SKILL.md) §2d uses), the harness has already placed you in your own
worktree — you don't create one, you just confirm `git rev-parse --show-toplevel` points at a
per-build tree and carry on.

**(b) Manual git-worktree fallback.** Agent-tool isolation can be **unavailable** — the harness may
not expose `EnterWorktree`, or `isolation: "worktree"` can fail (e.g. *"not in a git repository …
configure WorktreeCreate hooks"* when the repo was created mid-session). **Do not lose isolation and
fall back to building in the shared checkout** — create the worktree yourself with git, branching
straight off the **remote** base so it doesn't inherit a stale local `HEAD`:

```bash
git fetch origin <baseBranch>
git worktree add -b <number>-<short-description> <worktree-path> origin/<baseBranch>
cd <worktree-path>
```

**Path hygiene on Windows — use forward slashes and a sibling path.** A backslash path
(`C:\…\wt-2`) gets mangled by the shell and can create the worktree **nested inside the repo**
instead of as a sibling. Always pass a **forward-slash, shell-safe** path that resolves to a
**sibling** of the repo, e.g. `../<number>-<short-description>` or an absolute
`C:/DataCalumSimpson/<number>-<short-description>` — never a backslash path and never one that
lands inside the repo's own working tree.

Rename the branch to follow the repo's convention if needed (check `git branch -a` for patterns
like `feature/<number>-...`, `fix/<number>-...`). If you created the worktree from a local `HEAD`
rather than `origin/<baseBranch>` above, sync it — worktrees inherit from `HEAD` at creation, which
may be stale:

```bash
git pull origin <baseBranch>
```

**Clean up the manual worktree on completion.** A worktree you created by hand is yours to remove
once the PR is open (or the build is abandoned) — leaving it leaks disk and clutters
`git worktree list`. Remove it **best-effort** and tolerate Windows file-lock leftovers (a held
file handle can keep `git worktree remove` from deleting the directory):

```bash
git worktree remove <worktree-path> || git worktree remove --force <worktree-path> || true
git worktree prune                                   # drop the registry entry if the dir lingers
```

If the directory still can't be deleted because a process holds a lock, leave it — `git worktree
prune` has already cleared the registry, so it won't be mistaken for an active worktree; a later
sweep can reclaim the bytes. **Don't fail the build over a leftover directory.** (Worktrees the
Agent tool created are the harness's to reap — only clean up the ones *you* added.)

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

## 6a. Verify the repro is gone — for bug-type issues

**A green §6 is necessary but not sufficient for a bug fix.** If you reproduced a symptom in §2a, you
must now prove the fix **removes that symptom** — re-run the **exact same reproduction method** from
§2a against the **patched** code:

- **Runtime / UI bug:** run the app and drive it with the headless browser through the **same steps**;
  confirm the warning/error/broken behaviour is **gone** (clean console, correct render, working
  interaction). Capture the after-state (screenshot / clean log) as the "after" half of the
  before/after evidence.
- **Logic / data / API bug:** the regression test (or scripted call) that **failed before** must now
  **pass**. Keep that test in the suite so the bug stays fixed.
- **Build / tooling bug:** the command that failed before now succeeds.

Hold the bar:

- The fix is **not done** until the §2a repro no longer reproduces. If the symptom still appears, the
  fix is wrong or incomplete — **do not open a `Closes` PR**. Go back to §3/§5: a fix that compiles
  and passes the old tests but leaves the symptom is exactly the failure this loop exists to catch
  (the real root cause is often not the first plausible one — e.g. a secondary concern fixed while
  the true cause is untouched).
- **Verify against the symptom, not a proxy.** Confirm the *same* observable you pinned in §2a is
  gone, with the *same* method — not a different test that merely passes, and not "tests are green"
  standing in for "the warning is gone".
- Keep **both** the before (§2a) and after evidence for the PR body (§7) so muster and a human can see
  the bug was actually removed, not merely that the suite is green. muster remains the backstop, but
  it should be **confirming** a verified fix, not discovering an unverified one.

## 7. Open the pull request

```bash
git push -u origin <branch>
```

Write the PR body from [references/pr-template.md](references/pr-template.md): what changed and why,
key decisions with rationale, how each acceptance criterion is met, testing performed, and
screenshots for UI changes. **For a bug-type issue, the body must record the before/after repro
evidence** from §2a/§6a — the symptom reproduced on the unpatched code and that same method showing
it gone after the fix (the pr-template has a *Bug repro evidence* section for this). This is the
proof muster (and a human) needs to see the bug was actually removed, not merely that tests pass. If
the symptom **could not be reproduced** (§2a step 4), say so explicitly in the body instead of
claiming a verified fix. Link the issue **in the body**:

- `Closes #<number>` if fully addressed; `Relates to #<number>` if partial.

**The closing keyword must live in the PR _body_, not just the title.** GitHub only auto-closes an
issue on merge when a closing keyword (`Closes #N` / `Fixes #N` / `Resolves #N`) appears in the PR
**body** — a `(#N)` reference in the *title* does **not** auto-close. A PR that links the issue only
in its title merges without closing the issue, leaving shipped work showing open and forcing the
lookout to close it by hand. So every PR shipwright opens for a fully-addressed issue **must** carry
`Closes #<number>` in the body (the [pr-template](references/pr-template.md) already places it under
the summary). For a partial PR, use `Relates to #<number>` instead — deliberately *not* a closing
keyword, because a partial PR must not auto-close the issue.

```bash
gh pr create --title "<concise title>" --body "$(cat <<'EOF'
<PR body>
EOF
)"
```

**Don't comment on the host issue — return the PR link in your result and let the foreground lookout
post it.** When shipwright runs as a dispatched **subagent** (the autonomous `crows-nest` path), it
must **not** `gh issue comment` on the issue it was handed. That comment is an external write to an
issue the subagent didn't open, so the harness's auto-mode classifier consistently **denies** it —
the call is dead weight that fails on essentially every dispatched build and litters the run summary
with "issue-comment blocked by classifier" noise. It's also redundant: [`crows-nest`](../crows-nest/SKILL.md)
already posts the issue comment from your structured result during reconciliation (the same place it
reconciles labels) — `🔭 crows-nest: PR opened — <pr>`. So the subagent's job ends at **opening the
PR and returning `{ pr, branch, status, reason }`** (the return contract crows-nest maps); the
foreground lookout owns the host-issue comment. (This applies to the **host issue** only — PR
comments the pipeline posts on its *own* PR are unaffected, since those aren't classifier-blocked.)

### Verify the closing keyword is in the body before reporting `opened`

Don't trust that the keyword made it in — **read the created PR's body back and confirm it before
reporting the PR opened.** For a fully-addressed issue the body must contain a closing keyword that
references this issue (`Closes #<n>` / `Fixes #<n>` / `Resolves #<n>`); if it's missing, **self-correct
by editing the body** rather than reporting `opened` with a PR that won't auto-close:

```bash
pr=<pr-number>; n=<issue-number>
body=$(gh pr view "$pr" --json body --jq '.body')
if ! printf '%s' "$body" | grep -Eiq "(close[sd]?|fix(e[sd])?|resolve[sd]?) +#$n\b"; then
  # Keyword absent — append it to the body so the merge auto-closes the issue.
  gh pr edit "$pr" --body "$(printf '%s\n\nCloses #%s\n' "$body" "$n")"
fi
```

(A **partial** PR is the deliberate exception — it carries `Relates to #<n>`, no closing keyword, and
this check is skipped for it.) Only after the body is confirmed to carry the closing keyword (or has
been self-corrected) is the PR genuinely `opened`. This closes the loop that
[`crows-nest`](../crows-nest/SKILL.md) otherwise had to special-case — an ARMADA-opened `Closes #<n>`
PR auto-closes its issue on merge, so the lookout's close-the-loop pass (§5) just reconciles labels
rather than compensating for a missing keyword.

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
read than to watch — offer a short demo video via [`logbook`](../logbook/SKILL.md). **Skip** for
refactors, dependency bumps, infra-only changes, or one-line fixes. Phrase it as one question and
don't auto-record:

> "Want me to record a short walkthrough video for the stakeholders?"

Default to skipping if unsure — over-offering trains the user to mute the suggestion.

## 10. Suggest skill improvements — and file ARMADA defects (self-improvement loop)

After each issue, reflect: steps that were missing or mis-ordered, conventions worth documenting,
friction worth automating. Present suggestions and, if approved, open a PR against this skill.

When a reflection is about a genuine **ARMADA defect** — a step in this skill was wrong or missing, a
guard didn't fire, or you had to **guess** because guidance was absent — don't just suggest it,
**file it through the fleet's self-improvement loop**: route it via [`charter`](../charter/SKILL.md)
§9, which triages ARMADA-defect vs task-problem, files against the configured `armadaRepo` (never the
host project), de-dupes against open `fleet-defect` issues, and labels it `fleet-defect` **unarmed by
default** (armed only if `autoArmSelfFixes` is true). Keep it to **genuine ARMADA defects** — a
broken test or wrong requirement in the *target project* is task work, handled in the build, **not** a
fleet-defect. Filing is **best-effort and side-channel**: it must never block or derail the build —
surface what was filed in the handoff (§8) and carry on.

## 11. Address-review mode — respond to review comments on a PR

When shipwright is dispatched against an **existing PR with review comments** — by
[`crows-nest`](../crows-nest/SKILL.md)'s pipeline after a [`muster`](../muster/SKILL.md) review, or
by a human pointing it at a PR — it switches from building to **addressing review**: a considered
response to every comment, not blind compliance. The full procedure lives in
**[references/address-review-mode.md](references/address-review-mode.md)**:

> **Fetch every comment** (§11b) → **triage each — agree / discuss / disagree + one-line
> rationale** (§11c) → **implement the agreed changes** (§11d) → **re-validate** (§11e) → **push**
> and **reply per thread** (§11f) → **return the structured result** (§11g). Work on the PR's own
> branch (§11a); leave threads unresolved (the reviewer's call); a `blockingDisagreement` hands back
> to a human rather than merging.

## 12. Rebase mode — make a stale or conflicting PR mergeable

When shipwright is dispatched to **make an existing PR mergeable** — by
[`crows-nest`](../crows-nest/references/review-merge-pipeline.md)'s make-mergeable stage (§4.4b) when a reviewed PR is `BEHIND`
or `CONFLICTING` and `autoMerge: true`, or by a human pointing it at a stale PR — it rebases the PR
branch onto the current base, resolves any conflicts, re-validates, and force-pushes. This is the
hands-off version of the conflict resolution that otherwise has to be done by hand on a stale-branch
PR. The work happens on the **PR's own branch** so the force-push updates the PR in place.

> **Confirm the branch is fleet-owned** → **rebase onto the configured base** → **resolve conflicts
> integrating both sides** → **re-validate** → **force-push with `--force-with-lease`** — or, if it
> isn't mechanically resolvable, **fall back to `blocked`**.

### 12a. Confirm the branch is safe to force-push

Force-push is acceptable **only on a fleet-owned branch** — one whose commits are all ARMADA's. If a
human has pushed commits to the PR branch, do **not** rewrite it: return `blocked` and let a human
rebase, rather than risk clobbering their work.

```bash
gh pr view <n> --json headRefName,baseRefName,mergeable,author,commits
# Inspect authorship of the branch's own commits (those not on the base):
git log --format='%an <%ae>' origin/<baseBranch>..origin/<headRef>
```

If the branch carries non-ARMADA commits, stop here → `blocked` ("branch has human commits; rebase
by hand"). Otherwise continue.

### 12b. Check out the PR branch on its own worktree

Work on the PR's branch — never a fresh one — so the force-push lands on the PR:

```bash
gh pr checkout <n>        # or: git worktree add ../<n>-rebase <prHeadRef>
git fetch origin <baseBranch>
```

### 12c. Rebase onto the configured base and resolve conflicts

Rebase the PR branch onto the **configured `baseBranch`** (from `.armada/config.json`, §0) — not an
assumed `main`:

```bash
git rebase origin/<baseBranch>
```

When a conflict halts the rebase, resolve it by **integrating both sides** — keep the base's changes
*and* the PR's intent. **Never resolve by dropping the base's work** (e.g. `-X ours` blindly, or
taking the PR side wholesale) — that silently reverts whatever landed on the base since the branch
forked, which is exactly the bug a rebase is meant to avoid. Read both sides, understand what each
changed, and produce a resolution that preserves both. Then `git add` the resolved files and
`git rebase --continue`.

**Dependency lockfiles get the lockfile-merge convention, not a textual merge.** When the conflicting
file is a JS/package-managed **dependency lockfile** (`package-lock.json`, `yarn.lock`,
`pnpm-lock.yaml`, `npm-shrinkwrap.json`), do **not** hand-merge its hunks — a generated lockfile
three-way-merged by text is inconsistent and often corrupt. Instead apply the standard convention:
**(1) union the dependency edits in `package.json`** (keep both sides' added/bumped deps, higher
version on a clash), **(2) regenerate the lockfile via the repo's package manager** (`npm install` /
`yarn install` / `pnpm install`, matched to whichever lockfile exists — never resolve a `yarn.lock`
with `npm`), then `git add` the regenerated lockfile, and **(3) re-validate** (§12d) so a broken
dependency union blocks rather than merging. This is the same convention crows-nest's make-mergeable
stage documents ([crows-nest §4.4b](../crows-nest/references/review-merge-pipeline.md)); it applies
whether the lockfile conflict is hit here or there. (JS lockfiles only for now — other package
managers generalise later.)

If a conflict **isn't mechanically resolvable with confidence** — the two sides made genuinely
contradictory changes to the same logic and picking either loses correctness — **abort and fall
back to `blocked`** rather than guessing:

```bash
git rebase --abort
```

Return `unresolved` with which file/hunk couldn't be reconciled. **Bound the attempts** — the lookout
caps rebase rounds (`maxRebaseRounds`, default 1); don't loop on a branch that keeps re-conflicting.

### 12d. Re-validate the rebased tree

A clean rebase is **not** proof of a sound resolution — a mechanically-clean merge can still be
semantically wrong. Re-run the project's checks against the rebased head and **print the outputs** —
same gate as §6:

```bash
<commands.build> && <commands.test> && <commands.lint>   # must be green
```

If validation **fails** post-rebase, do **not** force-push a broken tree — return `blocked` with the
failing check. A clean-conflict resolution that breaks tests must block, never merge.

### 12e. Force-push with lease

Push the rebased branch to the PR's own branch. Use `--force-with-lease` (not bare `--force`) so the
push is refused if the remote moved under you — a guard against clobbering an unexpected concurrent
push:

```bash
git push --force-with-lease origin <headRef>
```

Then comment the PR with what happened (`gh pr comment <n>`): rebased onto `<baseBranch>`, conflicts
resolved (which files), re-validated green, new head sha.

### 12f. Return the structured result

Return a machine-readable result so the lookout can re-review and gate (§4.4b → §4.1 → §4.5):

```json
{
  "pr": 11,
  "mode": "rebase",
  "result": "resolved",          // "resolved" | "unresolved"
  "headSha": "<new head sha>",
  "rebasedOnto": "<baseBranch>",
  "validation": "pass",          // "pass" | "fail"
  "reason": "rebased onto master; resolved conflicts in skills/foo/SKILL.md; re-validated green"
}
```

`result: "unresolved"` (or `validation: "fail"`) tells the lookout to fall back to `armada:blocked`
with the reason — shipwright **never** force-merges an unresolved or test-breaking rebase, and the
final merge stays the lookout's gated decision (§4.5), never shipwright's.

## Inputs

- A GitHub issue number **or** a free-text description (build mode), **or** a PR number plus its
  review comments/findings (address-review mode, §11), **or** a PR number to rebase/make-mergeable
  (rebase mode, §12).
- Optional: a base branch override.

## Output

- **Build mode:** an isolated worktree with the implementation committed; an open, non-draft PR
  linking the issue with a structured summary body, **armed with the `triggerLabel` so the ready-PR
  watch picks it up automatically**; and the structured result (`{ pr, branch, status, reason }`)
  returned to the caller. When dispatched as a subagent, shipwright does **not** comment on the host
  issue itself — it returns the PR link and the **foreground lookout posts the issue comment** during
  reconciliation (§7), so the comment never trips the auto-mode classifier.
- **Address-review mode:** the agreed changes pushed to the PR branch; a per-thread reply on every
  review comment (triaged agree/discuss/disagree, threads left unresolved); a structured result for
  the lookout to re-review and gate on.
- **Rebase mode:** the PR branch rebased onto the configured base with conflicts resolved
  (integrating both sides), re-validated, and force-pushed with `--force-with-lease` to the PR's own
  branch — or, when the conflict isn't confidently resolvable or validation fails post-rebase, an
  `unresolved` structured result so the lookout falls back to `armada:blocked` rather than force-merge.
