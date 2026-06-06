---
name: lighthouse
description: >
  The ARMADA lighthouse — the fleet's autonomous reconnaissance. Every other ship is reactive
  (shipwright builds existing issues, muster reviews existing PRs); lighthouse is the one that
  *proactively finds* work. It surveys the repository for valuable future work — failing/skipped
  tests, TODO/FIXME, missing coverage, stale or contradicted docs, dependency/security smells,
  architectural gaps, recurring pitfalls — and, when the app is runnable, explores it live with
  Playwright to surface UX/functional findings (degrading to static-only when there's no runnable
  app). It turns each high-value, non-duplicate finding into a well-formed GitHub issue via the
  charter flow, filed UNARMED by default (charter --no-arm) so a human review stays the gate. Every
  run is bounded by a configurable budget (runtime, Playwright time, issues, findings) and reports
  what it did and did not cover. crows-nest dispatches it opportunistically as low-priority
  background work only when the fleet has spare capacity; existing build and review work always
  wins. Trigger when the user says "scan for work", "find future work", "reconnoitre the repo",
  "what should we build next", "survey the codebase", "run a recon pass", "light the lighthouse",
  or invokes /lighthouse. Non-mutating w.r.t. the source tree — it discovers and files issues, it
  never Writes/Edits, stages, commits, or opens PRs (that is shipwright's job); the project's own
  survey/validate commands it runs are fenced on a clean checkout and their side effects are never
  committed.
argument-hint: "[--static-only] [--max-issues N]"
allowed-tools: Bash, Read, Grep, Glob, Skill
---

# lighthouse — autonomous reconnaissance, charter the future

`lighthouse` is ARMADA's reconnaissance ship. The rest of the fleet is **reactive** —
[`shipwright`](../shipwright/SKILL.md) builds issues that already exist,
[`muster`](../muster/SKILL.md) reviews PRs that already exist. Nothing *proactively finds* work.
`lighthouse` is that ship: it **surveys the repository for valuable future work** — bugs, gaps, UX
problems, missing tests, stale docs, risky patterns — and turns the high-value findings into
**well-formed GitHub issues** via [`charter`](../charter/SKILL.md), **unarmed by default** so a human
stays in the loop. The result is the self-sustaining front of the pipeline: ARMADA can **discover,
define, and (once a human arms it) implement** new work even when no human has filed an issue.

> **One run:** read the budget and config (§0) → **static survey** the repo for candidate work (§2)
> → **dynamic survey** the running app with Playwright when it's runnable (§3, degrades to
> static-only) → **rank and shortlist** the highest-value findings within budget (§4) → **de-dupe**
> each against existing open issues and **charter** the survivors `--no-arm` (§5) → **report** what
> was found, filed, skipped, and not covered (§6).

A lighthouse surveys the coast and warns ships of what lies ahead. This skill is the
*Autonomous Recursive* of ARMADA pushed to the **front** of the pipeline: **generating** work, not
just reacting to it.

## What lighthouse is — and is not

- **Non-mutating w.r.t. the source tree.** lighthouse discovers and files issues. **lighthouse itself
  never `Write`s, `Edit`s, stages, or commits source, and never opens a PR** — that is
  [`shipwright`](../shipwright/SKILL.md)'s job. Its `allowed-tools` deliberately exclude `Write`/`Edit`,
  so the skill cannot author code. The one nuance the guarantee makes honest: lighthouse **does** run
  the project's *own* survey/validate commands via `Bash` — `commands.test`, optionally `commands.run`,
  and Playwright (§2, §3) — and those are the project's code, which *can* touch the working tree (build
  artifacts, caches, a test that writes a fixture). lighthouse treats them as **untrusted side effects**
  and **fences** them (§1a): it runs surveys only on a **clean checkout**, asserts `git status` is clean
  afterward, and **never stages or commits** whatever they leave behind. The only outward action
  lighthouse takes is **creating GitHub issues** (through `charter`, via `gh`). It surveys; it does not
  build.
- **Unarmed by default.** The issues it files are filed **without the trigger label** (charter
  `--no-arm`) — **human review is the gate.** A human reads the backlog lighthouse produced and arms
  the ones worth building. The off-by-default `lighthouse.autoArm` flag (§5c) is the *only* way a
  generated issue is ever armed automatically.
- **Bounded, not exhaustive.** Every run stops cleanly when any budget is hit (§1) and **reports what
  it did and did not cover** — no silent truncation. The goal is *continuous reconnaissance*, not a
  one-shot exhaustive audit.
- **Distinct from the other two discovery loops.** lighthouse discovers **new product work in the
  host repo**. It is **not** the fleet-defect loop (defects in ARMADA *itself* →
  [`charter`](../charter/SKILL.md) §9) and **not** [`cartographer`](../cartographer/SKILL.md) (per-repo
  *knowledge* into `.armada/cartography/`). It reads cartography but writes issues.

## 0. Discover config and the budget

Read `.armada/config.json` from the target repo. If it's absent the repo isn't commissioned — run
[`commission`](../commission/SKILL.md) first (it writes the `lighthouse` block with safe defaults).
The keys lighthouse reads:

- `triggerLabel` (default `armada`) — the arming label. lighthouse files issues **without** it
  (§5b); de-dupe (§5a) checks open issues regardless of label.
- `commands.run` — how this repo starts its app. Present → the **dynamic survey** (§3) is attempted;
  absent → lighthouse runs **static-only** and says so.
- `baseBranch` — the branch the static survey reads (current checkout is fine).
- The `lighthouse` config block:

```jsonc
"lighthouse": {
  "enabled":  false,   // crows-nest AUTO-dispatch on/off. Default false (opt-in). Manual /lighthouse always works.
  "autoArm":  false,   // the ONLY way generated issues get armed. Default false — human review is the gate.
  "intervalHours": 24, // crows-nest trigger: min hours since the last lighthouse run
  "commitsSinceScan": 20, // crows-nest trigger: N commits landed since the last scan
  "minIdleToDispatch": true, // BOOLEAN guard (default true): crows-nest only auto-dispatches when the runnable frontier is fully idle. Never loosens the existing-work-always-wins invariant.
  "budget": {
    "maxRuntimeSec":    300,  // hard cap on the whole run
    "maxPlaywrightSec": 120,  // hard cap on the dynamic survey
    "maxIssuesPerRun":  3,    // most issues a single run will file
    "maxFindings":      20    // most candidate findings a run will collect before it stops surveying
  }
}
```

**Manual `/lighthouse` runs regardless of `enabled`** — `enabled` gates only crows-nest's
*auto-dispatch* (§7), never a human asking for a recon pass. If the block is missing, fall back to
the defaults shown above and note it.

## 1. Bound the run — the budget is a hard cap, not a target

Reconnaissance is *continuous*, so each run is deliberately small. Before surveying, fix the budget
from config (§0) and treat **every** limit as a hard stop:

- **`maxRuntimeSec`** — the wall clock for the whole run. Track elapsed time from the start; when it's
  hit, **stop surveying, finish charter-ing whatever's already shortlisted, and report** (§6). Never
  blow the wall clock to "just finish one more".
- **`maxPlaywrightSec`** — a separate, tighter cap on the dynamic survey (§3) so a slow app can't eat
  the whole run. When hit, end the browser exploration and keep whatever it surfaced.
- **`maxFindings`** — stop *collecting* candidates once this many are in hand; you don't need every
  finding, you need the best few.
- **`maxIssuesPerRun`** — the most issues a single run will file (§5). Rank first (§4), file the top
  N, and list the rest as "found but not filed (budget)" in the report.

When a budget is hit, that is **not** an error — it's the design. The only failure mode is **silent
truncation**: always name in the report (§6) which surfaces were covered and which were skipped
because a budget ran out.

## 1a. Clean-tree fence — keep the non-mutating guarantee honest

lighthouse never `Write`s or `Edit`s source itself, but the **project commands it runs** (`commands.test`,
`commands.run`, Playwright — §2, §3) are the project's own code and *can* mutate the working tree (build
artifacts, caches, a test that writes a fixture or a snapshot). The guarantee is therefore not "no bytes
ever change on disk" — it is "**lighthouse leaves the repo exactly as it found it and commits nothing**".
Enforce that with a fence around any survey command:

- **Start clean.** Before running surveys, confirm the checkout is clean (`git status --porcelain` is
  empty). If it isn't, **don't survey a dirty tree** — note "skipped: working tree dirty" in the report
  (§6) rather than risk attributing pre-existing local changes to lighthouse. Prefer running on a
  **throwaway worktree** (`git worktree add`) or a fresh checkout when one is cheap, so surveys can't
  touch the user's working copy at all.
- **Assert clean after.** After the static and dynamic surveys, re-check `git status --porcelain`. If a
  command left changes behind, **do not stage or commit them** — discard them (`git checkout -- .` /
  `git clean -fd` on a throwaway tree, or restore the touched paths) and note what was left behind in
  the report. Their existence may itself be a finding ("`commands.test` dirties the tree"), but it is
  **never** something lighthouse commits.
- **Never stage, never commit, never push.** lighthouse has no `Write`/`Edit` and issues no `git add` /
  `git commit` / `git push` for source. Its only persistent output is **GitHub issues** via `charter`
  (§5). If a survey somehow produced a tree change, that change dies with the run.

This fence is what makes the stated guarantee enforceable with the tools lighthouse actually has: `Bash`
can run the project's read-mostly commands, but the surrounding discipline guarantees nothing they leave
behind ever lands in the repo.

## 2. Static survey — scan the repo for candidate work

The always-available pass. Survey the checkout for candidate future work, collecting each as a
**finding** (a short title, the evidence, where it lives, a rough value/effort sense) until
`maxFindings` or `maxRuntimeSec` is hit. Cover these surfaces, cheapest first:

- **Failing / skipped tests.** Run the repo's `commands.test` **inside the clean-tree fence (§1a)** —
  it's the project's own code and may touch the tree, so survey on a clean checkout, capture failures,
  and discard any side effects without committing them — then grep the test tree for skip markers (`it.skip`, `xit`, `@pytest.mark.skip`,
  `[Ignore]`, `t.Skip`, `#[ignore]`, `test.todo`). A skipped test is deferred work with a ready-made AC.
- **TODO / FIXME / HACK / XXX.** Grep the source for inline debt markers. Cluster them — a single
  recurring TODO across many files is one architectural finding, not twenty tickets.
- **Missing coverage.** Where a coverage report or obvious gap exists (a module with no test file, a
  public surface with no tests), note the untested area as a candidate.
- **Stale or contradicted docs.** README/docs that describe behaviour the code no longer has, a
  documented command that doesn't exist, version/setup drift. Cross-check docs against code.
- **Dependency / security smells.** Out-of-date or deprecated dependencies, pinned-to-vulnerable
  versions, `npm audit` / `pip-audit`-style signals if the toolchain offers them cheaply, secrets or
  risky patterns visible in source.
- **Architectural gaps & recurring pitfalls.** Duplicated logic begging for extraction, a missing
  abstraction, an error path that's swallowed. **If `.armada/cartography/` exists, read it** — its
  `pitfalls.md` / `conventions.md` heuristics name exactly the recurring traps a survey should look
  for in *this* repo, so a cartography-aware survey finds repo-specific work a generic scan misses.

Keep each finding **concrete and evidence-backed** — a file/line, a failing assertion, a doc line
that contradicts the code. Vague impressions ("the code could be cleaner") are not findings and never
become issues; they fail charter's buildable bar (§5) anyway.

## 3. Dynamic survey — explore the running app with Playwright (when runnable)

When the repo exposes `commands.run`, lighthouse **launches the app and explores it via Playwright**
— the same browser tooling [`spyglass`](../spyglass/SKILL.md) and [`logbook`](../logbook/SKILL.md)
use — to surface findings a static read can't: broken flows, console errors, dead links, accessibility
gaps, confusing UX, a feature that 404s. This pass is **bounded by `maxPlaywrightSec`**, runs **inside
the clean-tree fence (§1a)** — `commands.run` is the project's own code and may write logs, caches, or
local state, so its side effects are discarded and never committed — and **degrades gracefully**: it is
never allowed to error the run.

> Launch via `commands.run` → wait for the ready signal → drive a **short, bounded** exploration with
> Playwright (load the main routes, click the primary affordances, watch the console/network for
> errors) → collect UX/functional findings → tear the app down. Cap the whole pass at
> `maxPlaywrightSec`; if it's hit, keep what was surfaced and move on.

**Degrade to static-only — never error — when any of these holds**, and **note it in the report**:

- `commands.run` is **absent** (no runnable app) → skip §3 entirely; the run is static-only.
- The app **fails to launch** or never signals ready within the budget → tear down, note "app didn't
  start", continue with the static findings.
- **Playwright is unavailable** (browser/driver not installed) → skip the browser exploration, note
  "Playwright unavailable", continue.
- The app launches but a route/interaction throws mid-exploration → record it (it may itself be a
  finding) and keep going; don't abort the run.

The dynamic survey is **best-effort and additive**: its findings join the static ones for ranking
(§4). A run with no runnable app is still a valid run — it just covers fewer surfaces, and says so.

## 4. Rank and shortlist — value first, within budget

You'll usually have more findings than `maxIssuesPerRun` lets you file — that's expected. **Rank**
the collected findings and take the top few:

- **Value** — user/maintainer impact if addressed: a broken flow or a failing test outranks a cosmetic
  TODO; a security smell outranks a doc typo.
- **Confidence** — how sure the finding is real and actionable (evidence-backed, reproducible). Low-
  confidence hunches drop off the list.
- **Buildability** — can it be phrased as **concrete, testable acceptance criteria**? If not, it can't
  become a charter-able issue (§5) — keep it in the report as an observation, don't file it.
- **Effort sense** — a rough size, used only to break ties; lighthouse files small, focused issues, so
  prefer findings that slice into one focused capability over sprawling epics.

Take the top `maxIssuesPerRun` **buildable** findings forward to §5. Everything else is reported
(§6) as "found but not filed", so nothing is lost — a later run (or a human) can pick it up.

## 5. Discovery → charter → issues (de-duped, unarmed)

Each shortlisted finding becomes a **well-formed issue via the [`charter`](../charter/SKILL.md)
flow** — *not* a raw `gh issue create`. charter is what guarantees the issue is buildable: a
problem/goal, concrete testable acceptance criteria, scope, dependencies. lighthouse hands charter
the finding and its evidence; charter drafts and files it.

### 5a. De-dupe against existing open issues — never refile known work

**Before filing anything**, search the open backlog so lighthouse never refiles known or in-flight
work. This is non-negotiable — a recon ship that spams duplicates is worse than useless:

```bash
gh issue list --state open --search "<keywords from the finding>" --limit 30
gh issue list --state open --limit 50   # also eyeball the backlog for overlap
```

If a finding matches an existing open issue (or an in-flight `armada:underway` / `armada:done` one),
**drop it** — don't file a twin. Note it in the report as "deduped onto #N". charter's own §1 de-dupe
is a second safety net, but lighthouse de-dupes first so it doesn't even draft a known item.

### 5b. Charter each survivor `--no-arm` — unarmed is the default

File each de-duped, buildable finding through charter in **`--no-arm` mode** — the issue is created
with its type label (`enhancement` / `bug` / `documentation`) but **without** the `triggerLabel`, so
it lands in the backlog for a human to review and arm:

```bash
# Conceptually, per shortlisted finding — drive charter in --no-arm mode:
#   charter "<finding as a rough request, with evidence>"  --no-arm
# charter drafts the structured issue (problem/goal, testable ACs, scope) and files it UNARMED.
```

Invoke charter via the `Skill` tool, once per finding, passing the finding and its evidence and
**`--no-arm`**. This is deliberate: charter auto-arms *human-authored* requests by default, but
**lighthouse's generated issues are unarmed** — lighthouse overrides to `--no-arm` so human review is
the gate. (This does **not** change charter's default for issues a human authors directly.)

### 5c. `lighthouse.autoArm` — the only path to an armed generated issue

The **sole** way a lighthouse-generated issue gets armed is the config flag `lighthouse.autoArm`
(§0), **default `false`**:

- **`autoArm: false` (default)** — **everything lighthouse files is `--no-arm`.** Nothing it
  generates is ever auto-built; a human arms the backlog items they choose. This is the safety
  mechanism — human review in the loop.
- **`autoArm: true`** — reserved for **trusted repos** that have opted into auto-arming
  **high-confidence** findings. Only then does lighthouse arm a generated issue (add the
  `triggerLabel`), and even then only for the **highest-confidence, clearly-buildable** findings —
  never a low-confidence hunch. Left `false`, this path is dead and nothing lighthouse files is ever
  auto-armed.

Like `autoMerge` and `autoArmSelfFixes`, this is an explicit operator opt-in — `commission` never
turns it on.

## 6. Report — what was found, filed, skipped, and not covered

End every run with a clear summary so reconnaissance is legible and the human knows exactly what
landed and what didn't. **No silent truncation** — name what a budget cut off:

```
🔦 lighthouse recon — <repo> @ <branch>
  surveyed   : static ✓ · dynamic <ran (Ns) | skipped: no commands.run | skipped: Playwright unavailable | skipped: app didn't start>
  findings   : <N collected> (budget maxFindings=<M>)
  filed      : <K issue(s), unarmed (--no-arm)>:
                 - #<n> "<title>" (enhancement) — <one-line why>
  deduped    : <D finding(s) matched open issues> — onto #<a>, #<b>
  not filed  : <found but over maxIssuesPerRun / not buildable>:
                 - "<finding>" — <reason: queued for a later run | not testable enough to charter>
  not covered: <surfaces a budget cut off> — e.g. "dynamic survey capped at maxPlaywrightSec; routes /admin, /reports unexplored"
  armed      : none (autoArm=false — human review is the gate)   |   #<n> (autoArm=true, high-confidence)
  next       : a human reviews the backlog above and arms what's worth building:  gh issue edit <n> --add-label <triggerLabel>
```

If lighthouse filed **at least one** well-formed, non-duplicate, unarmed backlog issue, the run
succeeded at its job — it generated valuable new work a human can now choose to build. If it found
nothing worth filing (a clean, well-covered repo), say so plainly; **don't invent work to look
busy** — a "no new work found" recon is a valid, useful result.

## 7. crows-nest integration — opportunistic, low-priority, never preempts

[`crows-nest`](../crows-nest/SKILL.md) can dispatch lighthouse **autonomously** as **background,
low-priority** reconnaissance — but only as *spare-capacity* work that **never competes with real
build or review work**. The contract (the lookout's side is crows-nest §2f):

- **Gated by `lighthouse.enabled`** (config, **default `false`** = opt-in). With it off, crows-nest
  **never** auto-dispatches lighthouse; manual `/lighthouse` still works. This is the master switch,
  like `cartography` / `autoMerge`.
- **Only when fleet capacity is free.** crows-nest dispatches lighthouse **only** when the runnable
  frontier is empty — **horizon clear · harbour clear** (no issue build and no PR review is runnable
  or in flight). This is the hard invariant, gated by the boolean `lighthouse.minIdleToDispatch`
  (default `true`): there is no "utilisation below a threshold" relaxation, and nothing ever lets
  lighthouse run while a build or review is runnable or in flight. lighthouse is the lowest-priority
  thing the fleet does.
- **And only when a trigger condition holds** — at least one of: `intervalHours` has elapsed since the
  last lighthouse run; `commitsSinceScan` commits have landed since the last scan; or a major
  merge/release just completed. Idle alone isn't enough — there must be a *reason* to survey.
- **Existing work always wins.** If **any** build or review is runnable or in flight, crows-nest
  **skips or defers** lighthouse. It never preempts, blocks, or competes with build/review work, and
  it **never holds a tick** — it's a bounded, fire-and-forget background dispatch (the same §2d
  discipline as cartographer/foghorn), reconciled when it returns, best-effort, never fatal to a tick.

This makes lighthouse the fleet's idle-time reconnaissance: when there's nothing to build and nothing
to review, and enough has changed since the last look, the lighthouse sweeps the coast and charters
what it finds — and the moment real work appears, it yields.

## Inputs

- Nothing — `/lighthouse` runs one bounded recon pass using the configured budget.
- Optional: `--static-only` (skip the dynamic survey even if `commands.run` exists), or a budget
  override like `--max-issues N` for a one-off run.
- From crows-nest (§7): a background, low-priority, fire-and-forget dispatch when capacity is free and
  a trigger condition holds — gated by `lighthouse.enabled`.

## Output

- A **static survey** of the repo (always) plus a **dynamic Playwright survey** of the running app
  (when `commands.run` exists and Playwright is available; degrades to static-only with a note
  otherwise) — bounded by the configured budget.
- Up to `maxIssuesPerRun` **well-formed, de-duped GitHub issues** filed via charter, **unarmed**
  (`--no-arm`) by default — or armed only when `lighthouse.autoArm: true` and the finding is
  high-confidence.
- A **report** (§6) of what was found, filed, deduped, not filed, and not covered — no silent
  truncation. No code edited, no PR opened (that's shipwright's job).
