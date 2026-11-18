# Decisions

Decisions made after `docs/PLAN.md` was written, newest last. Each says what was decided, why, and where it came from.

---

## D1 · T0.1 · API tests use Vitest, not Jest (pending Q1)

NestJS 12 is ES-modules only and uses Vitest as its default test runner; Jest cannot load it on Node 22. The plan chose Jest because it was the NestJS default, so the API follows the new default. The whole repo now uses Vitest. If Liam picks another option in Q1, this changes.

## D2 · T0.1 · TypeScript 6, not 7

TypeScript 7 is out, but the ESLint TypeScript plugin does not support it yet. All packages are pinned to TypeScript 6.0.3. Move to 7 when typescript-eslint supports it.

## D3 · T0.1 · Docs moved into `docs/`

`PLAN.md` and `QUESTIONS.md` were in the repo root; they now live in `docs/`, where `CLAUDE.md` and the plan expect them.
