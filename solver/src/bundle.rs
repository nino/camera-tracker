//! Bundle adjustment: refines camera poses, 3D points and (optionally) the
//! focal length and radial distortion to minimise squared reprojection
//! error, with Levenberg–Marquardt.
//!
//! Each step solves the damped normal equations through the Schur complement
//! on the points: every point only touches its own 3×3 block, so the points
//! are eliminated first and only the (much smaller) camera system is solved
//! densely. That system is 6 values per free camera plus up to three shared
//! intrinsics (focal length, k1, k2). Dense is fine for a few hundred cameras; a sparse solver can
//! replace it later without changing the interface.
//!
//! Gauge: a reconstruction is only defined up to a similarity transform. The
//! cameras in `Options::fixed_cameras` (camera 0 by default) pin the rotation
//! and translation. The overall scale stays free; Levenberg–Marquardt's
//! damping keeps that one flat direction from making the system singular, so
//! the scale of the result is whatever the initial guess had.

use nalgebra::{DMatrix, DVector, Matrix3, Rotation3, SMatrix, Vector2, Vector3};

use crate::camera::{project_camera, Intrinsics, Pose};

/// One 2D track position: `pixel` is where `point` appears in `camera`.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Observation {
    pub camera: usize,
    pub point: usize,
    pub pixel: Vector2<f64>,
}

#[derive(Clone, Debug)]
pub struct Problem {
    pub intrinsics: Intrinsics,
    pub poses: Vec<Pose>,
    pub points: Vec<Vector3<f64>>,
    pub observations: Vec<Observation>,
}

#[derive(Clone, Debug)]
pub struct Options {
    pub max_iterations: usize,
    /// Cameras whose poses are held fixed (the gauge, see the module docs).
    pub fixed_cameras: Vec<usize>,
    /// Also refine the focal length (shared by all cameras).
    pub refine_focal: bool,
    /// Also refine the radial distortion: k1, and k2 too if `refine_k2`.
    pub refine_distortion: bool,
    pub refine_k2: bool,
    /// Stop when an accepted step lowers the cost by less than this fraction.
    pub function_tolerance: f64,
    /// Stop when a step moves the parameters by less than this, relative to
    /// their size.
    pub step_tolerance: f64,
}

impl Default for Options {
    fn default() -> Self {
        Self {
            max_iterations: 100,
            fixed_cameras: vec![0],
            refine_focal: false,
            refine_distortion: false,
            refine_k2: true,
            function_tolerance: 1e-12,
            step_tolerance: 1e-12,
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Report {
    /// Root-mean-square reprojection error in pixels (the 2D distance per
    /// observation), before and after. Pure noise of σ pixels per axis gives
    /// about σ·√2.
    pub initial_rms: f64,
    pub final_rms: f64,
    /// Accepted steps.
    pub iterations: usize,
    /// True if it stopped because the cost stopped improving (rather than
    /// running out of iterations or damping).
    pub converged: bool,
}

/// Root-mean-square reprojection error in pixels, or `None` if any observed
/// point is behind its camera.
pub fn rms_error(problem: &Problem) -> Option<f64> {
    let cost = cost(problem)?;
    Some((cost / problem.observations.len().max(1) as f64).sqrt())
}

/// Sum of squared reprojection errors.
fn cost(problem: &Problem) -> Option<f64> {
    let mut sum = 0.0;
    for obs in &problem.observations {
        let p = problem.poses[obs.camera].to_camera(&problem.points[obs.point]);
        let r = project_camera(&problem.intrinsics, &p)? - obs.pixel;
        sum += r.norm_squared();
    }
    Some(sum)
}

/// Camera-side parameters per observation: 3 rotation, 3 translation, then
/// the shared intrinsics focal, k1, k2.
const CAM: usize = 9;
type CameraJacobian = SMatrix<f64, 2, CAM>;
type PointJacobian = SMatrix<f64, 2, 3>;
type CameraPointBlock = SMatrix<f64, CAM, 3>;

/// Where each camera-side column of an observation's Jacobian lives in the
/// reduced camera system (`None` for fixed values).
type Columns = [Option<usize>; CAM];

struct Linearised {
    /// Camera-side normal matrix (Jcᵀ Jc) and gradient (Jcᵀ r).
    u: DMatrix<f64>,
    gc: DVector<f64>,
    /// Per point: Jpᵀ Jp and Jpᵀ r.
    v: Vec<Matrix3<f64>>,
    gp: Vec<Vector3<f64>>,
    /// Per observation: Jcᵀ Jp, and the columns it maps to.
    w: Vec<CameraPointBlock>,
    columns: Vec<Columns>,
}

/// Parameter layout: free cameras get 6 consecutive slots, then the refined
/// intrinsics (focal, k1, k2), so their rows come after every camera's.
struct Layout {
    camera_offset: Vec<Option<usize>>,
    intrinsics: [Option<usize>; 3],
    size: usize,
}

impl Layout {
    fn new(problem: &Problem, options: &Options) -> Self {
        let mut size = 0;
        let camera_offset = (0..problem.poses.len())
            .map(|c| {
                if options.fixed_cameras.contains(&c) {
                    None
                } else {
                    size += 6;
                    Some(size - 6)
                }
            })
            .collect();
        let mut slot = |on: bool| {
            on.then(|| {
                size += 1;
                size - 1
            })
        };
        let intrinsics = [
            slot(options.refine_focal),
            slot(options.refine_distortion),
            slot(options.refine_distortion && options.refine_k2),
        ];
        Self {
            camera_offset,
            intrinsics,
            size,
        }
    }

    fn columns(&self, camera: usize) -> Columns {
        let mut cols = [None; CAM];
        if let Some(offset) = self.camera_offset[camera] {
            for (k, col) in cols.iter_mut().take(6).enumerate() {
                *col = Some(offset + k);
            }
        }
        cols[6..].copy_from_slice(&self.intrinsics);
        cols
    }
}

fn skew(v: &Vector3<f64>) -> Matrix3<f64> {
    Matrix3::new(0.0, -v.z, v.y, v.z, 0.0, -v.x, -v.y, v.x, 0.0)
}

fn linearise(problem: &Problem, layout: &Layout) -> Linearised {
    let n = layout.size;
    let k = &problem.intrinsics;
    let mut lin = Linearised {
        u: DMatrix::zeros(n, n),
        gc: DVector::zeros(n),
        v: vec![Matrix3::zeros(); problem.points.len()],
        gp: vec![Vector3::zeros(); problem.points.len()],
        w: Vec::with_capacity(problem.observations.len()),
        columns: Vec::with_capacity(problem.observations.len()),
    };
    for obs in &problem.observations {
        let pose = &problem.poses[obs.camera];
        let rotated = pose.rotation * problem.points[obs.point];
        let p = rotated + pose.translation;
        let r = k.to_pixel(&Vector2::new(p.x / p.z, p.y / p.z)) - obs.pixel;
        let jproj = k.point_jacobian(&p);

        // Rotation is updated on the left, R ← exp(δ)·R, so ∂p/∂δ = −[R·X]×.
        let mut jc = CameraJacobian::zeros();
        jc.fixed_view_mut::<2, 3>(0, 0)
            .copy_from(&(jproj * -skew(&rotated)));
        jc.fixed_view_mut::<2, 3>(0, 3).copy_from(&jproj);
        jc.fixed_view_mut::<2, 3>(0, 6)
            .copy_from(&k.intrinsics_jacobian(&p));
        let jp: PointJacobian = jproj * pose.rotation.matrix();

        let cols = layout.columns(obs.camera);
        let jtj = jc.transpose() * jc;
        let jtr = jc.transpose() * r;
        for a in 0..CAM {
            let Some(ia) = cols[a] else { continue };
            lin.gc[ia] += jtr[a];
            for b in 0..CAM {
                if let Some(ib) = cols[b] {
                    lin.u[(ia, ib)] += jtj[(a, b)];
                }
            }
        }
        lin.v[obs.point] += jp.transpose() * jp;
        lin.gp[obs.point] += jp.transpose() * r;
        lin.w.push(jc.transpose() * jp);
        lin.columns.push(cols);
    }
    lin
}

/// Subtracts the Schur block for the observation pair (a, b) and its mirror
/// (b, a) from the lower triangle of `s`. `block` is Wa·V⁻¹·Wbᵀ. Camera
/// columns are 6 contiguous slots per camera; the intrinsics' slots (if
/// any) come after every camera.
fn subtract_lower(
    s: &mut DMatrix<f64>,
    ca: &Columns,
    cb: &Columns,
    block: &SMatrix<f64, CAM, CAM>,
    same: bool,
) {
    let (oa, ob) = (ca[0], cb[0]);
    if let (Some(oa), Some(ob)) = (oa, ob) {
        if same || oa == ob {
            // Diagonal block of one camera. For a pair (a ≠ b) on the same
            // camera, the mirror block is the transpose; add both.
            for j in 0..6 {
                for i in 0..6 {
                    let v = if same {
                        block[(i, j)]
                    } else {
                        block[(i, j)] + block[(j, i)]
                    };
                    s[(oa + i, oa + j)] -= v;
                }
            }
        } else if oa > ob {
            for j in 0..6 {
                for i in 0..6 {
                    s[(oa + i, ob + j)] -= block[(i, j)];
                }
            }
        } else {
            for j in 0..6 {
                for i in 0..6 {
                    s[(ob + i, oa + j)] -= block[(j, i)];
                }
            }
        }
    }
    // Rows of the shared intrinsics come after every camera's, so their
    // entries against camera columns are in the lower triangle; among
    // themselves, keep row ≥ column. The pair (a, b) adds block[i, j] at
    // (a's column i, b's column j), and its mirror (b, a) the same value at
    // (b's column j, a's column i).
    for i in 6..CAM {
        let Some(row) = ca[i] else { continue };
        for j in 0..CAM {
            if let Some(col) = cb[j] {
                if row >= col {
                    s[(row, col)] -= block[(i, j)];
                }
            }
        }
    }
    if !same {
        for j in 6..CAM {
            let Some(row) = cb[j] else { continue };
            for i in 0..CAM {
                if let Some(col) = ca[i] {
                    if row >= col {
                        s[(row, col)] -= block[(i, j)];
                    }
                }
            }
        }
    }
}

/// The damped step (camera deltas, point deltas), or `None` if the damped
/// system isn't positive definite.
fn solve_step(
    lin: &Linearised,
    by_point: &[Vec<usize>],
    lambda: f64,
) -> Option<(DVector<f64>, Vec<Vector3<f64>>)> {
    let damp = |m: &mut Matrix3<f64>| {
        for d in 0..3 {
            m[(d, d)] += lambda * m[(d, d)] + 1e-12;
        }
    };
    let mut s = lin.u.clone();
    for d in 0..s.nrows() {
        s[(d, d)] += lambda * s[(d, d)] + 1e-12;
    }
    let mut rhs = lin.gc.clone();
    let mut v_inv = Vec::with_capacity(lin.v.len());
    let mut weighted: Vec<CameraPointBlock> = Vec::new();
    let mut free_obs: Vec<usize> = Vec::new();
    for (i, observations) in by_point.iter().enumerate() {
        let mut v = lin.v[i];
        damp(&mut v);
        let inv = v.try_inverse()?;
        // Observations on fixed cameras (with no intrinsics) add nothing to the
        // camera system; skipping them matters for local adjustments.
        free_obs.clear();
        free_obs.extend(
            observations
                .iter()
                .copied()
                .filter(|&o| lin.columns[o].iter().any(Option::is_some)),
        );
        weighted.clear();
        weighted.extend(free_obs.iter().map(|&o| lin.w[o] * inv));
        for (a, &oa) in free_obs.iter().enumerate() {
            let r = weighted[a] * lin.gp[i];
            for (k, col) in lin.columns[oa].iter().enumerate() {
                if let Some(ia) = col {
                    rhs[*ia] -= r[k];
                }
            }
            // Each unordered pair once: S is symmetric and Cholesky only
            // reads its lower triangle.
            for (b, &ob) in free_obs.iter().enumerate().take(a + 1) {
                let block = weighted[a] * lin.w[ob].transpose();
                subtract_lower(&mut s, &lin.columns[oa], &lin.columns[ob], &block, a == b);
            }
        }
        v_inv.push(inv);
    }
    let dc = if s.nrows() == 0 {
        DVector::zeros(0)
    } else {
        -s.cholesky()?.solve(&rhs)
    };
    let dp = by_point
        .iter()
        .enumerate()
        .map(|(i, observations)| {
            let mut g = lin.gp[i];
            for &o in observations {
                let mut dco = SMatrix::<f64, CAM, 1>::zeros();
                for (a, col) in lin.columns[o].iter().enumerate() {
                    if let Some(ia) = col {
                        dco[a] = dc[*ia];
                    }
                }
                g += lin.w[o].transpose() * dco;
            }
            -(v_inv[i] * g)
        })
        .collect();
    Some((dc, dp))
}

fn apply(problem: &Problem, layout: &Layout, dc: &DVector<f64>, dp: &[Vector3<f64>]) -> Problem {
    let mut next = problem.clone();
    for (c, pose) in next.poses.iter_mut().enumerate() {
        if let Some(o) = layout.camera_offset[c] {
            let rot = Vector3::new(dc[o], dc[o + 1], dc[o + 2]);
            pose.rotation = Rotation3::new(rot) * pose.rotation;
            pose.translation += Vector3::new(dc[o + 3], dc[o + 4], dc[o + 5]);
        }
    }
    let [focal, k1, k2] = layout.intrinsics;
    if let Some(i) = focal {
        next.intrinsics.focal += dc[i];
    }
    if let Some(i) = k1 {
        next.intrinsics.k1 += dc[i];
    }
    if let Some(i) = k2 {
        next.intrinsics.k2 += dc[i];
    }
    for (point, delta) in next.points.iter_mut().zip(dp) {
        *point += delta;
    }
    next
}

fn step_is_negligible(
    problem: &Problem,
    dc: &DVector<f64>,
    dp: &[Vector3<f64>],
    tolerance: f64,
) -> bool {
    let step = (dc.norm_squared() + dp.iter().map(|d| d.norm_squared()).sum::<f64>()).sqrt();
    let size = (problem.points.iter().map(|p| p.norm_squared()).sum::<f64>()
        + problem
            .poses
            .iter()
            .map(|p| p.translation.norm_squared())
            .sum::<f64>())
    .sqrt();
    step <= tolerance * (1.0 + size)
}

/// Refines `problem` in place. Returns `None` (leaving it unchanged) if the
/// starting point has an observed point behind its camera.
pub fn bundle_adjust(problem: &mut Problem, options: &Options) -> Option<Report> {
    let layout = Layout::new(problem, options);
    let mut by_point = vec![Vec::new(); problem.points.len()];
    for (o, obs) in problem.observations.iter().enumerate() {
        by_point[obs.point].push(o);
    }
    let count = problem.observations.len().max(1) as f64;
    let mut current = cost(problem)?;
    let initial_rms = (current / count).sqrt();
    let mut lambda = 1e-4;
    let mut iterations = 0;
    let mut converged = false;

    'outer: while iterations < options.max_iterations {
        let lin = linearise(problem, &layout);
        loop {
            if lambda > 1e12 {
                break 'outer;
            }
            let step = solve_step(&lin, &by_point, lambda);
            if let Some((dc, dp)) = &step {
                if step_is_negligible(problem, dc, dp, options.step_tolerance) {
                    converged = true;
                    break 'outer;
                }
            }
            let candidate = step.map(|(dc, dp)| apply(problem, &layout, &dc, &dp));
            match candidate
                .as_ref()
                .and_then(|c| cost(c).map(|cost| (c, cost)))
            {
                Some((next, next_cost)) if next_cost < current => {
                    let gain = current - next_cost;
                    *problem = next.clone();
                    iterations += 1;
                    lambda = (lambda / 3.0).max(1e-12);
                    let done = gain <= options.function_tolerance * current;
                    current = next_cost;
                    if done {
                        converged = true;
                        break 'outer;
                    }
                    break;
                }
                // Rejected (worse, singular, or a point went behind a camera).
                _ => lambda *= 4.0,
            }
        }
    }
    if current == 0.0 {
        converged = true;
    }
    Some(Report {
        initial_rms,
        final_rms: (current / count).sqrt(),
        iterations,
        converged,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::synthetic::{dolly_scene, perturb, wide_dolly_scene};

    /// Scale that best maps estimated camera centres onto the true ones,
    /// measured from camera 0 (fixed, so shared by both).
    fn scale_between(truth: &Problem, est: &Problem) -> f64 {
        let o_t = truth.poses[0].centre();
        let o_e = est.poses[0].centre();
        let (mut num, mut den) = (0.0, 0.0);
        for (t, e) in truth.poses.iter().zip(&est.poses) {
            let (dt, de) = (t.centre() - o_t, e.centre() - o_e);
            num += dt.dot(&de);
            den += de.norm_squared();
        }
        num / den
    }

    /// Largest camera-centre and rotation errors after fixing the scale.
    fn pose_errors(truth: &Problem, est: &Problem) -> (f64, f64) {
        let s = scale_between(truth, est);
        let o = truth.poses[0].centre();
        let mut centre = 0.0f64;
        let mut angle = 0.0f64;
        for (t, e) in truth.poses.iter().zip(&est.poses) {
            let scaled = o + (e.centre() - o) * s;
            centre = centre.max((scaled - t.centre()).norm());
            // Frobenius distance ≈ √2·angle; unlike acos it stays precise near 0.
            let d = (t.rotation.matrix() - e.rotation.matrix()).norm() / 2f64.sqrt();
            angle = angle.max(d);
        }
        (centre, angle)
    }

    #[test]
    fn recovers_an_exact_scene_from_a_perturbed_start() {
        let truth = dolly_scene(15, 60, 0.0, 1);
        let mut est = perturb(&truth, 0.02, 0.05, 0.1, 2);
        let report = bundle_adjust(&mut est, &Options::default()).unwrap();
        assert!(report.initial_rms > 5.0, "{report:?}");
        assert!(report.final_rms < 1e-6, "{report:?}");
        assert!(report.converged, "{report:?}");
        let (centre, angle) = pose_errors(&truth, &est);
        assert!(centre < 1e-6, "centre error {centre}");
        assert!(angle < 1e-8, "rotation error {angle}");
    }

    #[test]
    fn fits_noisy_tracks_down_to_the_noise() {
        let noise = 0.5;
        let truth = dolly_scene(20, 80, noise, 3);
        let mut est = perturb(&truth, 0.02, 0.05, 0.1, 4);
        let report = bundle_adjust(&mut est, &Options::default()).unwrap();
        // σ per axis gives σ·√2 per observation; the fit absorbs a little of it.
        let expected = noise * 2f64.sqrt();
        assert!(
            report.final_rms < expected && report.final_rms > 0.85 * expected,
            "{report:?}"
        );
        // It found the least-squares minimum: no worse a fit than the truth.
        assert!(report.final_rms <= rms_error(&truth).unwrap(), "{report:?}");
        let (centre, angle) = pose_errors(&truth, &est);
        assert!(centre < 0.05, "centre error {centre}");
        assert!(angle < 5e-3, "rotation error {angle}");
    }

    #[test]
    fn refines_the_focal_length() {
        let truth = dolly_scene(20, 80, 0.2, 5);
        let mut est = perturb(&truth, 0.01, 0.03, 0.05, 6);
        est.intrinsics.focal *= 1.1;
        let options = Options {
            refine_focal: true,
            ..Options::default()
        };
        let report = bundle_adjust(&mut est, &options).unwrap();
        assert!(report.final_rms < 0.2 * 2f64.sqrt(), "{report:?}");
        let focal_error = (est.intrinsics.focal / truth.intrinsics.focal - 1.0).abs();
        assert!(
            focal_error < 0.01,
            "focal {} vs {}",
            est.intrinsics.focal,
            truth.intrinsics.focal
        );
        // Held at the wrong value, the focal length is still fitted worse. Only
        // slightly, though: on a dolly shot, focal length trades off against
        // depth, so focal refinement needs a shot with enough perspective.
        est = perturb(&truth, 0.01, 0.03, 0.05, 6);
        est.intrinsics.focal *= 1.1;
        let fixed = bundle_adjust(&mut est, &Options::default()).unwrap();
        assert!(fixed.final_rms > report.final_rms, "{fixed:?}");
    }

    /// The Schur-complement step equals solving the full damped normal
    /// equations densely (built from the same Jacobians).
    #[test]
    fn schur_step_matches_the_dense_solve() {
        let truth = wide_dolly_scene(5, 12, 0.5, 3);
        let est = perturb(&truth, 0.01, 0.02, 0.05, 4);
        let options = Options {
            refine_focal: true,
            refine_distortion: true,
            fixed_cameras: vec![0],
            ..Options::default()
        };
        let layout = Layout::new(&est, &options);
        let mut by_point = vec![Vec::new(); est.points.len()];
        for (o, obs) in est.observations.iter().enumerate() {
            by_point[obs.point].push(o);
        }
        let lin = linearise(&est, &layout);
        let lambda = 1e-3;
        let (dc, dp) = solve_step(&lin, &by_point, lambda).unwrap();

        // Dense: camera-side columns first, then 3 per point.
        let nc = layout.size;
        let n = nc + 3 * est.points.len();
        let mut jtj = DMatrix::<f64>::zeros(n, n);
        let mut jtr = DVector::<f64>::zeros(n);
        let k = est.intrinsics;
        for obs in &est.observations {
            let pose = &est.poses[obs.camera];
            let rotated = pose.rotation * est.points[obs.point];
            let p = rotated + pose.translation;
            let r = k.to_pixel(&Vector2::new(p.x / p.z, p.y / p.z)) - obs.pixel;
            let jproj = k.point_jacobian(&p);
            let mut row = DMatrix::<f64>::zeros(2, n);
            let cols = layout.columns(obs.camera);
            let mut jc = CameraJacobian::zeros();
            jc.fixed_view_mut::<2, 3>(0, 0)
                .copy_from(&(jproj * -skew(&rotated)));
            jc.fixed_view_mut::<2, 3>(0, 3).copy_from(&jproj);
            jc.fixed_view_mut::<2, 3>(0, 6)
                .copy_from(&k.intrinsics_jacobian(&p));
            for (a, col) in cols.iter().enumerate() {
                if let Some(c) = col {
                    for i in 0..2 {
                        row[(i, *c)] += jc[(i, a)];
                    }
                }
            }
            let jp = jproj * pose.rotation.matrix();
            for i in 0..2 {
                for j in 0..3 {
                    row[(i, nc + 3 * obs.point + j)] = jp[(i, j)];
                }
            }
            jtj += row.transpose() * &row;
            jtr += row.transpose() * DVector::from_column_slice(r.as_slice());
        }
        for d in 0..n {
            jtj[(d, d)] += lambda * jtj[(d, d)] + 1e-12;
        }
        let dense = -jtj.cholesky().unwrap().solve(&jtr);
        for i in 0..nc {
            assert!(
                (dense[i] - dc[i]).abs() < 1e-6 * (1.0 + dense[i].abs()),
                "camera {i}: {} vs {}",
                dense[i],
                dc[i]
            );
        }
        for (pi, d) in dp.iter().enumerate() {
            for j in 0..3 {
                let e = dense[nc + 3 * pi + j];
                assert!((e - d[j]).abs() < 1e-6 * (1.0 + e.abs()), "point {pi}");
            }
        }
    }

    #[test]
    fn refines_lens_distortion() {
        let truth = wide_dolly_scene(20, 120, 0.2, 9);
        let mut est = perturb(&truth, 0.005, 0.02, 0.03, 10);
        est.intrinsics.k1 = 0.0;
        est.intrinsics.k2 = 0.0;
        let options = Options {
            refine_focal: true,
            refine_distortion: true,
            ..Options::default()
        };
        let report = bundle_adjust(&mut est, &options).unwrap();
        assert!(report.final_rms < 0.2 * 2f64.sqrt(), "{report:?}");
        let k = est.intrinsics;
        // Focal length and distortion trade off a little against depth on
        // a dolly shot, so k1 comes back close rather than exact.
        assert!((k.k1 - truth.intrinsics.k1).abs() < 0.02, "{k:?}");

        // Without distortion, the same tracks can't be fitted.
        let mut flat = perturb(&truth, 0.005, 0.02, 0.03, 10);
        flat.intrinsics.k1 = 0.0;
        flat.intrinsics.k2 = 0.0;
        let pinhole = bundle_adjust(
            &mut flat,
            &Options {
                refine_focal: true,
                ..Options::default()
            },
        )
        .unwrap();
        assert!(pinhole.final_rms > 1.5 * report.final_rms, "{pinhole:?}");
    }

    #[test]
    fn leaves_fixed_cameras_alone() {
        let truth = dolly_scene(10, 40, 0.3, 7);
        let mut est = perturb(&truth, 0.02, 0.05, 0.1, 8);
        let before = est.poses[0];
        let options = Options {
            fixed_cameras: vec![0],
            ..Options::default()
        };
        bundle_adjust(&mut est, &options).unwrap();
        assert_eq!(est.poses[0], before);
    }

    #[test]
    fn refuses_a_start_with_points_behind_a_camera() {
        let truth = dolly_scene(5, 20, 0.0, 9);
        let mut est = truth.clone();
        let obs = est.observations[0];
        est.points[obs.point] = est.poses[obs.camera].centre()
            - (est.poses[obs.camera].rotation.inverse() * Vector3::z());
        let snapshot = est.clone();
        assert!(bundle_adjust(&mut est, &Options::default()).is_none());
        assert_eq!(est.points, snapshot.points);
    }

    #[test]
    fn rms_error_is_zero_for_the_true_scene() {
        let truth = dolly_scene(5, 20, 0.0, 10);
        assert!(rms_error(&truth).unwrap() < 1e-9);
    }
}
