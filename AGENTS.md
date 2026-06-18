# Repository Guidelines

## Project Overview

This package is `@natheihei/sandbox-opensandbox`, an ESM TypeScript library that adapts OpenSandbox to the AI SDK Harness sandbox provider interface.

The public API is exported from `src/index.ts`. Core behavior lives in:

- `src/open-sandbox-provider.ts`: creates, resumes, lists, and wraps OpenSandbox instances as Harness sessions.
- `src/open-sandbox-session.ts`: adapts OpenSandbox file, command, process, lifecycle, and port APIs to Harness session methods.
- `src/setup-scripts.ts`: runs create/resume setup scripts inside the sandbox.
- `src/types.ts`: public option and settings types.
- `test-stubs/`: narrow local stubs used by Vitest aliases for AI SDK beta packages.
- `example/`: runnable Codex/OpenSandbox examples that consume this package through `file:..`.

## Commands

Use `pnpm` from the repository root.

- Install dependencies: `pnpm install`
- Run tests: `pnpm test`
- Type-check: `pnpm type-check`
- Build package output: `pnpm build`
- Clean build artifacts: `pnpm clean`

For the example app:

- Type-check example: `pnpm --dir example check`
- Run basic example: `pnpm --dir example start`
- Run advanced concurrent-session example: `pnpm --dir example start:advanced`

The examples require Docker, an OpenSandbox server, and local Codex credentials as described in `README.md`.

## Testing Guidance

- Add or update Vitest tests next to changed source files using the existing `*.test.ts` pattern.
- Run `pnpm test` and `pnpm type-check` before reporting completion for code changes.

## TypeScript And Style

- Keep the package ESM-only. Use `import`/`export`, not CommonJS.
- Keep `strict` TypeScript compatibility. Avoid `any`; prefer focused local types when external beta package types are too broad.
- Prefer readonly public option types and narrow, explicit return types for exported APIs.
- Comments should explain non-obvious integration constraints, especially around Harness/OpenSandbox API mismatches. Avoid restating obvious code.

## Build And Packaging Notes

- `tsup.config.ts` builds only `src/index.ts` as ESM and keeps runtime SDK dependencies external.
- `package.json` publishes only `dist/**/*`, `README.md`, and `LICENSE`.
- `prepack` runs `pnpm build`; keep package metadata, exports, and generated declarations aligned when changing public exports.
- `tsconfig.build.json` controls emitted declaration/build behavior; `tsconfig.json` is the root type-check config.
