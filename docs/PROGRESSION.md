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
- **First real test.** Liam filled in four tickets by hand, some deliberately hard (a night shift, a scribbled-over date digit, ambiguous digits) and scanned them with a phone. The AI made no wrong readings: every value it gave was correct, and everything it was unsure of it marked unreadable, including the overwritten date. The cost was about 7 cents per ticket. The weak spot: it could not read any cursive Hebrew name or workplace with confidence. That shaped what came next: cutting each box out at full detail (T0.5) and asking shift leaders to write in print letters.

### 7. Rethinking after a disappointing result

Liam was unhappy that the AI read none of the cursive names or workplaces, while Claude Code, reading the same scans zoomed in, could read about half. He asked why they differed, and suggested the cause himself: the program's instructions put safety first ("say nothing if unsure"), while a person, or Claude reading for him, gives a best reading and marks the doubtful letters.

Two ideas came out of that conversation:

- **A list of the agency's workplaces** (Liam's idea, checked with the agency owner). Matching handwriting against a known list is far easier than reading it from scratch. If both readings match the same place, that is strong evidence.
- **Best-guess suggestions** for unclear boxes. The reviewer sees a pre-filled guess and confirms it, instead of typing. The box is still always flagged, so safety is unchanged and only review time shrinks.

A worker list was ruled out on purpose: the plan forbids keeping a register of workers.

### 8. Preparing the picture (T0.5)

Each scan is straightened using the four printed corner squares, even when it is tilted, photographed at an angle, upside down, or lying on a desk. Each box is then cut out at full detail, and blurred or dark scans are flagged.

- **Testing without real images.** All test pictures are generated from the blank ticket PDF (rotated, blurred, darkened, on a grey background), so no real ticket images are ever stored in the project.
- **Two test weaknesses were found by planting bugs on purpose.** With one corner square covered, the code first "found" a rectangle made of printed letters; it now accepts only marks the size of a real square. And the upside-down test was too lax to notice an upside-down result; it was tightened until the planted bug failed it.
- **Measuring rather than assuming.** Re-reading Liam's four tickets with straightened, cut-out images barely changed the results. That showed the bottleneck was the AI's instructions, not the picture quality, and it pointed the next step at the instructions.

### 9. Instructions version 2: best guesses and the workplace list

The AI now gives a best guess for every unclear box. The guess is always flagged and only pre-fills the reviewer's form. Workplaces are matched against the agency's list, and the answer format only allows exact list entries.

A workplace is accepted only when both readings name the same entry and the handwriting resembles it. Anything else is flagged, so a nearby entry can never be forced onto the writing.

Before handing it over, it was tested on Liam's tickets with a deliberately wrong list of workplaces. Every reading correctly answered "none of these", and the guesses for names and times matched what a careful human reading found (for example זכריה, and a start time of 02:50 that also makes the total add up).

**Result with the real list.** With the agency's 32 workplaces, all four workplaces on Liam's test tickets were matched by both readings, up from none. Three went straight through. The fourth looked corrected on paper, so it is still shown to a person. No wrong value got through unflagged. One reading was confidently wrong about a name again, but the two readings disagreed, so it was flagged. Names remain the weak field.

**A gap Liam found.** He asked what stops both readings from picking the same wrong entry when two places have similar names. The answer was "nothing", and his list already had such a pair (invented example: בית נוי and בית נוף). Now, when the handwriting also resembles a second entry, the workplace goes to a person even if both readings agree.

**Cost.** Liam raised cost as a real factor. One run over four tickets costs about 8 cents per ticket. That makes "when does the cost outweigh the time saved" a question to measure, alongside accuracy.

### 10. Names, speed and price

Workplaces were solved by the list; names remained the weakest field. Liam and Claude worked through it as a conversation rather than a spec:

- **What a mistake costs.** The name decides who gets paid, so a wrong name must never slip through, but a flagged name costs only a few seconds. The goal became making flagged names quick to confirm, and accepting only the safe ones.
- **Ideas weighed and dropped.** A worker list from the agency is impossible, because workers change every month or two. Saving names between runs was too much work for the gain and would break the rule that nothing is kept between jobs. A general list of common Israeli names was dropped: the workers come from many backgrounds, and a big list has look-alikes for almost every name. Printing "block letters" on the ticket would help, but shift leaders will not follow it.
- **What was chosen.** The export hands back a list of the month's names, and the user uploads it next time. This works because many workers stay at least two months. Names that read clearly in the same upload also help read the unclear ones, since one worker usually has several tickets. Both use the same safety rule as workplaces, including the look-alike check.
- **A third read.** When the two readings disagree or are unsure, a third independent reading breaks the tie. It only improves the suggestion the reviewer sees and never approves anything by itself, because the tests showed a reading can be confidently wrong.
- **Price as a feature.** Liam raised cost as a real factor: about 8 cents a ticket. The user will choose between reading now or in batch mode (about half price, results within hours), and between a stronger and a cheaper model. The price is shown before reading starts.

**Liam's challenge on "KOIN".** One reading kept returning the English word "KOIN" for a Hebrew name. Liam found it suspicious and asked why that reading saw only the cut-out boxes. The cause: in cursive, א, ס, ו and מ look like K, O, I and N, and read left to right the Hebrew name מוסא becomes "KOIN". On its own, a cut-out box gives no hint that the ticket is in Hebrew. That reading now sees the whole ticket as well as the enlarged boxes, and every instruction warns about Hebrew that looks like English. The same test also showed the look-alike check was too strict for short names, and it was tightened for names only.

**Result.** On the next run, three of the four names were accepted correctly, including the "KOIN" one. The fourth was correctly held back because a planted look-alike was on the list. Three of four workplaces were accepted, and the fourth was shown to a person because it looked corrected on paper. Nothing wrong was accepted. The cost was about 15 cents a ticket, including the third read.

### 11. The grading program (T0.6)

Until now, results were judged by eye on four tickets. Liam was wary of this step, so it was built with extra care. The program reads a folder of real scans with the full process, compares every box with what is really written, and reports the one number that matters most: wrong values that got through without a flag.

- **One process, not two.** The step-by-step reading process moved out of the test script into the shared core. The grading program, the test script and the future app now run the same code, so what is measured is what will ship.
- **Strict grading.** A wrong value only counts as caught if its own box was flagged. A general "blurry scan" warning does not excuse it. A missed crossed-out ticket counts as a failure.
- **Testing the tests.** Bugs were planted on purpose in the grading and the reading process to check that the tests notice. One planted bug went unnoticed, and that test was strengthened. A tool quirk was also caught: it silently broke the marker Excel needs to show Hebrew, while every test still passed, so a test now checks the actual bytes of the file.
- **Privacy.** A failed reading's error message used to repeat the whole client and names lists. It now names only the broken part.
- **No surprise costs.** By default the program only checks the files and estimates the cost. It reads only with `--yes`, and stops by itself if spending runs past the estimate.

**Checking a change made elsewhere.** Liam changed the ticket's size in another session and asked for it to be checked. Every test passed, but the tests only used empty tickets. Simulating filled-in and corrected tickets found two real problems: filled tickets came out upside down, and a two-box scribble made the corner markers invisible. Both were fixed, and tests with filled tickets now guard them (D33). Lesson: passing tests only prove what they test.
