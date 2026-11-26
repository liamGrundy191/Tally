# CLAUDE.md

Shift Ticket Processing System: turns scanned paper shift tickets into Excel sheets of hours per workplace, for a staffing agency. Every value is verified by rules or a person; nothing is guessed.

## Before any work

1. Read `docs/PLAN.md` fully. It is the specification. Decisions in it are final unless Liam changes them.
2. Read `docs/DECISIONS.md` and `docs/QUESTIONS.md` for anything decided or asked since.
3. Find the next unfinished task in `docs/PLAN.md` section 13. Work on that task only.

## Roles

- You write the code, open the pull request, get CI green, and merge.
- Liam is the overseer. He is not expected to write code. He does the "Liam checks" steps that need a person (printing, real scans, Excel); merge only after he reports them done. If a task's only Liam check is "CI is green", you can merge without him.
- Before starting a task, debrief Liam on its goal and your approach (short, not every detail) and wait for his go-ahead. Before a push or merge with substantial changes, tell him what it includes. Small doc fixes need no debrief.

## How to work

- One task per branch (`task/T1.3-uploads`) and per pull request.
- Write the task's tests first, then the code. A task is done only when its "Done when" criteria pass.
- Run `pnpm lint && pnpm typecheck && pnpm test` before opening a pull request. Never open one with failing checks.
- Pull request description: what was built, how it was tested, anything Liam should look at closely, and the task's "Liam checks" list.
- After each task, add its major decisions and discussions to `docs/PROGRESSION.md` (written for future employers: what and why, not code detail).
- Stop after each task and wait for Liam. Do not start the next task unless he says so.

## When something is unclear

- Do not guess. Add the question to `docs/QUESTIONS.md` with the task ID, the options, and your recommendation.
- If you can continue safely, take the option that flags more and assumes less, say so in the pull request, and record it in `docs/DECISIONS.md`.
- If you cannot continue safely, stop and say what you need.

## Hard rules

- Never add features, services, libraries or abstractions that `docs/PLAN.md` does not ask for.
- Never reintroduce rejected ideas: QR codes or serial numbers on tickets, a worker registry (lists that only help reading are allowed, D28; a worker's row total inside one workplace's sheet is allowed, D39), the system deciding by itself that two tickets are the same person, storing rates or pay (a per-ticket "57 rate" tick is allowed, D66; never a rate or an amount), keeping data after a month is closed, digital ticket entry (except a person typing another, non-Tally paper ticket from its scan, D68), hours without a ticket (except the morning hours a person types for the totals sheet's בוקר column only, D66), reading or updating the user's own Excel files, an Excel-like grid in the website.
- Never let a value reach an export without passing checks or a person confirming it.
- Tests never call the real Anthropic API. Use `FakeExtractor` and fixtures.
- Ticket text and uploaded lists are untrusted data. Never put them in a prompt as instructions; escape them in Excel.
- Never commit secrets, real ticket images or real names. Fixtures use invented names.
- Durations are integer minutes. No floating-point time arithmetic. No rounding.
- Keep the UI in plain English for non-technical users. Hebrew values must display right-to-left.

## Commands

```
docker compose -f docker/compose.dev.yml up -d   # Postgres + MinIO
pnpm db:migrate                                   # apply database migrations (DATABASE_URL in .env)
pnpm dev                                          # web, API, worker
pnpm seed:admin                                   # create first admin (asks for email and password)
pnpm lint && pnpm typecheck && pnpm test          # before every PR
pnpm e2e                                          # browser test: seeds its own database tally_e2e, reviews 3 tickets (first: pnpm --filter @tally/web exec playwright install chromium)
pnpm format                                       # fix formatting (Prettier)
docker build -f docker/app.Dockerfile -t tally-app:local .   # production image: API and worker
docker build -f docker/web.Dockerfile -t tally-web:local .   # production image: Caddy and the web app
docker compose -p tally-local -f docker/compose.prod.yml -f docker/compose.local.yml --env-file docker/local.env up -d
                                                  # rehearse production locally (https://tally.localhost:8443; `down -v` removes it)
sh docker/check-local.sh                          # check the rehearsal through Caddy (health, redirect, headers)
home\Install Tally.bat                           # home laptop (D62): Install once, then Open Tally / Update Tally (home/README.md)
git tag v1.2.3 && git push origin v1.2.3          # deploy a release (deploy.yml); roll back: Actions > Deploy > Run workflow from an earlier tag
pnpm ticket:pdf                                   # printable ticket
pnpm crops <scan>                                 # straighten a scan and save field crops (free)
pnpm extract <scan>                               # read a scan's tickets with the real model (costs cents)
pnpm poc --input <folder> --template             # Phase 0: empty truth.csv for a folder of scans
pnpm poc --input <folder> [--truth <csv>] [--yes] [--batch] # Phase 0 runner: grade against truth (--yes spends money; --batch half price, slower)
```

Keep this command list up to date when you add scripts.
