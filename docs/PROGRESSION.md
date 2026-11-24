# Project progression

A record of how this project was built: what we decided, why, and how the work was run. Written for people who want to understand the process, not the code.

## The project

A staffing agency sends temporary workers to many workplaces. After every shift, the shift leader fills in a paper ticket per worker. Each month the owner and his associates counted hundreds of these tickets by hand to produce Excel sheets of hours per workplace, which took many hours.

**Tally** turns scanned tickets into those Excel sheets. An AI model reads the handwriting, but nothing it reads is trusted on its own: every value passes rule checks or is confirmed by a person before it reaches the spreadsheet. When a month is closed, after its final Excel and workplace PDFs are downloaded, all its data is deleted.

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

Before handing it over, it was tested on Liam's tickets with a deliberately wrong list of workplaces. Every reading correctly answered "none of these", and the guesses for names and times matched what a careful human reading found (for example זהריה, and a start time of 02:50 that also makes the total add up).

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

**Liam's challenge on "KOIN".** One reading kept returning the English word "KOIN" for a Hebrew name. Liam found it suspicious and asked why that reading saw only the cut-out boxes. The cause: in cursive, the four Hebrew letters of the name look like K, O, I and N, and read left to right the name becomes "KOIN". On its own, a cut-out box gives no hint that the ticket is in Hebrew. That reading now sees the whole ticket as well as the enlarged boxes, and every instruction warns about Hebrew that looks like English. The same test also showed the look-alike check was too strict for short names, and it was tightened for names only.

**Result.** On the next run, three of the four names were accepted correctly, including the "KOIN" one. The fourth was correctly held back because a planted look-alike was on the list. Three of four workplaces were accepted, and the fourth was shown to a person because it looked corrected on paper. Nothing wrong was accepted. The cost was about 15 cents a ticket, including the third read.

### 11. The grading program (T0.6)

Until now, results were judged by eye on four tickets. Liam was wary of this step, so it was built with extra care. The program reads a folder of real scans with the full process, compares every box with what is really written, and reports the one number that matters most: wrong values that got through without a flag.

- **One process, not two.** The step-by-step reading process moved out of the test script into the shared core. The grading program, the test script and the future app now run the same code, so what is measured is what will ship.
- **Strict grading.** A wrong value only counts as caught if its own box was flagged. A general "blurry scan" warning does not excuse it. A missed crossed-out ticket counts as a failure.
- **Testing the tests.** Bugs were planted on purpose in the grading and the reading process to check that the tests notice. One planted bug went unnoticed, and that test was strengthened. A tool quirk was also caught: it silently broke the marker Excel needs to show Hebrew, while every test still passed, so a test now checks the actual bytes of the file.
- **Privacy.** A failed reading's error message used to repeat the whole client and names lists. It now names only the broken part.
- **No surprise costs.** By default the program only checks the files and estimates the cost. It reads only with `--yes`, and stops by itself if spending runs past the estimate.

**Checking a change made elsewhere.** Liam changed the ticket's size in another session and asked for it to be checked. Every test passed, but the tests only used empty tickets. Simulating filled-in and corrected tickets found two real problems: filled tickets came out upside down, and a two-box scribble made the corner markers invisible. Both were fixed, and tests with filled tickets now guard them (D33). Lesson: passing tests only prove what they test.

**First real run (12 tickets, new layout).** The gate passed: no wrong date or time got through without a flag. Once the grading counted a misspelt workplace given its proper list name as right, no wrong value of any kind was accepted. Every ticket was found and straightened, including those scanned upside down. Dates were read right 10 times out of 12, and every time a person was needed the right answer was filled in. Times were read right 9 to 11 times out of 12. Workplaces were accepted from the list 7 times. Names were the weak field again: none of these workers were on the names list, so only one name was accepted, and the right guess was filled in for 6 more. That shows how much the names list matters. About 2 boxes per ticket go to a person, at about 15 cents a ticket.

### 12. Cheaper and smarter reading

- **Batch mode.** Liam asked whether the big test could use Anthropic's batch service, which costs half. The runner now sends each round of readings as one batch. On the same 12 tickets it gave the same results for half the price.
- **Comparing models and effort.** Liam asked to compare a cheaper model and higher effort, and to test effort on the two hardest tickets only, to save money. The cheaper model was as safe but sent almost three times as many boxes to a person, so it was dropped. Higher effort fixed the hardest digits for about 10% more and became the default. Maximum effort thought until it ran out of space and returned nothing.
- **A cost bug found by testing.** That failed run showed a cost of zero, although it was billed. Failed answers now count toward the cost and the spending stop. Only an experiment that went wrong could have revealed this.

### 13. Preparing the big test

- **A test written in advance.** Instead of having people fill in tickets freely and then typing up what they wrote, Claude wrote the contents of 100 tickets and four people copy them. The answers are known before the first ticket is written, so the grading cannot be wrong because of a typing slip.
- **New facts change the test.** Liam learned that real tickets are about half English. Because the program accepted a workplace only when it looked like a list entry letter by letter, a place written in English would never match its Hebrew name. Each place can now have both spellings, and the Excel uses the Hebrew one.
- **The real Excel looks different.** The agency's sheet is a grid of workers by days. That clashes with a basic rule of the plan (never combine tickets into one person, since tickets only have first names), so it was written down as an open question, not built.

### 14. The big test passed

- **Smaller than planned, still honest.** The helpers dropped out, so the test was 45 tickets instead of 100. Instead of padding it, the test reused the 12 tickets from the first run, and every ticket was checked box by box against its image before running, so a typing slip in the answers could not pass for a reading mistake.
- **The result.** Not one wrong value was accepted, in any box. Two thirds of the boxes needed nobody; most of the rest came with the right answer filled in for a person to confirm.
- **What it revealed.** The cost per ticket was higher than estimated, and the spending stop cannot work in batch mode. Liam decided against a stop: a job stopped halfway causes more trouble than it saves, and the agency pays per ticket anyway.

### 15. Fitting the agency's real way of working

- **New facts, new design.** Liam learned that the agency builds its Excel through the month, edits it freely, and sends each workplace its tickets. The plan's "one job, one export" model no longer fit.
- **Many options, one choice.** Updating the agency's own file, syncing it by uploads, and a spreadsheet inside the website were each weighed and dropped as too fragile or too heavy. Looking at the agency's real file settled it: the system owns a strict file layout, months stay open about six weeks, and hours change only through tickets, so the Excel and the tickets sent to workplaces can never disagree.
- **Saying no to the system doing too much.** Liam's rule: some things are better left to people. The system fills the agency's layout, and the final file is theirs to change.

### 16. The database foundation (T1.1)

- **The plan first, then the tables.** The database was designed only after the months-and-Excel decisions settled, because every table depends on them: months instead of jobs, a confirmed English name on each ticket, the helper lists, and a record of downloads.
- **Deleting a month deletes everything in it,** enforced by the database itself, and tested: closing November leaves December untouched.
- **Supply-chain care.** The usual local file-storage image had been withdrawn by its makers, and a security audit found a known bug in a library Prisma depends on. Both were handled openly: a pinned, maintained replacement, and a pinned fixed version, each recorded with the reason.

### 17. Logging in (T1.2)

- **Standard, not overboard.** Liam set the bar: the app serves one person on one computer, so it gets the industry-standard protections (hashed passwords, lockout, secure sessions, CSRF protection, deny-by-default access) and skips two-step codes for now.
- **Tested from the outside.** The tests run the real API over HTTP, the way a browser would, including the attacks the protections are for: guessing passwords, forging a request from another site, reusing an old session or invite link.
- **Privacy over habit.** Logging every login in the audit trail is common, but those records would outlive every month's data. They were left out on purpose.

### 18. Uploads, months and lists (T1.3)

- **A flaw found before it was built.** The plan gave each month its own copy of the helper lists. Writing the code showed the catch: the lists are needed while a ticket is read, but its month is known only after its date is read. One shared set of lists fixes it, and works the same for the user; Liam agreed.
- **Tell the user at once.** Every check on a file (its real type, its size, its pages, whether it was uploaded before) runs the moment the upload is confirmed, so the screen can say straight away what is wrong, in plain words. A refused or repeated file is deleted at once: nothing is kept that will not be used, and a file is never paid for twice.
- **Built to survive a crash.** A job is queued in the same database transaction as the record it is about, and splitting a 300-page scan resumes where it stopped instead of starting over or leaving stray files.
- **Less stored, same result.** Each ticket keeps one image, the scan itself; the cleaned-up copy the reader needs is made again in milliseconds each time instead of being stored.

### 19. Reading tickets in the background (T1.4)

- **Reuse what was proven.** The reading steps that passed the big test were already one shared function; the worker feeds it and saves its results instead of copying the logic, so the product reads exactly as the test did.
- **Never pay twice.** Each answer from the AI is saved the moment it arrives, so a worker that crashes and restarts picks up where it stopped without buying the same reading again. The test stops the worker halfway on purpose and checks that every answer was paid for once.
- **An outside review before going further.** At Liam's request, three independent reviews checked everything built so far: the API, the reading rules, and the documents against the code. They found real problems, including one way a clearly written name could be silently replaced by a similar one from the list. The fixes go in their own change, before any real ticket is read.

### 20. The questions only a person can answer (T1.5)

- **Asked once, answered once.** Is this the same place? Are these two tickets the same shift? The system groups what is certain, asks about the rest once per pair, and applies each answer everywhere it belongs. It never answers for the user.
- **Remembered where it saves time.** A "same place" answer and every confirmed name go into the lists, so next month asks fewer questions. Liam chose this over asking again each month.
- **Cheaper help where it fits.** From this task on, routine work such as writing tests goes to a cheaper model, while reviews of the rules and the security stay on the strongest one.

### 21. The review API (T1.6)

- **A person settles every doubt, and the rules still check them.** Saving a ticket runs every rule again on the new values, so a correction can never bring in a new mistake unnoticed. A person can say "I checked the paper" only where the paper can really be right (very long hours, an old date); an empty box or an impossible time must be corrected.
- **Two people, one ticket.** Each ticket carries a version number. A save that names an old version is refused with "someone else changed this ticket", instead of silently overwriting the other person's work, or a fresh reading.
- **Saved values can raise new questions.** Correcting a name or a date may make two tickets look like the same shift. Such a save waits for the month to be checked again before the ticket counts as done.
- **Privacy in the details.** The audit trail records every change, but for a ticket outside any month it records only which boxes changed, not the names or hours, because nothing would ever delete it.

### 22. The app shell (T2.1)

- **A critique before the code.** The plan was challenged first and the review caught three real flaws: the compiled API would crash when loading the shared package's TypeScript source, a global "you were logged out" redirect would loop forever on the login page itself, and React's double-run of effects in development would make every real invite link look invalid. Each was designed out before anything was written.
- **Fewer tools, older versions.** One command, `pnpm dev`, starts the website, the API and the worker, using only what was already installed. Testing Library was dropped: React and jsdom alone drive the pages. React Router 8 and jsdom 30 were skipped because they need a newer Node than the repository allows, so the newest versions that run on it were pinned.
- **Finishing what nobody owned.** The printable ticket template had no task of its own. Liam chose to build the download now, so the app is usable end to end instead of leaving a gap.
- **Reviews found nothing serious.** Two independent reviewers looked at the result. The small fixes were made: a malformed redirect link could crash the login, a previous user's cached data is now cleared at login, and a "Try again" button appears when the login check fails.

### 23. Home, the month page and uploading (T2.2)

- **The critique caught timing and trust problems.** The month page would have stopped refreshing before tickets were sorted into workplaces, because sorting runs after reading. A failed reading job would have made the page ask for updates forever. A file-type check in the browser could have refused good files, since the server judges type by content. Each was designed out first: the page keeps refreshing a little longer, an upload with nothing new for 26 hours is shown as stopped, and the browser checks only size.
- **Less to build than it looked.** The critic also proved that uploading straight from the browser to storage already works, so no storage settings had to change. A one-time step in the local setup now creates the storage folder, which before had to be made by hand.
- **Prices shown, as estimates.** Liam chose to show the cost per ticket beside each speed: about 15 cents for Batch (measured) and about 30 cents for Now (not yet measured), plus a running total. Remove and search on the month page wait for the review screen in T2.3.
- **Photos stay.** Liam offered to allow only PDFs. Photos stay, because they lose only one check, the same-batch name comparison, and keep every other.
- **Reviews found nothing serious.** The fixes were small but real: a file no longer uploads, and gets paid for, after the person chose Leave. A frozen upload times out. "Stay" now really keeps uploads when logging out. An old upload is no longer called "stopped" when one of its tickets is being read again.

### 24. The review screen (T2.3)

- **The critique caught four ways to lose or invent a value.** A reader's old guess could have overwritten a correction a person had already saved, so a guess is now shown only while that box is still in doubt. The planned browser test would have deleted tickets in the developer's own local database, so it now has its own database and refuses to run against any other. A ticked "the paper really says this" could silently approve a different value after an edit, so it unticks when the value changes. Correcting a first name kept the old English name, so the English name is now cleared and confirmed again.
- **Liam's two choices.** Enter walks through every flagged box before it saves: one extra key, and no value is saved unseen. Names come from a type-ahead list instead of one-click buttons, with this month's names at the workplace first.
- **The picture matches what was read.** The highlighted boxes come from the same template field map that printing and reading use, drawn on a straightened copy rebuilt on demand rather than stored (D42). If a scan cannot be straightened, the whole scan is shown without highlights.
- **Reviews found nothing serious.** The fixes were small but real: focus now stays put after a duplicate answer, a double-click no longer saves twice, and an expired scan link is handled.
- **Tested the way it is used.** A keyboard-only browser test reviews three tricky tickets (disputed, crossed out, unreadable) in about two seconds and runs in CI.

### 25. Workplaces and lists (T2.4)

- **The planner found a bug left from T1.5.** After a chain of merges, a workplace question that had already been answered stayed open ("Is X the same place as X?"), so its tickets never became ready. The critic showed the first fix was incomplete, so an answer now settles every question about the same two final workplaces.
- **Liam's two choices.** The lists go on each month page, as the plan says, not on a new page. "Same place" asks "Are you sure? This cannot be undone" first, because a merge joins two Excel sheets and nothing can split them again. "Different place" stays one click, since it changes nothing.
- **Replacing a list cannot wipe by accident.** The box starts from the current list, so remembered spellings survive, and a preview shows what will be added and removed before anything is saved.
- **Reviews found nothing serious.** The fixes were small but real: a merge and the duplicate questions it raises are now one all-or-nothing step, so two tickets of one person can never stay "ready" unchecked. The history records the name actually kept, and keyboard focus moves to the next question.
- **Tested the way it is used.** A keyboard-only browser test answers a workplace question through the confirmation.

### 26. Admin: users and invites (T2.5)

- **Mostly already built.** The server side came in T1.2, so this task was the Admin page and its tests: a list of accounts, and "Invite someone" with a role (Reviewer by default).
- **No email, so a link is handed over.** The plan has no email sending, so the admin copies a one-time link that works for 7 days and is shown only once. The critic noticed that opening the link logs you in as the new person, so the page says plainly "do not open it yourself", and that a new invite cancels the earlier link.
- **Liam's choice: no list of pending invites.** The plan asks for none. Inviting again replaces the link, which also fixes a lost one, and invite emails are not kept on show.
- **Asking first, but only where it matters.** Role changes and disabling ask first, with Cancel focused. Enabling is one click, since it only restores access that can be taken away again. Disabling logs the person out at once.
- **The server stays the safeguard.** Your own account has no buttons, but the real protection is the server's last-admin rule, which holds for every change.
- **Reviews found nothing serious.** The fixes were small but real: the page re-checks who is logged in when an admin was demoted elsewhere, and the invite link is forgotten as soon as you leave the page.
- **Tested the way it is used.** A browser test invites a reviewer, who sets a password and does not see the Admin page.

### 27. The Phase 2 gate: real tickets through the browser

- **Liam saw the app work for the first time.** He reviewed 10 real tickets himself and called the flow "phenomenal"; the outlined doubtful boxes helped most. An agent reviewed the remaining 35 through the same screens.
- **The money was spent once, on purpose.** The 45 tickets were read once, in Batch, for $6.55 (estimated $6.50), and the app was then restarted with a fake reader so no click in the review could cost anything.
- **The safety rule held on real paper.** Before review, no wrong value was accepted without a flag. After review, 268 of 270 values match the answer file, and the other two follow from Liam's own answer that two places are one.
- **The gate also found a bug.** A person who types a workplace by its other spelling on the list starts a separate workplace, which would split one place across two Excel sheets. It is fixed before the Excel exporter.
- **The permission system did its job.** It refused to let an agent answer the workplace questions on a relayed approval, so Liam answered them himself in a minute.

### 28. The month's Excel file (T3.1)

- **The file follows the agency's own layout.** There is one sheet per workplace, with a row per confirmed English name, a column per day and totals as formulas. A totals sheet adds the workplaces up. A names sheet pastes straight back into the names list. A sheet of removed tickets means nothing disappears silently.
- **Minutes stay whole numbers.** Only the display shows two decimals, so the totals never drift.
- **Liam's two choices.** The labels are in Hebrew, like the agency's file, while worker names stay in English letters. The file always matches the current tickets, so a row or sheet with no hours left is dropped.
- **It reuses the month page's own grouping.** The page and the Excel can never disagree. The critic proposed this, and it made the plan smaller.
- **Safety comes before convenience.** Text from tickets can never become a formula: a leading apostrophe is added, and tab and carriage return are escaped too. The download refuses rather than leaving hours out: "Some tickets are still being sorted. Try again in a minute." appears while an upload is still being sorted. Everything is read in one consistent snapshot, and the browser does not keep the file in its cache.
- **Reviews found nothing serious.** The fixes were small but real: a download made during reading gave a confusing error, and a failed download showed raw JSON, so the button now shows the message on the page.
- **Checked on real data.** Built from the 45 real Phase 2 gate tickets, every workplace's total and the grand total (351.83 hours) matched the answer file exactly, which is the Phase 3 gate's own test. Three tickets had been saved before the D53 fix; one was re-saved for the check, so two sheets still carry English names from before that fix, with correct hours. Liam's check, opening it in Excel with the agency owner, is still to come.

### 29. Workplace PDFs (T3.2)

- **Each workplace gets its own tickets.** One PDF per workplace holds the original scan of each of its ready tickets, in date order and then by name. They download all together as one ZIP, or one workplace at a time. The files are named in Hebrew with the Hebrew month (Liam: "בת אביגדור נובמבר 2026.pdf"), because the workplace is who reads them.
- **The PDFs and the Excel always agree.** Both are built from the same snapshot of ready tickets, so a workplace's PDF holds exactly the shifts counted on its sheet. Tickets still waiting for review are left out of both, as the plan says for every download.
- **No new library.** The PDF tool was already in the project, and the ZIP is a short writer built on Node's own checksum. Its output was checked with three independent readers, and Hebrew file names survive.
- **The critic caught a rule that would have blocked closing a month.** Refusing to download a month with nothing ready would have stopped such a month from ever being closed and deleted, so an empty month now gives an empty ZIP.
- **Reviews found nothing serious.** The fixes were small but real: scans are loaded one at a time to keep memory low, storage locations stay on the server, file names drop invisible direction characters, and a download error shows next to the button that caused it.
- **Checked on real data.** From the 45 real gate tickets, the ZIP held 31 workplace PDFs. Every page was the original scan, unchanged, in the right workplace and in the right order.
