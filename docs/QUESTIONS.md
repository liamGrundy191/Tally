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

## Q6 · T2.3 · What Enter does on the review screen · answered

Context: Section 9 says **Confirm and next** is Enter, and Tab moves between flagged fields. If Enter saves at once, a reviewer who presses Enter in the first flagged box saves before looking at the others; the server then only re-runs the checks.

Options: A) Enter saves at once, from any box. B) "Walk, then save": Enter in a flagged box moves to the next flagged box not yet visited, and saves only once every flagged box has been visited (focusing a box counts as visiting it). With nothing flagged, Enter saves.

Recommendation: A, the fastest; the checks run again on every save.

Answer (Liam): B (2026-11-22).

## Q7 · T2.3 · One-click name buttons (D28) · answered

Context: D28 left "one-click name buttons in the review screen" as a maybe, to decide with the review screen. Section 5.2 already asks the name box to offer the names used at that workplace this month first, then the names list.

Options: A) A type-ahead list only: names used at this workplace this month first, then the names list. B) Buttons for the likely names as well.

Recommendation: A; the list already gives the same names in the same order, one key press away.

Answer (Liam): A (2026-11-22): the buttons are decided against, not left for later.

## Q8 · T2.4 · Where the lists are edited · answered

Context: Section 9 puts "the lists" on the month page, but the lists are shared by every month (D42), so a page of their own (/lists, with a menu link) would also fit.

Options: A) A page of their own, linked from the month page and the Workplaces page. B) A "Lists that help reading" section on each month page, the same two lists on every month.

Recommendation: B, as section 9 says; no new page. (The first plan suggested A; the critique pointed out that section 9 places the lists on the month page.)

Answer (Liam): B (2026-11-22), as section 9 says; no /lists page or menu link. The Workplaces page links to the month page's section; while no month exists yet, it shows the lists itself (D52).

## Q9 · T2.4 · Asking before "same place" · answered

Context: "Same place" merges two workplaces for every ticket of both and adds a spelling to the workplace list. It cannot be undone (nothing is built to split a workplace again). "Different place" changes nothing on the tickets.

Options: A) Three buttons, none chosen or focused, and a line saying it cannot be undone. B) The same, and "Same place" also asks "Are you sure?" first, with the focus on Cancel.

Recommendation: B: a slip would join two workplaces' sheets for good. (The first plan suggested A, since nothing is deleted.)

Answer (Liam): B (2026-11-22). "Different place" stays one click.

## Q10 · T2.5 · A list of pending invites · answered

Context: An invite link is shown once, when it is made. The API gives no list of invites waiting to be used, and section 8 asks for none. Without one, an admin cannot see who was invited but has not set a password yet.

Options: A) No list: inviting the same email again gives a new link, and the old one stops working. B) A list of pending invites (a new `GET /api/users/invites`), with their emails and expiry dates.

Recommendation: A; section 8 does not ask for it, and invited emails are kept only briefly (D44).

Answer (Liam): A (2026-11-22), no list.

## Q11 · T3.1 · The words in the Excel file · answered

Context: Section 6.2 fixes `עובד` and `סה"כ`, but not the other headings: the totals sheet's columns, the heading of each workplace sheet's total column, the removed sheet's columns, and the reason a ticket was removed. The agency's own file is in Hebrew.

Options: A) Hebrew, like the agency's file: `מקום עבודה` / `שעות`; `סה"כ`; `מקום עבודה | עובד | תאריך | שעות | סיבה | הוסר על ידי`; reasons `הוסר`, `הוחלף בכרטיס חדש`, `נסרק פעמיים`. B) English.

Recommendation: A. Worker names stay in English letters (5.2).

Answer (Liam): A (2026-11-23).

## Q12 · T3.1 · Rows and sheets that become empty · answered

Context: Section 6.2 says the layout only ever grows. But if every ticket of a worker at a place is removed, or two places are merged as "same place", that row or sheet has no hours left.

Options: A) Drop it: each download shows exactly the current tickets. B) Keep it, empty, in later downloads.

Recommendation: A. An empty row tells the owner nothing, and hours change only through tickets (6.1).

Answer (Liam): A (2026-11-23).

## Q13 · T3.2 · How each workplace PDF is named · answered

Context: Each workplace gets one PDF of its tickets, which the agency sends to that workplace by email or WhatsApp. Section 6.3 says only "the workplace's name and the month". The ZIP that holds them all is only seen by the agency.

Options: A) The Hebrew month: `חוות גולן נובמבר 2026.pdf`. B) The month as a number: `חוות גולן 2026-11.pdf`, like the Excel's `hours-2026-11.xlsx`.

Recommendation: A. The workplace reads the name, and the Hebrew month is clearer to it.

Answer (Liam): A (2026-11-24). The ZIP is `tickets-2026-11.zip`.

## Q14 · T3.3 · Tickets that still need review when a month is closed · answered

Context: Tickets still waiting for review are in neither the final Excel nor the workplace PDFs, and closing deletes them, so their hours would be lost without a trace.

Options: A) Closing is refused until every ticket of the month is ready or removed (removed ones are listed on the Excel's "removed" sheet). B) Closing is allowed, with a warning that says how many will be deleted.

Recommendation: A, so no hours can vanish without a trace; removing a ticket is one click.

Answer (Liam): A (2026-11-24).

## Q15 · T3.3 · Downloads at close · answered

Context: The plan allows closing after at least one download of each file. A file downloaded before later changes still counts, so hours changed since could be deleted without being in any file the user keeps.

Options: A) The server refuses unless the downloads are newer than the month's last change. B) The Close window downloads both files when Close is pressed, with a checkbox ticked by default. C) Any earlier download counts.

Recommendation: A.

Answer (Liam): B (2026-11-24), his own idea: a checkbox, ticked by default, "Download the final Excel and workplace PDFs now". The server keeps the plan's rule of at least one download of each.

## Q16 · T3.3 · A history entry for closing · answered

Context: Section 8 says every change writes an audit entry. After the purge, a "month closed" entry would be the only row about the month outside its summary, which already records who closed it and when.

Options: A) No entry: the summary is enough. B) A history entry as well.

Recommendation: A.

Answer (Liam): A (2026-11-24), "the summary is enough". He was unsure an audit log is needed at all and went with the recommendation. This bends section 8 on purpose.
