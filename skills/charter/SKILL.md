---
name: charter
description: >
  Turn a rough request into a well-formed, fleet-ready GitHub issue — then arm it. charter drafts a
  structured issue (imperative title, problem/goal, concrete testable acceptance criteria, scope,
  dependencies, notes) following issue best practices and this repo's house style, confirms the
  draft with you, creates it via gh with the right type label, and — by default — adds the
  triggerLabel from .armada/config.json so crows-nest picks it up with no extra step. Trigger when
  the user says "create an issue", "file a PBI", "charter a task", "new backlog item", "raise a
  ticket", "draft an issue", "open a work order", or invokes /charter. Distinct from commission
  (which sets the repo up); charter authors and arms the work that flows into the fleet.
argument-hint: "<rough request>"
disallowed-tools: Write, Edit
---

# charter — draft a fleet-ready issue and arm it

`charter` is how a rough request becomes work the fleet can build. It writes a **well-formed GitHub
issue** — the kind a human reviewer or `shipwright` can pick up without guessing — and then **arms
it** by adding the trigger label, so `crows-nest` consumes it automatically. It closes the loop on
the front end: `charter` produces the armed issues, `crows-nest` watches for them, `shipwright`
builds them.

It automates exactly what the fleet has been doing by hand: write a structured PBI, then
`gh issue edit <n> --add-label armada`. Because arming is automatic, **the quality bar matters more,
not less** — an armed issue gets built. So `charter` is opinionated about what counts as buildable
before it will create and arm anything.

> The acceptance criteria `charter` writes are the contract `shipwright` builds against and `muster`
> reviews. Vague ACs produce a vague PR. Treat them as the most important part of the issue.

## 0. Discover the project's conventions

Read `.armada/config.json` → `triggerLabel` (default `armada`) — that's the label that arms an
issue. If the file is absent the repo isn't commissioned: run
[`commission`](../commission/SKILL.md) first (or offer to), since arming keys off labels that
commissioning creates.

Two more keys matter for **self-improvement mode** (§9), where a skill files a defect against ARMADA
itself rather than authoring user work:

- `armadaRepo` — the ARMADA home repository (`owner/repo`) a self-raised fix is filed against. If
  absent, derive it from the plugin source (the marketplace/`homepage` it was installed from). A
  skill running in someone else's project must file the fix against **ARMADA**, never the host repo.
- `autoArmSelfFixes` — whether self-raised defect issues are armed. **Default `false`**: they are
  filed and labelled `fleet-defect` but left for human triage, because arming them lets the fleet
  rewrite (and, with `autoMerge`, merge) its own skills unattended. See §9.

Skim a couple of recent issues to match the house style for titles and body structure:

```bash
gh issue list --state all --limit 10
gh issue view <a-recent-number>          # see how titles/sections are written here
gh label list                            # the type labels available (enhancement/bug/…)
```

## 1. Take the request and de-dupe first

The input is a free-text description of the desired work. **Before drafting, search existing open
issues** so `charter` doesn't file a near-duplicate:

```bash
gh issue list --state open --search "<keywords from the request>"
gh issue list --state open --limit 50    # also eyeball the backlog for overlap
```

If you find a close match, surface it and ask whether to (a) build on / amend the existing issue,
(b) file anyway as distinct, or (c) drop it. Don't silently create a twin.

## 2. Check it's one focused capability

**One issue = one focused capability.** If the request is really an epic — it spans multiple
distinct surfaces, or its acceptance criteria fall into clearly separable groups — say so and offer
to file a **stack of linked issues** instead of one sprawling ticket (a foundation issue plus
siblings that reference it). A focused issue is faster to build, review, and revert; an epic stalls
the whole fleet behind one blocker. Get the user's call on splitting before drafting.

## 3. Check it's buildable — push back if it's too thin

Because `charter` **auto-arms by default**, a created issue goes straight into the build queue. So
before drafting, judge whether the request is concrete enough to produce **testable acceptance
criteria**. If it isn't — "make the dashboard better", "add some tests", "improve performance" —
**push back and get specifics first**:

- What's the observable, checkable outcome? (What would prove it's done?)
- What's in scope vs explicitly out?
- Any constraints, target files/areas, or dependencies?

Do not draft-and-arm an unbuildable issue and hope `shipwright` figures it out. Getting AC
specifics up front is cheaper than a wrong PR. (Draft-only mode — §6 — is the escape hatch when the
user just wants a body to hand-edit, not a build.)

## 4. Draft the structured issue

Write the issue following best practices and this repo's existing style. Use a concise, imperative
title of the form **`ship: capability`** (e.g. `charter: draft a fleet-ready issue and arm it`),
and a body with these sections:

```markdown
## Problem / Goal
<Why this is needed and what "good" looks like — 1–3 sentences.>

## Acceptance criteria
- [ ] <Concrete, testable outcome 1>
- [ ] <Concrete, testable outcome 2>
- [ ] <…each one independently checkable; this is the build contract>

## Scope / non-goals
- In: <what this issue covers>
- Out: <what it explicitly does not — keeps the PR focused>

## Dependencies
- <Other issues/PRs/branches this needs, or "none">

## Notes
- <Context, links, prior art, related issues.>
```

**Acceptance criteria must be concrete and testable** — each a checkbox a reviewer can tick by
observing the result, not a vague aspiration. If you can't phrase a criterion as something
checkable, that's a signal to go back to §3 for specifics.

## 5. Confirm the draft before creating

Filing a public issue is outward-facing, so **always show the full draft and confirm before
creating** — title, every section, the type label you'll apply, and whether it will be armed:

```
## Draft issue
**Title:** <ship: capability>
**Type label:** <enhancement | bug | documentation | …>
**Will arm:** yes (adds `<triggerLabel>`)  |  no (--no-arm: backlog only)  |  draft-only (won't create)

<full body as above>

Create it?
```

Adjust on feedback. Don't create until the user confirms.

## 6. Modes: arm (default), no-arm, draft-only

**Auto-arm is the default — opt-out, not opt-in.** This mirrors the single-gate model: ARMADA-
created work is armed automatically, and the real safety gate lives on the merge step
(`autoMerge`), not on manual arming. Three modes:

- **arm (default)** — create the issue *and* add the `triggerLabel`, so `crows-nest` picks it up
  with no extra step.
- **`--no-arm` / "leave it in the backlog"** — create the issue with its type label but **without**
  the trigger label, so it sits in the backlog until a human arms it.
- **draft-only** ("just show me the body", "don't create it") — print the drafted body and **do not
  call `gh issue create` at all**. Nothing is filed or armed.

If the request failed the buildable bar in §3 and the user hasn't supplied specifics, refuse to
auto-arm — offer draft-only or no-arm instead, never a created-and-armed unbuildable issue.

## 7. Create and arm

Create via `gh` with the appropriate **type label** per repo conventions (`enhancement` for a
feature, `bug` for a defect, etc.). Then, unless overridden, add the `triggerLabel` read from config
**in the same step** so there's no window where the issue exists unarmed:

```bash
# Create with the type label:
gh issue create --title "<ship: capability>" --label "<enhancement|bug|…>" --body "$(cat <<'EOF'
<the confirmed body>
EOF
)"

# Arm it (default) — add the trigger label read from .armada/config.json (default "armada"):
gh issue edit <new-number> --add-label "<triggerLabel>"
```

For `--no-arm`, skip the second command. For draft-only, run neither.

## 8. Report

Print the created issue's number and URL, its labels (type + whether armed), and what happens next:

```
⚓ Chartered issue #<n>: <title>
  type label : <enhancement|bug|…>
  armed      : yes (`<triggerLabel>`) — crows-nest will pick it up   |   no (backlog)
  url        : <issue url>
```

If armed, note that `crows-nest` will claim it on its next tick (no further action needed). If
no-arm, give the one-liner to arm it later: `gh issue edit <n> --add-label <triggerLabel>`.

## 9. Self-improvement mode — file a fleet defect (the recursive loop)

This is the **canonical convention for the whole fleet**: when *any* ARMADA skill hits a defect in
ARMADA *itself*, it routes a fix through `charter` so the fleet improves itself. The other skills
don't re-describe it — they point here. It generalises shipwright's "suggest skill improvements"
reflex (§10) into an automatic, fleet-wide one. It is the literal *Recursive* in ARMADA: the fleet
learning from its own runs.

> **Triage the failure** → if it's an **ARMADA defect**, `charter` a concise defect report **against
> the ARMADA repo**, **de-duped**, labelled **`fleet-defect`**, and **left unarmed by default** →
> note it in the run summary. Best-effort and side-channel — it **never blocks the primary task**.

### 9a. Triage first — is this ARMADA's fault, or the task's?

Only ARMADA's *own* defects get filed here. Distinguish, and when unsure default to **not** filing —
a false defect issue is noise:

- **Target-project / task problem** — the code under work is broken, a test legitimately fails, the
  issue's requirements are wrong. → Handle it normally in the build/review. **Do not** raise an
  ARMADA issue; that would pollute the fleet's tracker with the host project's bugs.
- **ARMADA defect** — a skill's instructions were wrong or missing, a guard didn't fire, the skill
  had to **guess** because guidance was absent, or the same friction keeps recurring across runs. →
  This is what self-improvement mode is for.

### 9b. Target the ARMADA repo — never the host project

File against `armadaRepo` from `.armada/config.json`, or derive it from the plugin source if that
key is absent (§0). A skill running inside someone else's repository **must** file the fix against
ARMADA's home repo with `gh issue create --repo <armadaRepo>`, so a host project's tracker is never
polluted with ARMADA's own defects.

### 9c. De-dupe against open `fleet-defect` issues

Before filing, search the ARMADA repo's open defects so the same gap isn't filed twice:

```bash
gh issue list --repo <armadaRepo> --state open --label "fleet-defect" --search "<keywords>"
```

If the defect is already filed, **add a comment or a 👍 reaction** to the existing issue (another
occurrence is signal it matters) rather than opening a duplicate.

### 9d. Draft the defect report

Use the §4 best-practice body, framed as a defect: what the skill was doing, **what went wrong**,
**why it's an ARMADA (not project) problem**, and a **suggested fix**, with concrete testable
acceptance criteria. Title it `<skill>: <the defect>` (e.g. `shipwright: base-branch guard didn't
fire on a feature-only file`).

### 9e. File it — labelled `fleet-defect`, unarmed by default (recursion risk)

Self-raised fixes modify ARMADA's *own* skills. With auto-arming + `autoMerge` on, that becomes a
**self-modifying loop that could rewrite and merge its own skills unattended** — the dream and the
hazard. Default to the safe side:

```bash
# Filed and labelled, but NOT armed — left for human triage (default):
gh issue create --repo <armadaRepo> --label "fleet-defect" --title "<skill>: <defect>" --body "<report>"
```

- Self-raised issues are labelled **`fleet-defect`** and are **not** auto-armed — even though
  `charter` auto-arms human-authored issues (§6). They sit for human triage.
- Only when **`autoArmSelfFixes: true`** in config does `charter` also add the `triggerLabel`,
  opting into the fleet fixing itself end-to-end. Leave it `false` unless the operator has chosen
  full autonomy knowingly.

### 9f. Never derail the primary task

Raising the issue is **best-effort and side-channel**. If the `gh` call fails or the repo can't be
resolved, **note it and carry on** — never block, fail, or retry-loop the build/review on a
self-improvement filing. Surface what was filed (or that filing was skipped) in the run summary
only:

```
🛠 fleet-defect filed: ARMADA#<n> "<skill>: <defect>" (fleet-defect, unarmed — human triage)
   — or — 🛠 fleet-defect: deduped onto existing ARMADA#<n>
   — or — 🛠 fleet-defect: skipped (filing failed: <reason>); primary task unaffected
```

## Best-practice guardrails (summary)

- **One issue = one focused capability** — offer a linked stack for epics (§2).
- **Acceptance criteria must be concrete and testable** — they're the build contract (§4).
- **Quality bar before auto-arming** — refuse to arm an unbuildable issue; get AC specifics first
  (§3).
- **De-dupe first** — search open issues so you don't file a twin (§1).
- **Opt-out, not opt-in** — auto-arm is default; support `--no-arm` and draft-only (§6).
- **Confirm before creating** — filing is outward-facing (§5).
- **Self-raised fixes are unarmed by default** — `fleet-defect` issues go to the ARMADA repo for
  human triage unless `autoArmSelfFixes` is on; the recursion risk is deliberate (§9).

## Inputs

- A free-text description of the desired work.
- Optional: `--no-arm` (create into the backlog, don't add the trigger label) or a draft-only
  request (show the body, don't create).
- A **fleet-defect report** from another skill (self-improvement mode, §9) — filed against the
  ARMADA repo, labelled `fleet-defect`, unarmed unless `autoArmSelfFixes` is true.

## Output

- **arm (default):** a well-formed GitHub issue, created with a type label and the `triggerLabel`,
  ready for `crows-nest` to pick up.
- **`--no-arm`:** the same issue created with its type label only, sitting in the backlog.
- **draft-only:** the drafted issue body printed, nothing created or armed.
- **self-improvement (§9):** a de-duped `fleet-defect` issue filed against the ARMADA repo (unarmed
  unless `autoArmSelfFixes`), surfaced in the run summary — never blocking the primary task.
