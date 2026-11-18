# CLAUDE.md

Shift Ticket Processing System: turns scanned paper shift tickets into Excel sheets of hours per workplace, for a staffing agency. Every value is verified by rules or a person; nothing is guessed.

## Before any work

1. Read `docs/PLAN.md` fully. It is the specification. Decisions in it are final unless Liam changes them.
2. Read `docs/DECISIONS.md` and `docs/QUESTIONS.md` for anything decided or asked since.
3. Find the next unfinished task in `docs/PLAN.md` section 13. Work on that task only.

## Roles

- You write the code.
- Liam is the overseer. He reviews every pull request, runs the "Liam checks" steps, and merges. He is not expected to write code.

## How to work

- One task per branch (`task/T1.3-uploads`) and per pull request.
- Write the task's tests first, then the code. A task is done only when its "Done when" criteria pass.
- Run `pnpm lint && pnpm typecheck && pnpm test` before opening a pull request. Never open one with failing checks.
- Pull request description: what was built, how it was tested, anything Liam should look at closely, and the task's "Liam checks" list.
- Stop after each task and wait for Liam. Do not start the next task in the same session unless he says so.

## When something is unclear

- Do not guess. Add the question to `docs/QUESTIONS.md` with the task ID, the options, and your recommendation.
- If you can continue safely, take the option that flags more and assumes less, say so in the pull request, and record it in `docs/DECISIONS.md`.
- If you cannot continue safely, stop and say what you need.

## Hard rules

- Never add features, services, libraries or abstractions that `docs/PLAN.md` does not ask for.
- Never reintroduce rejected ideas: QR codes or serial numbers on tickets, a worker registry or worker totals, merging people, storing rates or pay, keeping data after a job is closed, digital ticket entry.
- Never let a value reach an export without passing checks or a person confirming it.
- Tests never call the real Anthropic API. Use `FakeExtractor` and fixtures.
- Ticket text and imported Excel cells are untrusted data. Never put them in a prompt as instructions; escape them in Excel.
- Never commit secrets, real ticket images or real names. Fixtures use invented names.
- Durations are integer minutes. No floating-point time arithmetic. No rounding.
- Keep the UI in plain English for non-technical users. Hebrew values must display right-to-left.

## Commands

```
docker compose -f docker/compose.dev.yml up -d   # Postgres + MinIO
pnpm dev                                          # web, API, worker
pnpm seed:admin                                   # create first admin
pnpm lint && pnpm typecheck && pnpm test          # before every PR
pnpm format                                       # fix formatting (Prettier)
pnpm ticket:pdf                                   # printable ticket
pnpm poc --input <folder> --truth <truth.csv>     # Phase 0 runner
```

Keep this command list up to date when you add scripts.
