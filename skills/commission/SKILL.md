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
    "gate": "terminal",            // which events speak: "off" | "blocked" | "terminal" | "all" (routine ticks quiet)
    "provider": "",                // NON-SECRET cloud TTS provider: "" (free local OS voice) | "elevenlabs" | "openai" | …
    "voice": ""                    // NON-SECRET voice id for that provider; "" = the provider/OS default. The SECRET key is NEVER here — env / .env only.
  },
  "lighthouse": {                  // autonomous reconnaissance (lighthouse skill) — surveys for FUTURE work, charters it unarmed.
    "enabled": false,              // crows-nest AUTO-dispatch on/off. Default false (opt-in). Manual /lighthouse always works.
    "autoArm": false,              // the ONLY way generated issues get armed. Default false — human review is the gate.
    "intervalHours": 24,           // trigger: min hours since the last lighthouse run
    "commitsSinceScan": 20,        // trigger: N commits landed since the last scan
    "minIdleToDispatch": true,     // BOOLEAN guard (default true): only auto-dispatch when the runnable frontier is fully idle. Never overrides existing-work-always-wins.
    "budget": {                    // every run is bounded — recon, not exhaustive analysis
      "maxRuntimeSec": 300,        // hard cap on the whole run
      "maxPlaywrightSec": 120,     // hard cap on the dynamic (Playwright) survey
      "maxIssuesPerRun": 3,        // most issues a single run will file
      "maxFindings": 20            // most candidate findings a run collects before it stops surveying
    }
  },
  "logbook": "off",               // auto-record walkthrough? shipwright on PR open + crows-nest at merge/ship. "off" | "user-visible" | "all". Default "off" (opt-in).
  "publicIntake": {                // screen UNSOLICITED public issues (no trigger label) and charter the safe, good ones. The ONLY track that reads untrusted input.
    "enabled": false,              // master switch. Default false (opt-in) — the track is inert until on. Reads attacker-controllable text, so off by default.
    "authors": "",                 // optional allowlist of public authors to consider. "" = anyone (the point of the feature). Same form as top-level "authors".
    "autoArm": true,               // arm the chartered fresh issue (built automatically)? Default true (configurable). false = file unarmed for human review.
    "maxPerTick": 3,               // budget: most public issues SCREENED per tick. Bounds the screen fan-out.
    "requireDoubleCheck": true,    // run a 2nd independent safety screen before an ARMED charter? Default true. The layer that makes auto-arm safe.
    "closeOnCharter": true         // close the original public issue (courteous comment + link) when chartered? Default true.
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
**voice**, which speaks activity aloud). All keys are optional with sensible defaults, so write the
block as a convenience: `flavour` is a short free-text tone (default a gruff, proud **nautical
harbourmaster**) that steers the wording of what's spoken; `verbosity` (`terse | normal | rich`)
controls spoken length; `gate` (`off | blocked | terminal | all`, default `terminal`) keeps routine
ticks quiet, mirroring `notify`. Also write the two **non-secret** voice keys, both **default empty**:
`provider` (`""` = the free local OS voice; or `"elevenlabs"`, `"openai"`, …) and `voice` (the voice
id for that provider, `""` = its default). These live in config so a cloud-voice setup is
**discoverable and survives restarts with no env at all** — foghorn resolves provider/voice with
precedence `--flag > env (FOGHORN_TTS_PROVIDER/FOGHORN_VOICE) > foghorn.* config > default`. The
**secret key is NEVER written to config** — it comes from the environment or a gitignored repo-local
`.env` (`.armada/foghorn/.env`) only (see [`foghorn`](../foghorn/SKILL.md) §1). These keys set *tone
and voice*, not behaviour — foghorn is read-only w.r.t. the fleet and writing them turns nothing on by
itself. To actually **hear** the bell, the user also points `bellCommand` at it (see
[`foghorn`](../foghorn/SKILL.md) §3):
`"bellCommand": "node \"${CLAUDE_PLUGIN_ROOT}/scripts/foghorn-say.mjs\""`.

`lighthouse` configures the fleet's autonomous **reconnaissance** ([`lighthouse`](../lighthouse/SKILL.md)
— the ship that surveys the repo for *future* work and charters it). Write the block with safe
defaults: **`enabled: false`** so crows-nest never auto-dispatches lighthouse (manual `/lighthouse`
still works any time) — like `autoMerge` / `cartography`, turning on autonomous discovery is a
deliberate hand edit, never something commissioning enables. **`autoArm: false`** is the safety
mechanism: issues lighthouse generates are filed **unarmed** (`charter --no-arm`) for human review, and
`autoArm` is the *only* way they're ever auto-armed — reserved for trusted repos. The trigger
thresholds (`intervalHours`, `commitsSinceScan`, `minIdleToDispatch`) and the `budget`
(`maxRuntimeSec` / `maxPlaywrightSec` / `maxIssuesPerRun` / `maxFindings`) bound the
**opportunistic, low-priority** dispatch so recon only runs in spare capacity and never preempts
build/review work (see crows-nest §2f and lighthouse §0/§7). Left at the defaults, lighthouse never
auto-runs and nothing it would discover is ever auto-built.

`logbook` gates [`shipwright`](../shipwright/SKILL.md)'s **auto-walkthrough** — whether the builder
automatically records a narrated demo video via [`logbook`](../logbook/SKILL.md) when it opens a PR,
rather than waiting for an interactive offer. One of `"off" | "user-visible" | "all"`. **Write
`"off"`** on a fresh repo — like `lighthouse` and `cartography`, auto-recording is opt-in, never
something commissioning enables. Set `"user-visible"` to record automatically when the change is
user-visible (new workflows, multi-step UX, role-based behaviour — but not refactors, dependency
bumps, infra-only changes, or one-line fixes — shipwright applies the same heuristic it uses for the
interactive §9 offer); set `"all"` to record on every PR shipwright opens. When auto-recording,
shipwright invokes `logbook` non-interactively, best-effort and side-channel — a logbook failure,
missing toolchain, or degraded render **never blocks, fails, or delays** the build or handoff.

The **same key also drives [`crows-nest`](../crows-nest/SKILL.md)** (§8f): in the autonomous flow
shipwright runs in a background subagent and *defers* the walkthrough, so crows-nest records it at the
**PR-merged / issue-shipped reconcile** instead — idempotently (never double-records), verified before
posting, with a bounded backfill for already-merged PRs, and fully side-channel. So `"user-visible"` /
`"all"` covers both the open-time (shipwright) and merge-time (crows-nest) paths from one setting.

`publicIntake` gates crows-nest's **public-intake track** (§2g) — the one track that reads
**unsolicited issues from the general public** (those *without* the trigger label) instead of acting
only on armed work. Because it reads **untrusted, attacker-controllable text**, commission writes it
**off and defended**: **`enabled: false`** so the track is completely inert until an operator
deliberately turns it on — like `autoMerge` / `lighthouse`, enabling it is a hand edit, never something
commissioning switches on. Write the rest of the block as the documented defaults so a later
`enabled: true` is safe out of the box: `authors: ""` (consider anyone — the point of the feature),
`autoArm: true` (the chartered fresh issue is built automatically once on; set `false` to file unarmed
for human review), `maxPerTick: 3` (caps how many public issues are screened per tick),
`requireDoubleCheck: true` (a second independent safety screen must also clear before an *armed*
charter — the layer that makes auto-arm safe), and `closeOnCharter: true` (close the original with a
courteous link when chartered). When on, each public issue is screened **adversarially in an isolated,
read-only subagent** that treats the body as untrusted *data, never instructions*; safe good ideas are
**re-authored** by the fleet and chartered, and anything that looks like prompt-injection / malicious /
abuse is labelled `armada:flagged` for a human and **never acted on** (see crows-nest §2g and
[public-intake.md](../crows-nest/references/public-intake.md)). Left at the default, the fleet behaves
exactly as before and never reads a public issue.

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
# Public-intake track (screening unsolicited public issues — crows-nest §2g):
gh label create "armada:considered" --color "c5def5" --description "crows-nest screened this public issue and chose not to charter it (declined/duplicate/spam); left open for a human" --force
gh label create "armada:flagged"    --color "e99695" --description "crows-nest's public-intake screen judged this public issue prompt-injection/malicious/abusive; needs a human audit — never acted on" --force
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

## 5. Offer to charter recommended setup/improvement issues (don't force)

Commissioning prepares the repo, but a fresh repo usually still has **setup gaps the fleet can't
close inline** — the biggest being a **CI merge-gate**: lint/build/test running on every PR as an
independent, ideally **required** status check. ARMADA's only merge gate is otherwise the `muster`
subagent's *local* validation; if that misses something, `autoMerge` can land a broken base. CI
often can't be wired during commissioning (no pipeline yet, secrets/permissions absent), so rather
than scaffolding it inline, **commission offers to charter the gap as tracked future work** — and,
more generally, a short list of recommended setup/improvement issues, each filed **unarmed** for
human review and each body **stating it is pending an initial implementation**.

This is an **offer, not a default action** — never auto-create these issues. Present the
recommended list and let the user pick which (if any) to charter; default to none if they decline or
don't answer.

### 5a. The recommended list (CI merge-gate first)

Survey what the repo already has (don't recommend what exists) and assemble the candidate list,
**CI merge-gate as the primary recommendation**:

```bash
# Does a CI workflow already run checks on PRs?
ls .github/workflows/ 2>/dev/null            # GitHub Actions
ls .gitlab-ci.yml azure-pipelines.yml 2>/dev/null
# Are there already required status checks on the base branch?
gh api "repos/{owner}/{repo}/branches/<baseBranch>/protection" --jq '.required_status_checks.contexts' 2>/dev/null
```

Recommend an issue only when the gap is real:

- **CI merge-gate** *(primary)* — when no PR-triggered CI workflow runs the detected
  `build`/`test`/`lint` commands, **and/or** no required status check is configured on the base
  branch. This is the issue the whole feature exists for.
- **Branch protection / required review** — when the base branch has no protection rule (no required
  checks, no required review) — recommend only if it's a gap, and keep it distinct from the CI issue.
- Other genuine, repo-specific setup gaps you observed (e.g. no test command detected at all in §2) —
  keep the list **short** (≈1–3), each one focused and clearly future work.

Don't pad the list. If CI already gates PRs as a required check, say so and **offer nothing** — the
gap the feature targets is already closed.

### 5b. Charter each accepted issue — unarmed, "pending an initial implementation"

For each issue the user accepts, route it through [`charter`](../charter/SKILL.md) in **`--no-arm`**
mode (§6 there) so it's filed for human review and **not** picked up by the build queue. Each issue
must be **charter-quality** (§4 there: imperative `ship: capability`-style title, problem/goal,
concrete testable acceptance criteria, scope, notes) **and its body must state plainly that it is
pending an initial implementation** — tracked future work, not done at commission time. For the CI
merge-gate, the canonical shape:

```markdown
## Problem / Goal
This repo has no CI merge-gate: lint/build/test do not run as an independent status check on every
PR, so the only thing standing between a PR and the base branch is `muster`'s local validation.
With `autoMerge` on, a gap in local validation can land a broken base. Wire CI so the project's own
`build`/`test`/`lint` commands run on every PR and become a **required** status check.

> **Pending an initial implementation.** This issue was filed by `commission` at fleet setup time as
> tracked future work — CI was deliberately *not* scaffolded inline. It is unarmed; a human should
> review and implement (or arm) it.

## Acceptance criteria
- [ ] A PR-triggered CI workflow runs the project's `build` / `test` / `lint` commands (from
      `.armada/config.json`).
- [ ] The CI check is configured as a **required status check** on the `<baseBranch>` branch so a
      red check blocks merge.
- [ ] A failing check visibly blocks merge on a sample PR.

## Scope / non-goals
- In: a CI workflow running the configured commands on every PR + a required status check.
- Out: changing the commands themselves or the merge policy.

## Notes
- Filed unarmed by `commission` as recommended setup work. Primary motivation: an independent merge
  gate beyond `muster`'s local validation (see ARMADA's autoMerge safety model).
```

File it (charter §7, `--no-arm` path — type label only, **no** trigger label):

```bash
gh issue create --label "enhancement" --title "ci: gate every PR on lint/build/test as a required check" --body "$(cat <<'EOF'
<the body above>
EOF
)"
# Do NOT add the triggerLabel — these are unarmed, for human review.
```

Surface the result like charter §8 (number, url, **unarmed — for human review**, the one-liner to
arm later: `gh issue edit <n> --add-label <triggerLabel>`). Filing is **best-effort and
side-channel** — if a `gh` call fails, note it and carry on; it never blocks commissioning.

## 6. Warn when autoMerge is on but no required checks gate the merge

`autoMerge: true` lets the ready-PR pipeline merge unattended; its sole independent gate is then
whatever **required status checks** the base branch enforces. When `autoMerge: true` **and** there
are **no required status checks**, the effective merge gate is **`muster`'s local validation only** —
which is exactly the broken-base risk this feature targets. Commission **warns** about it (and so does
[`crows-nest`](../crows-nest/SKILL.md) at its merge gate — see below):

```bash
# Is autoMerge on in the config we just wrote/confirmed?
#   → read .armada/config.json → autoMerge
# Are there any required status checks on the base branch?
gh api "repos/{owner}/{repo}/branches/<baseBranch>/protection" \
  --jq '.required_status_checks.contexts | length' 2>/dev/null   # 0 / error ⇒ none
```

If `autoMerge: true` and the required-checks count is `0` (or the protection call errors, i.e. no
protection at all), print a prominent warning in the readiness report:

```
⚠ autoMerge is ON but the base branch has no required status checks — the merge gate is
  LOCAL-VALIDATION-ONLY (muster's subagent), with no independent CI gate. A gap in local validation
  can land a broken <baseBranch>. Charter the CI merge-gate issue above (§5) and/or set autoMerge:false.
```

This warning is **advisory** — it never flips `autoMerge` off or blocks commissioning; it just makes
the local-only gate visible. (`crows-nest`'s ready-PR pipeline raises the same warning at the merge
gate when it's about to auto-merge a PR with an empty `statusCheckRollup`.)

## 7. Report readiness and how to set sail

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
  foghorn     : flavour="a gruff, proud nautical harbourmaster" · verbosity=normal · gate=terminal · provider="" · voice="" — spoken narrator (set provider/voice for a cloud voice, key via env/.env; set bellCommand to hear it)
  lighthouse  : enabled=false · autoArm=false (defaults) — autonomous recon never auto-runs; run /lighthouse by hand any time (files unarmed backlog issues for human review)
  logbook     : off (default) — shipwright offers walkthrough interactively only; set user-visible or all to auto-record on PR open (see shipwright §9)
  publicIntake: enabled=false (default) — never reads public issues; set enabled=true to screen unsolicited public suggestions (untrusted input; defended in layers — crows-nest §2g)
  labels      : armada, armada:underway, armada:done, armada:shipped, armada:reviewing, armada:merged, armada:blocked, armada:considered, armada:flagged, fleet-defect ✓
  chartered   : <e.g. "#84 ci merge-gate (unarmed)" — or "none (offered, declined)" / "none (CI already gates PRs)">

<one of:>
  ⚠ autoMerge is ON but the base branch has no required status checks — the merge gate is
    LOCAL-VALIDATION-ONLY (muster's subagent). Charter the CI merge-gate issue (§5) and/or set autoMerge:false.
<or omit the warning when autoMerge is off, or required checks exist.>

Next:
  1. Label the issues you want built with `armada`:
       gh issue edit <number> --add-label armada
  2. Arm the lookout (crows-nest will hand you the exact /loop line):
       run the crows-nest skill, or say "watch for issues"
```

The `chartered` line reports the §5 offer's outcome; the `⚠` line is the §6 warning, printed **only**
when `autoMerge: true` and no required status checks gate the base branch.

## Idempotency & re-runs

- Labels: `--force` reconciles them — safe.
- Config: diff-and-confirm before overwrite — never clobbers hand edits silently. Re-running never
  flips `autoMerge` back on or off behind the user's back; if it's already set, leave it.
- Nothing here merges or arms. Commissioning writes `autoMerge: false`, **`autoArmSelfFixes: false`**,
  **`cartography: "off"`**, **`logbook: "off"`**, and **`publicIntake.enabled: false`** — neither
  autonomous merging, autonomous self-fixing, autonomous learning, auto-recording, nor reading
  untrusted public issues is ever turned on by commissioning.
- The **offer to charter** (§5) is the only step that can *create* anything, and only with the user's
  say-so — issues are filed **unarmed**, never armed into the build queue. On a re-run, **de-dupe
  first**: `gh issue list --state all --search "ci merge-gate"` (and the other candidates) — if the
  recommended issue already exists, don't file a twin; surface the existing one instead.
- The §6 **warning** is read-only — it never flips `autoMerge` or blocks; it just reports the
  local-only gate when `autoMerge: true` and no required checks exist.

## Inputs

- Optional: a custom trigger label, dispatch target, or base branch (otherwise detected/defaulted).

## Output

- `.armada/config.json` written (or confirmed up-to-date), with `autoMerge: false` and
  `autoArmSelfFixes: false`.
- The ten GitHub labels created/reconciled (issue track + PR track + shared blocked + public-intake
  `armada:considered` / `armada:flagged` + `fleet-defect`).
- An **offer** to charter a short list of recommended setup/improvement issues (CI merge-gate first),
  each filed **unarmed** via `charter --no-arm` with a body stating it is **pending an initial
  implementation** — only those the user accepts; nothing forced.
- A **local-validation-only warning** in the readiness report when `autoMerge: true` and the base
  branch has no required status checks.
- A readiness summary + the two next-step commands.
