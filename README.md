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
| **`crows-nest`** | The lookout. Runs under `/loop` and watches for new GitHub issues, then dispatches each one into the fleet. | ✅ shipped |
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

## Safety

**Label discipline is the master switch.** `crows-nest` only ever acts on issues *and* PRs carrying
the configured trigger label (`armada`). You arm autonomy by adding the label and disarm it by
removing it — per object, no code change needed — so the fleet can't run away with your whole
backlog.

**By default the fleet opens PRs and pushes commits but never merges** — the final merge stays a
human action. The ready-PR review pipeline (`muster` review → `shipwright` address → re-validate)
runs to completion and then **stops at "ready to merge, awaiting human"**.

**Gated auto-merge is opt-in.** Setting `autoMerge: true` in `.armada/config.json` lets the pipeline
perform the merge itself — a deliberate reversal of the never-merges rail, so it is fenced on every
side. `commission` always writes `autoMerge: false`; turning it on is a hand edit you make
knowingly. Even with it on, `crows-nest` will **never** merge when any of these holds:

- CI is **red or pending** (only a green check rollup merges);
- there's an **unresolved blocking review finding** from `muster`;
- the PR is a **draft** or GitHub reports it **not `mergeable`**;
- the repo's **branch protections / required reviews aren't satisfied** (GitHub is the source of
  truth — a refused merge is a block, not a retry);
- the **address↔review loop didn't converge** within `maxReviewRounds` (default 2).

When a merge is gated off for any of these, the PR is labelled `armada:blocked`, commented with the
reason, and handed back — it is never left half-driven. The merge, when it happens, uses your
configured `mergeMethod` (`merge`/`squash`/`rebase`). To disarm a PR mid-flight, just remove its
`armada` label.

---
🤖 Built with [Claude Code](https://claude.com/claude-code)
