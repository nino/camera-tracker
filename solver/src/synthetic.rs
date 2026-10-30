//! Synthetic scenes for tests: known cameras and points, noisy observations.

use nalgebra::{Rotation3, Vector2, Vector3};

use crate::bundle::{Observation, Problem};
use crate::camera::{project, Intrinsics, Pose};
pub use crate::rng::Rng;

pub const WIDTH: f64 = 640.0;
pub const HEIGHT: f64 = 360.0;

/// A dolly move past a cloud of points: `cameras` cameras along a 2-unit
/// path, all looking roughly at the cloud's centre; `points` points in a box
/// 4–8 units in front. Observations are the projections that land inside the
/// frame, plus Gaussian noise of `noise` pixels.
pub fn dolly_scene(cameras: usize, points: usize, noise: f64, seed: u64) -> Problem {
    let mut rng = Rng::new(seed);
    let intrinsics = Intrinsics::centred(800.0, WIDTH, HEIGHT);
    let world_points: Vec<Vector3<f64>> = (0..points)
        .map(|_| {
            Vector3::new(
                rng.range(-2.0, 2.0),
                rng.range(-1.2, 1.2),
                rng.range(4.0, 8.0),
            )
        })
        .collect();
    let poses: Vec<Pose> = (0..cameras)
        .map(|c| {
            let s = c as f64 / (cameras.max(2) - 1) as f64;
            let centre = Vector3::new(-1.0 + 2.0 * s, 0.2 * (s * 3.0).sin(), 0.5 * s);
            let target = Vector3::new(0.3 * s, 0.0, 6.0);
            Pose::look_at(centre, target, Vector3::new(0.05 * s, 1.0, 0.0))
        })
        .collect();
    let mut observations = Vec::new();
    for (c, pose) in poses.iter().enumerate() {
        for (i, point) in world_points.iter().enumerate() {
            if let Some(px) = project(&intrinsics, pose, point) {
                if (0.0..WIDTH).contains(&px.x) && (0.0..HEIGHT).contains(&px.y) {
                    let jitter = Vector2::new(rng.normal(), rng.normal()) * noise;
                    observations.push(Observation {
                        camera: c,
                        point: i,
                        pixel: px + jitter,
                    });
                }
            }
        }
    }
    Problem {
        intrinsics,
        poses,
        points: world_points,
        observations,
    }
}

/// Perturbs every pose except camera 0 and every point.
pub fn perturb(
    problem: &Problem,
    rotation: f64,
    translation: f64,
    point: f64,
    seed: u64,
) -> Problem {
    let mut rng = Rng::new(seed);
    let mut out = problem.clone();
    for pose in out.poses.iter_mut().skip(1) {
        pose.rotation = Rotation3::new(rng.normal3(rotation)) * pose.rotation;
        pose.translation += rng.normal3(translation);
    }
    for p in out.points.iter_mut() {
        *p += rng.normal3(point);
    }
    out
}
