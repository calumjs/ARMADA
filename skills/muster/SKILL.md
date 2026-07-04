---
name: muster
description: >
  The ARMADA inspection before sailing. Reviews an open pull request through two independent
  lenses in parallel — a conventions/correctness code-review pass and a codex-rescue
  root-cause second opinion — consolidates and dedupes the findings, posts them as inline PR
  review comments plus a top-level summary, and returns the findings as structured data for the
  fleet to act on. Trigger when the user says "muster", "review this PR", "inspect the diff",
  "run a review pass", "review PR #123", or invokes /muster. Also the review stage that
  crows-nest dispatches inside its ready-PR pipeline. Accepts a PR number (or the current
  branch's PR) and an optional review effort level.
argument-hint: "<PR number>"
disallowed-tools: Write, Edit
---

# muster — dual-lens review of a ready PR

`muster` is ARMADA's inspection before sailing: it reviews one open pull request and leaves the
crew a written verdict. It runs **two independent reviewers in parallel** — they never see each
other's notes — then consolidates what they found, posts it onto the PR as inline review comments
plus a summary, and hands the fleet back a structured list of findings it can gate a merge on.

> **Fan out two reviewers** → **consolidate + dedupe** → **post inline comments + summary** →
> **return structured findings.**

Two lenses catch more than one: a single reviewer anchors on the first thing it sees. The
code-review lens reads the diff against the project's conventions; the codex-rescue lens comes at
the same diff cold, from a root-cause/second-opinion angle. Disagreement between them is signal —
surface it rather than averaging it away.

## 0. Resolve config and the PR under review

Read `.armada/config.json` → `commands` (`build` / `test` / `lint`) and `baseBranch`; the
reviewers need to know how the project validates itself and what the diff is measured against. If
the file is absent the repo isn't commissioned — run [`commission`](../commission/SKILL.md) first.

Identify the PR:

- A PR number passed in (`#123` / `123`) → `gh pr view <n>`.
- No number → the PR for the current branch (`gh pr view --json number,headRefName,...`).

Pull what both lenses need, once, and pass it to each:

```bash
gh pr view <n> --json number,title,body,headRefName,baseRefName,isDraft,mergeable,url
gh pr diff <n>                                   # the unified diff under review
gh pr view <n> --json files --jq '.files[].path' # changed paths (for inline-comment targeting)
```

If the PR is **draft** or has no diff, stop early: there's nothing to muster yet. Report that and
return an empty finding set rather than spawning reviewers on nothing.

## 0b. Emit a liveness beat as you advance (so a long render isn't misread as stalled)

When crows-nest runs you as a **background** review subagent, the lookout sees **nothing** until you
return — and the §1b visual inspection is a **single long headless render** that freezes any
output-file mtime while it works normally. That is exactly the false-stall trap #134 was chartered on.
So, like shipwright (§0a of its SKILL), **emit a coarse liveness beat as you cross each phase** so the
lookout can tell *working* from *wedged* without guessing on mtime — most importantly a
`visual-inspection` beat **immediately before** you launch the render, so its generous phase-aware
grace covers the whole (bounded, §1b) render:

```bash
node "${CLAUDE_PLUGIN_ROOT:-<config.pluginRoot>}/scripts/liveness-beat.mjs" \
  beat --run <branch|PR> --phase <reviewing|visual-inspection|posting> [--note "<what>"]
# and when you finish (after returning your findings, §4):
node "${CLAUDE_PLUGIN_ROOT:-<config.pluginRoot>}/scripts/liveness-beat.mjs" \
  done --run <branch|PR> --status reviewed --reason "<one line>"
```

Beat `reviewing` when the two lenses fan out (§1), `visual-inspection` just before the §1b render,
`posting` when you post the review (§3), then the terminal `done` marker after §4. Key `--run` by the
PR's **branch** (else its number). Beats are **best-effort and side-channel** (they write only under
`out/liveness/`, gitignored) — if the producer is missing or a beat fails, swallow it and carry on; a
liveness write must **never** block, fail, or delay the review. The reader (crows-nest §2d *"Is an
in-flight build actually stalled?"*) consumes these beats + the phase-aware grace to classify the run.

## 1. Fan out two reviewers in parallel subagents

> **Who owns the fan-out depends on how muster is reached — because a subagent can't nest agents.**
> When you invoke muster **directly** (foreground, with the `Agent` tool available), muster itself
> spawns the two lenses as below. But inside [`crows-nest`](../crows-nest/SKILL.md)'s ready-PR
> pipeline, **the pipeline is already running as a subagent**, and a subagent **cannot spawn nested
> agents**. A muster subagent that tried to fan out there would fail to nest and silently collapse to
> a **single, degraded lens** — exactly the defect [#76](https://github.com/calumjs/ARMADA/issues/76)
> fixes. So in the pipeline the **two lenses are launched as two *top-level* agents by the Workflow**
> (`scripts/review-merge-pipeline.mjs` §4.1, via `consolidateLenses`), and muster is reused only to
> **post the already-consolidated verdict** (§3). Either way the contract is the same — two
> independent lenses, consolidated (§2), with any degrade **named** (§5), never a silent single lens.

Spawn **both** reviewers via the **`Agent` tool**, non-interactive, in the **same turn** so they
run concurrently. Each gets the PR metadata, the diff, the changed-file list, and the project's
validation commands — and an instruction to return findings in the **exact schema** below. They
work in **isolated context**: neither reviewer sees the other's output, and neither pollutes the
lookout's transcript.

If the **`Agent` tool isn't available at all** (muster is itself running as a subagent — no nested
agents), muster **cannot fan out**: it runs the **single lens it can** (the in-context `/code-review`
pass) and returns `degraded: true` with the missing lens **named** in `degradedReason` and the
summary. It must **never** present a single-lens read as a full two-lens review. In the pipeline this
case doesn't arise, because the Workflow owns the top-level fan-out (see the callout above).

- **Lens A — code-review (conventions + correctness).** Dispatch the built-in `/code-review` skill
  (or, if it isn't available, an `Explore` / `general-purpose` subagent running a
  conventions+correctness prompt) over the diff: does the change match the surrounding code's
  idioms, is it correct, does it handle errors and edge cases, does it keep to the issue's scope?
  This lens knows the repo's conventions. If neither the `/code-review` skill nor a suitable
  general-purpose subagent is available in the environment, note that in the summary and run with
  the single lens rather than failing the whole muster — a one-lens review is degraded, not useless,
  and no review is never a green light.

- **Lens B — codex-rescue (independent second opinion).** Dispatch with
  `agentType: codex:codex-rescue` for a root-cause / second-opinion read of the same diff — an
  external reviewer that hasn't absorbed this repo's habits and so catches what the conventions
  lens rationalises away. If the `codex:codex-rescue` agent type isn't available in the
  environment, note that in the summary and run with the single lens rather than failing the whole
  muster — a one-lens review is degraded, not useless.

### 1b. Visual inspection — REQUIRED for user-facing UI changes

A diff review alone **cannot** catch a rendered-layout regression — overlapping text, broken spacing,
a dead CSS class, a theme that only breaks on screen. When the PR touches a **user-facing UI surface**
(an `*.html` view, CSS, a rendered dashboard/app, a template, or any change to how something *looks*),
the review **must include a visual inspection of the actual rendered output**, not just the diff:

1. **Render the change — under a hard timeout that can never wedge the review.** Serve/launch the
   affected view and open it in a headless browser (Playwright/Chromium). Serve dashboards over a
   **localhost http server** — a `file://` open blocks the app's `fetch` and renders blank (e.g. the
   spyglass driver). Drive it into the state the change affects (populate the data path the PR
   touches). The **entire render — browser launch + `goto`/navigation + screenshot — MUST run under
   a hard timeout** so it can never hang the pipeline. On some hosts (seen repeatedly on win-arm64
   with the system browser) the launch or `goto` hangs **indefinitely**; without a bound it wedges
   the whole review — the agent goes silent for 10+ minutes and never reaches the merge gate. So
   bound it, and prefer bounding **each stage** so a hang at any point is caught quickly:
   - **Per-step Playwright timeouts.** Set them explicitly rather than relying on defaults: pass
     `timeout` to `launch`/`launchPersistentContext`, a bounded `page.goto(url, { timeout: … })`,
     and a bounded `page.screenshot({ timeout: … })` (and/or `page.setDefaultTimeout(…)` /
     `page.setDefaultNavigationTimeout(…)`). Keep each step short (e.g. ~20–30s) so a stalled stage
     fails fast instead of eating the whole budget.
   - **A total wall-clock backstop (~60–90s) around the whole render**, because a hang can occur
     *before* Playwright's own timers arm (e.g. the browser process never comes up). The robust shape
     is to **run the render in a dedicated child process / worker and wrap it in an OS wall-clock
     timeout** (`timeout(1)` around a render subprocess, a spawned worker you can `kill`, or a job
     object) so the backstop can actually terminate a hung native launch. An in-process race
     (`Promise.race` against a timer, an `AbortController` / `AbortSignal.timeout`) does **not** by
     itself cancel a stuck `launch`/`goto` — the losing Playwright call keeps running — so if you use
     one it **must also kill the spawned render worker** on timeout, not merely resolve around it.
     Either way control **always** returns *and the hung work is actually stopped*, even if the
     in-library timeouts never fire.
2. **On timeout or render failure, abandon the render cleanly and degrade — never hang.** If the hard
   timeout fires (or the render throws), **do not retry-loop or wait it out**: abandon the render and
   let the review continue to a **code-only verdict**.
   - **Kill only the browser instance this render launched — scoped to its own PID / handle.** Hold
     the child process PID or the Playwright `browser`/`context` handle from step 1 and kill/close
     **exactly that** (`browser.close()`, or `process.kill(child.pid)` on the launched PID, or close
     the isolated `--user-data-dir` session). In the worst failure — `launch` never returns, so there
     is *no* browser handle or PID yet — the scoped target is the **render worker process (tree) you
     spawned in step 1**: kill that one process/job object you own, never by image name. (This is why
     the backstop runs the render in a dedicated killable child — it guarantees you always have a
     scoped thing to kill even when Playwright hands you nothing.) A hung render is precisely where
     the temptation to `taskkill /IM` is strongest — resist it: **never** a blanket kill (see
     step 5), because a live desktop has the operator's own windows, a live stream, and other agents'
     browsers open, and a process-wide kill takes all of them down.
   - **Continue to a code-only verdict and record the render as `skipped (timed out)`.** The
     conventions/correctness lens and the codex-rescue lens still run and gate the merge; only the
     visual lens is dropped.
   - **Name the degrade in the summary.** A timed-out/failed render **degrades the review to
     code-lens-only**, and that degrade must be stated in the top-level summary (§3) — e.g. "visual
     inspection skipped: render timed out after 90s on this host; reviewed code-only" — the same way
     a missing second lens is called out in §1a. A degraded review is **incomplete, not a pass**: it
     never silently swallows the skip, but it also **never blocks or wedges** the pipeline over it.
3. **Screenshot and actually look.** Capture the rendered view and inspect the changed region for
   overlap, clipping, inconsistent spacing/alignment, broken wrap/responsive behaviour, and correct
   theme (light *and* dark where applicable). Compare against the intended design/mock if one exists.
4. **File what you see.** A visual defect is a finding — same as a code finding — with the region /
   screenshot cited so it's actionable.
5. **Tear down only the browser you launched — never a process-wide kill.** Close the exact instance
   this review spawned: hold the child process/PID or the Playwright `browser`/`context` handle and
   close *that*, or drive a dedicated `--user-data-dir` / isolated automation profile / headless
   session and close it. **Never** `taskkill /IM msedge.exe`, `pkill chrome`, `killall chrome`, or
   `Stop-Process -Name msedge` — a process-wide kill closes every browser window the operator has open
   on a live desktop (their work, a live stream, other agents), not just the review's. If teardown
   can't be scoped, prefer a fire-and-forget `file://` open with no teardown over a blanket kill.

This is a hard requirement because the highest-value UI bugs — a CSS rule keyed on a class the JS never
adds, text overflowing a fixed-width column — are **invisible in the diff** and only appear on screen. A
UI change that was never rendered during review is an **incomplete review**: say so in the summary rather
than passing a diff-only read as complete.

### Per-finding schema (both lenses return this)

Each reviewer returns a JSON array of findings; a finding is:

```json
{
  "severity": "blocking" | "major" | "minor" | "nit",
  "file":     "path/relative/to/repo/root",
  "line":     128,
  "title":    "short imperative headline (used for dedupe)",
  "detail":   "what's wrong and the suggested fix, with enough context to act on it"
}
```

- **`severity`** drives the merge gate downstream. **`blocking`** = must be resolved before any
  merge (correctness bug, security issue, data loss, broken contract). `major` / `minor` / `nit`
  are graded advice that don't on their own stop a gated merge.
- **`line`** is the line in the PR's head revision the comment should attach to (omit for a
  file-level or PR-level point). `file` + `line` are what inline posting keys off.
- **`title`** is the dedupe key (with `file`) — keep it stable and specific.

## 2. Consolidate and dedupe

Merge the two arrays into one finding set:

1. **Dedupe by `file` + `title`** (case-insensitive, trimmed). When both lenses raise the same
   point, keep one finding and **note that both lenses flagged it** in the detail — independent
   agreement is the strongest signal there is, so don't bury it.
2. On a severity clash for a merged finding, **keep the higher severity** (`blocking` > `major` >
   `minor` > `nit`). A reviewer that thinks something is blocking outranks one that shrugged.
3. **Preserve genuine disagreement.** If the lenses reach opposite conclusions on the same line
   (one flags it, the other explicitly blesses it), keep it as one finding and record both views —
   don't silently drop the dissent. A human reads the tension and decides.
4. Sort the consolidated set by severity (blocking first), then by file and line, so the PR
   summary reads worst-first.

## 3. Post the review to the PR

Leave the verdict **on the PR**, not just in chat — the whole point is a durable review the builder
and a human can act on.

- **Inline comments**, one per finding that has a `file` + `line`, anchored to the diff:

  ```bash
  gh api repos/{owner}/{repo}/pulls/<n>/comments \
    -f body="**[<severity>] <title>**

  <detail>

  <em>flagged by: code-review + codex-rescue</em>" \
    -f commit_id="<head sha>" \
    -f path="<file>" \
    -F line=<line> \
    -f side="RIGHT"
  ```

  (Get the head sha from `gh pr view <n> --json headRefOid`.) Findings without a line post as a
  PR-level comment (`gh pr comment <n>`) instead — don't drop them.

- **A top-level summary comment** that frames the verdict: counts by severity, the list of blocking
  findings (if any), whether the two lenses agreed or diverged, and a one-line bottom line
  (`N blocking, M major — not ready` / `no blocking findings — review advisory only`). This is what
  a human skims first.

Post the summary with `gh pr comment <n> --body "<summary>"`. **`muster` does not approve, request
changes, resolve threads, or merge** — it reviews and reports. Acting on the findings is
[`shipwright`](../shipwright/SKILL.md)'s job (address-review mode); gating the merge is
[`crows-nest`](../crows-nest/SKILL.md)'s.

## 4. Return the structured findings

Return the consolidated finding set to the caller (the lookout, in the pipeline) as the structured
array — same schema as §1 — plus a small header so a gate can be computed without re-parsing prose:

```json
{
  "pr": 150,
  "summary": { "blocking": 1, "major": 2, "minor": 3, "nit": 1 },
  "lenses": ["code-review", "codex-rescue"],
  "findings": [
    { "severity": "blocking", "file": "src/api/export.ts", "line": 128,
      "title": "CSV export unescaped on quotes", "detail": "…", "lenses": ["code-review","codex-rescue"] }
  ]
}
```

The lookout keys its merge gate off `summary.blocking` (any > 0 ⇒ not mergeable) and off whether a
review was posted at all. Keep the return machine-readable; the prose lives on the PR.

## 5. When something goes wrong

- **One lens fails** (agent type missing, subagent errors, or muster is itself a subagent and can't
  fan out — §1) — proceed with the lens that returned, mark the review **degraded** in the summary,
  and say so in the return (`"degraded": true`, `"lenses": ["code-review"]`). **Name the degrade
  explicitly** — the top-level summary comment must state *which* lens didn't run and *why* (e.g.
  "single-lens/degraded — codex-rescue lens unavailable (no nested agents)"), never a silent
  collapse to one lens. Don't fail the whole muster for a half-loaf; a named, degraded review is
  still worth posting — but it is a degraded review, not a green light. How the **merge gate** then
  reacts to that degrade is **conditional on `autoMerge`** (`scripts/merge-gate.mjs` gate 2, issue
  #99): under `autoMerge: true` a degrade hard-blocks (an unattended merge on a half-reviewed PR
  stays unsafe); under `autoMerge: false` a degraded-but-clean review (0 blocking from the lens that
  ran) resolves to `ready_awaiting_human` with the degrade named, so a person makes the merge call —
  never an autonomous merge on a single-lens read.
- **Both lenses fail** — post nothing, return an empty `findings` with a `"degraded": true` flag and
  a reason. The caller treats "no review produced" as **not** a green light (it must not infer
  "no findings ⇒ safe to merge").
- **`gh api` comment posting is rejected** (permissions / branch rules) — fall back to a single
  top-level summary comment listing every finding inline, and note the inline-posting failure. Never
  drop findings on the floor because the inline endpoint refused.
- **An ARMADA defect, not a PR finding.** If the thing that went wrong is a defect in `muster`
  *itself* — a review step was wrong or missing, a guard didn't fire, or it had to **guess** because
  guidance was absent (distinct from a finding *about the PR under review*, which is a normal
  finding) — file a fix through [`charter`](../charter/SKILL.md) §9: against the configured
  `armadaRepo`, de-duped, labelled `fleet-defect`, **unarmed by default**. It's best-effort and
  side-channel — note it in the summary and finish the review; never block the muster on it.

## Inputs

- `pr` *(optional)* — the PR number to review. Defaults to the current branch's PR.
- `effort` *(optional)* — review depth hint passed to the lenses (low/medium/high). Default medium.

## Output

- Inline PR review comments (one per located finding) + a top-level summary comment.
- A structured finding set returned to the caller for the merge gate.
- A degraded-review signal when one or both lenses couldn't run — never a false green light.
