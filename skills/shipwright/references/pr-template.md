# PR Summary Template

Use this for the PR body. Adapt sections as needed — omit sections that don't apply.

```markdown
## Summary

<2-3 sentences: what this PR does and why>

Closes #<issue-number>

## What changed

| File | Change |
|------|--------|
| `path/to/file` | <brief description> |

## Decisions

<Architectural / design choices made during implementation and the reasoning.
Reference existing decision records where applicable; note if a new one is warranted.>

- **Decision:** <what was decided>
  - **Why:** <rationale>
  - **Alternatives considered:** <what else, and why rejected>

## Acceptance criteria

- [x] Criterion 1 — <how it was met>
- [ ] Criterion 2 — <why not met / deferred>

## Testing

- [ ] Unit tests added/updated
- [ ] Integration tests added/updated
- [ ] Manual testing performed
- [ ] Build passes
- [ ] Tests pass
- [ ] Lint / format clean

<Describe specific test scenarios covered. Note any pre-existing failures on the
base branch so reviewers don't attribute them to this PR.>

## Bug repro evidence

<For bug-type issues only — omit for features. Show the reported symptom reproduced on the
unpatched code, then the same method confirming it's gone after the fix.>

- **Symptom (pinned):** <the exact observable — e.g. console warning text, failing assertion, wrong render>
- **Repro method:** <how it was reproduced — e.g. run app + Playwright steps, failing regression test, scripted call>
- **Before (unpatched):** <evidence the symptom reproduced — warning/log/screenshot, or "regression test X failed">
- **After (patched):** <same method now clean — clean console/screenshot, or "regression test X passes">

<If the symptom could not be reproduced, state that explicitly here — what was tried and what
else would be needed — instead of asserting a verified fix.>

## Screenshots

<If UI changes were made, include before/after screenshots>

## Follow-up items

<Deferred work, tech debt, or items for future PRs>

---
🤖 Generated with [Claude Code](https://claude.com/claude-code)
```
