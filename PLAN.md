# camera-tracker — plan & task tracker

A desktop camera-tracking (VFX match-move) tool whose distinguishing feature is
**onion-skinning**: superimpose several video frames so you can nudge a tracker
until features line up exactly, for precision. Built on WebGPU and Rust, with AI agents
doing most of the implementation.

## Goals

- **Ship the tool.** Velocity over hand-coding: agents implement each roadmap
  item end to end and open a PR; Nino sets direction and reviews. See
  `CLAUDE.md` for how agents work here.
- **GPU:** WebGPU (TypeScript + WGSL) in the frontend.
- **Rust:** kept as plumbing for now; the real payoff is the camera solver
  (milestone 6).

## Stack

- **Shell:** Tauri 2 + React 19 + Vite 8, Bun as package manager.
- **GPU:** WebGPU in the webview (verified working in Tauri's WKWebView on macOS
  26.5 — adapter "apple", `core-features-and-limits`).
- **Video:** WebCodecs via [mediabunny](https://mediabunny.dev/) for demux +
  frame-accurate decode.
- **Heavy math (later):** Rust for the camera solver / bundle adjustment.

## The video pipeline

```
.mp4 ──demux──► encoded packets ──decode──► VideoSample ──► GPU texture
       (mediabunny)              (WebCodecs)         (.toVideoFrame +
                                                      copyExternalImageToTexture)
```

The spine everything hangs off is the `FrameSource` interface
(`src/video/frame-source.ts`): "give me frame N, exactly." Get it right and every
later feature is "implement against FrameSource", never "rearchitect".

## Key design decisions

- **Frames are mediabunny `VideoSample`s, not raw `VideoFrame`s.** Richer (carries
  timestamp/rotation/colorspace/display size), draws to 2D canvas, converts to a
  VideoFrame for WebGPU. Mild coupling to mediabunny, accepted.
- **Ownership: the source owns, callers borrow.** Don't `.close()` borrowed
  samples; don't retain them past your current synchronous use. The cache owns
  lifetimes. (Avoids a full acquire/release refcount because a frame's durable
  copy becomes the GPU texture once uploaded.)
- **Seek by integer index through an authoritative per-frame timestamp table**,
  NOT `index / frameRate` — variable-frame-rate footage would land on the wrong
  frame. `frameRate` is metadata for UI timecode + Blender export only.
- **Upload frames with `copyExternalImageToTexture`, not `importExternalTexture`.**
  Both convert the video's colour space to sRGB, so colour wasn't the deciding
  factor. The copy gives a regular `texture_2d` that outlives the VideoFrame,
  which onion-skinning (several frames resident at once) and compute-shader
  tracking (milestone 4) both want; an external texture expires as soon as its
  frame closes. The copy costs one GPU blit per frame, which is negligible
  here. It also works in headless Chromium, where `importExternalTexture`
  doesn't.
- **Track positions are float _display_ pixels** (after rotation and pixel
  aspect; origin at the frame's top-left corner, so pixel centres sit at
  `.5`). That is the space the viewer draws in and what Blender's movie clip
  editor normalises against. Floats keep sub-pixel precision, and display ↔
  coded is a fixed linear map (rotation + pixel aspect), so the coded position
  can always be derived if a tracker ever needs raw sample-grid pixels.
- **WebGPU with a canvas 2D fallback.** The viewer draws through a small
  `FrameRenderer` interface (`src/gpu/frame-renderer.ts`); without WebGPU it
  falls back to mediabunny's 2D `.draw()`.

## Parked considerations

_None right now._

## Milestones

Each ships something usable. Order is deliberate: early steps build exactly the
infrastructure later steps need.

### 0 — Project init & de-risking ✅

- [x] Inspect scaffold; confirm toolchain (Rust 1.96, Bun 1.2.21, Tauri 2).
- [x] Verify WebGPU works in the Tauri webview (throwaway probe).
- [x] Choose stack: frontend WebGPU + mediabunny; Rust as plumbing.

### 1 — Load a video & step frame by frame (in progress)

- [x] `FrameSource` spine interface + ownership/seek design.
- [x] `MediabunnyFrameSource.open()` — demux, timestamp table, metadata, naive cache.
- [x] **1a harness:** drop-zone → open → draw current frame to a 2D canvas;
      `←`/`→` to step; frame counter. Replaces the WebGPU probe.
- [x] **Cache:** windowed LRU eviction (close evicted samples; keep a warm window
      around the playhead).
- [x] **Batched decode:** `getFrames` via `samplesAtTimestamps`.
- [x] **1b first WebGPU:** replace `.draw()` with a textured-quad renderer
      sampling the frame texture (handles display rotation).

### 2 — Manual tracker

- [x] Add a tracker (a point/marker) on a frame; store its position.
- [x] Move it across frames; data model for tracks over time (keys per frame,
      held between keys; drag or Alt+arrow nudge to key a frame).
- [x] Decide coded-vs-display coords: display (see "Key design decisions").
- [x] Persist tracks: autosaved per clip (name + size + mtime) in
      localStorage, as versioned JSON (`src/tracking/serialize.ts`).

### 3 — Onion-skinning

- [x] Sample N frames (`getFrames`) and blend them in a shader.
- [x] Controls: how many frames, opacity falloff, before/after (plus a
      red/cyan before/after tint, and O to toggle).

### 4 — Automatic tracking

- [ ] GPU correlation / pattern match around a tracker to follow it.
- [ ] Compute-shader track begins here (Surma's "All the cores, none of the canvas").

### 5 — Export to Blender

- [ ] Emit tracking data in a format Blender's movie clip editor can ingest
      (frame-indexed, using `frameRate`).

### 6 — Camera solver

- [ ] Recover 3D camera path from 2D tracks (bundle adjustment). **Rust lives here.**

### 7 — Stretch

- [ ] Object solvers, deeper math (trig, geometry), whatever the sky permits.

## Reference material

For the 1b WebGPU renderer, in order:

1. [WebGPU Fundamentals](https://webgpufundamentals.org/) — "Fundamentals" +
   "Inter-stage Variables" (device, pipeline, fullscreen-triangle).
2. WebGPU Fundamentals — "Textures" → "Importing Video" (samplers, bind groups,
   `importExternalTexture`). _This is literally 1b._
3. [Google "Your first WebGPU app" codelab](https://codelabs.developers.google.com/your-first-webgpu-app)
   — optional gentler parallel pass.
4. [Tour of WGSL](https://google.github.io/tour-of-wgsl/) — shader-language reference.

Deferred to milestone 4 (compute): Surma, "WebGPU — All of the cores, none of the
canvas." Codec deep-dive (optional): [WebCodecs Fundamentals](https://webcodecsfundamentals.org/).
