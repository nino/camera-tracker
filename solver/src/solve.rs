//! The camera solve: 2D tracks in, camera poses and 3D points out.
//!
//! Incremental structure from motion:
//! 1. Pick a pair of frames that share many tracks and have enough parallax,
//!    and estimate their relative pose from the essential matrix (RANSAC).
//! 2. Triangulate the tracks they share and bundle-adjust the pair.
//! 3. Repeatedly add the unsolved frame that sees the most solved points
//!    (resection with RANSAC, then pose refinement), triangulate tracks that
//!    are now seen from two solved frames, and bundle-adjust as it grows.
//! 4. Bundle-adjust everything, drop observations that still reproject badly
//!    (bad track positions), and adjust again.
//!
//! The result is defined up to a similarity transform: the first keyframe
//! sits at the origin looking down +z, and the two keyframes are about one
//! unit apart. Placing it in a scene (scale, floor, origin) is a later step.
//!
//! Pure rotation (tripod) shots have no parallax and fail at step 1 with
//! `SolveError::NoInitialPair`; they need a rotation-only solver.

use nalgebra::{Vector2, Vector3};

use crate::bundle::{bundle_adjust, Observation, Options as BundleOptions, Problem};
use crate::camera::{project, Intrinsics, Pose, MIN_DEPTH};
use crate::geometry::{
    essential_eight_point, normalise, parallax, refine_pose, relative_pose, resect, sampson_error,
    triangulate,
};
use crate::rng::Rng;

/// One track: its position on each frame where it is keyed.
pub type Track = Vec<(usize, Vector2<f64>)>;

#[derive(Clone, Debug)]
pub struct SolveInput {
    pub width: f64,
    pub height: f64,
    pub frame_count: usize,
    pub tracks: Vec<Track>,
    /// Focal length guess in pixels.
    pub focal: f64,
    /// Refine the focal length in the final bundle adjustment. Only reliable
    /// with plenty of perspective (see bundle.rs tests).
    pub refine_focal: bool,
}

#[derive(Clone, Debug)]
pub struct SolveOptions {
    /// Observations reprojecting further than this (pixels) are outliers.
    pub outlier_px: f64,
    /// Minimum angle between viewing rays to triangulate a point (radians).
    pub min_parallax: f64,
    pub ransac_iterations: usize,
    pub seed: u64,
}

impl Default for SolveOptions {
    fn default() -> Self {
        Self {
            outlier_px: 2.0,
            min_parallax: 1f64.to_radians(),
            ransac_iterations: 500,
            seed: 1,
        }
    }
}

#[derive(Clone, Debug)]
pub struct Solution {
    pub intrinsics: Intrinsics,
    /// Per frame; `None` where the frame couldn't be solved.
    pub poses: Vec<Option<Pose>>,
    /// Per track; `None` where the track couldn't be triangulated.
    pub points: Vec<Option<Vector3<f64>>>,
    /// RMS reprojection error (pixels) over the observations used.
    pub rms: f64,
    /// Per track RMS error over its used observations.
    pub track_errors: Vec<Option<f64>>,
    /// Observations dropped as outliers, as (track, frame).
    pub outliers: Vec<(usize, usize)>,
    /// The two frames the solve started from.
    pub keyframes: (usize, usize),
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum SolveError {
    /// Fewer than 8 tracks are shared by any two frames.
    NotEnoughTracks,
    /// No pair of frames gave a usable two-view start (e.g. no parallax).
    NoInitialPair,
}

impl std::fmt::Display for SolveError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(match self {
            SolveError::NotEnoughTracks => "Need at least 8 tracks shared by two frames.",
            SolveError::NoInitialPair => {
                "No two frames have enough parallax to start from (is the camera only rotating?)."
            }
        })
    }
}

impl std::error::Error for SolveError {}

struct State<'a> {
    input: &'a SolveInput,
    options: &'a SolveOptions,
    k: Intrinsics,
    poses: Vec<Option<Pose>>,
    points: Vec<Option<Vector3<f64>>>,
    /// Per track, per observation index: still used (not an outlier).
    active: Vec<Vec<bool>>,
    /// Frames tried and rejected for resection.
    failed: Vec<bool>,
    fixed_frame: usize,
    rng: Rng,
}

pub fn solve(input: &SolveInput, options: &SolveOptions) -> Result<Solution, SolveError> {
    let k = Intrinsics::centred(input.focal, input.width, input.height);
    let mut state = State {
        input,
        options,
        k,
        poses: vec![None; input.frame_count],
        points: vec![None; input.tracks.len()],
        active: input.tracks.iter().map(|t| vec![true; t.len()]).collect(),
        failed: vec![false; input.frame_count],
        fixed_frame: 0,
        rng: Rng::new(options.seed),
    };
    let keyframes = state.initialise()?;
    state.fixed_frame = keyframes.0;

    let mut last_adjusted = 2;
    while let Some(frame) = state.next_frame() {
        if !state.register(frame) {
            state.failed[frame] = true;
            continue;
        }
        state.triangulate_new();
        let solved = state.poses.iter().flatten().count();
        // Adjust whenever the solve has grown by a fifth, to keep drift down
        // without a full adjustment per frame.
        if solved >= last_adjusted + (last_adjusted / 5).max(3) {
            state.adjust(false);
            last_adjusted = solved;
        }
    }
    state.adjust(input.refine_focal);
    for _ in 0..3 {
        if state.reject_outliers() == 0 {
            break;
        }
        state.adjust(input.refine_focal);
    }
    Ok(state.finish(keyframes))
}

impl State<'_> {
    fn observations_on(&self, frame: usize) -> Vec<(usize, Vector2<f64>)> {
        let mut out = Vec::new();
        for (t, track) in self.input.tracks.iter().enumerate() {
            for (o, (f, px)) in track.iter().enumerate() {
                if *f == frame && self.active[t][o] {
                    out.push((t, *px));
                }
            }
        }
        out
    }

    /// Picks and solves the starting pair.
    fn initialise(&mut self) -> Result<(usize, usize), SolveError> {
        let frames = self.input.frame_count;
        let per_frame: Vec<Vec<(usize, Vector2<f64>)>> =
            (0..frames).map(|f| self.observations_on(f)).collect();
        // Score candidate pairs: many shared tracks, and motion between them
        // (median image displacement, capped so huge gaps don't dominate).
        let step = (frames / 40).max(1);
        let candidates: Vec<usize> = (0..frames).step_by(step).collect();
        let mut pairs = Vec::new();
        for (i, &a) in candidates.iter().enumerate() {
            for &b in &candidates[i + 1..] {
                let shared = shared(&per_frame[a], &per_frame[b]);
                if shared.len() < 8 {
                    continue;
                }
                let mut moves: Vec<f64> =
                    shared.iter().map(|(_, pa, pb)| (pa - pb).norm()).collect();
                moves.sort_by(f64::total_cmp);
                let median = moves[moves.len() / 2];
                let diag = self.input.width.hypot(self.input.height);
                let score = shared.len() as f64 * median.min(0.1 * diag);
                pairs.push((score, a, b, shared));
            }
        }
        if pairs.is_empty() {
            return Err(SolveError::NotEnoughTracks);
        }
        pairs.sort_by(|x, y| y.0.total_cmp(&x.0));
        for (_, a, b, shared) in pairs.into_iter().take(10) {
            if self.try_pair(a, b, &shared) {
                return Ok((a, b));
            }
        }
        Err(SolveError::NoInitialPair)
    }

    fn try_pair(
        &mut self,
        a: usize,
        b: usize,
        shared: &[(usize, Vector2<f64>, Vector2<f64>)],
    ) -> bool {
        let k = self.k;
        let norm: Vec<_> = shared
            .iter()
            .map(|(_, pa, pb)| (normalise(&k, pa), normalise(&k, pb)))
            .collect();
        let threshold = (self.options.outlier_px / k.focal).powi(2);
        let mut best: Option<Vec<usize>> = None;
        for _ in 0..self.options.ransac_iterations {
            let sample: Vec<_> = self
                .rng
                .sample(norm.len(), 8)
                .into_iter()
                .map(|i| norm[i])
                .collect();
            let Some(e) = essential_eight_point(&sample) else {
                continue;
            };
            let inliers: Vec<usize> = (0..norm.len())
                .filter(|&i| sampson_error(&e, &norm[i].0, &norm[i].1) < threshold)
                .collect();
            if best.as_ref().is_none_or(|b| inliers.len() > b.len()) {
                best = Some(inliers);
            }
        }
        let Some(inliers) = best else { return false };
        if inliers.len() < 8 || inliers.len() * 2 < norm.len() {
            return false;
        }
        let inlier_pairs: Vec<_> = inliers.iter().map(|&i| norm[i]).collect();
        let Some(e) = essential_eight_point(&inlier_pairs) else {
            return false;
        };
        let Some((pose_b, _)) = relative_pose(&e, &inlier_pairs) else {
            return false;
        };
        let pose_a = Pose::identity();

        let mut angles = Vec::new();
        for &i in &inliers {
            let (track, _, _) = shared[i];
            let (na, nb) = norm[i];
            let Some(x) = triangulate(&[(pose_a, na), (pose_b, nb)]) else {
                continue;
            };
            if pose_a.to_camera(&x).z <= MIN_DEPTH || pose_b.to_camera(&x).z <= MIN_DEPTH {
                continue;
            }
            let angle = parallax(&pose_a, &pose_b, &x);
            angles.push(angle);
            if angle >= self.options.min_parallax {
                self.points[track] = Some(x);
            }
        }
        angles.sort_by(f64::total_cmp);
        let triangulated = self.points.iter().flatten().count();
        if angles.is_empty()
            || angles[angles.len() / 2] < self.options.min_parallax
            || triangulated < 8
        {
            self.points.iter_mut().for_each(|p| *p = None);
            return false;
        }
        self.poses[a] = Some(pose_a);
        self.poses[b] = Some(pose_b);
        self.fixed_frame = a;
        self.adjust(false);
        true
    }

    /// The unsolved frame that sees the most solved points (at least 6).
    fn next_frame(&self) -> Option<usize> {
        (0..self.input.frame_count)
            .filter(|&f| self.poses[f].is_none() && !self.failed[f])
            .map(|f| {
                let seen = self
                    .observations_on(f)
                    .iter()
                    .filter(|(t, _)| self.points[*t].is_some())
                    .count();
                (seen, f)
            })
            .filter(|(seen, _)| *seen >= 6)
            .max()
            .map(|(_, f)| f)
    }

    fn register(&mut self, frame: usize) -> bool {
        let k = self.k;
        let known: Vec<(Vector3<f64>, Vector2<f64>)> = self
            .observations_on(frame)
            .into_iter()
            .filter_map(|(t, px)| Some((self.points[t]?, px)))
            .collect();
        let normalised: Vec<_> = known
            .iter()
            .map(|(x, px)| (*x, normalise(&k, px)))
            .collect();
        let within = |pose: &Pose, (x, px): &(Vector3<f64>, Vector2<f64>), tolerance: f64| {
            project(&k, pose, x).is_some_and(|p| (p - px).norm() < tolerance)
        };
        // A pose from 6 noisy points is rough, so samples are scored with a
        // looser threshold, and the best is then refined on its inliers and
        // re-scored at the real threshold (locally optimised RANSAC).
        let loose = 4.0 * self.options.outlier_px;
        let mut best: Option<(Pose, usize)> = None;
        for _ in 0..self.options.ransac_iterations {
            let sample: Vec<_> = self
                .rng
                .sample(normalised.len(), 6)
                .into_iter()
                .map(|i| normalised[i])
                .collect();
            let Some(pose) = resect(&sample) else {
                continue;
            };
            let count = known.iter().filter(|o| within(&pose, o, loose)).count();
            if best.as_ref().is_none_or(|(_, n)| count > *n) {
                best = Some((pose, count));
            }
        }
        let Some((mut pose, _)) = best else {
            return false;
        };
        let mut tolerance = loose;
        for _ in 0..4 {
            let inliers: Vec<_> = known
                .iter()
                .filter(|o| within(&pose, o, tolerance))
                .copied()
                .collect();
            if inliers.len() < 6 {
                return false;
            }
            pose = refine_pose(&k, pose, &inliers, 10);
            tolerance = (tolerance / 2.0).max(self.options.outlier_px);
        }
        let inliers: Vec<_> = known
            .iter()
            .filter(|o| within(&pose, o, self.options.outlier_px))
            .copied()
            .collect();
        if inliers.len() < 6 || inliers.len() * 2 < known.len() {
            return false;
        }
        let pose = refine_pose(&k, pose, &inliers, 10);
        self.poses[frame] = Some(pose);
        true
    }

    /// Triangulates tracks that now have two solved views with enough
    /// parallax. Robust to bad positions on a track: tries pairs of views,
    /// keeps the triangulation most views agree with, re-triangulates from
    /// those, and drops the views that disagree as outliers.
    fn triangulate_new(&mut self) {
        let k = self.k;
        let tolerance = self.options.outlier_px;
        for t in 0..self.input.tracks.len() {
            if self.points[t].is_some() {
                continue;
            }
            // (observation index, pose, normalised, pixel)
            let views: Vec<(usize, Pose, Vector2<f64>, Vector2<f64>)> = self.input.tracks[t]
                .iter()
                .enumerate()
                .filter(|(o, _)| self.active[t][*o])
                .filter_map(|(o, (f, px))| Some((o, self.poses[*f]?, normalise(&k, px), *px)))
                .collect();
            if views.len() < 2 {
                continue;
            }
            let agrees =
                |x: &Vector3<f64>, (_, pose, _, px): &(usize, Pose, Vector2<f64>, Vector2<f64>)| {
                    project(&k, pose, x).is_some_and(|p| (p - px).norm() < tolerance)
                };
            // Pairs to try: all of them for short tracks, else a sample.
            let n = views.len();
            let pairs: Vec<(usize, usize)> = if n <= 12 {
                (0..n)
                    .flat_map(|i| (i + 1..n).map(move |j| (i, j)))
                    .collect()
            } else {
                (0..40)
                    .map(|_| {
                        let s = self.rng.sample(n, 2);
                        (s[0], s[1])
                    })
                    .collect()
            };
            let mut best: Option<(usize, Vector3<f64>)> = None;
            for (i, j) in pairs {
                let (a, b) = (&views[i], &views[j]);
                let Some(x) = triangulate(&[(a.1, a.2), (b.1, b.2)]) else {
                    continue;
                };
                if parallax(&a.1, &b.1, &x) < self.options.min_parallax {
                    continue;
                }
                let support = views.iter().filter(|v| agrees(&x, v)).count();
                if best.as_ref().is_none_or(|(s, _)| support > *s) {
                    best = Some((support, x));
                }
            }
            let Some((support, x)) = best else { continue };
            if support < 2 {
                continue;
            }
            let inliers: Vec<_> = views.iter().filter(|v| agrees(&x, v)).collect();
            let rays: Vec<_> = inliers.iter().map(|v| (v.1, v.2)).collect();
            let Some(x) = triangulate(&rays) else {
                continue;
            };
            if !inliers.iter().all(|v| agrees(&x, v)) {
                continue;
            }
            for v in &views {
                if !agrees(&x, v) {
                    self.active[t][v.0] = false;
                }
            }
            self.points[t] = Some(x);
        }
    }

    /// Bundle-adjusts all solved frames and points.
    fn adjust(&mut self, refine_focal: bool) {
        let frames: Vec<usize> = (0..self.input.frame_count)
            .filter(|&f| self.poses[f].is_some())
            .collect();
        let tracks: Vec<usize> = (0..self.input.tracks.len())
            .filter(|&t| self.points[t].is_some())
            .collect();
        let mut frame_index = vec![usize::MAX; self.input.frame_count];
        for (i, &f) in frames.iter().enumerate() {
            frame_index[f] = i;
        }
        let mut observations = Vec::new();
        for (pi, &t) in tracks.iter().enumerate() {
            for (o, (f, px)) in self.input.tracks[t].iter().enumerate() {
                if self.active[t][o] && frame_index[*f] != usize::MAX {
                    observations.push(Observation {
                        camera: frame_index[*f],
                        point: pi,
                        pixel: *px,
                    });
                }
            }
        }
        let mut problem = Problem {
            intrinsics: self.k,
            poses: frames
                .iter()
                .map(|&f| self.poses[f].expect("solved"))
                .collect(),
            points: tracks
                .iter()
                .map(|&t| self.points[t].expect("triangulated"))
                .collect(),
            observations,
        };
        let options = BundleOptions {
            fixed_cameras: vec![frame_index[self.fixed_frame]],
            refine_focal,
            ..BundleOptions::default()
        };
        if bundle_adjust(&mut problem, &options).is_none() {
            return;
        }
        self.k = problem.intrinsics;
        for (i, &f) in frames.iter().enumerate() {
            self.poses[f] = Some(problem.poses[i]);
        }
        for (i, &t) in tracks.iter().enumerate() {
            self.points[t] = Some(problem.points[i]);
        }
    }

    /// Re-classifies every observation against the current solve: those
    /// reprojecting within `outlier_px` are used, the rest are outliers. This
    /// also brings back observations rejected earlier against a rougher
    /// solve. Drops points left with fewer than two used observations.
    /// Returns how many observations changed class.
    fn reject_outliers(&mut self) -> usize {
        let mut changed = 0;
        for t in 0..self.input.tracks.len() {
            let Some(x) = self.points[t] else { continue };
            for (o, (f, px)) in self.input.tracks[t].iter().enumerate() {
                let Some(pose) = self.poses[*f] else { continue };
                let good = project(&self.k, &pose, &x)
                    .is_some_and(|p| (p - px).norm() <= self.options.outlier_px);
                if good != self.active[t][o] {
                    self.active[t][o] = good;
                    changed += 1;
                }
            }
            let used = self.input.tracks[t]
                .iter()
                .enumerate()
                .filter(|(o, (f, _))| self.active[t][*o] && self.poses[*f].is_some())
                .count();
            if used < 2 {
                self.points[t] = None;
            }
        }
        changed
    }

    fn finish(self, keyframes: (usize, usize)) -> Solution {
        let mut total = 0.0;
        let mut count = 0usize;
        let mut track_errors = vec![None; self.input.tracks.len()];
        let mut outliers = Vec::new();
        for (t, track) in self.input.tracks.iter().enumerate() {
            let (mut sum, mut n) = (0.0, 0usize);
            for (o, (f, px)) in track.iter().enumerate() {
                if !self.active[t][o] {
                    outliers.push((t, *f));
                    continue;
                }
                let (Some(x), Some(pose)) = (self.points[t], self.poses[*f]) else {
                    continue;
                };
                if let Some(p) = project(&self.k, &pose, &x) {
                    sum += (p - px).norm_squared();
                    n += 1;
                }
            }
            if n > 0 {
                track_errors[t] = Some((sum / n as f64).sqrt());
                total += sum;
                count += n;
            }
        }
        Solution {
            intrinsics: self.k,
            poses: self.poses,
            points: self.points,
            rms: (total / count.max(1) as f64).sqrt(),
            track_errors,
            outliers,
            keyframes,
        }
    }
}

/// Tracks seen on both frames: (track, position on a, position on b).
fn shared(
    a: &[(usize, Vector2<f64>)],
    b: &[(usize, Vector2<f64>)],
) -> Vec<(usize, Vector2<f64>, Vector2<f64>)> {
    a.iter()
        .filter_map(|(t, pa)| b.iter().find(|(u, _)| u == t).map(|(_, pb)| (*t, *pa, *pb)))
        .collect()
}

#[cfg(test)]
mod tests_support {
    use super::*;
    use crate::synthetic::{HEIGHT, WIDTH};
    use nalgebra::{Matrix3, Rotation3};

    pub fn tracks_of(problem: &Problem) -> Vec<Track> {
        let mut tracks = vec![Vec::new(); problem.points.len()];
        for obs in &problem.observations {
            tracks[obs.point].push((obs.camera, obs.pixel));
        }
        tracks
    }

    pub fn input(problem: &Problem, tracks: Vec<Track>) -> SolveInput {
        SolveInput {
            width: WIDTH,
            height: HEIGHT,
            frame_count: problem.poses.len(),
            tracks,
            focal: problem.intrinsics.focal,
            refine_focal: false,
        }
    }

    /// Similarity (s, R, t) best mapping `from` onto `to` (Umeyama).
    pub fn similarity(
        from: &[Vector3<f64>],
        to: &[Vector3<f64>],
    ) -> (f64, Rotation3<f64>, Vector3<f64>) {
        let n = from.len() as f64;
        let mf = from.iter().sum::<Vector3<f64>>() / n;
        let mt = to.iter().sum::<Vector3<f64>>() / n;
        let mut cov = Matrix3::zeros();
        let mut var = 0.0;
        for (a, b) in from.iter().zip(to) {
            cov += (b - mt) * (a - mf).transpose();
            var += (a - mf).norm_squared();
        }
        let svd = cov.svd(true, true);
        let (u, v_t) = (svd.u.unwrap(), svd.v_t.unwrap());
        let mut d = Matrix3::identity();
        if (u * v_t).determinant() < 0.0 {
            d[(2, 2)] = -1.0;
        }
        let r = u * d * v_t;
        let s = (svd.singular_values.component_mul(&d.diagonal())).sum() / var;
        (s, Rotation3::from_matrix_unchecked(r), mt - s * r * mf)
    }

    /// Largest camera-centre error after aligning the solve to the truth, as a
    /// fraction of the camera path's extent.
    pub fn centre_error(truth: &Problem, solution: &Solution) -> f64 {
        let pairs: Vec<_> = truth
            .poses
            .iter()
            .zip(&solution.poses)
            .filter_map(|(t, s)| Some((s.as_ref()?.centre(), t.centre())))
            .collect();
        let (from, to): (Vec<_>, Vec<_>) = pairs.into_iter().unzip();
        let (s, r, t) = similarity(&from, &to);
        let extent = to.iter().map(|c| (c - to[0]).norm()).fold(0.0, f64::max);
        from.iter()
            .zip(&to)
            .map(|(a, b)| (s * (r * a) + t - b).norm())
            .fold(0.0, f64::max)
            / extent
    }
}

#[cfg(test)]
mod tests {
    use super::tests_support::*;
    use super::*;
    use crate::synthetic::{dolly_scene, Rng};
    use nalgebra::Rotation3;

    #[test]
    fn solves_a_noisy_dolly_shot_from_tracks_alone() {
        let truth = dolly_scene(30, 120, 0.3, 21);
        let solution = solve(&input(&truth, tracks_of(&truth)), &SolveOptions::default()).unwrap();
        assert!(
            solution.poses.iter().all(Option::is_some),
            "unsolved frames"
        );
        let triangulated = solution.points.iter().flatten().count();
        assert!(
            triangulated as f64 > 0.9 * truth.points.len() as f64,
            "{triangulated} points"
        );
        assert!(solution.rms < 0.3 * 2f64.sqrt(), "rms {}", solution.rms);
        let err = centre_error(&truth, &solution);
        assert!(err < 0.01, "centre error {err}");
    }

    #[test]
    fn drops_bad_track_positions_as_outliers() {
        let truth = dolly_scene(30, 120, 0.3, 22);
        let mut tracks = tracks_of(&truth);
        let mut rng = Rng::new(23);
        let mut corrupted = Vec::new();
        for (t, track) in tracks.iter_mut().enumerate() {
            for (f, px) in track.iter_mut() {
                if rng.uniform() < 0.03 {
                    *px += Vector2::new(rng.range(-1.0, 1.0), rng.range(-1.0, 1.0)).normalize()
                        * rng.range(15.0, 40.0);
                    corrupted.push((t, *f));
                }
            }
        }
        let solution = solve(&input(&truth, tracks), &SolveOptions::default()).unwrap();
        assert!(solution.poses.iter().all(Option::is_some));
        let caught = corrupted
            .iter()
            .filter(|c| solution.outliers.contains(c))
            .count();
        assert!(
            caught as f64 >= 0.95 * corrupted.len() as f64,
            "caught {caught} of {}",
            corrupted.len()
        );
        // And few good observations were thrown away with them.
        assert!(
            solution.outliers.len() < corrupted.len() + 20,
            "{} outliers",
            solution.outliers.len()
        );
        assert!(solution.rms < 0.3 * 2f64.sqrt(), "rms {}", solution.rms);
        assert!(centre_error(&truth, &solution) < 0.01);
    }

    #[test]
    fn handles_tracks_that_start_and_end_mid_shot() {
        let truth = dolly_scene(30, 150, 0.2, 24);
        // Keep each track only on a window of 8–15 frames.
        let mut rng = Rng::new(25);
        let tracks: Vec<Track> = tracks_of(&truth)
            .into_iter()
            .map(|track| {
                let start = (rng.uniform() * 30.0) as usize;
                let len = 8 + (rng.uniform() * 8.0) as usize;
                track
                    .into_iter()
                    .filter(|(f, _)| *f >= start && *f < start + len)
                    .collect()
            })
            .collect();
        let solution = solve(&input(&truth, tracks), &SolveOptions::default()).unwrap();
        let solved = solution.poses.iter().flatten().count();
        assert!(solved >= 28, "{solved} frames solved");
        assert!(centre_error(&truth, &solution) < 0.02);
    }

    #[test]
    fn reports_missing_tracks_and_missing_parallax() {
        let truth = dolly_scene(10, 60, 0.0, 26);
        let few: Vec<Track> = tracks_of(&truth).into_iter().take(5).collect();
        assert_eq!(
            solve(&input(&truth, few), &SolveOptions::default()).unwrap_err(),
            SolveError::NotEnoughTracks
        );

        // A tripod pan: cameras share a centre, so nothing can be triangulated.
        let mut tripod = truth.clone();
        for (c, pose) in tripod.poses.iter_mut().enumerate() {
            let yaw = Rotation3::from_axis_angle(&Vector3::y_axis(), 0.01 * c as f64);
            *pose = Pose {
                rotation: yaw,
                translation: Vector3::zeros(),
            };
        }
        let tracks: Vec<Track> = tripod
            .points
            .iter()
            .map(|x| {
                tripod
                    .poses
                    .iter()
                    .enumerate()
                    .filter_map(|(f, p)| Some((f, project(&tripod.intrinsics, p, x)?)))
                    .collect()
            })
            .collect();
        assert_eq!(
            solve(&input(&tripod, tracks), &SolveOptions::default()).unwrap_err(),
            SolveError::NoInitialPair
        );
    }

    #[test]
    fn refines_a_wrong_focal_guess() {
        let truth = dolly_scene(30, 120, 0.2, 27);
        let mut job = input(&truth, tracks_of(&truth));
        job.focal *= 0.9;
        job.refine_focal = true;
        let solution = solve(&job, &SolveOptions::default()).unwrap();
        let ratio = solution.intrinsics.focal / truth.intrinsics.focal;
        assert!((ratio - 1.0).abs() < 0.02, "focal ratio {ratio}");
        assert!(solution.rms < 0.2 * 2f64.sqrt(), "rms {}", solution.rms);
    }
}

#[cfg(test)]
mod sweep {
    //! Slow robustness sweep over many random scenes: `cargo test -- --ignored`.
    use super::tests_support::*;
    use super::*;
    use crate::synthetic::{dolly_scene, Rng};

    #[test]
    #[ignore]
    fn many_scenes() {
        let mut failures = Vec::new();
        for seed in 100..140u64 {
            let truth = dolly_scene(30, 120, 0.3, seed);
            let mut tracks = tracks_of(&truth);
            let mut rng = Rng::new(seed + 1000);
            for track in tracks.iter_mut() {
                for (_, px) in track.iter_mut() {
                    if rng.uniform() < 0.03 {
                        *px += Vector2::new(rng.range(15.0, 40.0), rng.range(-40.0, 40.0));
                    }
                }
            }
            match solve(&input(&truth, tracks), &SolveOptions::default()) {
                Ok(s) => {
                    let solved = s.poses.iter().flatten().count();
                    let err = centre_error(&truth, &s);
                    if solved < 30 || err > 0.01 || s.rms > 0.45 {
                        failures.push(format!(
                            "seed {seed}: {solved} frames, err {err:.4}, rms {:.3}",
                            s.rms
                        ));
                    }
                }
                Err(e) => failures.push(format!("seed {seed}: {e}")),
            }
        }
        assert!(failures.is_empty(), "{}", failures.join("\n"));
    }
}
