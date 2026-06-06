---
name: commission
description: >
  Commission the ARMADA fleet in the current repository — the one-time (idempotent) setup that
  every other ARMADA skill depends on. Detects the project's build/test/lint/run commands and base
  branch, writes .armada/config.json, creates the GitHub trigger + state labels, checks gh auth,
  and prints how to arm the crows-nest watch. Trigger when the user says "commission armada", "set
  up armada", "initialise armada", "armada bootstrap", "get armada ready", just installed the
  ARMADA plugin, or invokes /commission. Also auto-invoked by crows-nest and shipwright when they
  find the repo isn't commissioned yet. Safe to re-run.
allowed-tools: Bash, Read, Write, Edit, Grep, Glob
---

# commission — bring ARMADA into service in this repo

This skill is ARMADA's self-setup. Installing the plugin makes the *skills* available; commissioning
makes them *work in this repository* by creating the GitHub labels they key off and writing the
config that tells them how to build the project. **It is idempotent** — re-running it reconciles
state rather than duplicating it, so it's safe to run any time you're unsure whether a repo is ready.

> Any ARMADA skill that finds no `.armada/config.json` should run this first (or offer to).

## 1. Preflight

Confirm the environment before changing anything:

```bash
gh auth status                              # must be logged in
gh repo view --json nameWithOwner,defaultBranchRef   # must be a GitHub repo with a remote
git rev-parse --is-inside-work-tree         # must be a git work tree
```

If `gh` isn't authenticated, stop and tell the user to run `gh auth login` (or `! gh auth login`
in-session) — don't try to proceed. If there's no GitHub remote, ARMADA can't watch issues; say so.

## 2. Detect the project's commands and base branch

ARMADA is stack-agnostic, so commissioning *discovers* how to build this specific repo instead of
assuming. Inspect the repo and derive the commands. **Don't fabricate commands that don't exist** —
omit any you can't find, and the skills will infer or ask later.

| Signal in repo | Likely commands |
| :--- | :--- |
| `package.json` with `scripts` | use the `build` / `test` / `lint` / `format` / `dev`/`start` scripts that exist |
| `Makefile` | `make build`, `make test`, `make lint` (only targets that exist) |
| `*.csproj` / `*.sln` / `*.slnx` | `dotnet build`, `dotnet test`, `dotnet format` |
| `Cargo.toml` | `cargo build`, `cargo test`, `cargo clippy`, `cargo fmt` |
| `pyproject.toml` / `tox.ini` / `setup.py` | `pytest`, `ruff check`, `ruff format` / `black` |
| `go.mod` | `go build ./...`, `go test ./...`, `go vet ./...` |
| a skills-only repo (only `skills/*/SKILL.md`, no build system) | leave `build` empty; use a frontmatter/markdown validator as `test` if one exists |

Base branch: read it from `gh repo view --json defaultBranchRef` (the GitHub default), falling back
to `git symbolic-ref --short refs/remotes/origin/HEAD` then `main`.

**Show the detected commands to the user and let them correct before writing.** Detection is a
best-effort guess; a wrong `test` command poisons every later skill's validation step.

## 3. Write `.armada/config.json`

Write the config at the repo root. If one already exists, show a diff and **confirm before
overwriting** — the user may have hand-tuned it.

```jsonc
{
  "triggerLabel": "armada",        // crows-nest only acts on issues/PRs with this label
  "dispatch": "shipwright",        // "shipwright" (one build pass) or "flagship" (auto loop)
  "baseBranch": "<detected default>",
  "authors": "",                   // "" = act on anyone; "alice" or "alice,bob" to restrict by author
  "autoMerge": false,              // ready-PR pipeline may merge? Default false: stop-before-merge.
  "notify": "terminal",            // ship's bell: "off" | "blocked" | "terminal" | "all". Default "terminal" (shipped + blocked).
  "bellCommand": "",               // optional local command the bell also runs (focus-independent alert). Default "" = off. See crows-nest §8e.
  "mergeMethod": "squash",         // merge | squash | rebase, when autoMerge is true
  "maxReviewRounds": 2,            // bound on the address↔review loop before handing back
  "armadaRepo": "calumjs/ARMADA",  // where self-raised fleet-defect fixes are filed (charter §9)
  "autoArmSelfFixes": false,       // arm self-raised fleet-defects? Default false: human triage.
  "cartography": "off",            // cartographer auto-learn per-repo heuristics? "off" | "proposal" | "on". Default "off".
  "foghorn": {                     // the spoken narrator (foghorn skill). All optional — defaults shown.
    "flavour": "a gruff, proud nautical harbourmaster",  // free-text tone steering the spoken line
    "verbosity": "normal",         // spoken length: "terse" | "normal" | "rich"
    "gate": "terminal"             // which events speak: "off" | "blocked" | "terminal" | "all" (routine ticks quiet)
  },
  "commands": {
    "build":  "<detected or omitted>",
    "test":   "<detected or omitted>",
    "lint":   "<detected or omitted>",
    "format": "<detected or omitted>",
    "run":    "<detected or omitted>"
  }
}
```

Write `authors` as `""` by default so the fresh repo acts on issues from anyone (no behaviour
change). It's an optional allowlist — leave it blank, set a single username (`"calumjs"`), or a
comma-separated list (`"calumjs, dependabot[bot]"`) to restrict which issue authors crows-nest will
pick up (matched case-insensitively; see crows-nest §2a).

Add `.armada/` is fine to commit (it's project config, not secrets). Mention that the user can edit
`triggerLabel`/`dispatch`/`authors` later. **Write `autoMerge: false`** — never commission a repo with
auto-merge on; opting into autonomous merging is a deliberate, explicit choice the user makes later
by hand (see the README Safety section). `mergeMethod`/`maxReviewRounds` only take effect once the
user turns `autoMerge` on.

Write `notify` as `"terminal"` (the default) so the **ship's bell** is on for the events that
matter — a PR merged / an issue shipped, and any block — without pinging on routine ticks. It's the
fleet's observability: crows-nest rings a one-line notification at terminal/exception events instead
of you polling the `armada:*` labels (see crows-nest §8). The user can dial it down to `"blocked"`
(only "needs a human" events) or `"off"`, or up to `"all"` (also notify when a build opens a PR and
when a green PR awaits a human merge). The bell is best-effort and side-channel — it degrades to a
log line if the notifier isn't available and never affects the build/review/merge outcome.

Write `bellCommand` as `""` (the default — **off**). It's the ship's bell's optional **local command
hook**: a shell command crows-nest runs at the same reconcile points as the `PushNotification`, under
the same `notify` gate, **in addition to** it. It exists because `PushNotification` is suppressed
while the terminal has focus (suppressing both desktop *and* mobile), so an operator watching the
`/loop` gets no alert — a local command is focus-independent and can be audible. Left `""`, nothing
runs and the bell behaves exactly as before. The operator opts in by setting an OS-appropriate
command — ARMADA ships no sound asset and assumes no platform, e.g. `powershell.exe -File fanfare.ps1`
on Windows, `afplay /System/Library/Sounds/Glass.aiff` on macOS, or
`paplay /usr/share/sounds/freedesktop/stereo/complete.oga` on Linux. The command receives the bell
line as its first argument plus `ARMADA_BELL_EVENT` / `ARMADA_BELL_NUMBER` / `ARMADA_BELL_REASON` /
`ARMADA_BELL_MESSAGE` env vars, and is best-effort, bounded, and side-channel — see crows-nest §8e.

`armadaRepo` and `autoArmSelfFixes` wire the **self-improvement loop** (see
[`charter`](../charter/SKILL.md) §9): when a skill hits a defect in ARMADA *itself*, it files a fix
against `armadaRepo` — the ARMADA home repo, so a host project's tracker is never polluted — labelled
`fleet-defect`. Set `armadaRepo` to the repo ARMADA was installed from (e.g. `calumjs/ARMADA`); if
omitted, the skills derive it from the plugin source. **Write `autoArmSelfFixes: false`** — like
`autoMerge`, full self-fixing autonomy is an explicit hand edit, never something commissioning turns
on; left false, self-raised defects are filed for human triage rather than armed into the build queue.

`cartography` gates [`cartographer`](../cartographer/SKILL.md) — the ship that learns *per-repo*
heuristics (a pre-build step, a convention a human keeps correcting) from completed runs and maintains
a reviewable knowledge base under `.armada/cartography/`. One of `"off" | "proposal" | "on"`. **Write
`"off"`** on a fresh repo: cartographer never auto-runs, only manual `/cartographer` works, and the
fleet behaves exactly as before — like `autoMerge` and `autoArmSelfFixes`, turning on autonomous
learning is a deliberate hand edit, never something commissioning enables. The user can set
`"proposal"` (auto-runs at crows-nest's reconcile points but only proposes a diff for approval) or
`"on"` (auto-runs and commits knowledge into the active PR so it rides the muster review + autoMerge
gate). This is distinct from the fleet-defect loop above: `cartography` learns about the *host* repo;
`autoArmSelfFixes` is about defects in *ARMADA itself*.

`foghorn` holds the defaults for the spoken narrator ([`foghorn`](../foghorn/SKILL.md) — the fleet's
**voice**, which speaks activity aloud). All three keys are optional with sensible defaults, so write
the block as a convenience: `flavour` is a short free-text tone (default a gruff, proud **nautical
harbourmaster**) that steers the wording of what's spoken; `verbosity` (`terse | normal | rich`)
controls spoken length; `gate` (`off | blocked | terminal | all`, default `terminal`) keeps routine
ticks quiet, mirroring `notify`. These set *tone*, not behaviour — foghorn is read-only w.r.t. the
fleet and writing them turns nothing on by itself. To actually **hear** the bell, the user also
points `bellCommand` at it (see [`foghorn`](../foghorn/SKILL.md) §3):
`"bellCommand": "node \"${CLAUDE_PLUGIN_ROOT}/scripts/foghorn-say.mjs\""`.

## 4. Create the GitHub labels

The fleet tracks state entirely through labels, so they must exist. There are two tracks — issues
moving through the **build** and PRs moving through the **review→merge** pipeline. `--force` makes
this idempotent (creates or updates, never errors on re-run). Use the configured `triggerLabel`:

```bash
# Shared arming switch (issues and PRs):
gh label create "armada"           --color "1d76db" --description "Eligible for the ARMADA fleet to pick up"             --force
# Issue track (the new-issue watch):
gh label create "armada:underway"  --color "fbca04" --description "Claimed by crows-nest; a build is in progress"       --force
gh label create "armada:done"      --color "0e8a16" --description "ARMADA opened a PR for this issue"                   --force
gh label create "armada:shipped"   --color "006b75" --description "PR merged and acceptance criteria met; issue closed by crows-nest" --force
# PR track (the ready-PR review→merge pipeline):
gh label create "armada:reviewing" --color "fbca04" --description "Claimed by crows-nest; review→merge pipeline running" --force
gh label create "armada:merged"    --color "5319e7" --description "ARMADA merged this PR (auto-merge was enabled)"       --force
# Shared terminal failure state (issues and PRs):
gh label create "armada:blocked"   --color "b60205" --description "ARMADA could not finish; needs a human"              --force
# Self-improvement loop — a defect a skill found in ARMADA itself (see charter §9):
gh label create "fleet-defect"     --color "d4c5f9" --description "A defect a skill found in ARMADA itself; raised by the fleet for the fleet" --force
```

`fleet-defect` is the **self-improvement** label: when any skill hits a defect in ARMADA's own
skills it files a fix against `armadaRepo` via [`charter`](../charter/SKILL.md) (§9), labelled
`fleet-defect` and — by default — **left unarmed** for human triage. It tags issues *about the
fleet*, so it's neither an issue-track nor a PR-track state; it sits alongside them.

`armada:reviewing` and `armada:merged` are the PR-pipeline labels; `armada:shipped` is the
**issue-track terminal** state — crows-nest sets it (and closes the issue) once the linked PR is
merged and the acceptance criteria are satisfied, the end of the lifecycle that `armada:done` only
opens (see crows-nest's close-the-loop watch). `armada:blocked` is reused as the shared "needs a
human" terminal state across both tracks. (If `triggerLabel` was customised, name the eligible label
to match and adjust the state labels' prefix accordingly.)

## 5. Report readiness and how to set sail

Print a short readiness summary and the two things the user does next — **don't auto-create issues
and don't arm the loop for them** (both are the user's call):

```
⚓ ARMADA commissioned in <owner/repo>.
  base branch : <base>
  build/test  : <commands, or "none detected — skills will infer">
  authors     : <"" = anyone, or the configured allowlist>
  auto-merge  : off (default) — the sole merge gate; ready-PR pipeline stops at "awaiting human merge"
  notify      : terminal (default) — ship's bell on shipped + blocked; off | blocked | terminal | all
  bellCommand : "" (default, off) — optional local command the bell also runs (focus-independent alert)
  self-fixes  : armadaRepo=<owner/repo> · autoArmSelfFixes off (default) — fleet-defects filed for human triage
  cartography : off (default) — cartographer never auto-runs; off | proposal | on (run /cartographer by hand any time)
  foghorn     : flavour="a gruff, proud nautical harbourmaster" · verbosity=normal · gate=terminal — spoken narrator (set bellCommand to hear it)
  labels      : armada, armada:underway, armada:done, armada:shipped, armada:reviewing, armada:merged, armada:blocked, fleet-defect ✓

Next:
  1. Label the issues you want built with `armada`:
       gh issue edit <number> --add-label armada
  2. Arm the lookout (crows-nest will hand you the exact /loop line):
       run the crows-nest skill, or say "watch for issues"
```

## Idempotency & re-runs

- Labels: `--force` reconciles them — safe.
- Config: diff-and-confirm before overwrite — never clobbers hand edits silently. Re-running never
  flips `autoMerge` back on or off behind the user's back; if it's already set, leave it.
- Nothing here creates issues, opens PRs, or merges. Commissioning only prepares the repo, and it
  always writes `autoMerge: false`, **`autoArmSelfFixes: false`**, **and `cartography: "off"`** —
  neither autonomous merging, autonomous self-fixing, nor autonomous learning is ever turned on by
  commissioning.

## Inputs

- Optional: a custom trigger label, dispatch target, or base branch (otherwise detected/defaulted).

## Output

- `.armada/config.json` written (or confirmed up-to-date), with `autoMerge: false` and
  `autoArmSelfFixes: false`.
- The eight GitHub labels created/reconciled (issue track + PR track + shared blocked +
  `fleet-defect`).
- A readiness summary + the two next-step commands.
