# CLAUDE.md

Guidance for working in this repo. For the product vision, roadmap, and design
rationale, read `PLAN.md` first — it's the source of truth for _what_ we're
building and _why_. This file covers _how_ to work in the codebase.

## Package manager: Bun

This project uses **[Bun](https://bun.sh)** as its package manager and script
runner. Use it, not npm/yarn/pnpm — the lockfile is `bun.lock`.

```sh
bun install            # install dependencies
bun run <script>       # run a package.json script
bunx <tool>            # run a binary (npx equivalent)
bun add / bun remove   # change dependencies
```

## Common commands

| Command              | What it does                                    |
| -------------------- | ----------------------------------------------- |
| `bun run dev`        | Vite dev server (web only)                      |
| `bun run tauri dev`  | Run the full Tauri desktop app                  |
| `bun run build`      | Type-check (`tsc`) then build the web bundle    |
| `bun run typecheck`  | Type-check only, no emit                        |
| `bun run lint`       | ESLint over the project (`lint:fix` to autofix) |
| `bun run format`     | Prettier write (`format:check` to verify in CI) |
| `bun run test`       | Run the Vitest suite once                       |
| `bun run test:watch` | Vitest in watch mode                            |
| `bun run coverage`   | Vitest with a V8 coverage report                |

## Stack

- **Shell:** Tauri 2 + React 19 + Vite 8, TypeScript.
- **GPU:** WebGPU in the webview (the real learning goal — see `PLAN.md`).
- **Video:** WebCodecs via [mediabunny](https://mediabunny.dev/) for demux +
  frame-accurate decode.
- **Rust:** lives in `src-tauri/` — plumbing for now; the camera solver lands
  there later. The JS tooling (ESLint, Prettier, Vitest) deliberately ignores
  `src-tauri/`.

## Conventions

- **Formatting is Prettier's job, code-quality is ESLint's.** Don't add
  stylistic ESLint rules; `eslint-config-prettier` turns them off. Run
  `bun run format` before committing.
   - Indentation is **3 spaces** (`tabWidth: 3` in `.prettierrc.json`). Yes,
     three — deliberate.
   - `objectWrap: "collapse"`, so object literals collapse onto one line when
     they fit rather than preserving an author's line break.
- **ESLint** uses flat config (`eslint.config.js`): JS + TypeScript + React +
  React Hooks recommended rule sets. Note: ESLint is pinned to **9.x** because
  `eslint-plugin-react` does not yet support ESLint 10.
- **Tests are colocated** with the code they cover: `Foo.tsx` → `Foo.test.tsx`,
  `bar.ts` → `bar.test.ts`. They run under Vitest in a jsdom environment with
  globals enabled (no need to import `describe`/`it`/`expect`). React components
  are tested with React Testing Library; jest-dom matchers are registered in
  `src/test/setup.ts`. `src/App.test.tsx` is a worked example.

## Architecture notes

The spine of the app is the `FrameSource` interface (`src/video/frame-source.ts`):
"give me frame N, exactly." Everything downstream talks to a `FrameSource` and
nothing lower. Two rules are easy to get wrong and worth re-reading the doc
comment for:

- **Seek by integer frame index** through an authoritative per-frame timestamp
  table — never `index / frameRate` (variable-frame-rate footage would land on
  the wrong frame).
- **Ownership: the source owns, callers borrow.** Don't `.close()` a sample you
  got from a `FrameSource`, and don't retain it past your current synchronous
  use — the cache owns its lifetime.

When changing the video layer, keep the `FrameSource` contract intact; the
milestones in `PLAN.md` are all written as "implement against `FrameSource`".
