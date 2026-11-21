# Decisions

Decisions made after `docs/PLAN.md` was written, newest last. Each says what was decided, why, and where it came from.

**Risky decisions** bend a core rule on purpose. They are marked ⚠ RISKY and must be re-checked against real results before go-live: D30.

---

## D1 · T0.1 · API tests use Vitest, not Jest (Liam chose option A in Q1)

NestJS 12 is ES-modules only and uses Vitest as its default test runner; Jest cannot load it on Node 22. The plan chose Jest because it was the NestJS default, so the API follows the new default. The whole repo now uses Vitest.

## D2 · T0.1 · TypeScript 6, not 7

TypeScript 7 is out, but the ESLint TypeScript plugin does not support it yet. All packages are pinned to TypeScript 6.0.3. Move to 7 when typescript-eslint supports it.

## D3 · T0.1 · Docs moved into `docs/`

`PLAN.md` and `QUESTIONS.md` were in the repo root; they now live in `docs/`, where `CLAUDE.md` and the plan expect them.

## D4 · T0.2 · Field map coordinates are fractions of the marker frame

The plan says field positions are "fractions of the slip's width and height, measured from the top-left corner marker". `v1.ts` takes this literally: (0, 0) is the centre of the top-left marker and (1, 1) the centre of the bottom-right marker. Marker centres are what the image step finds on a scan, so crops come straight from the four found points, whatever the scan's size or skew.

## D5 · T0.2 · Slip layout: three per A4 page, no printed rules (Liam)

Liam found the A5 slip too large. Each slip is now a third of an A4 portrait page (210 × 99 mm), with dashed cut lines between them. The printed rules ("Black pen only", "No overwriting…", "Date = the day the shift started") are removed to save space; Liam judged they add little. Boxes stay 8.5 × 10 mm, so writing space is unchanged. Labels sit to the right of the boxes (Hebrew reading order); the start, end and total times share one row with labels above. Corner markers are 8 mm squares, 6 mm in from the slip edge to stay clear of printer margins. The `v1` mark sits beside the bottom-left marker.

## D6 · T0.2 · Fonts: Noto Sans Hebrew for Hebrew, Helvetica for English and digits

Noto Sans Hebrew (SIL Open Font License, file and licence in `packages/shared/assets/fonts/`) has only Hebrew letters, space, hyphen and geresh/gershayim. English labels, digits, ':' and '/' use the PDF's built-in Helvetica. A test checks every printed Hebrew character has a glyph.

## D7 · T0.2 · `pnpm ticket:pdf` runs TypeScript with Node's built-in type stripping

No extra tool (such as tsx) is added. `packages/shared` imports its own files with `.ts` extensions so Node can run them directly.

## D8 · T0.2 · poppler (`pdftoppm`) is a required tool for tests

CI installs `poppler-utils`. On Windows: `winget install oschwartz10612.Poppler`, then add its `Library\bin` folder to PATH. The Docker image will install it in Phase 4, as the plan says.

## D9 · Ticket · No last name on the ticket (owner)

The owner decided the last name is not needed. The ticket has one name field, first name (12 boxes); the rows below it moved up. The worker column in the export shows the first name, and `POSSIBLE_DUPLICATE` compares first names. Two different workers with the same first name at the same place and overlapping hours will now always be asked about ("Keep both"), since there is no surname to tell them apart.

## D10 · T0.3 · Two new flags: FIELD_EMPTY and TIME_INVALID (Liam)

A blank box gets "The end time is empty" rather than "Could not read". A time that cannot exist (25:00, 08:75, "8.5" written as decimal hours, "8" with no minutes) gets `TIME_INVALID`. A name or workplace of only punctuation ("-") counts as empty. A field already flagged unreadable or disputed is not flagged empty as well.

## D11 · T0.3 · Duplicates: same date only; names match in any order or with an extra word (Liam)

Liam chose same date only: a night shift entered twice with two different dates is not caught. Consecutive night shifts never overlap, so they are never flagged either way. Names match if they have the same words in any order ("דוד כהן" / "כהן דוד", Liam: yes), or if every word of one appears in the other ("דוד" / "דוד כהן", since the ticket has one name field). Back-to-back shifts (16:00 end, 16:00 start) do not overlap. If either ticket's times are unknown, it is asked about.

## D12 · T0.3 · Names: Hebrew and English are both fine (Liam)

Changes plan 4.1: an English name is no longer flagged. `SCRIPT_UNEXPECTED` is raised for anything else in a name: digits, other alphabets (Arabic, Russian), symbols, or Hebrew and English mixed in one name. Workplaces are not checked, since brand names may contain anything.

## D13 · T0.3 · How times are read

`HH:MM`, `H:MM`, `HHMM`, `HMM` and `HH.MM` are accepted; minutes must be two digits, so "8.5" and "8" are flagged, not guessed. "24:00" is accepted as an end time and means midnight (stored as 0); as a start time it is flagged. The two readings are compared by meaning: "8:30" and "08:30" agree.

## D14 · T0.3 · Dates are DD/MM/YY, checked in Israel time

Dates are day first, as printed on the ticket. Separators `/ . -` or none are accepted, and four-digit years from 1900 to 2099. "Today" for the future and too-old checks is the date in Asia/Jerusalem, not the server's clock (a server in UTC would think 01:00 in Israel is still yesterday). A date written month-first is caught only when it is impossible (11/18) or out of range; 05/11 versus 11/05 cannot be told apart by rules.

## D15 · T0.3 · Hours range uses start and end when the total is missing

`HOURS_OUT_OF_RANGE` checks the written total. If the total is missing, it checks end − start instead, so a 23-hour shift is still flagged. The missing total itself is flagged and is never filled in from start and end.

## D16 · T0.3 · What rules cannot catch (known limits)

Both readings agreeing on the same wrong value is caught only when it breaks a rule: a misread time usually breaks end − start = total, but a misread name, workplace or a date still inside the 45-day window does not. `REVIEW_EVERYTHING=true` covers this until real use shows otherwise; the Phase 0 runner measures it. On the night clocks change, the arithmetic uses clock time, so a leader who writes the real hours worked gets `TIME_MATH_MISMATCH` and a person confirms.

## D17 · T0.3 · Shifts under 2 hours are flagged (Liam)

Liam asked for short shifts to be flagged. `HOURS_OUT_OF_RANGE` now covers totals under `MIN_SHIFT_HOURS` (default 2) as well as 0 and totals over `MAX_SHIFT_HOURS`. Exactly 2:00 is not flagged. A very short total is more often a misreading (0:30 for 08:30) than a real shift.

## D18 · Ticket · Four slips per A4 page (Liam)

Removing the last name freed space, so Liam asked for four slips per page if they fit. Each slip is now a quarter of an A4 page (210 × 74.25 mm). To keep every box inside the corner-marker frame, boxes are 8.5 × 9 mm (were 10 mm tall) and the rows sit closer together. This replaces the slip size in D5.

## D19 · T0.4 · The reader lives in the shared package, server-side only

`TicketExtractor`, `AnthropicExtractor` and `FakeExtractor` are in `packages/shared/src/extraction`, imported as `@tally/shared/extraction`, so the Phase 0 runner and the worker use the same code. It is not exported from the main entry point, because it reads prompt files from disk and must never end up in the web app. Prompts are in `packages/shared/prompts/v1/`; a prompt change means a new `v2` folder, never an edit to `v1`, so every stored reading can be traced to the exact prompt that produced it.

## D20 · T0.4 · Model and answer format

- **Model:** `EXTRACTOR_MODEL` defaults to `claude-opus-5-5` (Anthropic's current default model) at effort `medium`. T0.6 measures accuracy and cost per ticket; a cheaper model is Liam's decision after that.
- **Answer format:** the model is held to the same schema the rules use, so a reply in any other shape is impossible or rejected.
- **What counts as a failed attempt:** an answer that does not validate, is cut off, or is a refusal. API errors (rate limits, outages) are passed on unchanged for the caller to retry.
- **The real model is recorded:** each reading records the model that actually answered.

## D21 · T0.4 · No automatic fallback to another model on a refusal

Anthropic recommends letting a declined request fall back to another model automatically. Here, a refused ticket is a failed attempt, and after retries it goes to a person (`EXTRACTION_ERROR`). This keeps one reader for every ticket and adds no beta feature. A refusal on a shift ticket should be very rare; T0.6 will show if it happens.

## D22 · T0.4 · `pnpm extract <image>` for one real reading

Shrinks the image (phone rotation applied, greyscale, longest side 2000 px), runs both passes on the whole ticket, and prints both readings, the flags and the cost. It does not straighten or crop yet (T0.5). It reads the API key from a local `.env`, which is never committed. TypeScript's `erasableSyntaxOnly` is on in `packages/shared` and `tools/poc`, so code stays runnable by Node directly.

## D23 · T0.5 · How a scan is prepared

- **Finding the markers.** The four corner markers are found as the largest solid dark squares that together form a rectangle with the ticket's proportions. Small print can never stand in for a missing marker, and the ticket must fill at least a quarter of the picture.
- **Upside-down and sideways scans.** The markers are symmetric, so these are told apart by the printed labels, which sit on the ticket's right-hand side.
- **Straightening.** A full perspective correction, so tilted and angled phone photos work.
- **What the AI receives.** The straightened ticket at 10 px/mm for pass A, and each field cut out at 12 px/mm with a 1.5 mm margin for pass B. Both are taken from the full-resolution image (up to 4000 px), not the 2000 px normalised copy, and are contrast-stretched to help dim photos.
- **Quality limits.** `IMAGE_DARK` below mean brightness 120; `IMAGE_BLURRY` below sharpness 50 (variance of the Laplacian, measured after the contrast stretch so lighting does not affect it). These are first values from four phone scans and blurred or darkened copies; they are retuned on the Phase 0 set.
- **Without markers.** When no markers are found, the whole normalised page is read and the ticket is flagged `MARKERS_NOT_FOUND`.
- **Commands.** `pnpm crops <scan>` saves the straightened ticket and crops to `scan-output/` (not committed) for checking by eye. `pnpm extract` now uses the same preparation and accepts multi-page PDFs.
- **Result on Liam's four tickets.** Every ticket was straightened correctly, but reading was about the same as before. The strict "any doubt means unreadable" instruction, not image quality, is what blocks cursive names and workplaces. That led to D24 and D25.

## D24 · Prompts v2 · Best-guess suggestions for unclear fields (Liam)

Changes plan principle 2. The extractor still returns `legible: false` whenever any character is uncertain, but it now also gives its best reading of the whole field as `suggestion`. A suggestion is never used as a value: the field stays flagged, and the reviewer sees the guess pre-filled and confirms or corrects it. When both readings suggest the same thing, that is the suggestion; when they differ, there is no suggestion and the reviewer sees both. Reason: on Liam's test tickets the AI marked every cursive name unreadable, which would mean a person typing almost every name.

## D25 · Prompts v2 · The agency's workplace list (Liam, with the agency owner)

- **The list.** The extractor receives the agency's workplaces and must name one entry exactly as `workplaceMatch`, or null. The answer format only allows list entries, so it cannot invent one.
- **When the workplace is accepted.** Both readings name the same entry, and every reading of the handwriting (value or suggestion) resembles it: at most max(2, 30% of the entry's length) letters different after name normalisation. The workplace is then set to the list entry, with no workplace reading flag. A crossed-out or overwritten workplace stays flagged.
- **When it is flagged.** Different entries; only one reading matching; no readable handwriting to compare; or handwriting that does not resemble the entry, so an entry is never forced onto the writing.
- **Two similar entries.** If the handwriting also resembles a second entry (for example בית נוי and בית נוף), the workplace is not accepted even when both readings agree: `MATCH_AMBIGUOUS` asks a person, with the matched entry suggested. Liam found this gap: two readings can make the same mistake.
- **Not on the list.** When neither reading matches any entry, `WORKPLACE_NOT_ON_LIST` asks whether it is a new workplace.
- **Where the list lives.** For now, `workplaces.txt` (one per line, kept off GitHub as it lists the agency's clients); later, an "upload Excel" screen in the app. No nicknames per entry yet.
- **Names.** See D28.
- **Versioning.** Prompts are now `v2`. The `v1` files are kept for the record but no longer match the answer format.

## D26 · Planning · The user chooses speed and reading quality, and sees the price (Liam)

- **Speed.** _Now_: tickets are read straight away. _Batch_: Anthropic's batch service, about half the price, with results usually within an hour and at most 24 hours. Tickets are reviewed later anyway, so batch suits most uploads.
- **Reading quality.** _Best_ uses the strongest model; _Standard_ uses a cheaper one. Each option says in plain words how it affects reading ("Standard: cheaper, more tickets may need a person"). Which model sits behind each option, and the per-ticket prices, are set from Phase 0 measurements, not assumed.
- **Price.** Before reading starts, the upload screen shows the estimated cost ("about $6 for 150 tickets"), from the measured average cost per ticket for the chosen options. The spending caps still apply.
- **Measured so far.** The strongest model, read immediately, costs about 8 cents per ticket on Liam's four test tickets.

## D27 · Planning · A third read for unclear fields (Liam)

When either reading is unsure of a field, or the two disagree, a third independent read (pass C) reads those fields only. It can only improve the guess the reviewer sees. It never accepts a value or clears a flag, because one reading can be confidently wrong (Liam's tickets showed this twice) and two out of three agreeing is weaker than two out of two. It adds cost only on unclear tickets.

## D28 · Planning · Known names, from last month's export and from the same batch (Liam)

Names were the weakest field on Liam's tickets. The name decides who gets paid, so a wrong name must never slip through, but a flagged name only costs the reviewer a few seconds.

- **An uploaded names list, not a register.** The user uploads a list of first names (for now `names.txt`, later an Excel upload). Names are matched exactly like workplaces (D25): both passes must name the same entry, the writing must resemble it, and it must resemble no other entry. Many names have look-alikes (דנה / דינה), so those still go to a person, with the guess filled in. A name missing from the list is normal (workers change every month or two) and is not flagged.
- **Nothing is kept between jobs.** Saving names automatically was considered and rejected: too much for too little. Instead the export has a `שמות` sheet with each confirmed name once, and the user uploads it next time. The list lives in the user's own files.
- **Names from the same batch.** One worker usually has several tickets in an upload. After the whole upload is read, names that raised no flag form a temporary list. An unclear name that resembles one of them is read again with those names on the list. Only names that came out of a clean reading are used, so one misread cannot spread to other tickets. The temporary list goes with the job.
- **Rejected or deferred.** A general list of common Israeli names (the workers' names are mostly not common ones, and a big list has look-alikes everywhere). Printing "block letters" on the ticket (not realistic for the shift leaders). One-click name buttons in the review screen (a maybe, to decide with the review screen).
- **Known limit.** Two workers really called the same name cannot be told apart by the name. The agency already handles this today.

## D29 · Planning · Read 2 sees the whole ticket as well as the boxes; look-alike tests (Liam)

- **Read 2.** It used to see only the cut-out boxes. On its own, a cut-out of the cursive name מוסא was read as the English "KOIN": cursive א, ס, ו, מ look like K, O, I, N, and reading them left to right reverses the word. Read 2 now gets the whole ticket for context, then each box enlarged. Its different wording keeps it independent from read 1. All prompts now warn that cursive Hebrew can look like Latin letters.
- **Look-alikes.** For names, only entries one letter apart count as look-alikes (two for names of 8 letters or more); two letters apart blocked clearly different short names such as הבן and הדס. Workplaces keep the stricter test, at Liam's request, because the list is short and two-letter pairs exist on it.

## D30 · ⚠ RISKY · An unclear total can be accepted when the times confirm it (Liam)

**The rule it bends:** "a guess is never a value" (plan principle 2, D24). This is the only exception.

**The rule.** The total worked is accepted without a person only when all of these hold: start and end were both read with certainty by both passes and raised no flag; the total's only flag is "unreadable" (not a disagreement, not corrected, ticket not crossed out); and both passes offer a total equal to end minus start. The ticket records `totalFromMath`, so the reviewer and the audit can see the total came from this rule.

**Why it is acceptable.** The total is the one field that can be checked against two others. Two independent guesses that agree with two certain times are stronger evidence than many accepted readings.

**What could go wrong.** If a shift leader wrote a wrong total, and both readings misread it as exactly the "right" one, the wrong total would be silently corrected to match the times. Hours would then follow the times, not what was written. This is unlikely but possible.

**Re-check before go-live.** In the Phase 0 set, count how often this rule fires and whether any total it accepted differs from the truth. If any does, remove the rule.

## D31 · T0.6 · How the Phase 0 runner grades

- **The dangerous case** is a wrong value with no flag on its own box. A flag on the whole ticket (blurry scan, missing markers) does not count, because a reviewer cannot be expected to recheck every box of a blurry ticket. The one exception is the times: "the times do not add up" or "hours out of range" sends the reviewer to start, end and total together, so it covers all three.
- **A missed crossed-out ticket** counts against the G0 gate, like a wrong date or time, because its hours would be paid.
- **What the reviewer finds filled in** is the guess, or the value when no reading was in doubt (for example a corrected box). A box where the two readings disagreed, and no guess is agreed, counts as "no guess", even though one reading's value is kept.
- **A failed reading** counts as "no guess" in all six boxes, because a person types the whole ticket.
- **Comparison is by meaning**, using the same rules the system uses: 8:30 is 08:30, 10/11/2026 is 10/11/26, and names and workplaces are normalised.
- **A misspelt workplace given its list name is right** (found on Liam's first real run: written "בית הורדם", accepted as the list's "בית הורדים"). It counts as right only when the writing resembles that entry and no other one; turning a misspelling into the proper name is what the list is for.
- **The whole folder is one batch** for the "names from the same batch" step (D28), like one upload.
- **Spending.** Without `--yes` the runner only checks the files and shows the estimated cost. With it, the runner stops starting new tickets at 1.5 times the estimate.
- **Excel.** The truth file must be saved as "CSV UTF-8"; anything else is refused instead of garbling Hebrew. Seconds that Excel adds to times (08:30:00) are dropped. Output files start with the UTF-8 marker Excel needs, and text that looks like a formula is escaped.

## D32 · Ticket · Narrower slip, smaller markers, 15 workplace boxes (Liam)

Liam looked at the printed ticket and asked for these changes:

- **Narrower slip.** Three quarters of A4's width (157.5 × 74.25 mm), still four per page, against the left edge; the 52 mm strip on the right is cut off. This replaces the slip size in D18.
- **6 mm markers** (were 8 mm), about 44% less black ink. Not smaller: the marker search ignores any mark under a third of the largest dark mark, and a fully inked character box (8 × 9 mm) must not push the markers out. 5 mm would need a change to the search.
- **15 workplace boxes** (were 18). To fit, character boxes are 8 mm wide (were 8.5 mm); height stays 9 mm.
- **Less padding.** Labels sit right beside the boxes instead of in a wide margin; the example strip is centred at the top; the three time groups are 6 mm apart (were about 12 mm).
- **Boxes keep 2 mm clear of the markers.** Found while testing: the scan's contrast stretch darkens the pale box lines, and a box 0.25 mm from a marker merged with it, so the marker was not found on tilted scans. A test now checks the clearance. The orientation check reads the new label column.
- **Still `v1`.** Only test tickets have been printed; old printouts no longer match and should be thrown away.

## D33 · Ticket · Two scan problems found while checking D32

Liam asked for the new ticket (D32) to be checked. All tests passed, but the tests only used empty tickets, so filled-in and corrected tickets were simulated too.

- **Filled-in tickets came out upside down.** The way up was decided by comparing the printed labels with the opposite side of the ticket. Dense handwriting there outweighed the labels, so every simulated filled ticket was turned 180°, with no warning. The cut-out boxes would then have shown the wrong fields. The way up now comes from the printed example strip (דנה, 08:30): turned 180° it would sit below the time boxes, where nothing is ever written. A test with heavy writing at four angles guards it.
- **A scribbled-out correction hid the markers.** Blacking out two boxes makes a solid patch four times a 6 mm marker's area, and the marker search ignored marks under a third of the largest. It now tries again without the one or two largest patches. The four markers must still match each other in size, so a scribble can never stand in for one. One covered marker is still flagged.
- **Old printouts are refused.** Scans of the previous layout raise `MARKERS_NOT_FOUND` instead of being cut up wrongly.

## D34 · Phase 0 · A realistic big test, read in batch mode (Liam)

- **Tickets are checked by a person when they are collected.** The product is not meant to accept anything a user uploads. So the big test (H0) uses realistic tickets: no fully crossed-out tickets, and everything scanned, no phone photos. The system still flags crossed-out tickets and still accepts photos, as a safety net, but they are not tested on purpose. Testing and checking stay as careful as before.
- **Names list.** For the big test, Liam brings the first names of the last six months' workers. Workers missing from it are normal and are not flagged.
- **Batch mode in the runner.** `pnpm poc --batch` sends each round of readings (passes A and B for every ticket, then pass C, then the second look at names) as one request to Anthropic's batch service, at half the price. Each round usually takes under an hour. The same prompts, answer format and checks are used, so results should match immediate mode. Stopping the program cancels a running batch. Built ahead of the user-facing speed choice in D26.

## D35 · Phase 0 · Opus at high effort; Sonnet and max effort rejected (Liam)

Measured on Liam's 12 real tickets in batch mode, then on the two hardest of them:

- **Sonnet 5.5 rejected.** It was as safe as Opus (nothing wrong accepted) but marked almost every box unsure: 66 of 72 boxes went to a person, against 25 with Opus. It also guessed names from the names list that were wrong. It costs a third as much, but the extra checking would cost far more than it saves. It is not offered as an option.
- **High effort is the default.** On the hardest ticket, three wrong time guesses at medium became three right guesses at high, for about 10% more (8.1 cents a ticket in batch mode, against 7.4). The setting is `EXTRACTOR_EFFORT`. Using high only for the third read was considered; nearly every ticket needs a third read because of names, so it would save almost nothing.
- **Max effort rejected.** On hard tickets it thought until it ran out of answer space (16,000 tokens) and returned nothing, at about five times the cost. Raising the limit would make each ticket cost dollars, and the ticket it failed on was not readable at high effort either.
- **Failed answers are counted in the cost.** The max test showed a cut-off answer reported as free. It is billed in full, so it now counts toward the report and the spending stop.
- **Measured on very few tickets.** The big test (H0) confirms the cost and the benefit.

## D36 · Phase 0 · The big test is copied from a prepared truth file, half in English (Liam)

- **Copied, not invented.** Claude writes the 100 tickets' contents as the truth file, and four people copy them onto real tickets. Typing in the true values afterwards from 100 handwritten tickets would itself introduce mistakes. Results are not split by writer: the goal is how well tickets are read, not who wrote them.
- **Half in English.** Liam learned that real tickets are about half English and half Hebrew, each ticket entirely in one language. The test has 48 English, 48 Hebrew and 4 mixed tickets, to check that a mixed one does not trip the system.
- **Two spellings of one place.** `workplaces.txt` lines may give a place in both languages: `Dolev = דולב`. Both spellings are on the list; the place's name is the Hebrew one (the agency's Excel is in Hebrew). Grading counts an English reading of a place as that place.
- **What the mix contains.** Most names and places come from the real lists. 12 names and 8 places are not on them, 3 places are misspelt by one letter, and there are night shifts, wrong totals, corrected digits and empty totals. Every real place appears at least once. Places longer than the 15 boxes are written past the last box.
- **To watch in the results.** Many real place names are one or two letters apart (in the style of דולב and דולפ). The look-alike check (D25) sends those to a person even when written clearly; the test measures how often.

## D37 · T3.1 · The agency's Excel layout (Liam, Q2)

- **Grids, as the agency uses today.** One sheet per workplace: a row per worker, a column per day of the month, the hours in each cell, a total per worker and per day. One totals sheet with only the workplaces and their totals.
- **Never merge, still: one row per ticket** (Q3). No two tickets ever share a row; the agency copies totals by hand if it wants to. It can change later.
- **English spelling of Hebrew names** comes from a names list with `Hebrew = English` lines. A name not on it gets a suggested spelling that a person confirms, so no spelling reaches the Excel unchecked.
- **Names in English letters**, as the agency writes them now.
- **Hours as decimals with two places (8.33).** Minutes stay whole numbers everywhere; only the display has two decimals. The cell keeps the exact value, so totals do not drift.
- *_Pay rates (such as *57 in a name) are left out*_ for now (Liam).
- **The details are settled when T3.1 is built.** Until then section 6.2 of the plan describes the old layout.

## D38 · Phase 0 · G0 passed (2026-11-20)

The big test (H0) became 45 real tickets: 33 copied by Liam from the prepared truth file (D36), mostly in his handwriting with his own corrected digits, plus the 12 tickets of the first real test. The helpers could not take part, so it is smaller than the 100 planned. Liam scanned uncut A4 pages; for this test only, Claude cut them into single tickets outside the project and matched each ticket to its truth row by checking every box against the image. Read with Opus at high effort in batch mode.

- **Gate passed: 0 wrong values accepted in any box**, names and workplaces included. All 18 mistakes were flagged to a person.
- **Workload:** 183 of 270 boxes (68%) accepted on their own; 69 sent to a person with the right guess filled in; 18 to type or fix (about one every 2.5 tickets). 37 of 45 tickets needed a person for at least one box.
- **Names are most of the work:** 30 of 45 went to a person. Most of them were on the names list and had the right guess, but one read was unsure or a look-alike name exists on the list. 7 of the 10 wrong or missing guesses were names not on the list.
- **Worked as designed:** English place spellings and a misspelt one matched the right place (D36); shortened place names went to a person instead of being forced onto a list entry; the deliberately wrong total and 12 corrected digits were flagged; the total-from-times rule (D30) was used twice, right both times.
- **Cost: $6.51, 14.5 cents a ticket in batch mode**, against an estimate of 9 cents: 34 of 45 tickets needed the third read. The estimate in the runner is too low and is to be corrected from this measurement when costs are next shown to a user.
- **No spending stop in batch mode (Liam).** The stop cannot act in batch mode, since a whole round is sent before any cost is known, and the run went past it ($6.51 against $5.82). Liam: the agency pays per ticket at about the estimate; stopping a job halfway would leave half-read jobs. It is not fixed; the cost is bounded anyway, as each ticket gets at most four reads.
- **Limits:** 45 tickets, mostly one writer. Strong evidence, not proof; the pilot month (T4.4) is the real test. Next: Phase 1.

## D39 · Plan v3 · Months, the agency's Excel layout and workplace PDFs (Liam)

Liam learned how the agency really works: it updates its Excel through the month as tickets arrive (weekly, until about the 10th of the next month), changes it by hand for many reasons, and sends workplaces their tickets on request. After several options were weighed (updating the agency's own file, syncing by uploads, a grid in the website), Liam chose:

- **Months instead of jobs.** One per calendar month, open about six weeks. Uploads are not tied to a month: each ticket joins the month of its date. Several months can be open at once.
- **The system owns a strict Excel layout,** built from the agency's own file: one sheet per workplace (a row per worker, days 1–31, totals) and a totals sheet. It only grows by a worker row or a workplace sheet. A fresh, complete file can be downloaded any time; the user never uploads an Excel. After the final download the file is the user's to change. His own notes live in a separate file the system ignores.
- **No grid in the website.** The site uploads, reviews, answers duplicate questions and lists tickets with **Remove**. Liam: recreating Excel in the site is not wanted.
- **Hours change only through tickets.** A correction is a new ticket; the duplicate question offers **Replace the old one**, **Keep both** or **Ignore the new one**. No hours without a ticket, so the Excel and the tickets sent to workplaces always agree.
- **Rows per worker, by person-confirmed name.** Every ticket gets a confirmed name in English letters; the same confirmed name at the same workplace shares a row. This replaces "never merge people" (principle 3) and Q3's "one row per ticket": the system still never decides by itself that two differently written names are one person, and the same name on the same day always asks. Two workers with one name are told apart by the person confirming. The remaining risk (two same-named workers never on the same day) is the same as in today's manual Excel.
- **Workplace PDFs:** one per workplace with all its tickets of the month, downloadable any time; sent by email and WhatsApp.
- **The lists carry on between months** (5.4): a new month copies the latest month's workplace and names lists, and confirmed names are added. They are deleted with their month. They only help reading and suggest spellings, and never put a worker or workplace in the Excel: rows come only from that month's tickets (Liam).
- **Dropped:** Excel import (old 6.3, T3.2), locking a job, the hidden `_meta` sheet, spending caps (D38).
- **Resources:** about 900 tickets a month; each page is kept as one image and the uploaded file is deleted once split; downloads are built on request and never stored.

## D40 · T1.1 · Database setup choices

- **Prisma 7.** The current version runs without its old query engine: the client is generated as plain TypeScript into `apps/api/src/generated/` (not committed; `pnpm install` generates it) and talks to Postgres through the `pg` driver. Settings live in `apps/api/prisma.config.ts`, which reads the repository's one `.env`.
- **MinIO from Chainguard.** MinIO stopped publishing free Docker images in 2025, so the local file storage uses Chainguard's free build of the same MinIO server, pinned by its exact digest. Only local development uses it; production uses AWS S3 (section 12), so nothing in the product depends on it.
- **The first admin is typed in, not written down.** `pnpm seed:admin` asks for the email and password (the password is not shown) and refuses a short password, an invalid email or an email already in use. No account details are in the code or the repository.
- **Flag codes are text in the database,** checked against the one list in `@tally/shared`, so the list of codes is not kept in two places.
- **A patched dependency.** Prisma's command-line settings loader pins `effect` 3.20.0, which has a published high-severity bug (a slow regular expression). It is overridden to the fixed 3.22.4; Prisma was re-tested with it. Remove the override when Prisma updates.
- **Database tests use their own empty schema** each run and drop it afterwards. Without a database they are skipped locally, and in CI a missing database fails the run instead of skipping.

## D41 · T1.2 · Logging in, kept to the standard and no further (Liam)

- **No two-step codes for now.** Liam: the app is for his father on one computer; it should meet industry standards without going overboard. The `totpSecret` column was removed. They can be added later if more people or computers use it.
- **Invites are links the admin sends himself.** The plan has no email sending, so creating an invite shows a link; it works once, for 7 days, and a new invite for the same email replaces the old link. The token is in the link's `#` part, so it never reaches server or proxy logs.
- **What is in place:** passwords hashed with argon2id; a wrong email and a wrong password get the same answer and take about as long; 10 wrong passwords lock the account for 15 minutes; 50 failed logins from one IP address in 15 minutes refuse that address; sessions are long random keys stored only as hashes, in an HttpOnly, Secure, SameSite=Lax cookie, ended after 12 idle hours, on logout, or when the account is disabled; a double-submit CSRF check on every change made while logged in; every route declares who may use it, and a route that does not is refused.
- **Accepted limits:** after 10 tries an attacker can tell that an account is locked, so that the email exists; login and invite acceptance (the only routes used without a session) have no CSRF check, as SameSite cookies already protect them. Behind the production proxy (T4.3) Express must be told to trust it, or every login would seem to come from one address.
- **There is always one active admin:** the last one cannot be disabled or made a reviewer.
- **Logins are not written to the audit trail.** Those entries would belong to no month, so they would pile up forever against the principle of keeping data for the shortest time. Changes to accounts (invites, accepted invites, role and disable changes) are audited.
- **Liam's check moves to T2.1,** where there is a login page to try it on.

## D42 · T1.3 · Uploads, months and the shared lists (lists: Liam)

- **One shared set of lists (Liam).** The plan gave each month its own copy of the workplace and names lists. But the lists are needed while a ticket is read, and its month is known only once its date is read, so they cannot belong to a month. There is now one workplace list and one names list, used by every month, and deleted only when no month is open. For the user it works the same.
- **The lists are pasted,** one entry per line. `A = B`, or two columns copied from Excel (which arrive separated by a tab), gives one entry's two spellings. A workplace is named by its Hebrew spelling (D36), a worker by the English one; a name on several lines is kept once. Up to 2000 entries of 200 characters. Replacing a list is audited with the number of entries only, since the audit trail outlives the lists.
- **Files are checked when the upload is confirmed,** not later in the background, so the upload screen can say at once what is wrong: not a PDF, JPEG or PNG (judged by content), over 50 MB, over 300 pages, damaged, or already uploaded. A refused or duplicate file is deleted at once. A duplicate's message names the first file and the day it came.
- **The upload's id is the random part of its upload key,** so a file confirmed twice (say, after a lost answer) gets the same answer, not a "duplicate".
- **Jobs are queued in the same transaction** as the upload or ticket they are about (pg-boss's Prisma adapter), so neither exists without the other.
- **Page images.** PDF pages are rendered one at a time, at 200 dpi as in the Phase 0 tests, as colour JPEGs; photos are turned the right way up and re-saved without their camera details. The greyscale copy the reader needs is not stored: it takes milliseconds to make again each time, and saves one file per ticket. The `s3KeyNormalised` column was removed.
- **Storage keys** are `uploads/<random UUID>` and `pages/<upload id>/<page>.jpg`: built from random UUIDs, with no names in them. Fixed page keys mean a split that is retried after a crash overwrites its pages instead of leaving stray files.
- **For the production bucket (Phase 4):** a rule that deletes files under `uploads/` after 2 days, which removes uploads that were never confirmed or that a crash left behind, and a CORS rule so the browser can upload. A signed upload link cannot limit the file's size, so the size is checked on confirmation.
- **One reading job per ticket** is queued when the ticket is created. T1.4 may group them for batch mode (D26) and the second look at names (6a).
- **The month summary's rows** (section 8) come in T1.5, when tickets have confirmed names and workplaces.
- **New libraries:** pg-boss 12.38.1 and the AWS SDK 3.1162.0 (both in the plan), pinned to releases about two weeks old. The tests use their own storage bucket and queue tables; CI starts MinIO as a step, because the image needs its `server` arguments.
