---
name: sea-trial
description: >
  The ARMADA sea-trial — the shakedown run. The fleet's true RUNTIME verification step: beyond unit
  tests, lint, and static validate, it actually LAUNCHES the project's app (via .armada/config.json →
  commands.run) and DRIVES a real user flow with Playwright to prove a change behaves correctly live —
  then reports pass/fail with evidence (screenshots, console/network errors). It is the runtime layer
  on top of shipwright's own validate step and the repo-local `verify` skill: green tests prove the
  code compiles and the old assertions still hold; sea-trial proves the change actually works when a
  user drives it. Every run is BOUNDED by a runtime budget and is READ-ONLY w.r.t. the fleet/source
  tree — it launches and drives the app, it never Writes/Edits, stages, or commits; the project
  commands it runs are fenced on a clean checkout and their side effects are never committed. It
  DEGRADES GRACEFULLY: no runnable app (no commands.run) → skip with a clear note; no Playwright/
  browser → launch-only smoke, no drive; a route that throws mid-flow → recorded as a finding, never a
  crash — a shakedown never errors the pipeline. shipwright can run it as a post-build runtime check and
  muster as a runtime lens before it gates. Trigger when the user says "sea-trial", "shakedown run",
  "run the app and verify the change", "drive the real flow", "does it work at runtime", "runtime
  verify", or invokes /sea-trial. Accepts a PR number, a branch, or a free-text change description
  (defaults to the current branch's change).
argument-hint: "[PR | branch | change] [--flow <name>] [--max-runtime-sec N] [--smoke-only]"
allowed-tools: Bash, Read, Grep, Glob, Skill
---

# sea-trial — the shakedown run, verify a change at runtime

`sea-trial` is ARMADA's **runtime** verification ship. Every other check the fleet runs is *static*:
[`shipwright`](../shipwright/SKILL.md)'s validate step runs `commands.build`/`test`/`lint`,
[`muster`](../muster/SKILL.md) reads the diff, the repo-local [`verify`](../../README.md) skill
exercises the affected flow. A green build proves the code **compiles and the old assertions still
hold** — it does **not** prove the change actually *works when a user drives the running app*.
`sea-trial` is that missing proof: it **launches the project's app** via the repo's own
`commands.run` and **drives a real user flow with Playwright**, watching the live app behave, then
reports **pass/fail with evidence** — screenshots and console/network errors, the same browser
ground-truth muster applies, shifted **left** so a runtime regression is caught in the build, not at
review.

> **One run:** read config + budget and run the **preflight** (§0) → **bound** the run (§1) →
> **fence** it read-only on a clean checkout (§1a) → **launch** the app via `commands.run` and wait
> for its ready signal (§2) → **drive** a real, bounded user flow with Playwright, watching console/
> network (§3) → **verify** the runtime behaviour the change was supposed to produce (§4) → **tear
> down** the exact instance it launched (§5) → **report** PASS / FAIL / SKIPPED with evidence (§6).

A sea-trial is the shakedown a ship makes before it's accepted into service — you don't take delivery
on the strength of the blueprint, you sail it. `sea-trial` is that shakedown for a change.

## What sea-trial is — and is not

- **Runtime, not static.** It is the *drive-the-running-app* layer **on top of** shipwright's validate
  step and the repo-local `verify` skill — **not a replacement** for either. Tests and lint still gate
  the build; sea-trial adds the live-behaviour proof they can't give.
- **Read-only w.r.t. the fleet/source tree.** sea-trial **never `Write`s, `Edit`s, stages, commits, or
  opens a PR** — its `allowed-tools` deliberately exclude `Write`/`Edit`. It launches and drives the
  app via `Bash` (the project's own `commands.run` + Playwright), and it **fences** those side effects
  (§1a): runs only on a clean checkout, and never stages or commits whatever the app leaves behind
  (logs, caches, local state). Its only outputs are a **verdict + evidence** it reports back — never a
  code change.
- **Bounded, never exhaustive.** Every run stops cleanly when the runtime budget is hit (§1) and
  **names what it did and did not drive** — no silent truncation. It shakes down *the change*, not the
  whole app.
- **Degrades gracefully — never errors.** No runnable app → **skip**; no Playwright/browser →
  **launch-only smoke**; a route that throws mid-flow → **a finding**, not a crash (§0, §3). A
  shakedown that can't run is a **SKIPPED** result, never a failed pipeline.
- **Invocable as a verification step.** shipwright can run it as a post-build runtime check and muster
  as a runtime lens before it gates (§7) — the hand-off both those skills already reach for when a
  change has a runtime surface.

## 0. Discover config and run the preflight

Read `.armada/config.json` from the target repo. If it's absent the repo isn't commissioned — run
[`commission`](../commission/SKILL.md) first (it detects and writes `commands.run`). The keys
sea-trial reads:

- **`commands.run`** — how this repo starts its app. **Present → the shakedown is attempted; absent →
  sea-trial SKIPS** (there's no app to drive) and says so. sea-trial launches the app **only** via this
  command, never an assumed `npm start` / `dotnet run`.
- `baseBranch` — the branch the change sits on top of.
- The optional `sea-trial` config block (defaults shown; fall back to these and note it if absent):

```jsonc
"sea-trial": {
  "enabled": true,          // manual /sea-trial always runs; this gates shipwright/muster AUTO-invocation (§7)
  "budget": {
    "maxRuntimeSec":    180,  // hard cap on the whole shakedown (launch + drive + verify)
    "maxPlaywrightSec": 120,  // tighter cap on the browser drive alone
    "maxSteps":         20    // most flow steps a single run will drive before it stops
  }
}
```

### Preflight — decide whether the shakedown can run, without erroring

Run the **bundled preflight** first. It reads the config **read-only**, probes for a Playwright/
browser backend, and returns one of three verdicts — `ready` / `degrade` / `skip` — **always exiting
0** (a skip/degrade is the design, not an error). Resolve the script path by the standard rule —
`${CLAUDE_PLUGIN_ROOT}/scripts/...`, never a relative path (installed plugins are copied to a cache and
relative paths break there):

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/sea-trial-preflight.mjs" --json   # machine-readable verdict
# or, human-readable:
node "${CLAUDE_PLUGIN_ROOT}/scripts/sea-trial-preflight.mjs"
```

Branch on the verdict:

- **`skip`** — no `commands.run` (no runnable app). **Report SKIPPED (§6) and stop** — there is nothing
  to shake down. This is a valid, non-failing outcome.
- **`degrade`** — `commands.run` is present but **no Playwright/browser** is resolvable. Do the
  **launch-only smoke** (§2) — confirm the app starts and serves its ready signal — then **skip the
  browser drive (§3)** and report the shakedown as **degraded** with that note. Point the probe at a
  system browser with `SEA_TRIAL_BROWSER_EXECUTABLE` (a full path) or `SEA_TRIAL_BROWSER_CHANNEL`
  (`msedge`/`chrome`) to upgrade a degrade to ready without installing anything (mirrors logbook's
  `LOGBOOK_BROWSER_*` escape hatches).
- **`ready`** — runnable app **and** a browser backend. Run the full shakedown (§2 → §6).

If the preflight script isn't present in this install, perform the same three checks by hand (is
`commands.run` set? is a Playwright/Puppeteer module or a system-browser env var resolvable?) and
branch identically. **The skill never errors on this gate** — it skips or degrades.

## 1. Bound the run — the budget is a hard cap, not a target

A shakedown is deliberately short — it drives *the change*, not the whole app. Fix the budget from
config (§0) and treat every limit as a hard stop:

- **`maxRuntimeSec`** — the wall clock for the whole run (launch + drive + verify). Track elapsed time
  from the start; when it's hit, **stop driving, tear down the app (§5), and report** (§6) what was and
  wasn't covered. Never blow the wall clock to "just finish one more step".
- **`maxPlaywrightSec`** — a tighter, separate cap on the browser drive (§3) so a slow app can't eat the
  whole run. Set it as an explicit Playwright timeout, **and** back it with an OS wall-clock timeout
  around a killable render child, because a native `launch`/`goto` can hang *before* Playwright's own
  timers arm — an in-process `Promise.race` alone does **not** stop a stuck launch (the same discipline
  muster §1b documents). When it fires, end the drive and keep what it surfaced.
- **`maxSteps`** — the most flow steps a run will drive before it stops. Keep the flow focused on the
  change; you don't need to click every affordance.

A hit budget is **not** an error — it's the design. The only failure mode is **silent truncation**:
the report (§6) always names which of the flow was driven and which was cut off.

## 1a. Clean-tree fence — keep the read-only guarantee honest

sea-trial never `Write`s or `Edit`s source itself, but the **project commands it runs** (`commands.run`,
Playwright) are the project's own code and *can* mutate the working tree (build artifacts, caches, a
dev server that writes local state). The guarantee is therefore not "no bytes ever change on disk" — it
is "**sea-trial leaves the repo exactly as it found it and commits nothing**". Enforce it exactly as
[`lighthouse`](../lighthouse/SKILL.md) §1a does:

- **Start clean.** Before launching, confirm the checkout is clean (`git status --porcelain` is empty).
  If it isn't, don't shake down a dirty tree — note "skipped: working tree dirty" (§6) rather than risk
  attributing pre-existing local changes to sea-trial. Prefer running against a **throwaway worktree**
  or a fresh checkout when one is cheap.
- **Assert clean after.** After the drive, re-check `git status --porcelain`. If the app left changes
  behind, **do not stage or commit them** — discard them (`git checkout -- .` / `git clean -fd` on a
  throwaway tree) and note what was left behind. Their existence may itself be a finding, but it is
  **never** something sea-trial commits.
- **Never stage, never commit, never push.** sea-trial has no `Write`/`Edit` and issues no `git add` /
  `git commit` / `git push`. Its only output is the verdict + evidence it reports.

## 2. Launch the app via `commands.run`

Launch the app **only** via the repo's configured `commands.run` (§0), inside the clean-tree fence
(§1a). Start it as a **backgrounded child you own** (hold its PID / handle — you'll tear down exactly
that in §5), then **wait for its ready signal** before driving it — a URL that returns 200, a log line,
a listening port — rather than a blind `sleep`. Bound the wait by `maxRuntimeSec`.

- If the app **fails to launch or never signals ready** within the budget, tear it down (§5) and report
  the shakedown as **SKIPPED — app didn't start** (§6) with the launch output as evidence. Don't hang.
- On the **`degrade`** path (§0), stop here: the app started and served its ready signal is itself the
  **launch-only smoke** result. Report degraded (§6) and skip §3.

## 3. Drive a real user flow with Playwright

With the app up and a browser backend available (`ready`), **drive the real flow the change affects** —
the same browser tooling [`spyglass`](../spyglass/SKILL.md), [`logbook`](../logbook/SKILL.md), and
[`lighthouse`](../lighthouse/SKILL.md) use. Pick the flow from the change under test: the PR/issue's
acceptance criteria, the affected route/interaction, the `--flow` argument if given. Keep it **bounded**
by `maxPlaywrightSec` and `maxSteps`.

> Open the app's entry URL → navigate to the affected surface → drive the **real interactions** the
> change touches (`goto` / `click` / `fill` / `press` / `hover` / `dragdrop`, not just a page load) →
> **watch the console and network** the whole time (collect `console` errors/warnings and failed
> requests) → capture a **screenshot** at the moment the change's outcome should be visible.

Serve/drive dashboards over a **localhost http server**, not `file://` — a `file://` open blocks the
app's `fetch` and renders blank (the same trap muster §1b calls out). Set **explicit per-step
Playwright timeouts** (`launch`, `goto`, `screenshot`) and the wall-clock backstop from §1, so a hung
launch fails fast instead of wedging the run.

**Degrade, never crash, mid-flow:** if a route 404s, an interaction throws, or a selector never
appears, **record it as a finding** (it may *be* the regression the change introduced) and keep going
where you can — don't abort the whole run on the first thrown step. A flow that can't complete is
**evidence**, captured and reported, not an exception that kills the pipeline.

## 4. Verify the runtime behaviour

The drive isn't the point — the **verification** is. Against the change under test, confirm the
**observable runtime outcome** the change was supposed to produce actually happened, and nothing
regressed:

- **The expected outcome is present** — the new value renders, the new interaction works, the flow
  reaches the state the acceptance criteria describe. Verify the *same observable* the change promised,
  on screen, not a proxy.
- **No new console errors / warnings** appeared during the flow that weren't there before (a hydration
  mismatch, an uncaught error, a failed `fetch`). Compare against what a baseline run of the flow
  produces where that's cheap.
- **No broken network requests** (4xx/5xx) on the path the change touches.

Turn each into a concrete **PASS** or **FAIL** with the evidence attached (the screenshot, the console
line, the failing request) — a verdict with no evidence is not a verdict.

## 5. Tear down — only the instance you launched

When the drive ends (or a budget is hit), tear down **exactly** what this run launched — the app child
process you backgrounded in §2 (by its PID / handle) and the Playwright `browser`/`context` you spawned
in §3 (by its handle, or a dedicated `--user-data-dir` / isolated headless session). **Never** issue a
process-wide kill — `taskkill /IM msedge.exe`, `pkill chrome`, `killall chrome`,
`Stop-Process -Name msedge`, or a blanket app-server kill by image name — it closes **every** browser
window and every instance the operator has open on a live desktop (their own work, a live stream, other
agents' browsers), not just this run's. If teardown can't be scoped to your instance, prefer a
fire-and-forget launch you don't need to kill over a blanket kill. Then re-assert the clean-tree fence
(§1a) — discard anything the app left behind, commit nothing.

## 6. Report — PASS / FAIL / SKIPPED, with evidence

End every run with a clear, self-contained verdict so the runtime check is legible and actionable. **No
silent truncation** — name what a budget cut off:

```
⚓ sea-trial shakedown — <repo> @ <branch/PR>
  preflight  : <ready | degrade: Playwright unavailable | skip: no commands.run>
  launched   : <commands.run> → ready in <N>s   |   SKIPPED (app didn't start)
  flow       : <name/description> — <K of M steps driven>  (budget maxSteps=<M>, maxPlaywrightSec=<S>)
  verdict    : PASS ✓   |   FAIL ✗   |   SKIPPED ⚪   |   DEGRADED 🟡 (launch-only smoke)
  checks     :
                 - <expected outcome> — PASS ✓ (screenshot: <path>)
                 - <console clean>     — FAIL ✗ (Uncaught TypeError: … — console line cited)
  evidence   : <screenshot path(s)>, <console/network excerpt>
  not driven : <surfaces a budget cut off> — e.g. "steps 12–20 unrun; maxPlaywrightSec hit at step 11"
```

- **PASS** — the app launched, the flow drove, and every runtime check held. The change works live.
- **FAIL** — the app launched and the flow ran, but a runtime check failed (wrong outcome, new console
  error, broken request). Cite the evidence — this is a **real** signal a green build missed.
- **SKIPPED** — no runnable app (no `commands.run`), or the app didn't start. **Not a failure** — the
  fleet just can't runtime-verify this repo/change; the static gates still stand.
- **DEGRADED** — runnable app but no browser backend: the launch-only smoke passed (app starts and
  serves), but the flow wasn't driven. State the degrade.

A SKIPPED or DEGRADED shakedown **never blocks** the pipeline — it's an *additive* runtime signal, not
a gate that fails closed. Only a **FAIL** is a red light, and even then the caller (shipwright/muster)
decides what to do with it (§7).

## 7. Invocation as a runtime-verification step

sea-trial is built to be **called by the fleet**, not only run by hand. It exposes a small contract —
a verdict + evidence — that a caller consults:

- **From [`shipwright`](../shipwright/SKILL.md) (post-build runtime check).** After the build validates
  green (shipwright §6) and, for a bug, the repro is confirmed gone (§6a), shipwright can invoke
  sea-trial via the `Skill` tool against the just-built change to **prove it works at runtime** before
  opening the PR — the drive-the-app layer on top of the reproduce→fix→verify loop shipwright already
  runs for UI/runtime bugs. A **SKIPPED/DEGRADED** result changes nothing (no runnable app / no
  browser — the static gates still stand); a **FAIL** is a real runtime regression to fix before the PR
  is opened. It is **best-effort and side-channel**: a sea-trial that can't run must never block or
  delay the build — swallow the skip/degrade and carry on.
- **From [`muster`](../muster/SKILL.md) (runtime lens before the gate).** muster's visual inspection
  (§1b) already renders a user-facing UI change in a headless browser; sea-trial generalises that to a
  **driven runtime flow** and can run as an additional lens whose verdict joins the review — a **FAIL**
  is a finding muster surfaces (with the screenshot/console evidence), a **SKIPPED/DEGRADED** is noted
  in the summary the same way a missing lens is (a degraded lens is incomplete, not a pass; it never
  blocks or wedges the review).

Both hand-offs treat sea-trial the way logbook is treated by shipwright §9: **invoke it, absorb the
outcome, never let its absence or a degrade block the pipeline.** Manual `/sea-trial` always runs; the
`sea-trial.enabled` flag (§0) gates only the *auto-invocation* by shipwright/muster.

## Inputs

- A **PR number**, a **branch**, or a **free-text change description** — the change to shake down.
  Defaults to the current branch's change.
- Optional: `--flow <name>` (drive a named/specific flow), `--max-runtime-sec N` (a one-off budget
  override), `--smoke-only` (force the launch-only smoke even when a browser is available).
- The repo's `.armada/config.json` (`commands.run`, `baseBranch`, and the optional `sea-trial` block).
- From shipwright/muster (§7): a best-effort, side-channel runtime-verification dispatch, gated by
  `sea-trial.enabled`.

## Output

- A **runtime verdict** — **PASS / FAIL / SKIPPED / DEGRADED** — for the change under test, produced by
  launching the app via `commands.run` and driving a real user flow with Playwright, bounded by the
  configured budget.
- **Evidence** for the verdict: screenshot(s) at the change's outcome, and any console/network errors
  captured during the flow.
- A **report** (§6) of what was launched, driven, verified, skipped, and not covered — no silent
  truncation. No code edited, no PR opened, nothing committed (that's shipwright's job); the app's own
  side effects are fenced on a clean checkout and discarded.
