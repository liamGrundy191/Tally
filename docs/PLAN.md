# Shift Ticket Processing System — Build Plan

Version 2 · 18 Nov 2026 · Owner: Liam

This is the complete specification. It is written for Claude Code, which writes most of the code. Claude Code also opens and merges the pull requests. Liam oversees and runs the checks that need a person. Read `CLAUDE.md` for the working rules, then this file top to bottom before starting any task.

---

## 1. What we are building

A staffing agency sends temporary workers to many workplaces. For every shift, the shift leader fills in a paper ticket per worker. Today the owner and his associates count hundreds of these tickets by hand to produce Excel sheets of hours per workplace. That takes many hours each month.

This system turns scanned tickets into those Excel sheets. The AI reads the tickets; rules and people verify every value; nothing is guessed. After the Excel file is exported and the user confirms it, all data for that job is deleted.

**Success** means a meaningful cut in human hours compared with the manual count, with results that match the paper.

### 1.1 Principles (non-negotiable)

1. **No silent guesses.** A value reaches an export only if it passed every rule check, was confirmed by a person, was typed by a person, or was imported from an earlier export. Anything else is flagged with a specific, plain-language reason.
2. **"Unreadable" is a valid answer.** The extractor returns `legible: false` rather than its best guess. Prompts, schemas and code must make that the easy path. It may add its best guess as a separate `suggestion`, which is shown to the reviewer and never used as a value (D24).
3. **Never merge people.** Each ticket is one row in the output. The system never decides that two tickets belong to the same worker and never combines them.
4. **One ticket never breaks a batch.** Every ticket is processed independently. A failure becomes a ticket that needs manual entry, never a failed request.
5. **Nothing is lost while a job is open.** Original files are immutable until the job is closed. All state lives in Postgres, so any process can crash and resume.
6. **Keep data for the shortest time possible.** When the user confirms the final export, the job's files and records are permanently deleted.
7. **Paper is the source of truth.** The system speeds up counting. If it is down, the owner counts by hand, as today.
8. **Every change is attributable.** Each correction records who, when, the old value and the new value (until the job is deleted).
9. **Speed is secondary.** A batch taking 20 minutes is fine. Clear status and correctness are not negotiable.
10. **Simple for non-technical users.** Every screen has one obvious next action, plain words, and no data-losing action without confirmation.

### 1.2 Decisions already made — do not revisit

| Topic             | Decision                                                                                                                                                                                 |
| ----------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Input             | Paper tickets, one per worker per shift, filled in by the shift leader. Collected at the office and scanned (sheet-fed scanner PDF preferred; phone photos accepted as JPEG/PNG).        |
| Ticket            | Plain slip, four per A4 page, photocopiable. **No QR code, no serial number.**                                                                                                           |
| Ticket fields     | First name, workplace, date, start time, end time, total worked. **No last name** (the owner decided it is not needed). **No break field** (breaks are paid). **No shift leader field.** |
| Handwriting       | Mainly Hebrew, occasionally English.                                                                                                                                                     |
| UI language       | English. Hebrew values must display correctly (right-to-left) inside it.                                                                                                                 |
| Rounding          | None. Minutes are kept exactly as written.                                                                                                                                               |
| Workers           | No worker register, no IDs, no grouping; an uploaded list of first names only helps reading (D28). Different workers often share a name, even at the same place and time.                |
| Workplaces        | Handwritten; they come and go. Grouped by name so each gets its own Excel sheet. Similar spellings are merged only after a person confirms.                                              |
| Jobs              | The user creates a job, uploads one or more files, reviews, exports one Excel file. Many jobs per month. No fixed date ranges.                                                           |
| Month-end combine | A job can import earlier exported Excel files (plus new scans) and export one combined file. Imported rows are trusted as they are.                                                      |
| Pay and rates     | Not in version 1. Excel shows hours only. Pay columns may be added later.                                                                                                                |
| Retention         | After the final export is downloaded and confirmed, the job is deleted. Nothing is kept between jobs except an anonymous summary.                                                        |
| Users             | The owner and a few associates, on laptops. Invite-only accounts.                                                                                                                        |
| AI                | Ticket images are sent to the Anthropic API. The owner has approved this.                                                                                                                |
| Budget            | Tens of dollars per month, paid by the agency, after the local proof works.                                                                                                              |

### 1.3 Non-goals (do not build)

Worker registry or worker totals · pay, rates, overtime, tax, payslips · invoicing · digital ticket entry by workers or leaders · QR codes or serial numbers · mobile app · Hebrew UI · tracking missing or late tickets · dispute handling · any feature not in this file.

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
/docs                PLAN.md, QUESTIONS.md, DECISIONS.md
```

**Interfaces that must stay swappable**

- `TicketExtractor.extract(image, template, pass): ExtractionResult`. Implementations: `AnthropicExtractor` (model name from env `EXTRACTOR_MODEL`; check Anthropic's docs for the current recommended vision model) and `FakeExtractor` (reads JSON from `/fixtures`). Tests never call the real API.
- `Exporter.export(jobId): Buffer`. Version 1 has `ExcelExporter` only.
- `Importer.import(jobId, file): ImportReport`. Version 1 has `ExcelImporter` for this system's own exports.

**Request flow.** The browser asks the API for signed upload URLs and sends files straight to S3. It then calls "complete", which records each upload and queues one job per file. The worker splits PDFs into pages, processes each page as a ticket, and writes results and flags to Postgres. The browser polls a progress endpoint. People resolve flags in the review screen. Export builds the Excel file in the worker.

---

## 4. Processing pipeline (scanned tickets)

Each step writes its result before the next starts and checks for its own saved result first, so every step is idempotent and a crash resumes cleanly.

1. **Intake.** Check file type by content (JPEG, PNG, PDF only; reject others with a message), size limit 50 MB, PDF page limit 300. Compute SHA-256. A file with the same hash already in this job raises `DUPLICATE_IMAGE` on the upload and is not processed again. A PDF becomes one ticket per page.
2. **Normalise.** Apply EXIF rotation, convert to greyscale JPEG, cap the long edge at 2000 px. Keep the original untouched; store the normalised copy beside it.
3. **Pre-checks.** Find the four corner markers and deskew/crop to the slip. Measure sharpness (variance of a Laplacian filter) and mean brightness. Failures raise `MARKERS_NOT_FOUND`, `IMAGE_BLURRY` or `IMAGE_DARK`. The ticket is still read, but these flags send it to a person. **Needs Liam's eyes:** thresholds are tuned on the Phase 0 set.
4. **Extraction, pass A.** Send the whole slip and the field list. The response must validate against the Zod schema: each field is `{ value: string | null, legible: boolean }`, plus `voided: boolean` and `overwrittenFields: string[]`. Invalid JSON counts as a failed attempt.
5. **Extraction, pass B.** Independent call with different prompt wording. If markers were found, send the whole slip and then each field's crop, enlarged (D29). Pass B never sees pass A's output.
   5a. **Extraction, pass C (tie-break, D27).** Only when a field is unreadable in either pass or the passes disagree: one more independent call, with its own wording, for those fields only. It never sees passes A or B. Its reading only improves the suggestion shown to the reviewer; it never settles a field or clears a flag.
6. **Compare and validate.** Normalise both passes (trim, digits only for date/time fields, name normalisation from section 5) and compare field by field. Then run the rule checks. Then group the workplace and check for possible duplicates (section 5). With a workplace list (D25) or a names list (D28), both passes naming the same entry, written like it and like no other entry, settles that field.
   6a. **Names from the same batch (D28).** After every ticket in the upload is read, names that raised no flag form a temporary list. A ticket whose name is still unclear and resembles one of them is read again (passes A and B) with those names added to the list. Only a name both passes settle from the list is taken; every other field and flag stays as first read. The temporary list is not stored.
   6b. **Total confirmed by the times (D30, ⚠ risky).** An unclear total is accepted only when both passes guess exactly end minus start, and start and end were both read with certainty.
7. **Set status.** No flags → `verified` (with `verifiedHow = auto`), unless `REVIEW_EVERYTHING=true`, in which case → `needs_review` with no flags, for a one-click confirm. Any flag → `needs_review`. Extraction failed after retries → `needs_manual_entry`.

`REVIEW_EVERYTHING` ships set to `true`. It is turned off only after real use shows no unflagged errors.

### 4.1 Flags

| Code                                                | Raised when                                                                                                                    | Shown to the user as                                        |
| --------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------- |
| `PASS_DISAGREEMENT`                                 | The two passes read a field differently                                                                                        | "The two readings disagree: 08:30 and 06:30"                |
| `FIELD_UNREADABLE`                                  | Either pass marked a field not legible                                                                                         | "Could not read the end time"                               |
| `FIELD_EMPTY`                                       | A field is blank on the paper (or only a dash or dot)                                                                          | "The end time is empty"                                     |
| `CORRECTION_MARKS`                                  | Overwritten characters reported                                                                                                | "The total looks overwritten"                               |
| `VOIDED_TICKET`                                     | The ticket is crossed out                                                                                                      | "This ticket looks crossed out. Exclude it?"                |
| `TIME_INVALID`                                      | A start, end or total that is not a real time (25:00, 08:75, "8.5", "8")                                                       | "25:70 is not a real time"                                  |
| `TIME_MATH_MISMATCH`                                | `end − start ≠ total` (midnight allowed)                                                                                       | "Start and end give 7:30, but total says 8:30"              |
| `HOURS_OUT_OF_RANGE`                                | Total is under `MIN_SHIFT_HOURS` (default 2, so 0 too) or above `MAX_SHIFT_HOURS` (default 16)                                 | "Total of 19:00 is unusually long"                          |
| `DATE_IN_FUTURE`                                    | Date is after today                                                                                                            | "The date is in the future"                                 |
| `DATE_TOO_OLD`                                      | Date is more than `MAX_DATE_AGE_DAYS` (default 45) before today                                                                | "The date is more than 45 days ago"                         |
| `DATE_INVALID`                                      | Not a real calendar date                                                                                                       | "31/02 is not a real date"                                  |
| `SCRIPT_UNEXPECTED`                                 | The name has characters that are not Hebrew or English letters (digits, other alphabets, symbols), or mixes Hebrew and English | "The name contains a digit — check the reading"             |
| `MARKERS_NOT_FOUND` / `IMAGE_BLURRY` / `IMAGE_DARK` | Pre-check failed                                                                                                               | "The scan is blurry"                                        |
| `WORKPLACE_SIMILAR`                                 | The workplace is similar to, but not the same as, another in the job                                                           | "Is 'סופר-פארם' the same place as 'סופר פארם'?"             |
| `WORKPLACE_NOT_ON_LIST`                             | A workplace list is in use and neither reading matches an entry (D25)                                                          | "Is 'X' a new workplace?"                                   |
| `MATCH_AMBIGUOUS`                                   | Both readings match a list entry, but the writing also resembles another entry (D25, D28)                                      | "Is this בית נוי or בית נוף?"                               |
| `POSSIBLE_DUPLICATE`                                | See 5.2                                                                                                                        | "Same name, place, date and overlapping times as ticket 14" |
| `EXTRACTION_ERROR`                                  | Extractor failed after retries                                                                                                 | "Could not read this ticket. Please type it in."            |

A flag is resolved only by a person: correcting the value, confirming it ("the paper really says this", logged), or excluding the ticket with a reason. Saving re-runs all rule checks on the saved values.

### 4.2 Statuses

| Level         | Values                                                                     |
| ------------- | -------------------------------------------------------------------------- |
| Ticket        | `processing`, `verified`, `needs_review`, `needs_manual_entry`, `excluded` |
| `verifiedHow` | `auto`, `confirmed`, `corrected`, `manual`, `imported`                     |
| Job           | `open`, `locked` (final export made), `closing` (purge running), `closed`  |

---

## 5. Names, workplaces and duplicates

### 5.1 Name normalisation (for comparison only; the export shows names as read)

Trim; collapse spaces; remove punctuation, quotes, geresh/gershayim and niqqud; unify Hebrew final letters (ך→כ, ם→מ, ן→נ, ף→פ, ץ→צ); lower-case Latin letters. Hyphens and spaces are treated as equal.

### 5.2 Workers: never grouped

Each ticket is one output row. There is no worker table.

**`POSSIBLE_DUPLICATE`** is raised on both tickets when, within the job, two tickets have matching names (same words after normalisation, in any order, or all words of one inside the other, e.g. "דוד" / "דוד כהן"; see D9 and D11), the same workplace group, the same date, and overlapping times (back-to-back shifts do not overlap; unknown times count as overlapping). This covers imported rows too. The review screen shows both tickets side by side with two choices:

- **Keep both — different people.** Both are cleared of the flag.
- **Exclude one — same ticket twice.** The chosen ticket is excluded with reason "duplicate".

The system never chooses for the user.

### 5.3 Workplaces: grouped, with confirmation for similar spellings

- The agency's list of workplaces is given to the extractor (D25). When both readings name the same list entry and the handwriting resembles it, the workplace is that entry; otherwise it is flagged, and a workplace on no list is flagged as possibly new.

- Workplaces with the same normalised name are grouped automatically.
- A workplace whose normalised name is similar to another group's (Levenshtein distance ≤ 2, or one contains the other) raises `WORKPLACE_SIMILAR`. The user chooses **Same place** (merge, choosing the display name) or **Different place**. The decision applies to every ticket in both groups.
- Workplace groups exist only inside a job and are deleted with it.

---

## 6. Jobs, export, import and deletion

### 6.1 Job lifecycle

1. The user creates a job with a name (e.g. "Week 3 Nov" or "November total").
2. The user uploads scans and/or earlier exported Excel files, in as many batches as they like.
3. The user reviews until every ticket is `verified` or `excluded` and no `WORKPLACE_SIMILAR` or `POSSIBLE_DUPLICATE` flag is open. Until then, the Export button is disabled with the reason shown ("12 tickets still need review").
4. The user exports. The job becomes `locked`; no ticket can change. (An admin can unlock; logged.)
5. The user downloads the file. The download is recorded.
6. The user presses **Close and delete** and types the job name to confirm. Allowed only after at least one download.
7. The purge job deletes everything (6.4) and marks the job `closed`.

Open jobs untouched for 60 days are purged automatically after a warning banner shown from day 50.

### 6.2 Excel export

One `.xlsx` workbook. Every sheet uses right-to-left view (`views: [{ rightToLeft: true }]`).

**Sheet 1 — `סיכום` (Summary)**

| Column      | Content                                                                     |
| ----------- | --------------------------------------------------------------------------- |
| Workplace   | Display name                                                                |
| Shifts      | Number of non-excluded tickets (formula `COUNTA` over that workplace sheet) |
| Total hours | Sum of that workplace sheet's hours (formula), shown as `[h]:mm`            |

A final row totals all workplaces (formulas).

**One sheet per workplace.** Sheet name = workplace display name, made safe: remove `\ / ? * [ ] :`, cut to 31 characters, add ` (2)`, ` (3)` if two names collide after cutting. The full name is in cell A1 as a title.

| Column   | Content                                                             |
| -------- | ------------------------------------------------------------------- |
| `row_id` | Hidden column. Stable ID of the ticket row (UUID). Used for import. |
| Date     | Excel date, displayed `DD/MM/YYYY`                                  |
| Worker   | First name, exactly as read or corrected                            |
| Start    | Excel time, `HH:MM`                                                 |
| End      | Excel time, `HH:MM`                                                 |
| Total    | Excel duration, `[h]:mm` — exact minutes, no rounding               |
| Hours    | Decimal hours (e.g. 8.1167), for anyone who wants to multiply       |
| Source   | Scan file name and page, or "imported: <file name>"                 |
| Verified | `auto`, `confirmed`, `corrected`, `manual` or `imported`            |

Rows are sorted by date, then start time. Each row is one ticket. Nothing is merged or totalled per worker.

**Sheet — `שמות` (Names).** Each confirmed first name once, sorted, nothing else. The user keeps it and uploads it as the names list for the next job (D28). Ignored on import.

**Sheet — `לא נכללו` (Excluded).** One row per excluded ticket: source, workplace, worker, date, reason, who excluded it. Ignored on import.

**Sheet — `_meta`.** Set to `veryHidden`. Contains: `format = shift-tickets`, `formatVersion = 1`, `jobId`, `exportedAt`, and one row per exported ticket: `row_id`, workplace full name, fingerprint. The fingerprint is the first 16 hex characters of SHA-256 over the canonical row values (date, worker, start, end, total, workplace).

**Safety:** any text cell starting with `=`, `+`, `-` or `@` is written with a leading apostrophe, to prevent formula injection.

Pay columns are not in version 1. Columns live in one place in `ExcelExporter`, so adding them later touches nothing else.

### 6.3 Excel import (month-end combine)

The user uploads an earlier export into a job. The importer:

1. Rejects the file with a plain reason if `_meta` is missing or `format` is not `shift-tickets` ("This file was not exported by the system, or its hidden information was removed"). Fallback: re-scan that batch.
2. Reads every workplace sheet (all sheets except Summary, Excluded and `_meta`). The workplace is the full name from `_meta` for known sheets, or the sheet name for sheets added by hand.
3. Compares rows with `_meta`. It produces a one-line report: "Batch file X: 120 rows, 2 changed, 1 added, 0 removed since export". The report is shown, not blocking.
4. Creates one ticket per row with `source = import`, status `verified`, `verifiedHow = imported`. Imported rows are trusted: they are not re-checked or flagged, except as below.
5. A row whose values cannot be parsed (e.g. a time typed as "eight") becomes `needs_manual_entry`, showing the raw cell values instead of an image.
6. If a file with the same `jobId` was already imported into this job, the user sees a dismissible warning: "This file was already added."
7. Imported rows take part in workplace grouping and `POSSIBLE_DUPLICATE` checks, like scanned tickets.

`formatVersion` lets later versions read older files. Never change the meaning of version 1.

### 6.4 Deletion at close

| Deleted                                                                           | Where                    |
| --------------------------------------------------------------------------------- | ------------------------ |
| Uploaded files and normalised images                                              | S3, every object version |
| Export files                                                                      | S3, every object version |
| Tickets, extractions, flags, workplace groups, uploads, audit entries for the job | Postgres                 |

| Kept                                                                                    | Why                                        |
| --------------------------------------------------------------------------------------- | ------------------------------------------ |
| Job summary: name, created and closed dates, who closed it, ticket count, total minutes | Shows the job was processed, with no names |
| User accounts                                                                           | Login                                      |

- The purge is idempotent. If it fails halfway, the job stays `closing` and the job retries until everything is gone.
- The S3 bucket has a lifecycle rule that expires non-current object versions after 1 day.
- Database backups are kept for 7 days, so deleted data is gone everywhere within a week.
- A closed job cannot be reopened. To redo it, scan the paper again into a new job.

---

## 7. Data model (Prisma)

All tables have `id` (UUID), `createdAt`, `updatedAt`. Durations are integer minutes.

| Model             | Key fields                                                                                                                                                                                                                                                                                                                           |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `User`            | email (unique), passwordHash, role (`admin` / `reviewer`), totpSecret?, disabledAt?                                                                                                                                                                                                                                                  |
| `Invite`          | email, role, tokenHash, expiresAt, usedAt?                                                                                                                                                                                                                                                                                           |
| `Session`         | userId, tokenHash, expiresAt, lastSeenAt                                                                                                                                                                                                                                                                                             |
| `Job`             | name, status, createdById, lockedAt?, closedAt?, closedById?, summaryTicketCount?, summaryTotalMinutes?, lastActivityAt                                                                                                                                                                                                              |
| `Upload`          | jobId, kind (`scan` / `excel_import`), originalFilename, s3KeyOriginal, sha256, mime, pageCount?, importReport (JSON)?                                                                                                                                                                                                               |
| `Ticket`          | jobId, uploadId, source (`scan` / `import`), pageIndex?, s3KeyNormalised?, templateVersion?, firstName?, workplaceRaw?, workplaceGroupId?, shiftDate?, startMinutes?, endMinutes?, totalMinutes?, status, verifiedHow?, excludedReason?, excludedById?, importRowId?, importRawValues (JSON)?, version (int, for optimistic locking) |
| `WorkplaceGroup`  | jobId, displayName, normalisedName, mergedIntoId?                                                                                                                                                                                                                                                                                    |
| `FieldExtraction` | ticketId, field, pass (`A` / `B`), value?, legible, model, promptVersion                                                                                                                                                                                                                                                             |
| `Flag`            | ticketId, field?, code, detail (JSON), relatedTicketId?, resolvedAt?, resolvedById?, resolution?                                                                                                                                                                                                                                     |
| `AuditEntry`      | jobId?, userId, action, entity, entityId, before (JSON)?, after (JSON)?                                                                                                                                                                                                                                                              |
| `Export`          | jobId, s3Key, dataHash, createdById, downloadedAt?                                                                                                                                                                                                                                                                                   |

**Constraints**

- `Upload` is unique on (`jobId`, `sha256`).
- A `locked`, `closing` or `closed` job rejects writes to its tickets.
- `AuditEntry` and `FieldExtraction` are insert-only for the application; only the purge deletes them.

---

## 8. API

REST + JSON under `/api`. Every route except login and invite acceptance requires a session. Every body is validated with shared Zod schemas. Every state-changing route writes an `AuditEntry`.

| Method and path                                            | Purpose                                                        | Role     |
| ---------------------------------------------------------- | -------------------------------------------------------------- | -------- |
| `POST /auth/login`, `POST /auth/logout`, `GET /auth/me`    | Session                                                        | any      |
| `POST /auth/accept-invite`                                 | Set password from invite token                                 | public   |
| `GET /users`, `POST /users/invite`, `PATCH /users/:id`     | Manage users                                                   | admin    |
| `GET /jobs`, `POST /jobs`, `GET /jobs/:id`                 | List, create, job summary with counts per status               | reviewer |
| `POST /jobs/:id/uploads/sign`                              | Signed S3 PUT URLs for a list of files                         | reviewer |
| `POST /jobs/:id/uploads/complete`                          | Confirm arrival, queue processing or import                    | reviewer |
| `GET /jobs/:id/progress`                                   | Counts by status, polled every 3 s                             | reviewer |
| `GET /jobs/:id/tickets?status=&flag=`                      | Paged list                                                     | reviewer |
| `GET /tickets/:id`                                         | Ticket, flags, related tickets, signed image URL (5 min)       | reviewer |
| `PUT /tickets/:id`                                         | Save values; re-runs checks; requires `version` (409 if stale) | reviewer |
| `POST /tickets/:id/exclude`, `POST /tickets/:id/reprocess` | Exclude with reason; run pipeline again                        | reviewer |
| `POST /flags/:id/resolve`                                  | Resolve duplicate or workplace decisions                       | reviewer |
| `GET /jobs/:id/workplaces`                                 | Workplace groups with ticket counts                            | reviewer |
| `POST /jobs/:id/export`                                    | Build final export (409 with blocking reasons if not ready)    | reviewer |
| `GET /exports/:id/download`                                | Signed download URL; records the download                      | reviewer |
| `POST /jobs/:id/close`                                     | Body: typed job name. 409 if never downloaded                  | reviewer |
| `POST /jobs/:id/unlock`                                    | Unlock a locked job                                            | admin    |
| `GET /templates/v1/pdf`                                    | Blank printable ticket PDF                                     | reviewer |
| `GET /health`                                              | DB, S3 and queue check                                         | public   |

---

## 9. Web app screens

| Screen                | Content                                                                                                                                                                                                                                                                                                        |
| --------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Login / Accept invite | Email and password; optional one-time code                                                                                                                                                                                                                                                                     |
| Jobs                  | List of jobs with status and counts; "New job" button                                                                                                                                                                                                                                                          |
| Job dashboard         | Progress ("142 of 310 read, 23 need review"); upload area; **Review next** button; Workplaces button; Export button with the reason it is disabled; after export, Download and **Close and delete**                                                                                                            |
| Upload                | Drag and drop many files (PDF, JPEG, PNG, XLSX). Per-file state: uploading, uploaded, failed with Retry. Excel imports show their one-line report. Before reading starts, the user picks **Speed** (Now / Batch) and **Reading quality** (Standard / Best) and sees the estimated price for this upload (D26). |
| Review                | Described below                                                                                                                                                                                                                                                                                                |
| Workplaces            | Workplace groups with counts; open `WORKPLACE_SIMILAR` questions as cards with **Same place** / **Different place**                                                                                                                                                                                            |
| Admin                 | Users, invites                                                                                                                                                                                                                                                                                                 |
| Ticket template       | Download the blank printable ticket                                                                                                                                                                                                                                                                            |

**Review screen**

- One ticket at a time. Image on one side (zoom, pan, rotate); form on the other, in the same order as the paper.
- Flagged fields are highlighted with their plain-language reason (section 4.1).
- Focusing a field highlights its box on the image, using the template field map.
- `POSSIBLE_DUPLICATE` shows both tickets side by side with **Keep both** / **Exclude one**.
- Imported rows needing manual entry show their raw cell values instead of an image.
- Actions: **Confirm and next** (Enter), **Exclude** (reason required), **Reprocess**, **Skip**. Tab moves between flagged fields.
- The queue can be filtered by flag type.
- Manual entry is the same screen with an empty form.

**Feedback rules:** always show how many tickets are in each state and what blocks export. Nothing fails silently. No spinner without a count. Hebrew values render right-to-left inside the English interface (use `dir="auto"` on value fields).

---

## 10. Reliability

| Failure                         | Behaviour                                                                                                 |
| ------------------------------- | --------------------------------------------------------------------------------------------------------- |
| A file fails to upload          | That file shows "failed" with Retry; others continue                                                      |
| Browser closed mid-upload       | Finished files are kept; the dashboard shows what arrived                                                 |
| Extractor error or rate limit   | Retry with exponential backoff, max 5 attempts                                                            |
| Invalid JSON from the extractor | Counts as a failed attempt                                                                                |
| All retries fail                | Ticket → `needs_manual_entry` with `EXTRACTION_ERROR`                                                     |
| Worker crashes mid-job          | pg-boss lease expires; another worker picks it up; steps are idempotent                                   |
| Server restart                  | Queue and state are in Postgres; work resumes                                                             |
| Two reviewers edit one ticket   | Second save gets 409 and reloads                                                                          |
| AI spending runs high           | Per-job and per-month caps (`SPEND_CAP_JOB_USD`, `SPEND_CAP_MONTH_USD`) pause the queue and show a banner |

Worker concurrency defaults to 4. Every job has a timeout. Related writes run in one transaction. Logs are structured JSON with `jobId` and `ticketId`. Errors go to Sentry (optional DSN).

**If the system is down:** shifts are unaffected (paper). At worst, the owner counts by hand as today, or waits and uploads later. Recovery: redeploy the containers from the repository, restore the database from backup, or re-scan the paper into a new job. The README includes a one-page recovery guide.

---

## 11. Security

- Invite-only accounts; first admin created by `pnpm seed:admin`.
- Passwords: argon2id, minimum 12 characters.
- Sessions: random token, stored hashed, sent in an httpOnly, Secure, SameSite=Lax cookie; idle expiry 12 hours.
- Login rate-limited per account and per IP; lockout after 10 failures for 15 minutes.
- Optional TOTP; required for admins before real data is loaded.
- CSRF protection on state-changing requests (double-submit token).
- Every route declares its role.
- S3: all public access blocked, encryption at rest, signed URLs valid 5 minutes and bound to one key, object keys are random UUIDs.
- File type checked by content; size and page limits enforced. Images are re-encoded, which strips metadata.
- All input validated with Zod; all database access through Prisma.
- Ticket text and imported cells are untrusted. They are never placed in a prompt as instructions and are escaped in Excel (section 6.2).
- HTTPS only, HSTS, strict Content Security Policy.
- Secrets only in environment variables; `.env.example` lists them without values.
- Dependencies pinned; `pnpm audit` in CI.

---

## 12. Local development and deployment

**Local**

- `docker compose -f docker/compose.dev.yml up -d` starts Postgres and MinIO.
- `pnpm dev` runs the web app, API and worker with hot reload.
- `pnpm seed:admin` creates an admin user.
- `EXTRACTOR=fake` runs everything without an API key. `EXTRACTOR=anthropic` with `ANTHROPIC_API_KEY` uses the real model.

**Production (Phase 4)**

- One small server runs `docker/compose.prod.yml`: web (static files served by Caddy), API, worker, Caddy with automatic HTTPS.
- Managed Postgres with daily backups kept 7 days.
- AWS S3 private bucket with versioning and the 1-day non-current-version lifecycle rule.
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
Print about 150 tickets. Five or more people fill them in, mostly Hebrew, some English, some careless. Include overnight shifts, crossed-out tickets, overwritten digits, two different workers with the same name, the same place spelled differently, and deliberate arithmetic mistakes. Scan them as multi-page PDFs; photograph about a third with phones. Type the true values into `truth.csv`.

**G0 Gate**
Zero unflagged wrong values in date, start, end and total. Names and workplaces are reported separately and reviewed by Liam. If the gate fails: change the ticket layout or the prompts, repeat H0 on a small set. Record the result and cost per ticket in `docs/DECISIONS.md`.

### Phase 1 — Backend core

**T1.1 Database and infrastructure**
`compose.dev.yml` (Postgres 16, MinIO); Prisma schema from section 7; first migration; `pnpm seed:admin`.
Done when: migrations apply to an empty database; seed creates an admin.

**T1.2 Authentication and users**
Login, logout, sessions, invites, roles, rate limiting, lockout, CSRF, optional TOTP.
Done when: tests cover login success and failure, lockout, an expired session, role denial, and invite acceptance.
Liam checks: try logging in with a wrong password 11 times.

**T1.3 Jobs and uploads**
Job create, list and summary; signed upload URLs; upload completion; intake checks; queueing.
Done when: an integration test uploads a PDF and an image to MinIO and sees them queued; a duplicate file is detected.

**T1.4 Pipeline worker**
Steps 1–7 of section 4 as pg-boss jobs; retries; spending caps; status and flag writing.
Done when: an integration test with the fake extractor processes the fixture folder and every ticket ends in the expected status with the expected flags; killing the worker mid-run and restarting completes the run without duplicates.

**T1.5 Workplaces and duplicates**
Workplace grouping, `WORKPLACE_SIMILAR`, `POSSIBLE_DUPLICATE`, and their resolutions.
Done when: tests cover merging, rejecting a merge, keep-both and exclude-one.

**T1.6 Review API**
Ticket get, save (re-runs checks, optimistic locking), exclude, reprocess; progress endpoint; audit entries.
Done when: tests cover a correction, a stale save (409), and resolving every flag type.

### Phase 2 — Web app

**T2.1 App shell**
Routing, layout, login and invite pages, API client with TanStack Query, error and empty states.
Liam checks: log in, log out, open a page without a session.

**T2.2 Jobs, dashboard and upload**
Jobs list, new job, dashboard with live progress, multi-file upload with per-file state and retry.
Liam checks: upload 30 files, close the tab midway, reopen.

**T2.3 Review screen** ⚠ needs Liam's eyes
Image viewer, form, flag reasons, field highlighting, keyboard flow, duplicate comparison, manual entry.
Done when: a Playwright test reviews three flagged fixture tickets with the keyboard only.
Liam checks: review 20 real tickets; time how long it takes.

**T2.4 Workplaces screen**
Groups and similar-name questions.

**T2.5 Admin**
Users and invites.

Phase 2 gate: one person takes the Phase 0 set from upload to zero open tickets using only the browser.

### Phase 3 — Excel, import and deletion

**T3.1 Excel exporter** ⚠ needs Liam's eyes
Section 6.2 exactly.
Done when: a test builds an export, reopens it with exceljs, and checks every sheet, the formulas, RTL view, safe sheet names, formula-injection escaping and `_meta`.
Liam checks: open it in Excel; Hebrew reads right-to-left; totals match the paper.

**T3.2 Excel importer**
Section 6.3 exactly.
Done when: tests cover a round trip (export → import → export gives the same rows), an edited row, an added row, a removed row, a file without `_meta`, an unparseable cell, and the same file imported twice.

**T3.3 Export, lock, close and purge**
Export button rules, locking, download recording, close with typed confirmation, purge, 60-day auto-purge.
Done when: an integration test closes a job and then finds no rows for it in any table (except the summary) and no objects under its S3 prefix.

Phase 3 gate: Excel totals for the Phase 0 set match `truth.csv` exactly. This is the "see it work locally" milestone.

### Phase 4 — Hardening and deployment

**T4.1** Security pass against section 11; admin TOTP required.
**T4.2** Logging, Sentry, `/health`, backup and restore test, recovery guide in the README.
**T4.3** `compose.prod.yml`, Caddy, Dockerfiles, deploy workflow.
**T4.4 Pilot** One real month in parallel with the manual count.

Phase 4 gate: the pilot output matches the manual count, or every difference is explained, and human time is clearly lower than today. Measure both.

---

## 14. Open items

- Pay and rate columns: rules unknown; not in version 1.
- Whether the worker should also sign the ticket.
- Exact Excel styling: confirm with the associates after T3.1.
