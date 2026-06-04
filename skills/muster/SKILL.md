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

## 1. Fan out two reviewers in parallel subagents

Spawn **both** reviewers via the **`Agent` tool**, non-interactive, in the **same turn** so they
run concurrently. Each gets the PR metadata, the diff, the changed-file list, and the project's
validation commands — and an instruction to return findings in the **exact schema** below. They
work in **isolated context**: neither reviewer sees the other's output, and neither pollutes the
lookout's transcript.

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

- **One lens fails** (agent type missing, subagent errors) — proceed with the lens that returned,
  mark the review **degraded** in the summary, and say so in the return (`"lenses": ["code-review"]`).
  Don't fail the whole muster for a half-loaf; a degraded review is still worth posting.
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
