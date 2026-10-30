# CLAUDE.md

How to work in this repo. For the product vision, roadmap, and design rationale,
read `PLAN.md` first: it says _what_ we're building and _why_. This file says
_how_.

## Working model: agents implement, Nino steers

Most code here is written by AI agents. Nino sets direction, reviews PRs, and
makes product calls. That means:

- **Take a whole task end to end.** Read the relevant code, plan, implement,
  test, verify, and open a PR. Don't stop to ask for approval on routine
  engineering decisions (file layout, helper names, test structure, small
  refactors that the task needs). Pick the sensible option and say what you
  picked in the PR description.
- **Larger changes are fine** when the task calls for them: replacing a
  throwaway component, restructuring a module, adding a dependency. Explain the
  reasoning in the PR. Keep unrelated changes out of the PR.
- **Ask first** only for things that change the product's direction or are hard
  to undo: dropping a milestone, swapping a core library (mediabunny, WebGPU,
  Tauri), changing the `FrameSource` contract, or anything that touches
  releases or signing.
- **The next task** is the first unchecked item in the current milestone in
  `PLAN.md`, unless Nino says otherwise. When a PR completes an item, tick it
  in `PLAN.md` in the same PR.
- **One PR per roadmap item** (or per coherent slice of one). Small, reviewable
  PRs merge faster than big ones.
- **Merge your own PRs** once CI is green and any review comments are
  handled, then move on to the next item. Nino reviews after the fact.

## Definition of done

A change is done when all of these pass locally:

```sh
bun run check   # typecheck + lint + format:check + tests
```

and, if `src-tauri/` changed:

```sh
cargo check --manifest-path src-tauri/Cargo.toml
```

CI runs the same `bun run check` on every PR (`.github/workflows/ci.yml`). If
you can't make something pass, say so in the PR rather than skipping, disabling,
or loosening a test or lint rule.

Every behaviour change comes with tests. Pure logic (caches, index maths, data
models, solvers) gets unit tests; components get React Testing Library tests
written against a fake `FrameSource`.

## Package manager: Bun

Use **[Bun](https://bun.sh)**, not npm/yarn/pnpm. The lockfile is `bun.lock`.

```sh
bun install            # install dependencies
bun run <script>       # run a package.json script
bunx <tool>            # run a binary (npx equivalent)
bun add / bun remove   # change dependencies
```

## Commands

| Command             | What it does                                        |
| ------------------- | --------------------------------------------------- |
| `bun run check`     | Everything CI runs: typecheck, lint, format, tests  |
| `bun run dev`       | Vite dev server (web only, port 1420)               |
| `bun run tauri dev` | Full Tauri desktop app (needs a desktop; not in CI) |
| `bun run build`     | Type-check (`tsc`) then build the web bundle        |
| `bun run typecheck` | Type-check only, no emit                            |
| `bun run lint`      | ESLint (`lint:fix` to autofix)                      |
| `bun run format`    | Prettier write (`format:check` to verify)           |
| `bun run test`      | Vitest once (`test:watch` for watch mode)           |
| `bun run coverage`  | Vitest with a V8 coverage report                    |

Run `bun run format` before committing; it is faster than fixing
`format:check` failures by hand.

## Stack

- **Shell:** Tauri 2 + React 19 + Vite 8, TypeScript (strict).
- **GPU:** WebGPU in the webview. Verified working in Tauri's WKWebView on
  macOS.
- **Video:** WebCodecs via [mediabunny](https://mediabunny.dev/) for demux and
  frame-accurate decode.
- **Rust:** `src-tauri/`. Plumbing for now; the camera solver lands there in
  milestone 6. The JS tooling (ESLint, Prettier, Vitest) ignores `src-tauri/`.

## Layout

```
src/
  App.tsx                  file open / drop zone; takes `openSource` as a prop
  video/
    frame-source.ts        FrameSource interface (the spine; read its doc comment)
    cached-frame-source.ts FrameSource over any decoder: LRU cache, pinning, ownership
    frame-cache.ts         the LRU cache itself (pure, unit-tested)
    mediabunny-source.ts   opens a file with mediabunny; extends CachedFrameSource
    FrameViewer.tsx        shows the current frame, keyboard stepping
  gpu/
    frame-renderer.ts      FrameRenderer interface; picks WebGPU or canvas 2D
    webgpu-frame-renderer.ts  WGSL shader, createFrameDrawer (any target), canvas renderer
  test/
    setup.ts               Vitest setup (jest-dom matchers, quiet canvas stub)
    fake-frame-source.ts   FakeFrameSource for component tests
    fake-renderer.ts       FakeRenderer: records which frames were drawn
src-tauri/             Rust/Tauri shell
PLAN.md                roadmap and design decisions
```

Group new code by domain (`src/video/`, `src/tracking/`, `src/gpu/`, …) rather
than by kind (`components/`, `utils/`).

## Conventions

- **Formatting is Prettier's job, code quality is ESLint's.** Don't add
  stylistic ESLint rules; `eslint-config-prettier` turns them off.
   - Indentation is **3 spaces** (`tabWidth: 3`). Deliberate.
   - `objectWrap: "collapse"`: object literals collapse onto one line when
     they fit.
- **ESLint** uses flat config (`eslint.config.js`). It is pinned to **9.x**
  because `eslint-plugin-react` does not yet support ESLint 10.
- **Tests are colocated**: `Foo.tsx` → `Foo.test.tsx`, `bar.ts` → `bar.test.ts`.
  Vitest runs in jsdom with globals enabled (no need to import
  `describe`/`it`/`expect`). jest-dom matchers are registered in
  `src/test/setup.ts`.
- **Comments explain why, not what.** Design decisions that a later agent could
  easily undo by accident belong in a doc comment next to the code (see
  `frame-source.ts` for the style).

## Testing without a real browser

jsdom has no WebCodecs, no WebGPU, and no canvas 2D context
(`getContext("2d")` returns `null`). So:

- Write UI and logic against the `FrameSource` interface and inject a fake in
  tests. Don't import `MediabunnyFrameSource` into code you want to unit test;
  pass it in (as a prop or argument) from the app's entry point.
- Code that draws must tolerate a `null` 2D context.
- Keep GPU code behind a small interface so the logic around it stays
  testable (see `FrameRenderer` and `createFrameDrawer` in `src/gpu/`). Note
  in the PR what you checked and what you couldn't.

### Checking in a real browser

Chromium and Playwright are available in cloud sessions
(`require("playwright")`), and `ffmpeg` can make test clips
(`ffmpeg -f lavfi -i testsrc=size=320x240:rate=24:duration=5 -c:v libx264
-pix_fmt yuv420p clip.mp4`; add `-display_rotation 90` before `-i` for a
rotated clip). Run `bun run dev`, then drive `http://localhost:1420`. From
`page.evaluate` you can `import("/src/…/*.ts")` and call app code directly.

- **WebCodecs** works headless: H.264 MP4 and VP9 WebM both decode.
- **WebGPU** needs `chromium.launch({ args: ["--enable-unsafe-webgpu"] })`
  and the page must be on `localhost` (a secure context). It runs on
  SwiftShader, with two quirks: a WebGPU canvas never shows its pixels
  (screenshots and `drawImage` read back black), and copying a `VideoFrame`
  to the GPU (`copyExternalImageToTexture` or `importExternalTexture`) crashes
  the GPU process. To check rendering, draw into an offscreen texture with
  `createFrameDrawer` and read it back with `copyTextureToBuffer`, passing the
  frame as an `ImageBitmap` (`createImageBitmap(videoFrame)`). Compare against
  `sample.draw()` on an `OffscreenCanvas`; the two should match exactly.
- Only the Tauri app (`bun run tauri dev`, macOS) exercises WKWebView. Agents
  in the cloud can't run it, so call that out in the PR when it matters.

## Architecture rules

The spine of the app is the `FrameSource` interface
(`src/video/frame-source.ts`): "give me frame N, exactly." Everything
downstream talks to a `FrameSource` and nothing lower. Two rules are easy to
get wrong:

- **Seek by integer frame index** through the authoritative per-frame
  timestamp table. Never `index / frameRate`: variable-frame-rate footage would
  land on the wrong frame.
- **Ownership: the source owns, callers borrow.** Don't `.close()` a sample
  you got from a `FrameSource`, and don't hold it across an `await`. The cache
  owns its lifetime. A `VideoFrame` you create with `sample.toVideoFrame()` is
  yours to close.

Keep the `FrameSource` contract intact; the milestones in `PLAN.md` are all
written as "implement against `FrameSource`".
