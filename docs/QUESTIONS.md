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

## Q1 · T0.1 · API test runner: Jest or Vitest · answered

Context: The plan says the API uses "Jest (NestJS default)". The current NestJS (version 12) now ships only as modern ES modules, and its default test runner for new projects is Vitest. Jest cannot load NestJS 12 on Node 22 (it needs Node 24.9 or later).

Options: A) NestJS 12 with Vitest, the same test tool as the rest of the repo. B) The older NestJS 11 with Jest, exactly as the plan says. C) NestJS 12 with Jest, which needs Node 24.9 or later everywhere.

Recommendation: A. It follows the reason the plan gave (use the NestJS default), keeps one test tool for the whole repo, and adds no libraries. A test confirms that NestJS dependency injection works under Vitest.

Answer (Liam): A

## Q2 · T3.1 · The agency's Excel layout · answered (later replaced by D39)

Context: The agency's real Excel is a grid, not a list of tickets: one row per worker, one column per day of the month (1–31), hours as decimals (8.25), a total for each worker and for each day, names in English letters. The plan (principle 3) never combines tickets into one worker, because a ticket only has a first name: two different workers with the same name at one place would end up in one row. It does not affect the big test (H0), which measures reading.

Questions:

1. One grid per workplace, or one for everyone?
2. Two workers with the same first name at one place: how does the agency tell them apart in the grid today?
3. A name written in Hebrew on the ticket: which English spelling goes in the grid? (A names list with `Hebrew = English` lines would answer it.)
4. 8:20 is 8.333… hours. How is it written today (8.33)? The plan forbids rounding, so this needs a rule.

Options: A) Keep the plan's layout (one row per ticket). B) Add the grid as well, built from confirmed tickets, with rules from the answers above. C) Only the grid.

Recommendation: decide when building the Excel export (T3.1), after the answers. Pay rates (for example *57 in a name) are left out, as Liam asked.

Answer (Liam): (2026-11-20)

1. One grid for each workplace with its workers, plus one totals grid that shows only the workplaces and their totals.
2. Today they do it by hand. Never merging stays: the system gives them a filled-in Excel, and at most they copy and paste some totals between rows themselves.
3. Today every name in the final Excel is in English letters, spelled by ear, which is why spellings differ. The system should do the same.
4. 8.33: two decimals is fine. "No rounding" was about minutes, which stay whole.

Follow-up for T3.1: which tickets share a row in a workplace grid (see Q3).

## Q3 · T3.1 · Which tickets share a row in the workplace grid · answered, then replaced by D39

Context: A grid row holds one worker's days. Putting two tickets in one row is the merge the plan forbids if the system decides it alone. Liam's rule: never merge; the agency may copy totals by hand.

Options: A) One row per name exactly as confirmed (after the English spelling): the same name on two tickets shares a row, a different spelling gets its own row. Two tickets with the same name on the same day are never added together: the second gets its own row and a flag. B) One row per ticket: nothing is ever combined, but a worker with 20 shifts has 20 rows.

Recommendation: A, with the shared rows listed on the review screen before export, so a person sees every pair the grid combines. Hebrew names get their English spelling from a names list with `Hebrew = English` lines; a name not on it gets a suggested spelling that a person confirms. Each cell keeps the exact hours (500 minutes / 60) and only shows two decimals, so the totals stay exact.

Answer (Liam): B for now (2026-11-20): every ticket gets its own row; it can change later if needed. Hebrew names: Claude's recommendation (a `Hebrew = English` names list, and a suggested spelling a person confirms for a name not on it).

## Q4 · T2.2 · The price on the upload screen · answered

Context: Section 9 and D26 ask for the estimated price before reading starts. Only batch mode was measured (14.5 cents a ticket, D38); the price of reading straight away is an inference.

Options: A) Show an estimate per ticket beside each speed, and a running "N tickets, about $X" for what was uploaded. B) Leave the price out until real costs are known.

Recommendation: A, labelled as estimates, with the numbers kept in one place so they are easy to correct.

Answer (Liam): A (2026-11-21): "about 15 cents a ticket" for Batch (measured, D38) and "about 30 cents a ticket, not yet measured" for Now, plus the running total.

## Q5 · T2.2 · Remove and search on the month page · answered

Context: Section 9 lists search and **Remove** on the month page, but the T2.2 task text does not, and the month summary's tickets carry no `version`, which removing needs.

Options: A) Leave them to T2.3, with the review screen. B) Add the version to the summary and build Remove with a confirmation now.

Recommendation: A, so T2.2 stays the size the task describes.

Answer (Liam): A (2026-11-21): deferred to T2.3.
