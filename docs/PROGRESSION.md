# Project progression

A record of how this project was built: what we decided, why, and how the work was run. Written for people who want to understand the process, not the code.

## The project

A staffing agency sends temporary workers to many workplaces. After every shift, the shift leader fills in a paper ticket per worker. Each month the owner and his associates counted hundreds of these tickets by hand to produce Excel sheets of hours per workplace, which took many hours.

**Tally** turns scanned tickets into those Excel sheets. An AI model reads the handwriting, but nothing it reads is trusted on its own: every value passes rule checks or is confirmed by a person before it reaches the spreadsheet. Once the final file is exported and confirmed, all data for that batch is deleted.

## How the work is run

- **Liam** owns the product. He wrote the specification (`docs/PLAN.md`), makes every product decision, and checks the things only a person can check: printing the ticket, trying real scans, opening the Excel file.
- **Claude Code** (an AI coding agent) writes the code, tests it, opens the pull requests, gets the automated checks (CI) green and merges.
- The work follows a fixed task list. Each task has a "done when" test and a "Liam checks" list, and gets its own branch and pull request.
- Tests are written before the code they test.
- When the spec doesn't answer something, the question goes to Liam with options and a recommendation, never a silent guess. Answers are recorded in `docs/DECISIONS.md`, so the reasoning survives.
- Before each task starts, Liam gets a short debrief: the goal and the approach. Substantial pushes are described to him before they go out.

## Timeline

### 1. The specification

Liam wrote a full build plan before any code. It sets ten non-negotiable principles. The main ones:

- **No silent guesses:** every value is checked by rules or confirmed by a person.
- **"Unreadable" is a valid answer** from the AI.
- **People are never merged:** each ticket is one row; the system never decides two tickets are the same worker.
- **Delete data as soon as the job is done.**
- **Paper stays the source of truth.**

It also lists ideas that were rejected on purpose (QR codes, a worker database, storing pay rates), so they don't creep back in.

### 2. Project setup (T0.1)

The skeleton of the system: web app, API, shared code, automated checks on every pull request.

- **First real decision.** The plan said to test the API with Jest "because it is the framework's default". The newest version of the framework had changed its default to Vitest, and Jest could no longer run it. Rather than pick silently, this went to Liam as a written question with three options. He chose to follow the plan's reasoning (use the default) over its wording.
- **A dependency was too new.** The newest TypeScript wasn't yet supported by the linting tools, so we pinned the previous version and recorded why.
- **A review found real gaps.** A code review of the finished setup found that server code could use browser-only features without any check failing. It also found the type definitions described a newer Node.js than the one actually running. Both were fixed before merging.

### 3. Changing how we work

At first Liam reviewed and merged each pull request himself. He decided he wanted to oversee, not operate. From then on, Claude Code owned the pull request, CI and merge, and Liam got short debriefs instead of step-by-step confirmations. The project's working rules were updated so later sessions follow the same arrangement.

### 4. The paper ticket (T0.2)

The ticket design and a generator for the printable PDF. Four solid black corner squares let the system find and straighten the ticket in a scan. A single "field map" file records where every box is, and both the PDF and the scan-cropping code read it, so they can never drift apart.

- **Testing a printed layout.** The test turns the PDF into an image and checks every corner square is within half a millimetre of where the field map says. A first version of this test still passed when the squares were moved 1 mm on purpose, so it was tightened until it caught that.
- **Feedback from Liam:** the first version (two A5 tickets per page, with rules printed at the bottom) was too large. It became three per A4 page, without the rules. Box sizes stayed the same, so writing space didn't shrink.
- **Feedback from the agency owner:** the last name isn't needed. The field was removed, and the effects were followed through: duplicate detection and the Excel worker column now work from the first name alone.
- **Using the freed space:** with one row fewer, four tickets fit on a page. The boxes lost 1 mm of height so every box still sits inside the four corner squares, which the scanning step depends on.

### 5. The checking rules (T0.3)

The rules that decide when a ticket must be looked at by a person. Liam marked this as the most important step so far and asked for edge cases to be "triple checked".

What was covered:

- **Times:** shifts that cross midnight; "24:00"; decimal hours written as minutes ("8.5" or "08:50" meaning 8½ hours); a 12-hour clock ("04:30" meaning 16:30); the night the clocks change.
- **Dates:** impossible dates (31/02, 29/02 outside a leap year); month-first dates; a mistyped year.
- **"Today":** the date is taken in Israel time, so a server running on another time zone can't move a ticket into the future by a day.
- **Names:** spelling marks, Hebrew final letters, hyphens versus spaces, invisible right-to-left characters that AI output can carry.
- **Workplaces:** spellings close enough to ask about, without asking about the empty name.
- **Duplicates:** the same ticket scanned twice; two different workers with the same name; back-to-back shifts that touch but don't overlap.

Four questions went to Liam, each with a recommendation:

1. **Blank boxes and impossible times get their own clear messages.** Liam agreed. He also asked for very short shifts to be flagged; anything under 2 hours now goes to a person.
2. **Night shifts.** For possible duplicates, should a night shift written with two different dates be caught? Liam chose to stay with "same date only". He raised the case of two genuine night shifts on consecutive nights. That led to an explanation that consecutive nights never overlap in time, so they are safe under either option.
3. **Swapped name order** counts as the same name. Liam agreed.
4. **Which names to flag.** Liam overruled the original spec: names written in English are fine. Anything else that doesn't make sense in a name (digits, other alphabets, symbols) is flagged.

To prove the tests catch real mistakes, five bugs were planted on purpose: an off-by-one at midnight, an off-by-one on the 45-day limit, Hebrew final letters not unified, a crossed-out ticket only flagged if both AI readings agreed, and back-to-back shifts counted as overlapping. Every one was caught.

The rules' known limits are written down rather than hidden. If both AI readings agree on the same wrong name, nothing in the rules can tell. That's why every ticket is reviewed by a person until real use shows it's safe to stop.

### 6. Reading tickets with AI (T0.4)

The step that sends a ticket image to the AI and gets back what it read. It is built so the AI is held to a strict answer form generated from the same rules the checks use, and so that "I can't read this" is the easy answer.

- **Two independent readings with different wording.** Each ticket is read twice from two separately worded instructions, so one phrasing's blind spot is less likely to repeat. The instructions are plain English files that Liam reviews, and they are versioned: changing them means a new version, so any reading can be traced to the exact instructions behind it.
- **Handwriting is data, never instructions.** The instructions tell the AI that anything written on a ticket is text to copy. Someone writing "ignore your rules" on a ticket has no effect.
- **A fake reader for testing.** All automated tests use prepared answers instead of the real AI, so they cost nothing and give the same result every time. A stand-in for the AI service checks the real reader's handling of refusals, cut-off answers and malformed answers, again without calling the API.
- **Cost and ownership.** Liam asked whether to use his own API key or a company account. Decision: his key for development with invented data, and an agency-owned account before any real worker data is processed, since the agency is the one sending its workers' names to the AI provider and should hold the account and the bills.
- **A deliberate deviation from the vendor's default.** Anthropic recommends an automatic fallback to another model when a request is declined. We chose to treat a decline as a failed reading that goes to a person, keeping one reader for every ticket.
