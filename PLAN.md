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
                                                      importExternalTexture)
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

## Parked considerations

- **Coded vs display dimensions.** Currently exposing _display_ size. Trackers may
  need _coded_ (raw sample-grid) pixels for sub-pixel precision. Revisit at
  milestone 2.
- **`importExternalTexture` vs `copyExternalImageToTexture`** for the WebGPU
  upload — colorspace-handling tradeoff. Decide when we write the renderer (1b).

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
- [ ] **Cache:** windowed LRU eviction (close evicted samples; keep a warm window
      around the playhead).
- [ ] **Batched decode:** `getFrames` via `samplesAtTimestamps`.
- [ ] **1b first WebGPU:** replace `.draw()` with a textured-quad renderer sampling
      the frame as an external texture.

### 2 — Manual tracker

- [ ] Add a tracker (a point/marker) on a frame; store its position.
- [ ] Move it across frames; data model for tracks over time.
- [ ] (Decide coded-vs-display coords here.)

### 3 — Onion-skinning

- [ ] Sample N frames (`getFrames`) and blend them in a shader.
- [ ] Controls: how many frames, opacity falloff, before/after.

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
