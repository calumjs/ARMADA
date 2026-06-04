# shipwright — decompose large issues into a stacked PR series

This is shipwright's **stacked-PR decomposition** (build mode, §3b): when an issue is too large to
ship as one PR, slice it into a stack. It's part of planning (after the [SKILL.md §3](../SKILL.md)
implementation plan, before writing code); jump here only when the change is large enough to
warrant slicing.

Most issues ship as one PR. **Large ones should ship as a stack.** Trigger decomposition when the
change touches multiple distinct surfaces, the diff would plausibly exceed ~2,000 lines, or the PR
body would need to be organised into "slices" to be readable. A monster PR is slower to land (one
blocker holds the whole thing), harder to review carefully, and riskier to revert.

If slicing:
- **Each slice = one branch, one PR, one focused capability.**
- **Slices stack — a slice's base is the previous slice's head, not the base branch.** This keeps
  each PR's diff small and reviewable in isolation.
- **Identify the foundation first** (usually data model + base surface); co-equal siblings branch
  off it and can be worked in parallel (their own worktrees). Cross-cutting / hardening passes go
  last as their own slices.
- For non-trivial stacks (4+ slices), keep a long-lived `<issue>-rollup` branch that merges each
  slice's head as it stabilises — it's both the continuous-integration surface and the eventual
  single merge unit. Fixes land on the slice branch, never the rollup.

Present the slice tree (slice numbers, branch names, base for each, one-line purpose) and **get
sign-off before writing code** — it's the most expensive thing to redo.

> When crows-nest dispatches a sliced build, its own internal fan-out spawns the parallel slice
> builders as **background** agents rather than blocking serially on each, so one slice doesn't
> stall the others — see [crows-nest SKILL.md](../../crows-nest/SKILL.md) §2d.
