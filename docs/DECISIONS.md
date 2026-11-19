# Decisions

Decisions made after `docs/PLAN.md` was written, newest last. Each says what was decided, why, and where it came from.

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
