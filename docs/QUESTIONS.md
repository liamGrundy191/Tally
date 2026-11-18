# Questions for Liam

Claude Code adds a question here whenever `docs/PLAN.md` does not answer something. Liam answers in place; the decision then moves to `docs/DECISIONS.md`.

Format:

```
## Q<number> · <task ID> · <short title> · open | answered
Context: what is unclear and why it matters.
Options: A) ... B) ...
Recommendation: ...
Answer (Liam): ...
```

---

## Q1 · T0.1 · API test runner: Jest or Vitest · open

Context: The plan says the API uses "Jest (NestJS default)". The current NestJS (version 12) now ships only as modern ES modules, and its default test runner for new projects is Vitest. Jest cannot load NestJS 12 on Node 22 (it needs Node 24.9 or later).

Options: A) NestJS 12 with Vitest, the same test tool as the rest of the repo. B) The older NestJS 11 with Jest, exactly as the plan says. C) NestJS 12 with Jest, which needs Node 24.9 or later everywhere.

Recommendation: A. It follows the reason the plan gave (use the NestJS default), keeps one test tool for the whole repo, and adds no libraries. A test confirms that NestJS dependency injection works under Vitest.

Answer (Liam):
