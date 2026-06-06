---
name: cartographer
description: >
  The ARMADA cartographer. Owns *per-repo* knowledge: it mines completed fleet runs for reusable,
  actionable heuristics and maintains a reviewable knowledge base under `.armada/cartography/`, so
  the fleet specialises to a repo over time without anyone hand-writing AGENTS.md guidance. It
  analyses one completed run from the evidence already on the issue/PR — the original issue, the PR
  diff, commit/retry history, muster + human review comments, build/test failures, and the
  resolution path — and emits `heuristic / evidence / confidence` entries, paying special attention
  to human corrections, repeated failures, and repeated successes. It dedupes, updates, and prunes
  against existing cartography, then commits the changes into the active ARMADA PR so they ride the
  muster review + autoMerge gate. shipwright reads cartography before building; crows-nest auto-runs
  it (best-effort, side-channel) at its reconcile points when the `cartography` config key is on.
  Trigger when the user says "learn from this run", "update the cartography", "map this repo",
  "extract heuristics", "what has the fleet learned", or invokes /cartographer. Accepts a PR number,
  an issue number, or nothing (defaults to the current branch's PR). Distinct from the fleet-defect
  self-improvement loop — cartographer is about the *host* repo, fleet-defect is about *ARMADA*.
argument-hint: "[issue-number | PR-number]   (defaults to the current branch's PR)"
allowed-tools: Bash, Read, Write, Edit, Grep, Glob, Skill
---

# cartographer — learn per-repo heuristics and specialise the fleet over time

Every ARMADA run discovers repo-specific knowledge — a pre-build step that has to run first, a
companion file that always moves with another, a convention a human keeps correcting — and today it
**evaporates between runs**. `cartographer` is the ship that owns *per-repo* knowledge: it mines a
completed run for reusable, **actionable** heuristics and maintains a knowledge base under
`.armada/cartography/`, so the fleet **specialises to a repo over time** without anyone hand-writing
guidance. The next [`shipwright`](../shipwright/SKILL.md) run consults that map during its Research
step and plans with the grain of the repo.

> **Consult-before-acting.** The pattern cartographer establishes — *read the accumulated map before
> you act, write back what you learned after* — is the shape future ships should adopt. shipwright is
> the first consumer (its Research step, §6); `muster` reading cartography to review against known
> pitfalls is a natural follow-up, not built here.

## 0. The boundary — cartographer vs the fleet-defect loop (read this first)

ARMADA already has **one** self-improvement loop: the **fleet-defect** loop (charter §9, shipwright
§10, crows-nest §7). cartographer is a **second, orthogonal** learning loop, and the two must never
be confused:

| | **fleet-defect loop** | **cartographer** |
| :--- | :--- | :--- |
| **Learns about** | *ARMADA itself* — a skill step was wrong/missing, a guard didn't fire, the fleet had to guess | *the host repo* — its build quirks, conventions, pitfalls, workflows |
| **Files against** | the `armadaRepo` (e.g. `calumjs/ARMADA`) — never the host project | the host repo's own `.armada/cartography/` |
| **Output** | a `fleet-defect` GitHub issue | reviewable Markdown heuristics committed to the active PR |
| **Trigger** | a defect in the fleet's *own guidance* | a completed run that revealed *repo* knowledge |

**The fleet-defect loop is left entirely unchanged by cartographer.** If a reflection is about
ARMADA's own guidance, it still routes through charter §9 as a `fleet-defect` — cartographer does
**not** touch it, re-implement it, or file against `armadaRepo`. A broken test or wrong requirement
in the *target project* is neither a fleet-defect *nor* cartography unless it yields a **reusable**
repo heuristic. When in doubt: *Is this about how ARMADA works (→ fleet-defect) or about how this
repo works (→ cartographer)?*

## 1. Inputs and modes

cartographer runs in two modes, both analysing **one completed run**:

- **Manual (`/cartographer` / `/armada:cartographer`).** A human invokes it on demand against:
  - a **PR number** — analyse that PR's run;
  - an **issue number** — find its linked PR and analyse that run;
  - **nothing** — default to the **current branch's PR** (`gh pr view --json number` on the branch).
- **Auto (dispatched by crows-nest).** A best-effort background subagent fired at crows-nest's three
  terminal reconcile points (§7). It's handed the issue/PR it should analyse and runs non-interactively.

If the repo isn't commissioned (no `.armada/config.json`), run
[`commission`](../commission/SKILL.md) first — cartography is gated by a config key it writes (§8).

## 2. The cartography store — `.armada/cartography/`

Repo knowledge lives under **`.armada/cartography/`** as **reviewable Markdown**, committed to the
repo like the rest of `.armada/` (it's project knowledge, not secrets). It's plain Markdown on
purpose: a human reviews it in the PR diff, edits it by hand, or deletes an entry they disagree with.

**Layout — a topic split** (create files lazily; a brand-new repo may start as a single
`cartography.md` and split out as it grows — the SKILL documents both and either is valid):

| File | Holds |
| :--- | :--- |
| `architecture.md` | How the system is put together — module boundaries, where things live, what depends on what. |
| `conventions.md` | House style the repo enforces — naming, structure, the service/helper a human keeps steering toward. |
| `pitfalls.md` | Traps that bite — generated files you mustn't edit, ordering gotchas, flaky areas, footguns. |
| `workflows.md` | Repo-specific procedures — pre-build steps, codegen, the order operations must run in. |
| `testing.md` | How tests really work here — the runner, fixtures, what a green/red baseline looks like, slow suites. |
| `glossary.md` | Repo-local vocabulary — domain terms, internal names, acronyms a newcomer would miss. |

Add an `index.md` only if helpful. Keep each file a flat list of heuristic entries (§3) under topic
headings; **don't** let it sprawl into prose essays — the point is a *scannable, actionable* map a
subagent reads in seconds.

## 3. The heuristic format — actionable and structured

Every entry is a **`heuristic / evidence / confidence`** triple — an **instruction the fleet can
act on**, not a passive fact. The litmus test: *could a shipwright run* do *something differently
because of this line?* If not, it's a fact, not a heuristic — drop it.

```markdown
### Run `npm run generate` before the main build
- **heuristic:** Before `npm run build`, run `npm run generate` — the build depends on generated
  types that aren't checked in.
- **evidence:** 3 failed builds in PR #123 ("Cannot find module './generated'") cleared the moment
  `npm run generate` was run first.
- **confidence:** High
- **source:** PR #123 · 2026-06-06
```

**Confidence** is one of **`High` | `Medium` | `Low`**, earned by evidence:

- **High** — a human correction, or a pattern seen across **multiple** runs (repeated failure then
  success, or repeated success). Acted on by default.
- **Medium** — observed once with clear cause-and-effect in this run. Applied with a light touch;
  promoted to High when a later run confirms it.
- **Low** — a plausible inference from a single ambiguous signal. **Proposal-only** — surfaced for a
  human, not auto-applied, and the first to be pruned if never confirmed (§5).

### Good vs bad

| Good (actionable) | Bad (passive fact) |
| :--- | :--- |
| "Before the main build, run `npm run generate`." | "The project uses code generation." |
| "Put new API handlers in `src/api/`, not `src/routes/` — reviewers move them every time." | "There is an `src/api/` directory." |
| "Don't edit `*.gen.ts` — they're regenerated and your change is lost." | "The repo uses React." |
| "Tests need `DATABASE_URL` set or the suite errors at import." | "There are tests." |

A line a reviewer would answer "so what?" to is a fact; cut it. Keep every entry **specific,
imperative, and tied to evidence**.

## 4. Analyse one completed run

Gather the evidence **already on the issue/PR** — no re-running the build. Pull in parallel:

- **The original issue** — `gh issue view <n>` (title, body, acceptance criteria, comments).
- **The PR diff** — `gh pr diff <pr>` and `gh pr view <pr> --json files,title,body`.
- **Commit + retry history** — `git log` on the PR branch; **how many attempts** before green
  (repeated build/test failures then a pass is the strongest signal).
- **`muster` + human review comments** — `gh pr view <pr> --json reviews` and
  `gh api repos/{owner}/{repo}/pulls/<pr>/comments`. **Human corrections are the highest-value
  evidence** (§4a).
- **Build / test failures** — failure messages in CI logs or the PR/issue comment trail, and what
  finally cleared them.
- **The resolution path** — what the working change actually did differently from the failed attempts.
- **Existing cartography** — read `.armada/cartography/` *first* so you update rather than duplicate (§5).

From that evidence, emit heuristics (§3), **paying particular attention to**:

- **Human corrections** → §4a (highest value).
- **Repeated failures** — the same error class hit N times before a fix landed → a High-confidence
  *pitfall* or *workflow* ("do X first", "don't touch Y"). The worked example: 3 failed builds before
  learning `npm run generate` is required → Workflow heuristic, Confidence High.
- **Repeated successes** — a pattern that *worked* across runs (the same file always edited alongside
  another, a test command that's reliably green) → a *convention* or *workflow* worth codifying.

Be **conservative**: a one-off with no clear cause is not yet a heuristic. Prefer few High-value
entries over many speculative ones — the map is read on every future build, so noise has a cost.

### 4a. Human corrections become heuristics (highest value)

A human review comment that *corrects* the fleet is the single most valuable evidence there is —
someone spent attention to steer the repo. **Convert every correction into a reusable heuristic:**

| Human review comment | Cartography heuristic |
| :--- | :--- |
| "use `FooService` instead of calling the client directly" | **conventions:** "Call `FooService` for X; don't use the raw client." Confidence **High**. |
| "don't touch generated files" | **pitfalls:** "Never edit generated files (`*.gen.*`); regenerate instead." Confidence **High**. |
| "run `npm run generate` first" | **workflows:** "Run `npm run generate` before the build." Confidence **High**. |

A correction lands at **High** confidence immediately — it doesn't need to be seen twice. Record the
review-comment URL / PR as evidence so the heuristic is auditable back to the human who set it.

## 5. Reconcile — no duplicate or stale knowledge

**Before writing, reconcile against existing cartography.** Read `.armada/cartography/` and, for each
candidate heuristic:

- **Update, don't duplicate.** If a near-twin already exists, **update it in place** — strengthen its
  confidence, append the new evidence (e.g. "+ PR #145"), or sharpen the wording. Never append a
  second entry that says almost the same thing. Two entries on the same topic is a bug in the map.
- **Promote on repetition.** A Medium heuristic confirmed by a second run becomes High; note both
  pieces of evidence.
- **Prune stale / low-value.** Remove an entry when it's **contradicted** by newer evidence (a human
  reversed the guidance), **superseded** (the workflow changed — the codegen step was removed), or a
  **Low-confidence guess that was never confirmed** across several subsequent runs. Pruning is part of
  the job: a map full of dead entries is worse than a small accurate one.
- **Demote on contradiction.** If new evidence weakens but doesn't kill an entry, lower its confidence
  and record why, rather than deleting outright.

The store is **append-rarely, edit-often**: most runs *adjust* existing entries; only genuinely new
knowledge adds a line.

## 6. shipwright reads cartography before building

cartographer is only useful if the fleet *consults* it. shipwright's **Research step (§2)** — where
it already reads `README` / `CLAUDE.md` / `docs/` — is extended to **also read
`.armada/cartography/`** and apply relevant heuristics during planning (§3 of shipwright):

- A **workflow** heuristic ("run `npm run generate` first") becomes a planned step.
- A **pitfall** ("don't edit `*.gen.ts`") fences the change.
- A **convention** ("use `FooService`") shapes the implementation to match the grain of the repo.

High-confidence heuristics are applied by default; Low-confidence ones are surfaced as considerations,
not hard constraints. This is the payoff: each run the repo gets *easier* to build because the last
run wrote down what it learned.

## 7. Auto-run at crows-nest's reconcile points (ship's-bell discipline)

When the `cartography` config key is on (§8), [`crows-nest`](../crows-nest/SKILL.md) dispatches
cartographer as a **best-effort background subagent** at its **three terminal reconcile points** —
the same points the ship's bell rings:

- **build-completion** (crows-nest §2d) — a background build returned `opened`; analyse the new PR's run.
- **PR-pipeline outcome** (crows-nest §3e) — a review→merge pipeline reconciled; analyse the addressed
  PR (its muster + human review comments are the richest correction evidence).
- **issue-shipped** (crows-nest §5) — an issue closed `armada:shipped`; analyse the full resolution path.

It runs under the **ship's-bell discipline (crows-nest §8c)** — it is a *side-channel courtesy*,
never part of the tick's outcome:

- **Best-effort & side-channel.** cartographer runs **after** the consequential action (the label
  swap, the merge, the issue close have already happened). It is the last, optional step — never
  re-ordered ahead of the outcome.
- **Bounded.** One cartographer dispatch per reconcile event, in the background, in its own context —
  it never fans out a swarm and never holds the tick open.
- **Never blocks, derails, or fails the tick.** If cartographer errors, finds nothing, or the tool
  isn't available, the tick is **unaffected** — swallow the failure (log it at most once) and carry
  on. A failed map update must never turn a green tick red, exactly as a failed bell ring never does.
- **De-duped.** Each terminal event triggers cartographer **once** (the in-flight guards mean a
  reconciled unit isn't re-picked), so the same run isn't re-analysed every tick.

With the key **off** (the default), crows-nest does **not** auto-dispatch cartographer at all —
learning is opt-in, and manual `/cartographer` always works regardless.

## 8. Config gating — the `cartography` key

Auto-run is gated by a **`cartography`** key in `.armada/config.json`, mirroring how `autoMerge` /
`notify` / `autoArmSelfFixes` gate other autonomous behaviour. [`commission`](../commission/SKILL.md)
writes it with a **safe default**:

```jsonc
// How cartographer learns per-repo heuristics. Default "off": never auto-runs.
//   "off"      → cartographer never auto-runs; only manual /cartographer works (default)
//   "proposal" → auto-runs at reconcile points, but only *proposes* a diff for human approval
//   "on"       → auto-runs and commits knowledge into the active PR (rides muster + autoMerge)
"cartography": "off",
```

- **`"off"` (default).** Cartographer never auto-runs. The fleet behaves exactly as before; a human
  who wants the map runs `/cartographer` by hand. This is the conservative default — learning is an
  explicit opt-in, like `autoMerge` and `autoArmSelfFixes`.
- **`"proposal"`.** Auto-runs at the reconcile points but **never commits silently** — it presents the
  proposed cartography diff (as a PR comment or for human approval) rather than pushing. The
  middle ground: learning is on, but a human signs each update.
- **`"on"`.** Auto-runs and **commits the knowledge update into the active PR** (§9) so it rides the
  existing review + merge gate.

`commission` **always writes `"off"`** on a fresh repo — turning cartographer's autonomy on is a
deliberate hand edit, never something commissioning enables (same posture as `autoMerge: false`).

## 9. Reviewable updates — never a silent default-branch mutation

Cartography is repo knowledge that future builds *trust*, so an update must be **reviewed, never a
silent commit to the base branch**. cartographer rides the existing review machinery:

- **When there's an active ARMADA PR** (the common case — the run that produced the learning is on an
  open PR): **commit the `.armada/cartography/` changes into that PR's branch.** The update then rides
  the same [`muster`](../muster/SKILL.md) review + `autoMerge` gate as the code — a reviewer sees the
  heuristic change in the same diff as the work that motivated it, and approves or edits it there.
  Commit message: `cartography: <one-line of what was learned>`.
- **When there's no active PR** (e.g. a blocked issue with no open PR, or a manual run against an
  already-merged PR): cartographer **opens a dedicated cartography PR** (`cartography: learn from
  PR #<n>`, armed with the `triggerLabel` so the ready-PR watch reviews it) — or, in `"proposal"`
  mode, **presents the proposed diff for approval** instead of pushing.

Either way the rule holds: **a cartography change is always reviewable and never a silent mutation of
the default branch.** The active-PR path is preferred because it keeps the learning attached to the
run that produced it; the dedicated-PR path is the fallback when no such PR exists.

## 10. Report

Summarise what was learned, in one short block:

```
## Cartography update — <repo> · run #<pr/issue>
- **Added:**   <N> heuristic(s)   — e.g. workflows: "run npm run generate before build" (High)
- **Updated:** <N> — e.g. conventions: "use FooService" confidence Medium → High (+ PR #145)
- **Pruned:**  <N> — e.g. removed stale "edit config.yml" (superseded)
- **Path:**    committed to PR #<n>  |  opened cartography PR #<m>  |  proposed for approval
```

On the auto path, this summary is a **log line in the tick output** (side-channel, §7) — never a
ship's-bell notification of its own and never anything that gates the tick.

## Inputs

- **Manual:** a PR number, an issue number, or nothing (defaults to the current branch's PR).
- **Auto:** the issue/PR crows-nest hands it at a reconcile point (§7), plus the `cartography` config
  mode (§8).

## Output

- Reviewable `.armada/cartography/*.md` changes (added / updated / pruned heuristics in the
  `heuristic / evidence / confidence` format), **committed into the active ARMADA PR** (or a dedicated
  cartography PR / a proposed diff when there's no active PR) so every update rides the muster review
  + autoMerge gate and is never a silent default-branch mutation.
- A one-block summary of what was added / updated / pruned and which review path it took (§10).
- The `fleet-defect` self-improvement loop is **untouched** — cartographer is about the host repo,
  not ARMADA (§0).
