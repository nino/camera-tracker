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

/// Progress notes for debugging solves: printed by test builds (see the
/// ignored `api::dump::run_file`), compiled out otherwise.
macro_rules! trace {
    ($($arg:tt)*) => {
        #[cfg(test)]
        eprintln!($($arg)*);
        #[cfg(not(test))]
        let _ = format_args!($($arg)*);
    };
}

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
    /// Refine the focal length. Only reliable with plenty of perspective
    /// (see bundle.rs tests).
    pub refine_focal: bool,
    /// Radial distortion guess (see camera.rs); 0 for none.
    pub k1: f64,
    pub k2: f64,
    /// Refine k1 and k2.
    pub refine_distortion: bool,
}

#[derive(Clone, Debug)]
pub struct SolveOptions {
    /// Observations reprojecting further than this (pixels) are outliers.
    pub outlier_px: f64,
    /// Minimum angle between viewing rays to triangulate a point (radians).
    pub min_parallax: f64,
    /// Minimum median parallax of the starting pair (radians). Lower than
    /// `min_parallax`: handheld shots rarely have more between two frames.
    pub min_start_parallax: f64,
    pub ransac_iterations: usize,
    pub seed: u64,
}

impl Default for SolveOptions {
    fn default() -> Self {
        Self {
            outlier_px: 2.0,
            min_parallax: 0.25f64.to_radians(),
            min_start_parallax: 0.2f64.to_radians(),
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
    /// For frames that failed to register: how many solved points they saw
    /// then. They're retried once they see more.
    failed: Vec<Option<usize>>,
    fixed_frame: usize,
    /// Solved frames in the order they were added.
    order: Vec<usize>,
    rng: Rng,
    k1_only: bool,
}

/// Frame pairs tried as the starting pair.
const START_CANDIDATES: usize = 20;

/// A candidate two-view start (see `State::try_pair`).
struct Start {
    a: usize,
    b: usize,
    pose_b: Pose,
    points: Vec<(usize, Vector3<f64>)>,
    /// Median angle between the two views' rays to the points (radians).
    parallax: f64,
}

/// Solved cameras needed before the intrinsics are refined mid-solve.
const MIN_CAMERAS_FOR_INTRINSICS: usize = 12;

pub fn solve(input: &SolveInput, options: &SolveOptions) -> Result<Solution, SolveError> {
    let k = Intrinsics {
        k1: input.k1,
        k2: input.k2,
        ..Intrinsics::centred(input.focal, input.width, input.height)
    };
    let mut state = State {
        input,
        options,
        k,
        poses: vec![None; input.frame_count],
        points: vec![None; input.tracks.len()],
        active: input.tracks.iter().map(|t| vec![true; t.len()]).collect(),
        failed: vec![None; input.frame_count],
        fixed_frame: 0,
        order: Vec::new(),
        rng: Rng::new(options.seed),
        k1_only: false,
    };
    let keyframes = state.initialise()?;
    state.fixed_frame = keyframes.0;

    let mut last_global = 2;
    while let Some(frame) = state.next_frame() {
        if !state.register(frame) {
            state.failed[frame] = Some(state.seen_points(frame));
            continue;
        }
        state.triangulate_new();
        // Refine the newest cameras after every addition (cheap), and the
        // whole solve (with the intrinsics, if asked) each time it has grown
        // by half, to keep drift down.
        // Intrinsics wait for enough cameras: with a handful, focal length
        // and distortion trade off against depth and can run away.
        let solved = state.order.len();
        if solved >= last_global + last_global / 2 {
            state.k1_only = true;
            state.adjust(solved >= MIN_CAMERAS_FOR_INTRINSICS, false);
            state.k1_only = false;
            last_global = solved;
        } else {
            state.adjust(false, true);
        }
    }
    trace!(
        "incremental done: {} frames, {:?}",
        state.order.len(),
        state.k
    );
    state.adjust(true, false);
    for _ in 0..3 {
        if state.reject_outliers() == 0 {
            break;
        }
        state.adjust(true, false);
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
        // Real handheld shots often have well under a degree of parallax
        // between any two frames, so rather than taking the first pair
        // that clears a bar, try the most promising pairs and keep the one
        // with the most parallax.
        let mut best: Option<Start> = None;
        for (_, a, b, shared) in pairs.into_iter().take(START_CANDIDATES) {
            if let Some(start) = self.try_pair(a, b, &shared) {
                if best.as_ref().is_none_or(|s| start.parallax > s.parallax) {
                    best = Some(start);
                }
            }
        }
        let start = best
            .filter(|s| s.parallax >= self.options.min_start_parallax)
            .ok_or(SolveError::NoInitialPair)?;
        let (a, b) = (start.a, start.b);
        for (track, x) in start.points {
            self.points[track] = Some(x);
        }
        self.poses[a] = Some(Pose::identity());
        self.poses[b] = Some(start.pose_b);
        self.order = vec![a, b];
        self.fixed_frame = a;
        self.adjust(false, false);
        Ok((a, b))
    }

    /// A two-view start for frames `a` and `b` (camera `a` at the origin),
    /// or `None` if their tracks don't fit one relative motion.
    fn try_pair(
        &mut self,
        a: usize,
        b: usize,
        shared: &[(usize, Vector2<f64>, Vector2<f64>)],
    ) -> Option<Start> {
        let k = self.k;
        let norm: Vec<_> = shared
            .iter()
            .map(|(_, pa, pb)| (normalise(&k, pa), normalise(&k, pb)))
            .collect();
        let threshold = (self.options.outlier_px / k.focal).powi(2);
        let mut best: Option<Vec<usize>> = None;
        let mut needed = self.options.ransac_iterations;
        let mut tried = 0;
        while tried < needed {
            tried += 1;
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
                needed = needed.min(ransac_iterations_for(inliers.len(), norm.len(), 8));
                best = Some(inliers);
            }
        }
        let inliers = best?;
        if inliers.len() < 8 || inliers.len() * 2 < norm.len() {
            return None;
        }
        let inlier_pairs: Vec<_> = inliers.iter().map(|&i| norm[i]).collect();
        let e = essential_eight_point(&inlier_pairs)?;
        let (pose_b, _) = relative_pose(&e, &inlier_pairs)?;
        let pose_a = Pose::identity();

        let mut triangulated = Vec::new();
        for &i in &inliers {
            let (track, _, _) = shared[i];
            let (na, nb) = norm[i];
            let Some(x) = triangulate(&[(pose_a, na), (pose_b, nb)]) else {
                continue;
            };
            if pose_a.to_camera(&x).z <= MIN_DEPTH || pose_b.to_camera(&x).z <= MIN_DEPTH {
                continue;
            }
            triangulated.push((track, x, parallax(&pose_a, &pose_b, &x)));
        }
        if triangulated.len() < 8 {
            return None;
        }
        let mut angles: Vec<f64> = triangulated.iter().map(|t| t.2).collect();
        angles.sort_by(f64::total_cmp);
        let median = angles[angles.len() / 2];
        // Keep the points that are at least half as well triangulated as the
        // typical one; bundle adjustment and later views firm them up.
        let points: Vec<_> = triangulated
            .into_iter()
            .filter(|t| t.2 >= 0.5 * median)
            .map(|(track, x, _)| (track, x))
            .collect();
        (points.len() >= 8).then_some(Start {
            a,
            b,
            pose_b,
            points,
            parallax: median,
        })
    }

    /// Solved points that `frame` has active observations of.
    fn seen_points(&self, frame: usize) -> usize {
        self.observations_on(frame)
            .iter()
            .filter(|(t, _)| self.points[*t].is_some())
            .count()
    }

    /// The unsolved frame that sees the most solved points (at least 6). A
    /// frame that failed is tried again once it sees a quarter more.
    fn next_frame(&self) -> Option<usize> {
        (0..self.input.frame_count)
            .filter(|&f| self.poses[f].is_none())
            .map(|f| (self.seen_points(f), f))
            .filter(|&(seen, f)| {
                seen >= 6 && self.failed[f].is_none_or(|before| seen > before + before / 4)
            })
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
        let mut needed = self.options.ransac_iterations;
        let mut tried = 0;
        while tried < needed {
            tried += 1;
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
                needed = needed.min(ransac_iterations_for(count, known.len(), 6));
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
                trace!(
                    "frame {frame}: {} of {} points fit",
                    inliers.len(),
                    known.len()
                );
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
            trace!(
                "frame {frame}: {} of {} points fit",
                inliers.len(),
                known.len()
            );
            return false;
        }
        let pose = refine_pose(&k, pose, &inliers, 10);
        self.poses[frame] = Some(pose);
        self.order.push(frame);
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

    /// Bundle-adjusts the solve. `local` refines only the most recently
    /// added cameras and the points they see, holding every other camera
    /// that sees those points fixed; otherwise everything is refined.
    /// Whether refined intrinsics are believable: focal length within a
    /// factor of 3 of the guess, distortion short of a fisheye's.
    fn plausible(&self, k: &Intrinsics) -> bool {
        let ratio = k.focal / self.input.focal;
        (1.0 / 3.0..=3.0).contains(&ratio) && k.k1.abs() <= 1.0 && k.k2.abs() <= 1.0
    }

    /// `intrinsics` lets it refine what the input asks to (focal length,
    /// distortion); otherwise they're held.
    fn adjust(&mut self, intrinsics: bool, local: bool) {
        const LOCAL_WINDOW: usize = 10;
        let mut free = vec![!local; self.input.frame_count];
        if local {
            for &f in self.order.iter().rev().take(LOCAL_WINDOW) {
                free[f] = true;
            }
        }
        free[self.fixed_frame] = false;
        let seen_by_free = |t: usize| {
            self.input.tracks[t]
                .iter()
                .enumerate()
                .any(|(o, (f, _))| self.active[t][o] && free[*f] && self.poses[*f].is_some())
        };
        let tracks: Vec<usize> = (0..self.input.tracks.len())
            .filter(|&t| self.points[t].is_some() && (!local || seen_by_free(t)))
            .collect();
        let mut used = vec![false; self.input.frame_count];
        for &t in &tracks {
            for (o, (f, _)) in self.input.tracks[t].iter().enumerate() {
                if self.active[t][o] && self.poses[*f].is_some() {
                    used[*f] = true;
                }
            }
        }
        let frames: Vec<usize> = (0..self.input.frame_count)
            .filter(|&f| self.poses[f].is_some() && (used[f] || f == self.fixed_frame))
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
            fixed_cameras: frames
                .iter()
                .enumerate()
                .filter(|(_, &f)| !free[f])
                .map(|(i, _)| i)
                .collect(),
            refine_focal: intrinsics && self.input.refine_focal,
            refine_distortion: intrinsics && self.input.refine_distortion,
            refine_k2: !self.k1_only,
            // Stop once an iteration gains less than a millionth of the
            // cost: far below what moves a camera visibly, and the last
            // dozens of iterations otherwise go on such crumbs.
            function_tolerance: 1e-6,
            ..BundleOptions::default()
        };
        let start = problem.clone();
        let Some(rep) = bundle_adjust(&mut problem, &options) else {
            return;
        };
        if !local {
            trace!(
                "global BA, {} frames: rms {:.3} -> {:.3} in {} steps, {:?}",
                frames.len(),
                rep.initial_rms,
                rep.final_rms,
                rep.iterations,
                problem.intrinsics
            );
        }
        if !self.plausible(&problem.intrinsics) {
            // The intrinsics ran off somewhere no real lens is (an
            // ill-conditioned shot); redo the adjustment without them.
            problem = start;
            let held = BundleOptions {
                refine_focal: false,
                refine_distortion: false,
                ..options
            };
            if bundle_adjust(&mut problem, &held).is_none() {
                return;
            }
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

/// RANSAC iterations needed to draw at least one all-inlier sample of `k`
/// with 99.9% probability, given the best inlier count so far (adaptive
/// termination: few iterations when nearly everything is an inlier).
fn ransac_iterations_for(inliers: usize, total: usize, k: usize) -> usize {
    let w = inliers as f64 / total.max(1) as f64;
    let all_inliers = w.powi(k as i32);
    if all_inliers >= 1.0 {
        return 1;
    }
    if all_inliers <= 0.0 {
        return usize::MAX;
    }
    ((1.0 - 0.999f64).ln() / (1.0 - all_inliers).ln())
        .ceil()
        .max(1.0) as usize
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
            k1: 0.0,
            k2: 0.0,
            refine_distortion: false,
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
    use crate::synthetic::{dolly_scene, wide_dolly_scene, Rng};
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
    fn solves_through_a_distorting_lens() {
        let truth = wide_dolly_scene(40, 150, 0.2, 41);
        let mut job = input(&truth, tracks_of(&truth));
        job.refine_focal = true;
        job.refine_distortion = true;
        let solution = solve(&job, &SolveOptions::default()).unwrap();
        assert!(solution.rms < 0.2 * 2f64.sqrt(), "rms {}", solution.rms);
        assert_eq!(solution.poses.iter().flatten().count(), 40);
        let k = solution.intrinsics;
        assert!((k.k1 - truth.intrinsics.k1).abs() < 0.03, "{k:?}");

        // A pinhole solve of the same tracks fits worse.
        job.refine_distortion = false;
        let pinhole = solve(&job, &SolveOptions::default()).unwrap();
        // (Moving the points absorbs some of the distortion, so the gap is
        // smaller than the 8% at the corners suggests.)
        assert!(
            pinhole.rms > 1.5 * solution.rms,
            "pinhole rms {}",
            pinhole.rms
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
