# Multi-repo targeting — operate the fleet across more than one repo

ARMADA is commissioned **per-repo**: `.armada/config.json` lives in one checkout and, by default, the
fleet acts on **that** repo — the ambient `gh` repo (whatever `gh repo view` resolves in the cwd).
Multi-repo targeting adds **opt-in** first-class support to *switch between* more than one repo
**without re-commissioning each time**, while keeping the single-repo default byte-for-byte unchanged.

This is the **first increment**: the fleet operates on **one selected repo at a time**. Watching
several repos **concurrently** is a deliberate follow-up (see [Follow-up](#follow-up-concurrent-multi-repo-watching)).

## The model

Two optional config keys, both written by [`commission`](../../commission/SKILL.md) §3a:

| Key | Meaning | Default |
| :-- | :------ | :------ |
| `repos` | A list of `owner/name` the fleet may target. Also accepts the comma-separated string form. | `[]` — single-repo |
| `activeRepo` | Which one of `repos` is **currently selected**. | `""` — the ambient repo |

**No `repos` / no `activeRepo` ⇒ single-repo default.** The fleet targets the ambient cwd repo exactly
as it always has — no behaviour change.

## The one resolution rule

Every repo-scoped skill and script resolves the target repo with the same precedence:

```
--repo <owner/name> flag   >   config.activeRepo   >   ambient `gh repo view`
```

The bundled [`repo-target.mjs`](../../../scripts/repo-target.mjs) helper is the single source of truth
for this rule and makes the active repo **unambiguous and reported**:

```bash
# Resolve the active repo AND report where it came from (flag / config / ambient):
node "${CLAUDE_PLUGIN_ROOT}/scripts/repo-target.mjs" resolve
#   -> calumjs/site  (source: config.activeRepo)

# List the configured repos, active one marked '*':
node "${CLAUDE_PLUGIN_ROOT}/scripts/repo-target.mjs" list
#   * calumjs/site
#     calumjs/ARMADA

# SWITCH the active repo — writes activeRepo into .armada/config.json, no re-commission:
node "${CLAUDE_PLUGIN_ROOT}/scripts/repo-target.mjs" use calumjs/ARMADA

# Append a repo not yet in `repos`, then select it:
node "${CLAUDE_PLUGIN_ROOT}/scripts/repo-target.mjs" use calumjs/new-repo --add
```

`use` refuses a target that isn't in `repos` unless you pass `--add`, so a typo can't silently point
the fleet at a repo you never configured.

## How the fleet consumes it

- **[`crows-nest`](../SKILL.md) §1/§2a** — it **re-resolves the active repo at the start of every tick**
  (so a mid-watch `use` switch takes effect on the next tick, no re-arm) and, **when multi-repo is
  configured**, threads `--repo <activeRepo>` into every **remote** `gh` scan/claim/reconcile call (§2a
  scans, §2d claim, §3e/§5f/close-the-loop label + comment writes) and leads the tick line with
  `[<owner/name>]` so the target is unambiguous. With no `repos` config it omits `--repo` and runs
  against the cwd repo exactly as today.
- **[`spyglass`](../../spyglass/SKILL.md)** — both snapshot drivers resolve the repo through the shared
  `repo-target.mjs` resolver (same precedence AND validation), so the dashboard charts the selected repo
  with no extra flag. Pass `--repo <owner/name>` to override for one session.

## Build & merge are GUARDED, not repo-targeted (this increment)

Repo targeting is safe for **remote** `gh` operations — the scans, the spyglass view, and the label /
comment writes all take `--repo <activeRepo>` and act on GitHub directly. **Building and merging do
not.** shipwright builds in a **local worktree of the checkout**, and the review→merge pipeline runs
`gh pr merge` / `update-branch` against the **ambient checkout repo**; selecting a different `activeRepo`
does **not** re-clone or re-checkout that repo. So building/merging a repo other than the checkout's
origin would silently act on the **wrong** local tree.

Rather than do that, the fleet **refuses**: when `activeRepo` ≠ the checkout's origin repo, the guard
trips and the build/merge is held with a clear message —

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/repo-target.mjs" guard
#   activeRepo calumjs/site ≠ checkout calumjs/ARMADA → exit 4 (refuse)
```

`review-merge-pipeline.mjs` calls the same guard internally and returns `blocked` with that reason
instead of merging. Making the build/merge path itself **cross-repo** — checking out / cloning the
selected repo, running its own `.armada/config.json` build commands — is a deliberate **follow-up**, not
delivered here. Until then: to build/merge a repo, make it the checkout (or set `activeRepo` back to the
checkout's origin).

## Switching, step by step

```bash
# 1. Configure the set once (or hand-edit .armada/config.json "repos": [...]):
node "${CLAUDE_PLUGIN_ROOT}/scripts/repo-target.mjs" use calumjs/ARMADA --add
node "${CLAUDE_PLUGIN_ROOT}/scripts/repo-target.mjs" use calumjs/site   --add

# 2. Select the one you want the fleet to work on now:
node "${CLAUDE_PLUGIN_ROOT}/scripts/repo-target.mjs" use calumjs/site

# 3. Arm the watch — crows-nest targets calumjs/site; spyglass charts it. No re-commission.
#    Switch again any time by re-running `use`; the next tick targets the new active repo.
```

## Follow-up: concurrent multi-repo watching

This increment watches **one selected repo per `/loop`**. A future increment can watch **several repos
concurrently** in a single scheduler tick — scanning each repo's tracks, budgeting concurrency across
them, and reporting a per-repo schedule. That needs a repo dimension threaded through the whole
cross-track dependency graph and the dispatch bounds, plus per-repo build commands (each target repo's
own `.armada/config.json`), so it is intentionally **out of scope here** and called out as the next
step. Cross-repo dependency graphs are likewise deferred.
