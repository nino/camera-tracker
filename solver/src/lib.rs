//! Camera solver: recovers camera poses and 3D points from 2D tracks.
//!
//! Pure Rust with no I/O or platform code, so the same crate can be built
//! natively, into the Tauri app, or to WebAssembly.
//!
//! Conventions (shared with the frontend, see `src/tracking/tracks.ts`):
//! - Image positions are display pixels with the origin at the top-left
//!   corner of the frame, x right, y down; pixel centres sit at .5.
//! - Cameras follow the computer-vision convention: the camera looks down
//!   +z, with +x right and +y down in the image. A pose maps world points
//!   into camera coordinates: `p_cam = R * p_world + t`.

pub mod bundle;
pub mod camera;
pub mod geometry;
pub mod rng;
pub mod solve;

#[cfg(test)]
mod synthetic;
