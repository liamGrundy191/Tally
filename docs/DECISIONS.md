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

The owner decided the last name is not needed. The ticket has one name field, first name (12 boxes); the rows below it moved up. The worker column in the export shows the first name, and `POSSIBLE_DUPLICATE` compares first names. (Replaced by D39: the Excel row is the confirmed English name.) Two different workers with the same first name at the same place on the same day (any hours, D44) will now always be asked about ("Keep both"), since there is no surname to tell them apart.

## D10 · T0.3 · Two new flags: FIELD_EMPTY and TIME_INVALID (Liam)

A blank box gets "The end time is empty" rather than "Could not read". A time that cannot exist (25:00, 08:75, "8.5" written as decimal hours, "8" with no minutes) gets `TIME_INVALID`. A name or workplace of only punctuation ("-") counts as empty. A field already flagged unreadable or disputed is not flagged empty as well.

## D11 · T0.3 · Duplicates: same date only; names match in any order or with an extra word (Liam)

(Replaced in part by D39 and D44: the same name on the same day always asks, whatever the times.) Liam chose same date only: a night shift entered twice with two different dates is not caught. Consecutive night shifts never overlap, so they are never flagged either way. Names match if they have the same words in any order ("דוד כהן" / "כהן דוד", Liam: yes), or if every word of one appears in the other ("דוד" / "דוד כהן", since the ticket has one name field). Back-to-back shifts (16:00 end, 16:00 start) do not overlap. If either ticket's times are unknown, it is asked about.

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
- **Price.** Before reading starts, the upload screen shows the estimated cost ("about $6 for 150 tickets"), from the measured average cost per ticket for the chosen options. The spending caps still apply. (Replaced by D38: no spending stop in batch mode.)
- **Measured so far.** The strongest model, read immediately, costs about 8 cents per ticket on Liam's four test tickets.

## D27 · Planning · A third read for unclear fields (Liam)

When either reading is unsure of a field, or the two disagree, a third independent read (pass C) reads those fields only. It can only improve the guess the reviewer sees. It never accepts a value or clears a flag, because one reading can be confidently wrong (Liam's tickets showed this twice) and two out of three agreeing is weaker than two out of two. It adds cost only on unclear tickets.

## D28 · Planning · Known names, from last month's export and from the same batch (Liam)

Names were the weakest field on Liam's tickets. The name decides who gets paid, so a wrong name must never slip through, but a flagged name only costs the reviewer a few seconds.

- **An uploaded names list, not a register.** The user uploads a list of first names (for now `names.txt`, later an Excel upload). Names are matched exactly like workplaces (D25): both passes must name the same entry, the writing must resemble it, and it must resemble no other entry. Many names have look-alikes (דנה / דינה), so those still go to a person, with the guess filled in. A name missing from the list is normal (workers change every month or two) and is not flagged.
- **Nothing is kept between jobs.** Saving names automatically was considered and rejected: too much for too little. Instead the export has a `שמות` sheet with each confirmed name once, and the user uploads it next time. The list lives in the user's own files. (Replaced by D42: the lists are stored, shared by all months.)
- **Names from the same batch.** One worker usually has several tickets in an upload. After the whole upload is read, names that raised no flag form a temporary list. An unclear name that resembles one of them is read again with those names on the list. Only names that came out of a clean reading are used, so one misread cannot spread to other tickets. The temporary list goes with the job.
- **Rejected or deferred.** A general list of common Israeli names (the workers' names are mostly not common ones, and a big list has look-alikes everywhere). Printing "block letters" on the ticket (not realistic for the shift leaders). One-click name buttons in the review screen (a maybe, to decide with the review screen).
- **Known limit.** Two workers really called the same name cannot be told apart by the name. The agency already handles this today.

## D29 · Planning · Read 2 sees the whole ticket as well as the boxes; look-alike tests (Liam)

- **Read 2.** It used to see only the cut-out boxes. On its own, a cut-out of a cursive four-letter Hebrew name was read as the English "KOIN": its cursive letters look like K, O, I, N, and reading them left to right reverses the word. Read 2 now gets the whole ticket for context, then each box enlarged. Its different wording keeps it independent from read 1. All prompts now warn that cursive Hebrew can look like Latin letters.
- **Look-alikes.** For names, only entries one letter apart count as look-alikes (two for names of 8 letters or more); two letters apart blocked clearly different short names such as הלן and הדס. Workplaces keep the stricter test, at Liam's request, because the list is short and two-letter pairs exist on it.

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
- **Never merge, still: one row per ticket** (Q3). No two tickets ever share a row; the agency copies totals by hand if it wants to. It can change later. (Replaced by D39: one row per confirmed name.)
- **English spelling of Hebrew names** comes from a names list with `Hebrew = English` lines. A name not on it gets a suggested spelling that a person confirms, so no spelling reaches the Excel unchecked.
- **Names in English letters**, as the agency writes them now.
- **Hours as decimals with two places (8.33).** Minutes stay whole numbers everywhere; only the display has two decimals. The cell keeps the exact value, so totals do not drift.
- *_Pay rates (such as *57 in a name) are left out*_ for now (Liam).
- **The details are settled when T3.1 is built.** Until then section 6.2 of the plan describes the old layout. (Replaced by D39: section 6.2 now has the agency's layout.)

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
- **The lists carry on between months** (5.4): a new month copies the latest month's workplace and names lists, and confirmed names are added. They are deleted with their month. (Replaced by D42: one shared set of lists.) They only help reading and suggest spellings, and never put a worker or workplace in the Excel: rows come only from that month's tickets (Liam).
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

- **No two-step codes for now.** Liam: the app is for the owner, on one computer; it should meet industry standards without going overboard. The `totpSecret` column was removed. They can be added later if more people or computers use it.
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

## D43 · T1.4 · The reading worker (speed and quality: Liam)

- **Batch is the default speed; there is no reading-quality choice (Liam).** Batch costs about half and tickets wait for review anyway. The cheaper model was rejected in D35, so only one quality is left and the choice is dropped from the upload screen. The speed is chosen when an upload is confirmed and kept on the upload.
- **One reading job per upload,** queued when splitting ends. The second look at names (6a) needs every ticket of the upload read first, and batch mode sends each round of the whole upload as one batch. Uploads are read side by side (4 at once), and inside an upload read straight away, 4 tickets at once.
- **Every answer is kept as it arrives** (`Reading`: the whole validated answer of one pass, with the lists it was given and its token counts). A job restarted after a crash reuses the kept answers, so no reading is paid for twice, and saved tickets are skipped. This replaces `FieldExtraction`, which kept one row per field and lost the crossed-out and overwritten marks and the list matches.
- **Retries.** A failed reading is tried again, 5 attempts in all, waiting 2, 4, 8 and 16 seconds; an unusable answer counts as a failed attempt. A refused API key is not retried: it stops the job, which pg-boss retries later. Jobs are tried 5 times in all.
- **Long jobs.** A reading job may run for hours in batch mode. It sends a heartbeat, so if the worker dies its job is taken up again within a minute. Known limit: a batch still running at Anthropic when the worker dies is not picked up; its round is sent again, so that one round is paid twice. Rare (a crash during a batch), and recorded rather than built around.
- **Month (6c).** A ticket joins the month of its date only when nothing at all is flagged on the date, including a date in the future or more than 45 days old: those wait outside any month until a person confirms the date. A date in a closed month raises `MONTH_CLOSED`, and the ticket stays outside any month.
- **The workplace as read is kept,** except that a list spelling ("Dolev") is stored as its place's Hebrew name (D36), so both spellings of one place group together in T1.5.
- **D30 is stored** on the ticket (`totalFromMath`), so the review screen can show that the total was accepted because the times confirm it.
- **A page that cannot be split does not stop the others** (principle 4, from the code review). It is retried with the job; on the last attempt the rest of the file is read and the page is recorded on the upload (`failedPages`), for the progress screen (T1.6) to show.
- **`EXTRACTOR` must be set** to `anthropic` or `fake`: the worker never falls back to the fake reader by itself, which would "read" real tickets. The fake reader gives every ticket the same prepared clean answer, for local runs without a key.

## D44 · Review · Fixes from three independent reviews (Liam asked for them)

At Liam's request, three reviewers checked everything built so far: the API, the reading rules, and the documents against the code. Each finding was checked again before fixing.

- **A clearly read name is never replaced by a list entry.** The list used to settle a name whenever the writing resembled an entry, so two clear readings of "Dina" became the list's "Dana" with no flag. The list now settles a name only when the readings were unsure of it, or read it exactly as the entry; otherwise a person decides (`MATCH_AMBIGUOUS`, with the entry suggested). Workplaces keep D25/D36: a misspelt place still matches its list entry. This can only send more names to a person.
- **Same name, same place, same day always asks** (5.2, D39), whatever the times. The rule still followed D11 and asked only when the shifts overlapped, so two non-overlapping shifts would have been added together silently.
- **The third read can raise a doubt, never clear one** (D27): its "crossed out" and "overwritten" marks now count, and a third read seeing another total stops the D30 shortcut.
- **Smaller rule fixes:** every invisible formatting character is removed (soft hyphens, the Arabic letter mark); a date or time box with only a dash is empty, as 4.1 says; the checks refuse a malformed "today" instead of silently skipping the date checks.
- **The CSRF cookie lives as long as the login**, and `/auth/me` gives a lost one back. Before, closing and reopening the browser made every change fail until the session expired.
- **Less kept:** failed logins are deleted after a day on every login, not only on the next failure; used and expired invites are deleted; the invite audit entry keeps the role, not the email.
- **Two admins cannot disable each other at once:** that change now runs in a serializable transaction.
- **A pasted list is at most 40,000 characters,** which fits the API's 100 KB request limit even in Hebrew.
- **Real names out of the repository:** three first names from Liam's test scans, which are on the agency's names list, were replaced in tests and documents. The reading instructions in use (prompts v3) still use one of them as an example; prompt files are never edited once used, so it goes in the next prompt version. Earlier versions of the files keep them in the project history.
- **Documents brought in line:** removed `totpSecret` from section 7 and added the login-limit fields; old decisions now say what replaced them; `pnpm dev` is marked as arriving in T2.1, the first task with a screen; CI now also builds the web app (section 12). The prompts in use are v3 (pass C added, D27).

## D45 · T1.5 · Workplaces, names and duplicates (Liam: the three answers)

- **"Same place" is remembered (Liam, 1A).** Workplace groups belong to one month, so the answer would otherwise be asked again next month. A "same place" answer adds the other spelling to the workplace list, the way confirmed names join the names list.
- **Names in block letters are shown as "Kwame" (Liam, 2A):** a capital first letter and the rest small, also after a hyphen ("Mary-Ann"). Rows compare names ignoring capitals and spaces.
- **No invented English spelling (Liam, 3A).** A clear Hebrew name gets its English spelling only from a `Hebrew = English` line of the names list; otherwise `NAME_NOT_CONFIRMED`, and a person picks one of the names already used at that workplace this month or on the list, or types it. Asking the reader for a spelling would change the reading instructions that passed G0.
- **Every confirmed name joins the names list,** including English names read clearly (5.4).
- **When the questions are asked.** After an upload is read, its months are organised: tickets are grouped by workplace (a workplace still in doubt waits for a person), then `WORKPLACE_SIMILAR` and `POSSIBLE_DUPLICATE` are raised once per pair. Only one organiser runs for a month at a time. Answering a question organises the month again, since a merge can bring two tickets of one name together.
- **A question sends a verified ticket back to a person,** and it returns to verified once its questions are answered. A ticket that was never verified stays for the person to confirm (T1.6).
- **Duplicates:** "replace" excludes the older ticket ("replaced", pointing at the new one); "ignore" excludes the newer one ("duplicate"); "keep both" keeps both. "Older" is the ticket created first.
- **The month summary's rows:** each workplace with one row per confirmed name and the tickets in it; tickets without a confirmed name are listed apart; removed tickets are not shown.
- **From the review of T1.5:** answering a question takes the same month lock as organising, so a ticket cannot join a group while it is merged; merging follows earlier merges to the group they ended in; "same place" needs the person to choose the name kept; a removed ticket cannot replace or be replaced, and the other duplicate questions about it close; a Hebrew spelling two workers share on the names list is always asked; every clear name left without an English spelling is asked (no row otherwise); a name written in mixed case ("McDonald") is kept as written; a spelling already on the list for some place is not added to another; organising a month that is being deleted does nothing; a big month gets two minutes to organise.

## D46 · T1.6 · Reviewing tickets

- **Removing a ticket needs no reason (Liam).** The person presses "remove"; the ticket is kept as removed, with who did it, and leaves the Excel and the workplace PDF. Its questions close, and so do the duplicate questions other tickets had about it.
- **"I checked the paper" only where the paper can really say it.** A save may confirm as written: start and end not matching the total, unusual hours, a date more than 45 days old, unusual characters in the name as written, and a crossed-out ticket. It cannot confirm an empty box, a time or date that does not exist, or a date in the future: those are settled only by a new value. A confirmation is for the values of that save only: a later save with other values checks them again from scratch. Only a warning the person was shown can be confirmed: if new values raise a new one, the save is refused and the person confirms it with the next save.
- **Every save runs the rule checks again** on the saved values. Doubts about the reading (disagreeing readings, unclear boxes, overwritten marks, a blurry scan, a reading that failed) are settled by the save, recorded as "changed" or "confirmed". A crossed-out ticket stays open until it is confirmed or removed.
- **A save does not mark a ticket verified straight away when it may raise a question.** When the name, workplace, date or month changes, the ticket's open questions are dropped and the month is organised again; the ticket turns verified only once the organiser has found nothing new to ask. So does a ticket in a month that is not grouped yet (its workplace was in doubt). The same applies to a question about a place whose tickets have all moved away: it is dropped.
- **Reading a ticket again** sets everything the reader sets again, including the English name, and pays for new readings (it does not reuse the kept answers). It is read straight away, whatever the upload's speed. Its open questions, and other tickets' open duplicate questions about it, are dropped and asked again if still needed. Questions already answered stay as they were answered, except "keep both": that answer is dropped when a save changes the ticket's values or name, or the ticket is read again, so the pair is asked again (flags more; the audit trail keeps the old answer). It is refused while any ticket of the same upload is still being read; try again when that finishes.
- **Every reading counts as a change to the ticket.** A review screen opened before a ticket was read again cannot save over the new reading: the save is refused and the person reloads.
- **The audit trail keeps no ticket values outside a month.** A ticket with no month yet (no date, or a closed month) has its audit entries kept with no names, times or dates, only which boxes changed, since nothing would delete them at a month's close. Inside a month, entries keep the values before and after, and are deleted with the month.

## D47 · T2.1 · The app shell and `pnpm dev`

- **How the API runs locally.** Node cannot strip NestJS decorators, so the API is compiled by `tsc` (`apps/api/tsconfig.build.json`, into `apps/api/dist`, which git ignores) and Node runs the result; `@tally/shared` is still run from its source with Node's type stripping (D7). `pnpm dev` builds once, then runs side by side: the compiler in watch mode, the API, the worker and the web app, each restarting when its files change. The worker is the same build with `MODE=worker`, set from `apps/api/worker.env` so it works the same on Windows. No new tool (tsx, concurrently, cross-env). CI also runs that build, so it cannot break unnoticed.
- **The web app talks to `/api` on its own address.** In development Vite passes `/api` to the API on port 3000; in production Caddy will (T4.3). Cookies then just work and no CORS is needed. The session cookie is `Secure`: Chrome, Edge and Firefox accept that on `http://localhost`, Safari does not, so the local checks use Chrome or Edge.
- **Libraries:** React Router 7.18.5, TanStack Query 5.107.1, MUI 9.5.0 (with Emotion 11.14.0 / 11.14.1) and, for tests, jsdom 29.1.1, pinned to releases at least two weeks old. React Router 8 and jsdom 30 or later need Node 22.22, newer than the Node 22.12 the repository allows, so the last versions that run on it were taken. The default MUI look is kept: greys and one blue. Tests drive the pages with React and jsdom alone; Testing Library is not added.
- **React Hook Form waits for T2.3.** The plan names it; the two small forms here (login, invite) do not need it, and the review form will.
- **The login.** A page without a session sends the person to log in and back to that page afterwards, but only to a page of this site, never to another site named in the link. When a session ends while the app is open (12 hours idle), the next refused request sends the person to log in with "You were logged out. Please log in again."; a first visit shows no such notice. An empty email or password is refused before anything is sent, with a plain message (now also on the server). Wrong passwords and the lockout show the server's message as it is.
- **The invite link's token** is read from the part after `#`, which never reaches the server's logs, and is then removed from the address bar.
- **The ticket template download is built now** (Liam): `GET /api/templates/v1/pdf` gives logged-in users the blank printable ticket, and the Ticket template page has a Download button. No other task built it. It is a plain link: if the session has ended, the click shows the server's short "Please log in." reply instead of a page; acceptable for now, revisit in T4.3.
- **`pnpm dev` and type errors.** The first build must pass, so a type error in the API stops `pnpm dev` from starting at all; fix it and start again. Do not set `MODE` in your own terminal: it beats `worker.env`, and both processes would run in the same mode.
- **For T4.3:** MUI adds its styles with `<style>` tags, which a strict Content Security Policy blocks. T4.3 needs an Emotion cache with a CSP nonce.

## D48 · T2.2 · Home, the month page and uploading (price and Remove: Liam, Q4 and Q5)

- **Each file is uploaded and confirmed on its own,** 3 at a time. Its upload link is asked for just before it is used, so it never outlives its 5 minutes, and the file is confirmed as soon as it has arrived, so the screen can say at once "Uploaded: 12 pages" or why it was refused. The server already makes one upload per file however many are confirmed together, so nothing is lost by confirming them one by one.
- **Retry starts from the step that failed.** A file that did not reach storage gets a new link; a file whose confirmation was lost is confirmed again with the same key, which is safe (D42). If a confirmation tried again finds the file never arrived, the file is sent again by itself, once. An upload with no progress for a minute is stopped and shown as failed, so it cannot hold one of the 3 places forever.
- **The browser only checks the size** (50 MB) before sending. The file's type is judged by the server from its content, as before; the file picker only suggests PDF, JPEG and PNG.
- **The server is the only record of what arrived.** Nothing is kept in the browser. After the tab is closed mid-upload, Home shows the uploads that arrived; adding the same files again is the way to finish, and the ones already there come back as "already uploaded" and are not read twice. Leaving the page while files are uploading asks first, and leaving stops them: nothing more is sent or confirmed. Logging out asks too, since the login page now does the logging out. If the files finish while the question is open, the page leaves by itself.
- **Speed is chosen before files are added** and cannot change while they upload. Beside each speed is the estimated price per ticket (Liam, Q4): about 15 cents for Batch (measured, D38) and about 30 cents for Now (not yet measured); after each file, its estimate, and a running total for the page. The numbers are kept in one place in the upload page.
- **Live progress.** The uploads are asked for every 3 seconds while one is splitting or has tickets being read, and the questions stop when nothing is. Home and the month page keep asking for their counts for 2 minutes more, while the month is sorted into workplaces (D45); this covers only an upload the open page saw finish, so a page opened just after one finished shows counts that may still change (reload to see them). An upload with nothing new for 26 hours (batch mode takes at most 24) is shown as "Reading this upload stopped. Tell your admin." and is not asked about again. "Nothing new" counts from the upload's last change or, if later, its newest ticket waiting to be read, so a ticket of an old upload sent to be read again is not taken for a stuck upload (`GET /progress` now gives this time as `activeAt`).
- **Tickets not sorted into a workplace yet** are counted on the month page in the browser: the month's tickets, without removed ones, minus those listed by workplace. Workplaces with no tickets are not shown.
- **Remove and search on the month page wait for T2.3** (Liam, Q5): removing needs the ticket's version, which the review screen loads anyway.
- **Dates and Hebrew.** Shift dates are shown as DD/MM/YY for the day stored, whatever the browser's time zone. File names, names and workplaces are shown in their own right-to-left-aware spans, so Hebrew reads correctly inside an English line.
- **Local storage bucket.** The compose file has a one-off `minio-setup` service, with the same MinIO image, that creates the `tally` bucket and stops; nothing created it before. The browser uploads to MinIO directly, which MinIO allows from any origin by default; production needs the CORS rule of D42.
- **Known limit, not fixed here.** Photos arrive one ticket per file, so 30 photos are 30 uploads: the same-batch name comparison (6a, D28) never applies to them, and in batch mode they are read 4 uploads at a time. Liam offered to allow PDFs only if photos caused trouble (2026-11-21). Photos stay allowed, because a photographed ticket still gets every check except the same-batch name comparison.
- **For later:** the web app keeps its own copy of the API's answer types, which could drift from the API; T4.3's Content Security Policy must allow uploads to the storage address.

## D49 · T2.3 · The review screen (Enter and name picks: Liam, Q6 and Q7)

- **The image is the straightened slip.** Nothing straightened is stored (D42), so `GET /tickets/:id/slip` makes it again from the page scan on each request, the way the reader prepares it, without the field crops (about 0.3–0.5 s for a 200 dpi page). It is sent with `Cache-Control: private, no-store`. The template's field map then lines up with the image, so the flagged boxes are outlined and the focused one is outlined strongly. Without corner markers the slip is a 404, and the screen shows the whole scan with no outlines; "Show the whole scan" (or W) switches to it at any time. The review screen uses the whole width, the scan taking three fifths of it and up to 70% of the screen's height, so handwriting is readable. The viewer zooms, pans and turns with no library: buttons, the mouse wheel and dragging, or the keys + − arrows R 0 while it has the focus.
- **What a box starts with.** The reader's guess (D24) only while that box still has an open doubt about its reading (unreadable, disputed, or two list entries); otherwise the stored value. A disputed box with no agreed guess starts empty, because filling in the stored reading would quietly pick one of the two (D31). A time or date that does not exist starts as written. A saved guess never comes back once its doubt is settled.
- **Enter walks, then saves (Liam, Q6).** Enter in a flagged box moves to the next flagged box not yet visited, and saves once every one has been visited; focusing a box counts. With nothing flagged, Enter saves. A held-down Enter, Enter while typing with an input method, and Enter while saving do nothing. A ticket typed in by hand counts every box as flagged. In the name list, Enter on a highlighted name picks it; Enter with nothing highlighted keeps what was typed.
- **Tab never traps.** Tab and Shift+Tab move between the flagged boxes and their checkboxes only when the focus is on one; from the last, Tab goes to **Confirm and next**, then on as usual (Skip, Reprocess, Remove). Dialogs and the open name list keep their own Tab.
- **"The paper really says this".** A checkbox under each warning that can be confirmed as written (D46). Changing a box the warning is about unticks and disables it, so the save checks the new values from scratch. Changing the first name clears the English name unless the person typed one, so the name is confirmed again. An empty English name is sent as "not confirmed yet".
- **Names (Liam, Q7).** One type-ahead list: the names used at this workplace this month first, then the names list; any other name can be typed. D28's one-click name buttons are decided against.
- **After a save.** The server answers only after the month is sorted again, so its answer is final: a verified ticket goes on to the next one; one that still needs something stays, with "Saved. This ticket still needs: …", and a new duplicate question takes the focus. A ticket whose only question is "is this the same place" goes on too: that is answered on the Workplaces page (T2.4). Refusals are shown as the server words them; "Someone else changed this ticket" has **Reload**. The form starts again only when the ticket or its version changes, so answering a question does not wipe what was typed.
- **Duplicates.** Both tickets side by side, the one scanned first on the left (the server's order: created, page, id), and three equal buttons that say what each removes. None is chosen or focused; the focus goes to the question.
- **Remove and Reprocess ask first,** with the focus on Cancel. Reading again warns that what was typed is lost and that it costs money. Both go on to the next ticket.
- **The queue lives in the browser.** It is the server's list, needing review first, then typed in by hand, oldest first, for the month and flag chosen ("Only tickets with"). Skipped tickets are remembered until the screen is left; "Nothing left to review" offers them again. Home has **Review next**; the month page has **Review next** for that month, a search by name, workplace or date, and **Open** and **Remove** on each ticket. The month summary now gives each ticket's version, which removing needs.
- **The browser test.** `pnpm e2e` builds the API and the web app, seeds three fixture tickets (disputed, crossed out, unreadable) through the real API and worker with the fake reader, then a Playwright browser reviews them with the keyboard only: it corrects the first, removes the second, types in the third, and answers the duplicate question that raises. It uses its own database `tally_e2e` and bucket `tally-e2e`, never the dev database, wiped at each run, with its own ports (API 3100, web 4173). The fixtures' dates are moved to yesterday in Israel, so no date check fires on any day. The seed is a Vitest file (Vitest loads NestJS, D47) that runs only through its own Vitest config, which sets the flag it needs; `pnpm test` and a plain `vitest run` skip it. CI runs it in the same job after the build.
- **From the check with 20 real tickets** (all verified, no wrong value accepted):
  - **Enter on the only flagged box did nothing** in `pnpm dev`. React's development mode runs the form's start-up twice, and the second run forgot that the box had been visited. The box the form starts on is now marked visited directly, and the screen's tests run the way `pnpm dev` does.
  - **A Hebrew name was taken as the English name.** A names list line with no English spelling ("יעל" alone) is named in Hebrew, and the reader gave that name to every ticket written the same way, with no question; with `REVIEW_EVERYTHING=false` such a ticket would have been verified with a Hebrew name in the Excel. Such a line now only helps reading: the name is asked (`NAME_NOT_CONFIRMED`), as for a name not on the list (5.2, D45). The review form never fills in a name for the Excel that has Hebrew letters.
  - **Comment lines in a pasted list are skipped:** a line starting with `#` is a comment, as it already was for `names.txt` and `workplaces.txt` in the Phase 0 runner, which now uses the same rule.
- **Libraries:** React Hook Form 7.91.0 (no schema resolver: the English name is checked with the shared schema directly) and Playwright 1.65.0, for the browser test only.
- **The 20-real-ticket check was run by an agent (Liam, 2026-11-22).** Liam is not worried about review time ("even an hour is a big improvement"), so an agent reviewed 20 real Phase 0 tickets on the screen, read once by the real model in Batch (about $2.75, 13.7 cents a ticket; 13 of 20 needed a third read). Against `truth.csv`: 0 of 120 values accepted wrong, 28 flagged (25 with the right guess), all 20 verified with the right values. The run found the three problems above. Its times (5–13 s a ticket) are a script's, not a person's.

## D50 · T2.4 · Workplaces and lists (lists on the month page, "Are you sure?": Liam, Q8 and Q9)

- **A bug from T1.5, fixed: a question about one place.** After a chain of merges (b joined a, then a joined c), the question "b or c?" stayed open although both were now one place: it would have read "Is X the same place as X?", and its tickets never turned verified. An answer now settles every open question about the same two places as they are after earlier merges: once b joined a, "b or c" and "a or c" are one question with one answer. Organising a month also drops any such question already stored. It acts only on a person's merges; the system still never decides two places are one.
- **Contradictory answers:** if b and c were called different places and a person then merged both into a, the merge wins. The other way round, an earlier "different place" can be asked again as a new pair after a later merge (b and c were different; once b joins a, "a or c" may be asked): it flags more, by design.
- **An answer is all or nothing.** The questions a merge raises (two tickets of one name and day now in one place, or another similar place) are asked in the same transaction as the answer, before any ticket turns verified again; if anything fails, nothing of the answer is kept.
- **The audit records the places really kept and merged** (their ids and names after earlier merges), beside the ids stored in the question.
- **The workplace list after a merge:** the entry that already holds one of the two names gets the other; a new entry is named by its Hebrew spelling (D36), the way a pasted list names it, so editing the list later does not swap names.
- **The Workplaces page** shows each open month's questions as cards, one per pair of places: "Is A the same place as B?", each side with its tickets, how it was written on them, and "See a ticket" (the last two were not asked for, but are cheap and help decide). Three equal buttons, none chosen or focused: "Same place, keep the name A", "Same place, keep the name B" (the person chooses the name, 5.3) and "Different place". "Same place" asks "Are you sure? This cannot be undone." with the focus on Cancel (Liam, Q9); "Different place" is one click. Below the cards, the month's workplaces with their spellings and counts. After an answer, or a refusal, the month and the review counts are asked for again, and the focus goes to the month's next question, or to "No workplace questions to answer." A refusal offers **Reload**. The answer buttons keep the place's name as written (no capitals, the name never split over two lines).
- **No undo.** A merge cannot be split again, and nothing renames a place outside a merge; section 5.3 asks for neither.
- **The review screen no longer names the two places** in its "same place" message, since the names stored with the question can be out of date after a merge; it links to the Workplaces page instead.
- **The lists are on each month page (Liam, Q8),** under "Lists that help reading", as section 9 says: the same two shared lists on every month, no page of their own. Each is shown as the text it would be pasted as (`name = other spelling`), so it is edited rather than typed again. Before anything is sent, the browser reads the text with the same rules as the server and says what would change ("312 entries (was 300): 15 new, 3 no longer on the list, 2 other spellings removed"), or what is wrong with a line. Replacing asks first, with the focus on Cancel, and says that tickets already read are not read again; for the names list, that names added from confirmed tickets and missing from the text are removed. An empty list is allowed.
- **Pasting only, no file upload.** Section 5.4 and D42 say the lists are pasted; a .txt picker was left out.
- **A list replaced while a "same place" adds a spelling** no longer loses the spelling: both take one lock, as the names list already did for confirmed names.
- **The month summary now gives** each workplace's spellings and the open workplace questions (`questions`).

## D51 · T2.5 · Admin: accounts and invites (no pending-invites list: Liam, Q10)

- **The Admin page** lists every account (email, role, Active or Disabled) and has "Invite someone" (email and role, Reviewer chosen by default). The API was already built in T1.2; this task adds the page and a few tests.
- **No list of pending invites (Liam, Q10).** Section 8 asks for none. Inviting the same email again gives a new link and the old one stops working, so a lost link is fixed by inviting again.
- **The link is shown once,** in a read-only field with **Copy**, and never stored, logged or put in an address on the admin's side. The page says: "Send this link to {email}. It works once, until {date}. Whoever opens it first gets the account, so do not open it yourself. It will not be shown again. Any earlier link for this email no longer works." The date is in Israel time. Opening the link in the admin's own browser would log the admin out and into the new account, hence the warning. Copy says "Copied." or "Could not copy. Select the link and copy it yourself.", so it never fails silently.
- **No email sending, removing accounts or cancelling invites:** the plan asks for none. Disabling is how someone leaves; it logs them out at once.
- **Asking first.** Disable, Make admin and Make reviewer ask, with the focus on Cancel, and say what happens ("They see the Admin page the next time they open the site", "They will no longer see the Admin page"). Enable is one click: it only gives back access that can be taken away again at once. Enabling also clears a wrong-password lock. The buttons are disabled while a change or an invite is being sent.
- **"Not yourself" is on the page only.** Your own row has no buttons ("This is you."), but the API does not refuse a change to your own account. The safety property is that there is always one active admin, and the server enforces that for every change (one transaction, serializable, so two admins cannot disable each other at once). Changing your own role when another admin exists is harmless and can be undone by that admin; a server rule would add code without protecting anything more.
- **Refusals are shown as the server words them.** An email that already has an account now says "This email already has an account. If it is disabled, enable it in the list above." A 403 (the admin was made a reviewer meanwhile) asks again who is logged in, so the menu drops the Admin link.
- **The browser test** (`pnpm e2e`, admin.e2e.ts): the seeded admin invites a new reviewer (a new email each run), reads the link from the page (headless browsers have no clipboard), logs out, sets a password through the link and lands on Home with no Admin link. The test API gets `APP_URL=http://localhost:4173`, so links point at the web app under test.
- **For production (T4.3):** `APP_URL` must be the site's real address, or invite links point at the wrong place.

## D52 · Phase 2 gate · The lists before the first month (Liam)

- **Found preparing the Phase 2 gate:** the lists were only on a month page (D50, Q8), but no month exists until the first tickets are read, so an agency could not enter its names and workplaces before its first upload, and the first reading went without them.
- **The fix, the smallest one:** while no month is open, the Workplaces page shows the same "Lists that help reading" section (it otherwise links to the month page's section, as before). Home with no months says "Before the first upload, set up the lists that help reading on the Workplaces page." The month page stays the main place for the lists (Q8 unchanged).

## D53 · Phase 2 gate · Passed: 45 real tickets from upload to zero open tickets in the browser

- **The run (2026-11-23).** The Phase 0 set (45 real tickets in two PDFs, one upload, Batch) was read once on a separate gate database: 125 reads, 37 minutes, $6.55 (2.56 M tokens in, 0.14 M out). Then the app was restarted with the fake reader, so nothing clicked during the review could spend money.
- **Reading, before anyone reviewed (270 values):** 169 accepted and right, 76 flagged with a right guess, 22 flagged to type. **No wrong value was accepted unflagged.** Three values a script counted as wrong were the workplace list's Hebrew name for the place the truth file wrote in English (one of them a typo in the truth file).
- **The review, browser only:** Liam reviewed 10 tickets; at his request, an agent reviewed the other 35 through the same screens with Playwright. Every workplace question was answered by Liam. End state: 45 of 45 verified, 0 open flags, all in one month.
- **The result:** 268 of 270 stored values match the truth file, and Liam's 10 tickets match exactly. The two left over follow from Liam's answer that two places the truth file lists apart are one place; his knowledge is taken over the file. The gate's definition ("one person") was met in spirit: the screens alone took every ticket to verified.
- **Found and fixed before T3.1:** a workplace a person types as a list entry's other spelling (the English spelling of a Hebrew entry) starts a group of its own instead of joining that entry's group, so one place would get two Excel sheets. A save now stores a workplace typed as any list spelling (ignoring case, spaces and punctuation, as grouping does) under its list name, as the reader already did. A spelling two list places share stays as typed.
- **Noted for later, not now (Liam):** the review flow works well, but the design looks plain and much of the site is not self-explanatory for a newcomer. Both wait for a later design pass.
