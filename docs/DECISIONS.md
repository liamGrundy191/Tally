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
