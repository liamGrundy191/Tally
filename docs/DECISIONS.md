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
