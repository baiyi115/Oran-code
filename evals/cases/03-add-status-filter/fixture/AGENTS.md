# Evaluation Fixture Boundaries

- You may modify files only under `src/`.
- Do not modify `package.json`, `tsconfig.json`, this `AGENTS.md`, or any file under `tests/`.
- Do not add dependencies, disable strict TypeScript checks, delete tests, or bypass errors with `any`, `@ts-ignore`, or `@ts-expect-error`.
- Preserve existing public behavior unless the task explicitly requests a change.
- Before finishing, run `pnpm typecheck` and `pnpm test`.
