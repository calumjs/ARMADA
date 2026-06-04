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
| `flagship` | The command vessel. An autonomous build → review → verify → fix loop that drives an issue all the way to merge-ready. | 🚧 roadmap |
| `sea-trial` | The shakedown run. Launches the app and drives a real flow with Playwright to verify a change works at runtime. | 🚧 roadmap |
| `logbook` | The voyage record. Records a narrated "done" walkthrough video for stakeholders. | 🚧 roadmap |
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

> Prefer not to use the plugin system? Drop the `skills/` folders into your project's
> `.claude/skills/` and run `/commission` — same result, project-scoped.

### Then set sail

```text
1. Label the issues you want built:   gh issue edit <n> --add-label armada
2. Arm the lookout:                   run crows-nest (it hands you the /loop line)
```

The `armada` label is the arming switch — `crows-nest` only ever touches issues that carry it, so
you grant autonomy one issue at a time.

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
  // Optional author allowlist — whose issues the lookout will act on (matched case-insensitively).
  //   "" (blank/omitted) → anyone (default)
  //   "calumjs"          → only that author
  //   "calumjs, bob"     → any author in the comma-separated list
  // A JSON array (["alice","bob"]) is also accepted; the string form above is the primary one.
  "authors": "",
  // May the ready-PR pipeline perform the final merge? Default false (stop-before-merge). See Safety.
  "autoMerge": false,
  // Merge method when autoMerge is true: "merge" | "squash" | "rebase".
  "mergeMethod": "squash",
  // Bound on the address↔review loop before crows-nest hands a PR back to a human.
  "maxReviewRounds": 2,
  // The ARMADA home repo. When a skill hits a defect in ARMADA itself it files the fix here
  // (never the host project). Omit to derive it from the plugin source. See Self-improvement loop.
  "armadaRepo": "calumjs/ARMADA",
  // May self-raised fleet-defect fixes be armed? Default false: filed for human triage, not built.
  "autoArmSelfFixes": false,
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

---
🤖 Built with [Claude Code](https://claude.com/claude-code)
