# Shift Ticket Processing System — Build Plan

Version 3 · 21 Nov 2026 · Owner: Liam (months, the agency's Excel layout and workplace PDFs: D39; shared lists: D42)

This is the complete specification. It is written for Claude Code, which writes most of the code. Claude Code also opens and merges the pull requests. Liam oversees and runs the checks that need a person. Read `CLAUDE.md` for the working rules, then this file top to bottom before starting any task.

---

## 1. What we are building

A staffing agency sends temporary workers to many workplaces. For every shift, the shift leader fills in a paper ticket per worker. Today the owner and his associates count hundreds of these tickets by hand to produce Excel sheets of hours per workplace. That takes many hours each month.

This system turns scanned tickets into those Excel sheets, in the agency's own layout, and sorts the ticket images into one PDF per workplace. The AI reads the tickets; rules and people verify every value; nothing is guessed. Tickets arrive weekly, so a month is built up over about six weeks. When the user closes the month, all its data is deleted.

**Success** means a meaningful cut in human hours compared with the manual count, with results that match the paper.

### 1.1 Principles (non-negotiable)

1. **No silent guesses.** A value reaches an export only if it passed every rule check, was confirmed by a person, or was typed by a person. Anything else is flagged with a specific, plain-language reason.
2. **"Unreadable" is a valid answer.** The extractor returns `legible: false` rather than its best guess. Prompts, schemas and code must make that the easy path. It may add its best guess as a separate `suggestion`, which is shown to the reviewer and never used as a value (D24).
3. **A person decides who is who.** In the Excel, a worker's tickets at one workplace share a row only when a person-confirmed name is exactly the same (section 5.2). The system never decides by itself that two differently written names are one person, and never adds two tickets of one name on one day together without asking.
4. **One ticket never breaks a batch.** Every ticket is processed independently. A failure becomes a ticket that needs manual entry, never a failed request.
5. **Nothing is lost while a month is open.** Ticket images are immutable until the month is closed. All state lives in Postgres, so any process can crash and resume.
6. **Keep data for the shortest time possible.** When the user closes a month, its files and records are permanently deleted. Nothing is kept across months except the lists that help reading (5.4) and an anonymous summary.
7. **Paper is the source of truth.** The system speeds up counting. If it is down, the owner counts by hand, as today. The Excel and the workplace PDFs always agree: hours change only through tickets (6.1).
8. **Every change is attributable.** Each correction records who, when, the old value and the new value (until the month is deleted).
9. **Speed is secondary.** A batch taking 20 minutes is fine. Clear status and correctness are not negotiable.
10. **Simple for non-technical users.** Every screen has one obvious next action, plain words, and no data-losing action without confirmation.

### 1.2 Decisions already made — do not revisit

| Topic             | Decision                                                                                                                                                                                 |
| ----------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Input             | Paper tickets, one per worker per shift, filled in by the shift leader. Collected at the office and scanned (sheet-fed scanner PDF preferred; phone photos accepted as JPEG/PNG).        |
| Ticket            | Plain slip, four per A4 page, photocopiable. **No QR code, no serial number.**                                                                                                           |
| Ticket fields     | First name, workplace, date, start time, end time, total worked. **No last name** (the owner decided it is not needed). **No break field** (breaks are paid). **No shift leader field.** |
| Handwriting       | About half Hebrew and half English; each ticket is written in one language (D36).                                                                                                        |
| UI language       | English. Hebrew values must display correctly (right-to-left) inside it.                                                                                                                 |
| Rounding          | None in the data: minutes are kept exactly as written. The Excel shows hours as decimals with two places (8.33); only the display is rounded (D37).                                      |
| Workers           | No worker register, no IDs. In the Excel, a worker's tickets at one workplace share a row when a person confirmed the same name (5.2). Lists of names only help reading (D28).           |
| Workplaces        | Handwritten; they come and go. About 50 a month. Each gets its own Excel sheet and PDF. Similar spellings are merged only after a person confirms.                                       |
| Months            | One month per calendar month, open about six weeks (tickets arrive until about the 10th of the next month). Each ticket goes to the month of its date. Uploads are weekly.               |
| Excel             | The system creates the Excel and owns its layout (6.2); the user never uploads an Excel. A fresh, complete file can be downloaded any time. After the final download it is the user's.   |
| Changes           | Hours change only through tickets: remove a ticket, or scan a new ticket that replaces the old one (5.2). No hours entered without a ticket.                                             |
| Ticket images     | One PDF per workplace with all its tickets of the month, downloadable any time (6.3).                                                                                                    |
| Pay and rates     | Not in version 1. Excel shows hours only. Pay columns may be added later.                                                                                                                |
| Retention         | When the user closes a month, it is deleted. Automatic deletion 60 days after the month ends.                                                                                            |
| Users             | For now the owner, on one computer; associates can be invited later. Invite-only accounts.                                                                                               |
| AI                | Ticket images are sent to the Anthropic API. The owner has approved this.                                                                                                                |
| Volume and budget | About 900 tickets (7,000 hours) a month. Reading costs about 15 cents a ticket in batch mode (D38), paid by the agency.                                                                  |

### 1.3 Non-goals (do not build)

Worker registry (a worker's total exists only as a row total inside one workplace's sheet) · pay, rates, overtime, tax, payslips · invoicing · digital ticket entry by workers or leaders · hours entered without a ticket · reading or updating the user's own Excel files · an Excel-like grid in the website · QR codes or serial numbers · mobile app · Hebrew UI · tracking missing or late tickets · dispute handling · any feature not in this file.

---

## 2. The paper ticket

A slip three quarters of an A4 page wide and a quarter high (157.5 × 74.25 mm), four per A4 page (the strip beside them is cut off, D32), generated once as a PDF and then printed or photocopied anywhere.

**Printed elements**

- Four solid black corner squares (6 mm), used to find and straighten the slip.
- A small version mark in one corner: `v1`.
- Field labels in Hebrew, with English beneath in smaller type.
- Character boxes in a light colour (pale blue, e.g. `#B8D4F0`), so box lines do not merge with ink.
- `:` in times and `/` in dates printed in place, so only digits are handwritten.
- A filled-in example strip at the top: a name in block letters and a time written `08:30`.

**Handwritten fields**

| Field key     | Label (HE / EN)        | Format                        |
| ------------- | ---------------------- | ----------------------------- |
| `firstName`   | שם פרטי / First name   | Block letters, 12 boxes       |
| `workplace`   | מקום עבודה / Workplace | Block letters, 15 boxes       |
| `date`        | תאריך / Date           | `DD/MM/YY`, one digit per box |
| `startTime`   | שעת התחלה / Start      | `HH:MM`, 24-hour              |
| `endTime`     | שעת סיום / End         | `HH:MM`, 24-hour              |
| `totalWorked` | סה"כ שעות / Total      | `HH:MM`, e.g. `08:30`         |

**The arithmetic check:** `end − start = total`. If `end < start`, the shift crossed midnight: add 24 hours to `end` first. The shift belongs to the date written (the start day).

**Field map.** Each template version has a field map in code (`packages/shared/src/templates/v1.ts`): the position of every field box as fractions of the marker frame, where (0, 0) is the centre of the top-left corner marker and (1, 1) the centre of the bottom-right one (D4). The PDF generator and the cropping step both read the same map, so they cannot drift apart.

---

## 3. Architecture

Three runtime processes from one TypeScript monorepo: the web app, the API, and the background worker. Postgres holds all state and the job queue. S3 holds files.

| Component  | Technology                                                                                 |
| ---------- | ------------------------------------------------------------------------------------------ |
| Monorepo   | pnpm workspaces, TypeScript strict, ESLint, Prettier                                       |
| Web app    | React 19, Vite, MUI, TanStack Query, React Router, React Hook Form with Zod                |
| API        | NestJS                                                                                     |
| Worker     | Same NestJS codebase, started with `MODE=worker`                                           |
| Database   | PostgreSQL 16, Prisma                                                                      |
| Queue      | pg-boss (on the same Postgres)                                                             |
| Files      | S3 via AWS SDK v3; MinIO locally                                                           |
| Images     | sharp; PDF pages rasterised with `pdftoppm` (poppler-utils, installed in the Docker image) |
| Ticket PDF | pdf-lib with an embedded Hebrew font (e.g. Noto Sans Hebrew)                               |
| Excel      | exceljs                                                                                    |
| Extraction | Anthropic API, vision-capable model, behind a `TicketExtractor` interface                  |
| Tests      | Vitest (shared, web, API), Playwright for one end-to-end flow                              |

**Repository layout**

```
/apps/web            React app
/apps/api            NestJS app (API and worker entry points)
/packages/shared     Zod schemas, types, rule checks, template field maps
/tools/poc           Phase 0 command-line scripts
/fixtures            Test images, fake extractor outputs, ground truth
/docker              Compose files, Caddyfile, Dockerfiles
/docs                PLAN.md, QUESTIONS.md, DECISIONS.md, PROGRESSION.md
```

**Interfaces that must stay swappable**

- `TicketExtractor.extract(image, template, pass): ExtractionResult`. Implementations: `AnthropicExtractor` (model name from env `EXTRACTOR_MODEL`; check Anthropic's docs for the current recommended vision model) and `FakeExtractor` (reads JSON from `/fixtures`). Tests never call the real API.
- `Exporter.export(monthId): Buffer`. Version 1 has `ExcelExporter` (6.2) and `WorkplacePdfExporter` (6.3).

**Request flow.** The browser asks the API for signed upload URLs and sends files straight to S3. It then calls "complete", which records each upload and queues one job per file. The worker splits PDFs into pages, processes each page as a ticket, and writes results and flags to Postgres. Each ticket joins the month of its date once the date is settled. The browser polls a progress endpoint. People resolve flags in the review screen. Downloads build the Excel file or the workplace PDFs on request; nothing is stored.

---

## 4. Processing pipeline (scanned tickets)

Each step writes its result before the next starts and checks for its own saved result first, so every step is idempotent and a crash resumes cleanly. Every answer from the reader is saved as it arrives, so a restarted job never pays for a reading twice (D43).

1. **Intake.** Check file type by content (JPEG, PNG, PDF only; reject others with a message), size limit 50 MB, PDF page limit 300. Compute SHA-256. A file with the same hash as an upload still held is reported as a duplicate and is not processed again. These checks run when the upload is confirmed, so the user hears at once; a refused or duplicate file is deleted (D42). A PDF becomes one ticket per page.
2. **Normalise.** Store each page as its own JPEG image (the ticket's original scan, used in the workplace PDFs; PDF pages at 200 dpi, photos turned upright without their metadata), then delete the uploaded file: one upload can hold tickets of two months, and each page is deleted with its own month. The normalised copy (EXIF rotation, greyscale JPEG, long edge capped at 2000 px) is made again each time the ticket is read, not stored (D42).
3. **Pre-checks.** Find the four corner markers and deskew/crop to the slip. Measure sharpness (variance of a Laplacian filter) and mean brightness. Failures raise `MARKERS_NOT_FOUND`, `IMAGE_BLURRY` or `IMAGE_DARK`. The ticket is still read, but these flags send it to a person. **Needs Liam's eyes:** thresholds are tuned on the Phase 0 set.
4. **Extraction, pass A.** Send the whole slip and the field list. The response must validate against the Zod schema: each field is `{ value: string | null, legible: boolean }`, plus `voided: boolean` and `overwrittenFields: string[]`. Invalid JSON counts as a failed attempt.
5. **Extraction, pass B.** Independent call with different prompt wording. If markers were found, send the whole slip and then each field's crop, enlarged (D29). Pass B never sees pass A's output.
   5a. **Extraction, pass C (tie-break, D27).** Only when a field is unreadable in either pass or the passes disagree: one more independent call, with its own wording, for those fields only. It never sees passes A or B. Its reading only improves the suggestion shown to the reviewer; it never settles a field or clears a flag.
6. **Compare and validate.** Normalise both passes (trim, digits only for date/time fields, name normalisation from section 5) and compare field by field. Then run the rule checks. Then group the workplace and check for possible duplicates (section 5). With a workplace list (D25) or a names list (D28), both passes naming the same entry, written like it and like no other entry, settles that field.
   6a. **Names from the same batch (D28).** After every ticket in the upload is read, names that raised no flag form a temporary list. A ticket whose name is still unclear and resembles one of them is read again (passes A and B) with those names added to the list. Only a name both passes settle from the list is taken; every other field and flag stays as first read. The temporary list is not stored.
   6b. **Total confirmed by the times (D30, ⚠ risky).** An unclear total is accepted only when both passes guess exactly end minus start, and start and end were both read with certainty.
   6c. **Month.** A ticket whose date is settled joins the month of that date; the month is created when its first ticket arrives. A ticket whose date is not settled waits, outside any month, until a person confirms the date in review. A date in a month that is already closed raises `MONTH_CLOSED`.
7. **Set status.** No flags → `verified` (with `verifiedHow = auto`), unless `REVIEW_EVERYTHING=true`, in which case → `needs_review` with no flags, for a one-click confirm. Any flag → `needs_review`. Extraction failed after retries → `needs_manual_entry`.

`REVIEW_EVERYTHING` ships set to `true`. It is turned off only after real use shows no unflagged errors.

### 4.1 Flags

| Code                                                | Raised when                                                                                                                    | Shown to the user as                                |
| --------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------- |
| `PASS_DISAGREEMENT`                                 | The two passes read a field differently                                                                                        | "The two readings disagree: 08:30 and 06:30"        |
| `FIELD_UNREADABLE`                                  | Either pass marked a field not legible                                                                                         | "Could not read the end time"                       |
| `FIELD_EMPTY`                                       | A field is blank on the paper (or only a dash or dot)                                                                          | "The end time is empty"                             |
| `CORRECTION_MARKS`                                  | Overwritten characters reported                                                                                                | "The total looks overwritten"                       |
| `VOIDED_TICKET`                                     | The ticket is crossed out                                                                                                      | "This ticket looks crossed out. Exclude it?"        |
| `TIME_INVALID`                                      | A start, end or total that is not a real time (25:00, 08:75, "8.5", "8")                                                       | "25:70 is not a real time"                          |
| `TIME_MATH_MISMATCH`                                | `end − start ≠ total` (midnight allowed)                                                                                       | "Start and end give 7:30, but total says 8:30"      |
| `HOURS_OUT_OF_RANGE`                                | Total is under `MIN_SHIFT_HOURS` (default 2, so 0 too) or above `MAX_SHIFT_HOURS` (default 16)                                 | "Total of 19:00 is unusually long"                  |
| `DATE_IN_FUTURE`                                    | Date is after today                                                                                                            | "The date is in the future"                         |
| `DATE_TOO_OLD`                                      | Date is more than `MAX_DATE_AGE_DAYS` (default 45) before today                                                                | "The date is more than 45 days ago"                 |
| `DATE_INVALID`                                      | Not a real calendar date                                                                                                       | "31/02 is not a real date"                          |
| `SCRIPT_UNEXPECTED`                                 | The name has characters that are not Hebrew or English letters (digits, other alphabets, symbols), or mixes Hebrew and English | "The name contains a digit — check the reading"     |
| `MARKERS_NOT_FOUND` / `IMAGE_BLURRY` / `IMAGE_DARK` | Pre-check failed                                                                                                               | "The scan is blurry"                                |
| `WORKPLACE_SIMILAR`                                 | The workplace is similar to, but not the same as, another in the month                                                         | "Is 'סופר-פארם' the same place as 'סופר פארם'?"     |
| `WORKPLACE_NOT_ON_LIST`                             | A workplace list is in use and neither reading matches an entry (D25)                                                          | "Is 'X' a new workplace?"                           |
| `MATCH_AMBIGUOUS`                                   | Both readings match a list entry, but the writing also resembles another entry (D25, D28)                                      | "Is this בית נוי or בית נוף?"                       |
| `POSSIBLE_DUPLICATE`                                | See 5.2                                                                                                                        | "There is already a ticket for Kwame here on 13/11" |
| `NAME_NOT_CONFIRMED`                                | The name has no confirmed spelling in English letters yet (5.2)                                                                | "Confirm the name in English letters"               |
| `MONTH_CLOSED`                                      | The ticket's date is in a month that is already closed (6.1)                                                                   | "November is already closed"                        |
| `EXTRACTION_ERROR`                                  | Extractor failed after retries                                                                                                 | "Could not read this ticket. Please type it in."    |

A flag is resolved only by a person: correcting the value, confirming it ("the paper really says this", logged), or excluding the ticket with a reason. Saving re-runs all rule checks on the saved values.

### 4.2 Statuses

| Level         | Values                                                                     |
| ------------- | -------------------------------------------------------------------------- |
| Ticket        | `processing`, `verified`, `needs_review`, `needs_manual_entry`, `excluded` |
| `verifiedHow` | `auto`, `confirmed`, `corrected`, `manual`                                 |
| Month         | `open`, `closing` (purge running), `closed`                                |

---

## 5. Names, workplaces and duplicates

### 5.1 Name normalisation (for comparison only; the export shows names as read)

Trim; collapse spaces; remove punctuation, quotes, geresh/gershayim and niqqud; unify Hebrew final letters (ך→כ, ם→מ, ן→נ, ף→פ, ץ→צ); lower-case Latin letters. Hyphens and spaces are treated as equal.

### 5.2 Workers: one row per confirmed name

There is no worker table. The Excel has one row per worker in each workplace's sheet (6.2), so every ticket gets a **confirmed name in English letters** (the agency writes all names in English):

- **Written in English and read with certainty:** the name as read.
- **Written in Hebrew:** the English spelling from the names list when the name was settled from a `Hebrew = English` line (5.4); otherwise `NAME_NOT_CONFIRMED`, and a person confirms the system's suggested spelling or types one.
- **Consistent spellings:** when a person confirms a name, the review screen first offers the names already used at that workplace in that month, so one worker is not spelt two ways.
- **Same confirmed name, same workplace, same month = one row.** Comparison ignores capital letters and extra spaces. Two different workers with the same name are told apart by the person confirming ("Kwame", "Kwame B"); only they can know.
- The month page lists, for every row, the tickets it is made of.

**`POSSIBLE_DUPLICATE`** is raised on both tickets when, within the month, two tickets have matching names (the same confirmed name, or before confirmation the same words after normalisation, in any order, or all words of one inside the other, e.g. "דוד" / "דוד כהן"; see D9 and D11), the same workplace group and the same date, whatever their times. The review screen shows both tickets side by side with three choices:

- **Replace the old one.** The new ticket is a correction: the old one is excluded with reason "replaced by" the new one, and leaves the Excel and the workplace PDF.
- **Keep both.** Two shifts, or two different people (then give one a different name). Both stay; on the same row and day, the Excel cell holds their sum.
- **Ignore the new one.** The same ticket scanned twice: the new one is excluded with reason "duplicate".

The system never chooses for the user.

### 5.3 Workplaces: grouped, with confirmation for similar spellings

- The agency's list of workplaces is given to the extractor (D25). When both readings name the same list entry and the handwriting resembles it, the workplace is that entry; otherwise it is flagged, and a workplace on no list is flagged as possibly new. A list line may give a place's spellings in both languages (`Dolev = דולב`); the Hebrew one is the place's name, used for its sheet and PDF (D36).
- Workplaces with the same normalised name are grouped automatically.
- A workplace whose normalised name is similar to another group's (Levenshtein distance ≤ 2, or one contains the other) raises `WORKPLACE_SIMILAR`. The user chooses **Same place** (merge, choosing the display name) or **Different place**. The decision applies to every ticket in both groups.
- Workplace groups exist only inside a month and are deleted with it.

### 5.4 The lists that help reading

There is one workplace list and one names list (D25, D28), shared by all months (D42): a ticket is read before its month is known. The user pastes them once, one entry per line (`Hebrew = English`, or two columns copied from Excel, give one entry's two spellings), and can replace either list at any time. Every confirmed name is added to the names list (with its Hebrew spelling as `Hebrew = English` when the ticket was in Hebrew), so the list keeps up with new workers. The lists are deleted when no month is open, so nothing is kept once every month is closed. The lists only help reading and suggest spellings; they never put a worker or a workplace in the Excel. Rows and sheets come only from that month's tickets.

---

## 6. Months, Excel, workplace PDFs and deletion

### 6.1 Month lifecycle

1. A month (e.g. "November 2026") is created when the first ticket dated in it arrives (step 6c). Several months can be open at once; early in a month, the previous one is usually still open.
2. The user uploads scans whenever they come, usually weekly. Uploads are not tied to a month: each ticket joins the month of its date.
3. The user reviews flagged tickets. Tickets that are not yet `verified` are left out of downloads, and the month page says how many are waiting ("12 tickets still need review").
4. Any time, the user downloads a fresh Excel (6.2) or the workplace PDFs (6.3). Each download is built from the current data and recorded.
5. Hours change only through tickets: **remove** a ticket (exclude it, with a reason), or scan a **new ticket**; the duplicate question (5.2) lets it **replace** the old one. There is no editing of hours without a ticket, so the Excel and the PDFs always agree with the paper.
6. When done (usually by the 10th of the next month), the user presses **Close month**, downloads the final Excel and PDFs, and types the month's name to confirm. Allowed only after at least one download of each. The purge (6.4) deletes everything and marks the month `closed`. From then on the final Excel is the user's own to change as they like.
7. A ticket dated in a closed month raises `MONTH_CLOSED`; the user excludes it and adds it to the final Excel by hand.

Months are purged automatically 60 days after their last day, after a warning banner shown from day 50.

### 6.2 Excel layout (strict)

The system creates the file and owns its layout; it is rebuilt from the data on every download. The layout only ever grows by a worker (a row) or a workplace (a sheet and a row on the totals sheet). Nothing else changes between downloads. Based on the agency's own monthly file (D37, D39). One `.xlsx` workbook, every sheet in right-to-left view.

**Sheet 1: `סה"כ שעות` (totals).** Row 1: headings. One row per workplace, in the same order as the sheets: column A the workplace's name, column B a formula pointing to that workplace sheet's grand total. A last row, `סה"כ`, adds them up (formula).

**One sheet per workplace**, sorted by name. Sheet name = the workplace's Hebrew name, made safe: remove `\ / ? * [ ] :`, cut to 31 characters, add ` (2)`, ` (3)` if two names collide after cutting.

| Where           | Content                                                                                                     |
| --------------- | ----------------------------------------------------------------------------------------------------------- |
| Row 1           | A1 `עובד`, B1:AF1 the days 1 to 31                                                                          |
| Row 2           | Empty                                                                                                       |
| From row 3      | One row per worker (5.2), sorted by name: column A the confirmed name, in English letters                   |
| Day cells       | That day's hours as a decimal number: exact minutes ÷ 60, shown with two decimals (8.33); empty if no shift |
| Column AG       | The worker's month total: `=SUM(B:AF)` of the row                                                           |
| Last row `סה"כ` | Each day's total and the grand total (formulas)                                                             |

**Sheet: `שמות` (names).** Each confirmed name once, sorted, with its Hebrew spelling when there is one (`Hebrew = English`). It can be uploaded as the names list (5.4).

**Sheet: `לא נכללו` (removed).** One row per excluded ticket: workplace, name, date, hours, reason (including "replaced by"), who removed it.

**Safety:** any text cell starting with `=`, `+`, `-` or `@` is written with a leading apostrophe, to prevent formula injection.

Pay columns are not in version 1. Columns live in one place in `ExcelExporter`, so adding them later touches nothing else.

### 6.3 Workplace PDFs

One PDF per workplace, with every non-excluded ticket of the month: each ticket's original scan as one page, sorted by date and then name. File name: the workplace's name and the month. Downloaded together as one ZIP, or one workplace at a time. The agency sends them to workplaces by email or WhatsApp; a ticket that is removed or replaced leaves its PDF too.

### 6.4 Deletion at close

| Deleted                                                                                                                                                           | Where                    |
| ----------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------ |
| Ticket page images and normalised images; any uploaded file still held                                                                                            | S3, every object version |
| Tickets, extractions, flags, workplace groups, download records, audit entries for the month; uploads with no tickets left; the lists, when no month is left open | Postgres                 |

| Kept                                                                                      | Why                                          |
| ----------------------------------------------------------------------------------------- | -------------------------------------------- |
| Month summary: name, created and closed dates, who closed it, ticket count, total minutes | Shows the month was processed, with no names |
| User accounts                                                                             | Login                                        |

- The purge is idempotent. If it fails halfway, the month stays `closing` and the purge retries until everything is gone.
- The S3 bucket has a lifecycle rule that expires non-current object versions after 1 day.
- Database backups are kept for 7 days, so deleted data is gone everywhere within a week.
- A closed month cannot be reopened.
- Downloads are built on request and not stored, so there are no export files to delete.

---

## 7. Data model (Prisma)

All tables have `id` (UUID), `createdAt`, `updatedAt`. Durations are integer minutes.

| Model            | Key fields                                                                                                                                                                                                                                                                                                                                                                    |
| ---------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `User`           | email (unique), passwordHash, role (`admin` / `reviewer`), disabledAt?, failedLogins, lockedUntil? (D41)                                                                                                                                                                                                                                                                      |
| `Invite`         | email, role, tokenHash, expiresAt, usedAt?                                                                                                                                                                                                                                                                                                                                    |
| `Session`        | userId, tokenHash, expiresAt, lastSeenAt                                                                                                                                                                                                                                                                                                                                      |
| `LoginFailure`   | ip (kept one day, for the limit per computer, D41)                                                                                                                                                                                                                                                                                                                            |
| `Month`          | year, month, status, closedAt?, closedById?, summaryTicketCount?, summaryTotalMinutes?, lastActivityAt                                                                                                                                                                                                                                                                        |
| `Upload`         | uploadedById, originalFilename, s3KeyOriginal? (cleared once split), sha256, mime, pageCount?, failedPages, speed (`batch` / `now`)                                                                                                                                                                                                                                           |
| `Ticket`         | uploadId, monthId? (set once the date is settled), pageIndex, s3KeyPage, templateVersion?, firstName? (as read), workerName? (confirmed, English letters), workplaceRaw?, workplaceGroupId?, shiftDate?, startMinutes?, endMinutes?, totalMinutes?, totalFromMath, status, verifiedHow?, excludedReason?, excludedById?, replacedById?, version (int, for optimistic locking) |
| `WorkplaceGroup` | monthId, displayName, normalisedName, mergedIntoId?                                                                                                                                                                                                                                                                                                                           |
| `ListEntry`      | kind (`workplace` / `name`), name (a place's Hebrew name, or the English spelling of a worker's name), spellings (text[], every other spelling)                                                                                                                                                                                                                               |
| `Reading`        | ticketId, pass (`A` / `B` / `C`), listsKey, answer (JSON: every field's value, legible and suggestion, and the ticket's marks), model, promptVersion, inputTokens, outputTokens (D43)                                                                                                                                                                                         |
| `Flag`           | ticketId, field?, code, detail (JSON), relatedTicketId?, resolvedAt?, resolvedById?, resolution?                                                                                                                                                                                                                                                                              |
| `AuditEntry`     | monthId?, userId, action, entity, entityId, before (JSON)?, after (JSON)?                                                                                                                                                                                                                                                                                                     |
| `Download`       | monthId, kind (`excel` / `pdfs`), userId                                                                                                                                                                                                                                                                                                                                      |

**Constraints**

- `Upload` is unique on `sha256` while it is held.
- A `closing` or `closed` month rejects writes to its tickets.
- A ticket's images are deleted with its month; an upload is deleted when it has no tickets left.
- `AuditEntry` and `Reading` are insert-only for the application; only the purge deletes them.

---

## 8. API

REST + JSON under `/api`. Every route except login and invite acceptance requires a session. Every body is validated with shared Zod schemas. Every state-changing route writes an `AuditEntry`.

| Method and path                                            | Purpose                                                                    | Role     |
| ---------------------------------------------------------- | -------------------------------------------------------------------------- | -------- |
| `POST /auth/login`, `POST /auth/logout`, `GET /auth/me`    | Session                                                                    | any      |
| `POST /auth/accept-invite`                                 | Set password from invite token                                             | public   |
| `GET /users`, `POST /users/invite`, `PATCH /users/:id`     | Manage users                                                               | admin    |
| `GET /months`, `GET /months/:id`                           | List; month summary with counts per status and its rows                    | reviewer |
| `POST /uploads/sign`                                       | Signed S3 PUT URLs for a number of files                                   | reviewer |
| `POST /uploads/complete`                                   | Confirm arrival, run the intake checks, queue processing                   | reviewer |
| `GET /progress`                                            | Counts by status, polled every 3 s                                         | reviewer |
| `GET /tickets?month=&status=&flag=`                        | Paged list; `month=none` for tickets waiting for a date                    | reviewer |
| `GET /tickets/:id`                                         | Ticket, flags, related tickets, signed image URL (5 min)                   | reviewer |
| `PUT /tickets/:id`                                         | Save values; re-runs checks; requires `version` (409 if stale)             | reviewer |
| `POST /tickets/:id/exclude`, `POST /tickets/:id/reprocess` | Exclude with reason; run pipeline again                                    | reviewer |
| `POST /flags/:id/resolve`                                  | Resolve duplicate (replace, keep both, ignore) or workplace decisions      | reviewer |
| `GET /months/:id/workplaces`                               | Workplace groups with ticket counts                                        | reviewer |
| `GET`, `PUT /lists/:kind`                                  | Read or replace the workplace or names list (pasted text)                  | reviewer |
| `GET /months/:id/excel`, `GET /months/:id/pdfs`            | Build and download; records the download                                   | reviewer |
| `POST /months/:id/close`                                   | Body: typed month name. 409 if the Excel or the PDFs were never downloaded | reviewer |
| `GET /templates/v1/pdf`                                    | Blank printable ticket PDF                                                 | reviewer |
| `GET /health`                                              | DB, S3 and queue check                                                     | public   |

---

## 9. Web app screens

| Screen                | Content                                                                                                                                                                                                                                                                                                                        |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Login / Accept invite | Email and password                                                                                                                                                                                                                                                                                                             |
| Home                  | Open months with counts ("November: 640 tickets, 12 need review"); tickets waiting for a date; **Upload** and **Review next** buttons                                                                                                                                                                                          |
| Month                 | Counts; **Review next**; **Download Excel** and **Workplace PDFs**; the tickets by workplace and row, with search and **Remove**; the lists; **Close month**                                                                                                                                                                   |
| Upload                | Drag and drop many files (PDF, JPEG, PNG). Per-file state: uploading, uploaded, failed with Retry. Before reading starts, the user picks **Speed** (Now / Batch) and **Reading quality** (Standard / Best) and sees the estimated price for this upload (D26). Batch is the default; there is no reading-quality choice (D43). |
| Review                | Described below                                                                                                                                                                                                                                                                                                                |
| Workplaces            | Workplace groups with counts; open `WORKPLACE_SIMILAR` questions as cards with **Same place** / **Different place**                                                                                                                                                                                                            |
| Admin                 | Users, invites                                                                                                                                                                                                                                                                                                                 |
| Ticket template       | Download the blank printable ticket                                                                                                                                                                                                                                                                                            |

**Review screen**

- One ticket at a time. Image on one side (zoom, pan, rotate); form on the other, in the same order as the paper.
- Flagged fields are highlighted with their plain-language reason (section 4.1).
- Focusing a field highlights its box on the image, using the template field map.
- `POSSIBLE_DUPLICATE` shows both tickets side by side with **Replace the old one** / **Keep both** / **Ignore the new one**.
- Confirming a name offers the names already used at that workplace this month first (5.2).
- Actions: **Confirm and next** (Enter), **Exclude** (reason required), **Reprocess**, **Skip**. Tab moves between flagged fields.
- The queue can be filtered by flag type.
- Manual entry is the same screen with an empty form.

**Feedback rules:** always show how many tickets are in each state and how many are left out of downloads. Nothing fails silently. No spinner without a count. Hebrew values render right-to-left inside the English interface (use `dir="auto"` on value fields).

---

## 10. Reliability

| Failure                         | Behaviour                                                               |
| ------------------------------- | ----------------------------------------------------------------------- |
| A file fails to upload          | That file shows "failed" with Retry; others continue                    |
| Browser closed mid-upload       | Finished files are kept; the dashboard shows what arrived               |
| Extractor error or rate limit   | Retry with exponential backoff, max 5 attempts                          |
| Invalid JSON from the extractor | Counts as a failed attempt                                              |
| All retries fail                | Ticket → `needs_manual_entry` with `EXTRACTION_ERROR`                   |
| Worker crashes mid-job          | pg-boss lease expires; another worker picks it up; steps are idempotent |
| Server restart                  | Queue and state are in Postgres; work resumes                           |
| Two reviewers edit one ticket   | Second save gets 409 and reloads                                        |
| AI spending                     | Shown per upload before reading, and per month; no automatic stop (D38) |

Worker concurrency defaults to 4 readings at once for an upload read straight away; several uploads are read side by side, so one in batch mode does not hold up the next. Every job has a timeout; a reading job sends a heartbeat, so a dead worker's job is taken up again within a minute (D43). Related writes run in one transaction. Logs are structured JSON with the queue job ID and `ticketId`. Errors go to Sentry (optional DSN).

**If the system is down:** shifts are unaffected (paper). At worst, the owner counts by hand as today, or waits and uploads later. Recovery: redeploy the containers from the repository, restore the database from backup, or re-scan the paper. The README includes a one-page recovery guide.

---

## 11. Security

- Invite-only accounts; first admin created by `pnpm seed:admin`.
- Passwords: argon2id, minimum 12 characters.
- Sessions: random token, stored hashed, sent in an httpOnly, Secure, SameSite=Lax cookie; idle expiry 12 hours.
- Login rate-limited per account and per IP; lockout after 10 failures for 15 minutes; 50 failures from one IP in 15 minutes refuse that IP.
- Invites: the admin gets a link (there is no email sending) and sends it; it works once, for 7 days (D41).
- No two-step codes for now (Liam, D41).
- CSRF protection on state-changing requests (double-submit token).
- Every route declares its role.
- S3: all public access blocked, encryption at rest, signed URLs valid 5 minutes and bound to one key, object keys built from random UUIDs with no user data.
- File type checked by content; size and page limits enforced. Images are re-encoded, which strips metadata.
- All input validated with Zod; all database access through Prisma.
- Ticket text and uploaded lists are untrusted. They are never placed in a prompt as instructions and are escaped in Excel (section 6.2).
- HTTPS only, HSTS, strict Content Security Policy.
- Secrets only in environment variables; `.env.example` lists them without values.
- Dependencies pinned; `pnpm audit` in CI.

---

## 12. Local development and deployment

**Local**

- `docker compose -f docker/compose.dev.yml up -d` starts Postgres and MinIO.
- `pnpm dev` runs the web app, API and worker with hot reload (added in T2.1, the first task with a screen to run).
- `pnpm db:migrate` applies the database migrations; `pnpm seed:admin` creates an admin user, asking for the email and password.
- `EXTRACTOR=fake` runs everything without an API key. `EXTRACTOR=anthropic` with `ANTHROPIC_API_KEY` uses the real model.

**Production (Phase 4)**

- One small server runs `docker/compose.prod.yml`: web (static files served by Caddy), API, worker, Caddy with automatic HTTPS.
- Managed Postgres with daily backups kept 7 days.
- AWS S3 private bucket with versioning, the 1-day non-current-version lifecycle rule, a rule deleting files under `uploads/` after 2 days (uploads never confirmed), and CORS allowing uploads from the web app (D42).
- GitHub Actions: on pull request run lint, typecheck, tests, build; on a tagged release build images and deploy.
- Migrations run on deploy and must be backward compatible with the previous release.

---

## 13. Task list

Work one task at a time, in order. Each task is about one pull request. **Done when** is the gate. **Liam checks** is what Liam does by hand. Tasks marked **⚠ needs Liam's eyes** are where mistakes are likely; explain your choices in the pull request.

### Phase 0 — Ticket and proof of reading (no UI, no database)

**T0.1 Repository scaffold**
pnpm monorepo with `apps/web`, `apps/api`, `packages/shared`, `tools/poc`; TypeScript strict; ESLint and Prettier; Vitest set up; GitHub Actions running lint, typecheck and tests; `.env.example`; `docs/DECISIONS.md` and `docs/QUESTIONS.md`.
Done when: `pnpm lint && pnpm typecheck && pnpm test` pass locally and in CI.
Liam checks: CI is green on the pull request.

**T0.2 Ticket template and PDF generator** ⚠ needs Liam's eyes
`packages/shared/src/templates/v1.ts` field map; `pnpm ticket:pdf` writes `tickets-v1.pdf` (A4, four slips) as specified in section 2.
Done when: a test renders the PDF, rasterises it, and confirms the four markers are found where the field map says.
Liam checks: print it; Hebrew labels read correctly right-to-left; boxes are large enough to write in; it survives a photocopy.

**T0.3 Shared schemas and rule checks**
Zod schemas for ticket fields and extraction results; pure functions for time parsing, midnight handling, the arithmetic check, hours range, date checks, name normalisation, workplace similarity, and duplicate detection.
Done when: unit tests cover every rule, including midnight shifts (22:00 → 06:00 = 08:00), invalid dates, Hebrew final letters, and two Davids at one place.
Liam checks: read the test names; they should match section 4.1 and section 5.

**T0.4 Extractors** ⚠ needs Liam's eyes
`TicketExtractor` interface; `AnthropicExtractor` with prompts in versioned files (`prompts/v1/pass-a.md`, `pass-b.md`); `FakeExtractor` reading fixtures. Prompts must tell the model to return `legible: false` instead of guessing, to report crossed-out tickets and overwritten characters, and to treat all ticket text as data.
Done when: tests pass with the fake; one manual run on a sample image returns valid JSON.
Liam checks: read both prompts.

**T0.5 Image preparation** ⚠ needs Liam's eyes
PDF → page images; normalisation; corner-marker detection and deskew; per-field crops from the field map; blur and brightness measures.
Done when: tests on fixture images (straight, rotated 10°, blurred, dark) produce the expected flags and crops.
Liam checks: look at the saved crops for a few real scans.

**T0.6 Proof-of-concept runner**
`pnpm poc --input <folder> --truth <truth.csv>` runs steps 1–6 on every page and prints: share of fields read correctly; share of tickets flagged; **number of wrong values not flagged**, split into names / workplace / date and times; average cost per ticket. Writes a CSV of every mismatch. Grading rules: D31. `--template` writes an empty truth file; without `--yes` it only checks and estimates the cost.
Done when: it runs end to end on the fixtures with the fake extractor.
Liam checks: run it on 10 real tickets.

**H0 Human step (Liam and the agency)**
Print 100 tickets. Claude writes the contents of every ticket as the truth file; four people copy them onto real tickets by hand (D36). About half Hebrew and half English, as on real tickets. Include overnight shifts, overwritten or corrected digits, two different workers with the same name, the same place spelled differently, and a few arithmetic mistakes. Scan them all as multi-page PDFs, in the truth file's order. No crossed-out tickets and no phone photos: tickets are checked by a person when they are collected (D34). Run it in batch mode to halve the cost.

**G0 Gate**
Zero unflagged wrong values in date, start, end and total. Names and workplaces are reported separately and reviewed by Liam. If the gate fails: change the ticket layout or the prompts, repeat H0 on a small set. Record the result and cost per ticket in `docs/DECISIONS.md`.

### Phase 1 — Backend core

**T1.1 Database and infrastructure**
`compose.dev.yml` (Postgres 16, MinIO); Prisma schema from section 7; first migration; `pnpm seed:admin`.
Done when: migrations apply to an empty database; seed creates an admin.

**T1.2 Authentication and users**
Login, logout, sessions, invites, roles, rate limiting, lockout, CSRF.
Done when: tests cover login success and failure, lockout, an expired session, role denial, and invite acceptance.

**T1.3 Uploads, months and lists**
Signed upload URLs; upload completion; intake checks; splitting into page images; queueing; months created from ticket dates; month list and summary; the workplace and names lists (5.4).
Done when: an integration test uploads a PDF and an image to MinIO and sees them queued; a duplicate file is detected; a list saved once is still there when a new month starts (D42).

**T1.4 Pipeline worker**
Steps 1–7 of section 4 as pg-boss jobs; retries; status and flag writing; tickets joining their month (6c).
Done when: an integration test with the fake extractor processes the fixture folder and every ticket ends in the expected status with the expected flags; killing the worker mid-run and restarting completes the run without duplicates.

**T1.5 Workplaces, names and duplicates**
Workplace grouping, `WORKPLACE_SIMILAR`, confirmed names and `NAME_NOT_CONFIRMED`, `POSSIBLE_DUPLICATE`, and their resolutions; the month summary's rows (section 8).
Done when: tests cover merging, rejecting a merge, a Hebrew name settled from a `Hebrew = English` line, replace, keep both and ignore.

**T1.6 Review API**
Ticket get, save (re-runs checks, optimistic locking), exclude, reprocess; progress endpoint, including files still being split; audit entries.
Done when: tests cover a correction, a stale save (409), and resolving every flag type.

### Phase 2 — Web app

**T2.1 App shell**
Routing, layout, login and invite pages, API client with TanStack Query, error and empty states; `pnpm dev`.
Liam checks: log in, log out, open a page without a session; try logging in with a wrong password 11 times (moved from T1.2).

**T2.2 Home, month page and upload**
Home with open months, month page with live progress and the tickets by workplace and row, multi-file upload with per-file state and retry.
Liam checks: upload 30 files, close the tab midway, reopen.

**T2.3 Review screen** ⚠ needs Liam's eyes
Image viewer, form, flag reasons, field highlighting, keyboard flow, name confirmation, duplicate comparison, manual entry.
Done when: a Playwright test reviews three flagged fixture tickets with the keyboard only.
Liam checks: review 20 real tickets; time how long it takes.

**T2.4 Workplaces and lists**
Groups, similar-name questions, and uploading or replacing the lists.

**T2.5 Admin**
Users and invites.

Phase 2 gate: one person takes the Phase 0 set from upload to zero open tickets using only the browser.

### Phase 3 — Excel, workplace PDFs and deletion

**T3.1 Excel exporter** ⚠ needs Liam's eyes
Section 6.2 exactly.
Done when: a test builds a month's file, reopens it with exceljs, and checks every sheet, the rows per worker, a day with two kept tickets, the formulas, RTL view, safe sheet names and formula-injection escaping.
Liam checks: open it in Excel with the owner; it looks like their own file; totals match the paper.

**T3.2 Workplace PDFs**
Section 6.3 exactly.
Done when: a test builds the PDFs for a month and finds every non-excluded ticket in its workplace's PDF, in date order, and no removed or replaced ticket.
Liam checks: open a few PDFs.

**T3.3 Close and purge**
Download recording, close with typed confirmation, purge, 60-day auto-purge.
Done when: an integration test closes a month and then finds no rows for it in any table (except the summary) and no objects for its tickets in S3, while another open month is untouched.

Phase 3 gate: Excel totals for the Phase 0 set match `truth.csv` exactly. This is the "see it work locally" milestone.

### Phase 4 — Hardening and deployment

**T4.1** Security pass against section 11.
**T4.2** Logging, Sentry, `/health`, backup and restore test, recovery guide in the README.
**T4.3** `compose.prod.yml`, Caddy, Dockerfiles, deploy workflow.
**T4.4 Pilot** One real month in parallel with the manual count.

Phase 4 gate: the pilot output matches the manual count, or every difference is explained, and human time is clearly lower than today. Measure both.

---

## 14. Open items

- Pay and rate columns: rules unknown; not in version 1.
- Whether the worker should also sign the ticket.
- Exact Excel styling: confirm with the associates after T3.1.
- The totals sheet's pay-rate columns (regular, morning, `*55`, `*60`) in the agency's file: not in version 1.
