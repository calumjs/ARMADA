# ⚓ ARMADA

<img width="1672" height="941" alt="image" src="https://github.com/user-attachments/assets/fae51aca-c048-40e9-8a80-573cc7aa000d" />

**A**utonomous **R**ecursive **M**ulti-**A**gent **D**evelopment **A**ssembler.

ARMADA is a fleet of [Claude Code](https://claude.com/claude-code) skills. One skill keeps
watch for new GitHub issues; the rest pick them up, build them, review them, verify them, and
drive them to a merge-ready PR — with as much or as little human steering as you want.

The skills are **stack-agnostic**. They drive GitHub (`gh`), git worktrees, and your project's
own build/test/lint/run commands — they don't care whether you're shipping Go, Rust, .NET,
TypeScript, or Python.

## The fleet

Skills are colourful by design (a `crows-nest` is more memorable than a `github-issue-poller`),
but each one's **`description`** frontmatter carries explicit trigger phrases, so Claude fires
the right skill from natural language — you rarely type the name.

| Skill | Role | Status |
| :--- | :--- | :--- |
| **`commission`** | The bootstrap. Sets ARMADA up in a repo: detects build/test commands, writes `.armada/config.json`, creates the GitHub labels. Idempotent. | ✅ shipped |
| **`charter`** | The work order. Turns a rough request into a well-formed, testable GitHub issue and arms it with the trigger label so the fleet picks it up. | ✅ shipped |
| **`crows-nest`** | The lookout. A single, maximally parallel scheduler that runs under `/loop` and watches **both tracks at once** — new issues *and* ready PRs — graphs their dependencies/conflicts together, and dispatches independent builds and reviews **concurrently** up to per-track bounds. | ✅ shipped |
| **`shipwright`** | The builder. Takes one issue and works it end-to-end in an isolated worktree, opening a PR. | ✅ shipped |
| **`muster`** | Inspection before sailing. Reviews a ready PR through two parallel lenses (code-review + codex-rescue), dedupes, and posts inline comments + a summary. | ✅ shipped |
| **`logbook`** | The voyage record. Turns a shipped change into a short narrated, chaptered walkthrough video and attaches it to the PR — stack-agnostic, driven by a reusable per-repo staging recipe (launch / stage / reach) that works for web, CLI, or API. | ✅ shipped |
| **`cartographer`** | The mapmaker. Mines completed runs for actionable *per-repo* heuristics (`heuristic / evidence / confidence`) and maintains a reviewable knowledge base under `.armada/cartography/`, so the fleet specialises to a repo over time. shipwright reads it before building; crows-nest auto-runs it (best-effort, gated by `cartography`) at its reconcile points. | ✅ shipped |
| **`lighthouse`** | The reconnaissance. The fleet's only *proactive* ship: surveys the repo for **future** work (failing/skipped tests, TODO/FIXME, missing coverage, stale docs, dependency smells, gaps) — and explores the running app with Playwright when it's runnable — then charters each high-value, de-duped finding as a well-formed issue, **unarmed** so a human review is the gate. crows-nest dispatches it opportunistically as low-priority background work when the fleet is idle (gated by `lighthouse.enabled`); existing build/review work always wins. | ✅ shipped |
| **`quartermaster`** | The cost governor. Reads the same read-only cost signals spyglass consumes and turns them into governance: `report` (today's spend, in-flight accrual, burn-rate, end-of-day forecast) and `check` (an allow/pause verdict against `budget.perRunUSD` / `budget.perDayUSD`). crows-nest consults it before dispatching a build and **holds** new work — reason surfaced — when over budget. Degrades open (no budget → allow; no cost data → allow + warn), so it never blocks the fleet on missing data. | ✅ shipped |
| `flagship` | The command vessel. An autonomous build → review → verify → fix loop that drives an issue all the way to merge-ready. | 🚧 roadmap |
| **`sea-trial`** | The shakedown run. The fleet's true **runtime** verification step: launches the app via `commands.run` and drives a real user flow with Playwright to prove a change works live — reporting **PASS / FAIL / SKIPPED / DEGRADED** with evidence (screenshots, console/network errors). The drive-the-running-app layer on top of shipwright's validate step and the repo-local `verify` skill. Bounded by a runtime budget, read-only w.r.t. the source tree, and degrades gracefully (no `commands.run` → skip; no Playwright → launch-only smoke) so it never errors the pipeline. shipwright can run it post-build and muster as a runtime lens. | ✅ shipped |
| `signal-flags` | Signals back. Addresses reviewer comments on a PR and replies to each thread. | 🚧 roadmap |
| `cargo-manifest` | The manifest. Writes task/PR documentation for completed work. | 🚧 roadmap |

We're adding ships as we need them, not all at once. `crows-nest` + `shipwright` already form a
working loop: an issue appears → it gets built → a PR opens.

## Install & set up

ARMADA is a Claude Code plugin. Add it as a marketplace and install it, then **commission** it in
whatever repo you want the fleet to work on:

```text
/plugin marketplace add calumjs/ARMADA      # or a local path: /plugin marketplace add ./
/plugin install armada@armada
/armada:commission                          # one-time, idempotent, per repo
```

Installing makes the *skills* available. **`commission`** is what makes them work in a given repo:
it auto-detects your build/test/lint/run commands and base branch, writes `.armada/config.json`,
creates the ARMADA labels, and tells you how to arm the watch. You don't hand-configure
anything — that knowledge lives in the skill, so any install self-sets-up.

> **What you need installed.** Only `gh` (authenticated), Node.js, and git are **required**; every
> other tool is **optional with a documented fallback**. See **[REQUIREMENTS.md](REQUIREMENTS.md)** for
> the full reference — what each external tool (ElevenLabs, Codex, `ffmpeg`, Playwright, `gh`) is for,
> required vs optional, how to provide it, its alternatives, and exactly what happens without it.

> **Prefer not to use the plugin system?** Drop **both** the `skills/` **and** `scripts/` folders into
> your project's `.claude/` (i.e. `.claude/skills/` and `.claude/scripts/`) and run `/commission` —
> project-scoped, and it works **out of the box**. Two things to know:
>
> - **No `CLAUDE_PLUGIN_ROOT` export needed.** Skills reference their bundled scripts (the crows-nest
>   review/merge pipeline, the foghorn bell, logbook, spyglass) as `${CLAUDE_PLUGIN_ROOT}/scripts/...`,
>   and that variable is set by the *plugin installer* — not under a drop-in. So `commission` detects
>   drop-in mode and **records the resolved path as `pluginRoot`** in `.armada/config.json`, which the
>   skills consume as a **runtime fallback**: they resolve `${CLAUDE_PLUGIN_ROOT}` when it's set, else
>   fall back to the recorded `pluginRoot`. A pure drop-in therefore needs no manual export — exporting
>   `CLAUDE_PLUGIN_ROOT` stays available only as an **optional override** (e.g. to force a specific
>   root). (Copying `scripts/` too — not just `skills/` — is what gives the fallback something to point
>   at.)
> - **A gitignored `.claude/` means the skills aren't committed.** Many repos ignore `.claude/`, so
>   `git add .claude/skills` is a silent no-op and collaborators who clone get no skills. `commission`
>   warns when it detects this; for a **shared or multi-machine repo, prefer the plugin install**, which
>   doesn't depend on committing `.claude/`.
>
> So the drop-in route gives the **same result** as the plugin with no extra step — `commission`
> records `pluginRoot` for you and only surfaces the gitignore caveat above when it applies.

### Then set sail

```text
1. Label the issues you want built:   gh issue edit <n> --add-label armada
2. Arm the lookout:                   run crows-nest (it hands you the /loop line)
```

The `armada` label is the arming switch — `crows-nest` only ever touches issues that carry it, so
you grant autonomy one issue at a time.

## Releasing & versioning

ARMADA ships as a Claude Code plugin, and **the plugin `version` is the install cache key.** Claude
Code copies an installed plugin into a cache keyed by its version, so an install only picks up new or
changed skills when `.claude-plugin/plugin.json` `version` is bumped. (We learned this the hard way
once: a new skill didn't appear for installs until the version went `0.1.0` → `0.2.0`.)

**Release rule: bump `version` on every skill add or change.** Because this repo's model is "every
feature is a release" — a feature here *is* a new or updated skill — any PR that touches `skills/`
(or a bundled `scripts/` file a skill invokes) must bump `.claude-plugin/plugin.json` `version` in
the same PR. No version bump → downstream installs silently stay on the old skill.

**Version-bump conflicts auto-resolve.** Because *every* PR bumps the same `version` line, two PRs in
flight collide on it — the second to merge would need a hand-resolve. A custom git **merge driver**
kills that: `.gitattributes` marks `.claude-plugin/plugin.json` with `merge=semver-higher`, and
[`scripts/semver-higher-merge.mjs`](scripts/semver-higher-merge.mjs) 3-way-merges the file and, for a
conflict that is *only* the `version` line, keeps the **higher** semver and drops the markers (any
*other* conflict is still left for a human). Git merge drivers are configured per-clone (never
committed — a repo can't run code on your machine just by being cloned), so **run this once after
cloning**:

```bash
node scripts/setup-merge-driver.mjs      # registers the driver for this clone
```

Until you run it, git falls back to a normal conflict — safe, just not automatic. Verify with
`node scripts/semver-higher-merge.test.mjs` (spins up a throwaway repo, merges two branches bumping to
different versions, asserts a clean merge on the higher one).

A couple of related distribution conventions:

- **Bundled-file paths use `${CLAUDE_PLUGIN_ROOT}`.** Any script or asset a *skill* references at
  runtime (e.g. `scripts/review-merge-pipeline.mjs`, `scripts/merge-gate.mjs`) is addressed as
  `${CLAUDE_PLUGIN_ROOT}/scripts/...`, never a bare relative path — once installed, the plugin lives
  in a cache and relative paths break. The repo-local `test`/`lint` command in `.armada/config.json`
  is the exception: it runs against this checkout, not the installed plugin, so it intentionally uses
  a bare path. The plugin installer sets `${CLAUDE_PLUGIN_ROOT}`; under a **drop-in** install it's
  unset, so `commission` records a `pluginRoot` in `.armada/config.json` and the skills **fall back to
  it** when the env var is absent (resolve `${CLAUDE_PLUGIN_ROOT}`, else `pluginRoot`) — so a drop-in
  resolves bundled scripts with no manual export; exporting `CLAUDE_PLUGIN_ROOT` is an optional
  override (see the drop-in notes above).
- **The marketplace catalog tracks the shipped skill set.** When a skill ships, update the plugin
  description in `.claude-plugin/marketplace.json` so the catalog doesn't drift from reality.

## Per-repo configuration

`commission` writes `.armada/config.json` for you, but you can hand-edit it. Shape:

```jsonc
{
  // The label crows-nest watches for, on both issues and PRs. Objects without it are ignored.
  "triggerLabel": "armada",
  // How crows-nest dispatches a claimed issue: "shipwright" (single pass) or "flagship" (auto loop).
  "dispatch": "shipwright",
  // Default base branch for new work.
  "baseBranch": "main",
  // MULTI-REPO (opt-in) — let the fleet switch between more than one repo without re-commissioning.
  //   "repos"      → the set of "owner/name" targets ([] / omitted = single-repo default, unchanged)
  //   "activeRepo" → which one is currently selected ("" / omitted = the ambient cwd repo)
  // Resolution rule everywhere: --repo flag > activeRepo > ambient `gh repo view`. Switch with
  //   node scripts/repo-target.mjs use <owner/name>     (no re-commission; --add to append a new repo)
  // crows-nest targets the active repo; spyglass charts it. One repo at a time — concurrent
  // multi-repo watching is a follow-up. See skills/crows-nest/references/multi-repo.md.
  "repos": [],
  "activeRepo": "",
  // Optional author allowlist — whose issues the lookout will act on (matched case-insensitively).
  //   "" (blank/omitted) → anyone (default)
  //   "calumjs"          → only that author
  //   "calumjs, bob"     → any author in the comma-separated list
  // A JSON array (["alice","bob"]) is also accepted; the string form above is the primary one.
  "authors": "",
  // May the ready-PR pipeline perform the final merge? Default false (stop-before-merge). See Safety.
  "autoMerge": false,
  // Ship's bell — which terminal/exception fleet events emit a one-line notification.
  //   "off"      → never notify
  //   "blocked"  → only "needs a human" blocks
  //   "terminal" → shipped + blocked (default)
  //   "all"      → terminal events plus "PR opened" and "awaiting human merge"
  "notify": "terminal",
  // Merge method when autoMerge is true: "merge" | "squash" | "rebase".
  "mergeMethod": "squash",
  // Bound on the address↔review loop before crows-nest hands a PR back to a human.
  "maxReviewRounds": 2,
  // The ARMADA home repo. When a skill hits a defect in ARMADA itself it files the fix here
  // (never the host project). Omit to derive it from the plugin source. See Self-improvement loop.
  "armadaRepo": "calumjs/ARMADA",
  // May self-raised fleet-defect fixes be armed? Default false: filed for human triage, not built.
  "autoArmSelfFixes": false,
  // May cartographer auto-learn per-repo heuristics into .armada/cartography/? Default "off".
  //   "off"      → never auto-runs; only manual /cartographer works (default)
  //   "proposal" → auto-runs at crows-nest's reconcile points but only proposes a diff for approval
  //   "on"       → auto-runs and commits learning into the active PR (rides muster review + autoMerge)
  // NOTE: "on" COMMITS into the PR, so .armada/cartography/ must be TRACKED (not gitignored) or the
  // git add is a silent no-op and the learning is dropped. If you gitignore .armada/cartography/
  // (treating the map as local scratch — as ARMADA itself does), stay at "proposal". commission and
  // cartographer both warn on this collision; they never edit your .gitignore.
  "cartography": "off",
  // Autonomous reconnaissance (lighthouse) — surveys for FUTURE work and charters it, unarmed.
  "lighthouse": {
    "enabled": false,          // crows-nest auto-dispatch on/off. Default false (opt-in). Manual /lighthouse always works.
    "autoArm": false,          // the ONLY way generated issues get armed. Default false — human review is the gate.
    "intervalHours": 24,       // trigger: min hours since the last lighthouse run
    "commitsSinceScan": 20,    // trigger: N commits landed since the last scan
    "minIdleToDispatch": true, // BOOLEAN guard (default true): only auto-dispatch when the runnable frontier is fully idle. Never overrides existing-work-always-wins.
    "budget": { "maxRuntimeSec": 300, "maxPlaywrightSec": 120, "maxIssuesPerRun": 3, "maxFindings": 20 }
  },
  // Launch the spyglass dashboard alongside the crows-nest watch — ON by default (a read-only view).
  //   "off"   → nothing auto-launches; manual /spyglass still works
  //   "run"   → the per-run operations dashboard (default)
  //   "chart" → the whole-fleet sea-chart
  //   "both"  → both views
  // crows-nest hands the launch line when you arm the watch; the view serves over http://127.0.0.1.
  "spyglass": "run",
  // The fleet's spend GOVERNOR (quartermaster). Both keys optional — omit BOTH (default) = ungoverned.
  // When set, crows-nest consults `quartermaster check` before dispatching new builds (§2d) and HOLDS
  // new work — reason surfaced — when over budget. Read-only w.r.t. cost data; degrades open (no
  // budget → allow; no cost data → allow + warn), so it never blocks the fleet on missing data.
  "budget": {
    "perRunUSD": null,  // pause new dispatches if any single run's spend exceeds this (USD). null = no cap.
    "perDayUSD": null   // pause new dispatches if today's PROJECTED spend would exceed this (USD). null = no cap.
  },
  // Your project's commands. Any can be omitted; skills will infer or ask.
  "commands": {
    "build":  "npm run build",
    "test":   "npm test",
    "lint":   "npm run lint",
    "format": "npm run format",
    "run":    "npm run dev"
  }
}
```

## The self-improvement loop (the "Recursive" in ARMADA)

The fleet improves *itself*. When any ARMADA skill hits a defect in **ARMADA's own skills** — a step
was wrong or missing, a guard didn't fire, or the skill had to **guess** because guidance was absent
— it routes a fix back into the fleet rather than silently working around it. This is the literal
**R**ecursive in *Autonomous Recursive Multi-Agent Development Assembler*: the fleet learning from its
own runs.

The reflex is a single shared convention (documented once in `charter` §9, referenced by every
skill):

1. **Triage first.** A broken test or wrong requirement in the *target project* is task work, handled
   in the build — it is **never** filed as an ARMADA defect. Only ARMADA's own gaps qualify.
2. **File via `charter`** a concise defect report (what went wrong, why it's ARMADA's fault, a
   suggested fix) **against the ARMADA repo** (`armadaRepo`, or derived from the plugin source) — so a
   skill running in your project never pollutes your tracker with ARMADA's bugs.
3. **De-dupe** against existing open `fleet-defect` issues; a repeat occurrence adds a comment/reaction
   instead of a twin.
4. **Best-effort, side-channel.** Filing never blocks or derails the primary build or review — it's
   surfaced in the run summary and nothing more.

**Self-raised fixes are unarmed by default.** A `fleet-defect` issue modifies ARMADA's own skills, so
with arming + `autoMerge` on it becomes a loop that could rewrite and merge its own skills unattended
— the dream and the hazard. So `fleet-defect` issues are **filed for human triage, not armed**, even
though `charter` auto-arms human-authored issues. Set **`autoArmSelfFixes: true`** to opt into the
fleet fixing itself end-to-end; it defaults `false`, and `commission` never turns it on.

> **Not to be confused with `cartographer`.** This loop learns about **ARMADA itself** (a skill was
> wrong) and files a `fleet-defect`. `cartographer` (gated by `cartography`, default `"off"`) learns
> about the **host repo** (a pre-build step, a convention a human keeps correcting) and maintains a
> reviewable map under `.armada/cartography/` that future builds consult. They're independent loops.

## Safety

**Label discipline is the master switch.** `crows-nest` only ever acts on issues *and* PRs carrying
the configured trigger label (`armada`). You arm autonomy by adding the label and disarm it by
removing it — per object, no code change needed — so the fleet can't run away with your whole
backlog.

**By default the fleet opens PRs and pushes commits but never merges** — the final merge stays a
human action. The ready-PR review pipeline (`muster` review → `shipwright` address → re-validate)
runs to completion and then **stops at "ready to merge, awaiting human"**.

**`autoMerge` is the single gate — PRs ARMADA opens are auto-armed.** When `shipwright` opens a PR
it adds the `armada` label itself, so the ready-PR watch picks it up with no manual PR-arming step.
This is safe because review and address **never merge**: the *only* consequential action is the
final merge, and that is already gated by `autoMerge`. With `autoMerge: false` the pipeline reviews,
addresses, and re-validates, then stops before merging; with `autoMerge: true` you've already opted
in. One gate is enough, so there's no redundant second "arm this PR" step. Only PRs ARMADA itself
opens are auto-armed — human PRs are left alone unless you arm them, and removing the `armada` label
still disarms any PR.

**Gated auto-merge is opt-in.** Setting `autoMerge: true` in `.armada/config.json` lets the pipeline
perform the merge itself — a deliberate reversal of the never-merges rail, so it is fenced on every
side. `commission` always writes `autoMerge: false`; turning it on is a hand edit you make
knowingly. Even with it on, `crows-nest` will **never** merge when any of these holds:

- CI is **red or pending** (only a green check rollup merges);
- there's an **unresolved blocking review finding** from `muster`;
- the PR is a **draft** or GitHub reports it **not `mergeable`** even after the auto-rebase below;
- the repo's **branch protections / required reviews aren't satisfied** (GitHub is the source of
  truth — a refused merge is a block, not a retry);
- the **address↔review loop didn't converge** within `maxReviewRounds` (default 2).

**Auto-rebase when `autoMerge` is on — bounded and fenced.** A reviewed PR can still be
un-mergeable because its branch drifted while the pipeline ran. With `autoMerge: true`, `crows-nest`
makes it mergeable itself instead of parking it for a human: a `BEHIND` PR is updated from the base,
and a `CONFLICTING` PR is **rebased and resolved by a `shipwright` subagent** (rebase onto the
configured base, integrate both sides — never drop the base's changes — re-validate, force-push with
`--force-with-lease`). It is bounded (`maxRebaseRounds`, default 1), **re-validated and re-reviewed**
before the merge gate, force-pushes **only fleet-owned branches** (a branch with human commits is
never rewritten), and **falls back to `armada:blocked`** — never a forced merge — if the conflict
isn't confidently resolvable, validation fails post-rebase, or the cap is hit. With `autoMerge:
false` this is off: the branch is left untouched and the PR is surfaced as "needs rebase".

When a merge is gated off for any of these, the PR is labelled `armada:blocked`, commented with the
reason, and handed back — it is never left half-driven. The merge, when it happens, uses your
configured `mergeMethod` (`merge`/`squash`/`rebase`). To disarm a PR mid-flight, just remove its
`armada` label.

## License

[MIT](LICENSE) © calumjs

---
🤖 Built with [Claude Code](https://claude.com/claude-code)
