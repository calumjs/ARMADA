---
name: quartermaster
description: >
  The ARMADA quartermaster — the fleet's cost governor. spyglass already SEES per-run cost;
  quartermaster turns that observability into GOVERNANCE, so the fleet stays within a budget without
  a human watching the meter. It reads the SAME read-only cost signals spyglass consumes (the per-run
  post-mortems under out/costs/<run>.json + the run→worktree map) and runs in two modes: `report`
  (today's total spend, the in-flight/accruing portion, per-run spends, a burn-rate in USD/hour, and a
  simple end-of-day forecast at the current rate) and `check` (an allow/pause verdict against the
  budgets in .armada/config.json — budget.perRunUSD / budget.perDayUSD). crows-nest consults `check`
  BEFORE it dispatches a build and HOLDS new work — reason surfaced — when the verdict is PAUSE. It is
  read-only w.r.t. the cost data, dependency-free, and degrades OPEN — no budget set allows cleanly,
  and missing cost data allows + warns (a governor never blocks the fleet on missing data). Trigger
  when the user says "check the budget", "what is the fleet spending", "fleet cost report", "are we
  over budget", "governor status", "burn rate", "can we afford to dispatch", or invokes
  /quartermaster. Accepts a mode (report | check) and optional --per-run / --per-day overrides.
argument-hint: "[report|check] [--per-run <usd>] [--per-day <usd>] [--json]"
allowed-tools: Bash, Read, Grep, Glob, Skill
---

# quartermaster — the fleet's cost governor

`quartermaster` is the ship that **governs the fleet's spend**. ARMADA runs unattended, and
[`spyglass`](../spyglass/SKILL.md) already makes per-run cost *observable* — but observability is not
control. quartermaster is the **governance** layer on top of it: it reads the same cost signals and
answers two questions the fleet needs to stay solvent without a human watching the meter —

> **What is the fleet spending?** (`report`) and **may we dispatch more work?** (`check`).

It is a small, dependency-free Node script (`scripts/quartermaster.mjs`) plus this skill. Like
spyglass, it is **read-only with respect to the cost data** — it never writes under `out/costs/`
(that is the cost-postmortem *producer's* job, crows-nest §8g); `report`/`check` write nothing at
all. Its `allowed-tools` exclude `Write`/`Edit` for the same reason.

## The cost signals it reads (the SAME ones spyglass uses)

quartermaster is a **consumer**, never a producer. When the crows-nest `costs` config key is on
(default), crows-nest hands each completed subagent's **real token usage** to
[`scripts/spyglass-cost-postmortem.mjs`](../../scripts/spyglass-cost-postmortem.mjs), which
accumulates a per-model, API-equivalent cost estimate into `out/costs/<run>.json`, and records the
run→(branch, worktree, startedAt) map into `out/costs/_runs.json`. quartermaster reads exactly those
files (all under the gitignored `out/costs/`):

- `out/costs/<run>.json` — per run: `totalCost` (USD, or `null` when the only usage is unpriced —
  the codex/gpt review lens), `final` (`true` = reconciled, `false` = still accruing), `updatedAt`.
- `out/costs/_runs.json` — per issue: `branch`, `worktree`, `startedAt` (the burn-clock start).

A run counts toward **today** when its last activity is on or after the local midnight. This is the
same read-only, side-channel data spyglass renders — quartermaster never fetches anything new and
never mutates anything.

## Two modes

### `report` — what is the fleet spending today?

```bash
node scripts/quartermaster.mjs report          # human-readable
node scripts/quartermaster.mjs report --json    # machine-readable
```

Prints, from real cost signals:

- **today's spend** — the sum of every run active today (final + accruing-so-far).
- **in-flight accrual** — the spend recorded so far by runs that are still accruing (`final:false`),
  plus a conservative *reserve* of the spend still to come.
- **per-run spend** — each run's cost (the largest is the per-run-budget yardstick).
- **burn-rate** — USD/hour over the elapsed window since the earliest run started today.
- **forecast (EOD)** — projected end-of-day spend at the current burn-rate (`spend + rate ×
  hours-remaining`). A very young window (< 15 min) is flagged low-confidence.

### `check` — may we dispatch more work? (the enforcement verdict)

```bash
node scripts/quartermaster.mjs check                       # ALLOW / PAUSE line
node scripts/quartermaster.mjs check --json                 # { decision, reason, ... }
node scripts/quartermaster.mjs check --per-day 20 --per-run 3   # what-if / override
```

Returns a single, clear **allow / pause** verdict against the configured budgets:

| Situation | Verdict |
| --------- | ------- |
| No budget set (both keys absent) | **ALLOW** — the fleet is deliberately ungoverned. |
| Cost data unavailable (no `out/costs/`) | **ALLOW + warn** — never block the fleet on missing data. |
| A single run has spent **>** `budget.perRunUSD` | **PAUSE** — a run overran its per-run budget. |
| Today's projected spend (actual + in-flight reserve) **>** `budget.perDayUSD` | **PAUSE** — the day's budget would be exceeded. |
| Otherwise | **ALLOW** — within budget. |

The comparison is a **strict `>`**: spend exactly *at* the budget still allows; only spend that
**would exceed** it pauses. `check` **always exits 0** (a governor must never crash the tick) — the
decision is on stdout: a leading `ALLOW`/`PAUSE` token in text mode, or `decision` in `--json` mode.
On a PAUSE it also prints a loud **BUDGET ALERT** line.

Budgets come from `.armada/config.json` → `budget` (below); `--per-run` / `--per-day` override them
for a what-if or a test.

## Budgets (config)

Two optional keys under a `budget` object in `.armada/config.json` (both absent = ungoverned — no
behaviour change; this is the default a fresh commission writes):

```jsonc
{
  "budget": {
    "perRunUSD": 5,     // pause new dispatches if any single run's spend exceeds this. Absent = no per-run cap.
    "perDayUSD": 50     // pause new dispatches if today's projected spend would exceed this. Absent = no per-day cap.
  }
}
```

[`commission`](../commission/SKILL.md) documents and writes the block (defaults empty). See also
REQUIREMENTS.md and the README.

## How crows-nest consults it before dispatch

crows-nest is the fleet's scheduler. In its dispatch leg (crows-nest §2d) — **after** it has selected
the runnable frontier but **before** it claims and dispatches a build — it runs `quartermaster check`
once for the tick. If the verdict is **PAUSE**, it **holds** the frontier's *new build dispatches*
for this tick and reports the quartermaster reason as the hold reason (§2e), instead of spending
blind; work already in flight is never interrupted (a governor gates *new* spend, it doesn't kill
running builds). If the verdict is **ALLOW** (including the ungoverned and no-data degrade-open
cases), the tick dispatches normally. This keeps the fleet inside its budget with the *reason* always
surfaced — a legible hold, not a silent stall. The full convention is crows-nest §2d.

## Alerts + postmortem

- **Alert.** On a PAUSE, `check` prints a clear **BUDGET ALERT** line. crows-nest surfaces the reason
  in its tick output, and — where the fleet's bell/[`foghorn`](../foghorn/SKILL.md) is wired — the
  budget-breach reason rides the same notification channel as a block, so an operator *hears* the
  fleet hit its budget rather than discovering it later on the meter.
- **Postmortem flag.** The cost-postmortem producer flags a run whose reconciled spend overran
  `budget.perRunUSD`: it stamps `overBudget` into `out/costs/<run>.json` and prints an `over budget`
  note, so an overrun is recorded on the run's own post-mortem, not just in aggregate.

## Guarantees

- **Dependency-free** — Node built-ins + the read-only cost files. No install, matching
  validate-skills and the rest of the fleet's scripts.
- **Read-only w.r.t. the cost data** — it never writes under `out/costs/`; `report`/`check` write
  nothing at all. It is a governor's *view + verdict*, not a producer.
- **Degrades open, never closed** — no budget → allow; no cost data → allow + warn; an internal error
  in `check` → allow + warn. The fleet is **never blocked on missing data or a governor bug**.

## Follow-ups (out of scope for v1)

Weekly/monthly budgets; a per-issue cost *estimate* before dispatch (predict, not just react); a
spyglass budget gauge / alert lane rendering the governor's state on the chart.
