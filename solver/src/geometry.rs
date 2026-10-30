//! Multi-view geometry for building an initial solve: essential matrices,
//! relative pose, triangulation and camera resection.
//!
//! Everything here works in *normalised* image coordinates: a pixel `(u, v)`
//! becomes `((u − cx) / f, (v − cy) / f)`, the point where its ray crosses the
//! plane z = 1 in camera space. Thresholds in pixels are converted with the
//! focal length by the caller.

use nalgebra::{
    DMatrix, Matrix3, Matrix3x4, Rotation3, SMatrix, SVector, Vector2, Vector3, Vector4,
};

use crate::camera::{projection_jacobian, Intrinsics, Pose, MIN_DEPTH};

/// Pixel → normalised image coordinates.
pub fn normalise(k: &Intrinsics, pixel: &Vector2<f64>) -> Vector2<f64> {
    Vector2::new((pixel.x - k.cx) / k.focal, (pixel.y - k.cy) / k.focal)
}

/// A correspondence between two views, in normalised coordinates.
pub type Pair = (Vector2<f64>, Vector2<f64>);

/// Unit eigenvector of the smallest eigenvalue of a symmetric matrix: the
/// least-squares null vector of A when given AᵀA. (nalgebra's SVD is thin,
/// so it can't give the null space of a short, wide A directly.)
fn smallest_eigenvector<const N: usize>(ata: &SMatrix<f64, N, N>) -> SVector<f64, N> {
    // Through a dynamic matrix: nalgebra's static eigen-decomposition needs
    // type-level sizes that a const generic can't provide.
    let eig = DMatrix::from_column_slice(N, N, ata.as_slice()).symmetric_eigen();
    let (i, _) = eig
        .eigenvalues
        .iter()
        .enumerate()
        .min_by(|a, b| a.1.total_cmp(b.1))
        .expect("non-empty");
    SVector::from_column_slice(eig.eigenvectors.column(i).as_slice())
}

/// Essential matrix from ≥ 8 normalised correspondences (`x2ᵀ E x1 = 0`),
/// by the linear eight-point method, projected onto valid essential matrices
/// (two equal singular values, one zero).
pub fn essential_eight_point(pairs: &[Pair]) -> Option<Matrix3<f64>> {
    if pairs.len() < 8 {
        return None;
    }
    let mut ata = SMatrix::<f64, 9, 9>::zeros();
    for (a, b) in pairs {
        let row = SVector::<f64, 9>::from([
            b.x * a.x,
            b.x * a.y,
            b.x,
            b.y * a.x,
            b.y * a.y,
            b.y,
            a.x,
            a.y,
            1.0,
        ]);
        ata += row * row.transpose();
    }
    let e = smallest_eigenvector(&ata);
    let e = Matrix3::new(e[0], e[1], e[2], e[3], e[4], e[5], e[6], e[7], e[8]);
    let svd = e.svd(true, true);
    let (u, v_t) = (svd.u?, svd.v_t?);
    let s = (svd.singular_values[0] + svd.singular_values[1]) / 2.0;
    Some(u * Matrix3::from_diagonal(&Vector3::new(s, s, 0.0)) * v_t)
}

/// Squared Sampson distance of a correspondence to an essential matrix, in
/// normalised units (multiply by f² for pixels²).
pub fn sampson_error(e: &Matrix3<f64>, a: &Vector2<f64>, b: &Vector2<f64>) -> f64 {
    let x1 = a.push(1.0);
    let x2 = b.push(1.0);
    let ex1 = e * x1;
    let etx2 = e.transpose() * x2;
    let num = x2.dot(&ex1);
    let den = ex1.x * ex1.x + ex1.y * ex1.y + etx2.x * etx2.x + etx2.y * etx2.y;
    if den <= 0.0 {
        return f64::INFINITY;
    }
    num * num / den
}

/// The four (R, t) decompositions of an essential matrix, with ‖t‖ = 1.
pub fn decompose_essential(e: &Matrix3<f64>) -> Option<[Pose; 4]> {
    let svd = e.svd(true, true);
    let (mut u, mut v_t) = (svd.u?, svd.v_t?);
    if u.determinant() < 0.0 {
        u = -u;
    }
    if v_t.determinant() < 0.0 {
        v_t = -v_t;
    }
    let w = Matrix3::new(0.0, -1.0, 0.0, 1.0, 0.0, 0.0, 0.0, 0.0, 1.0);
    let r1 = Rotation3::from_matrix_unchecked(u * w * v_t);
    let r2 = Rotation3::from_matrix_unchecked(u * w.transpose() * v_t);
    let t = u.column(2).into_owned();
    let pose = |rotation, translation| Pose {
        rotation,
        translation,
    };
    Some([pose(r1, t), pose(r1, -t), pose(r2, t), pose(r2, -t)])
}

/// Linear (DLT) triangulation of one point from several views, given each
/// view's pose and normalised observation. `None` if degenerate.
pub fn triangulate(views: &[(Pose, Vector2<f64>)]) -> Option<Vector3<f64>> {
    let mut ata = SMatrix::<f64, 4, 4>::zeros();
    for (pose, x) in views {
        let p = projection_matrix(pose);
        for row in [
            p.row(0) * 1.0 - p.row(2) * x.x,
            p.row(1) * 1.0 - p.row(2) * x.y,
        ] {
            let r = row.transpose();
            ata += r * r.transpose();
        }
    }
    let h: Vector4<f64> = smallest_eigenvector(&ata);
    if h.w.abs() < 1e-12 {
        return None;
    }
    Some(h.xyz() / h.w)
}

fn projection_matrix(pose: &Pose) -> Matrix3x4<f64> {
    let mut p = Matrix3x4::zeros();
    p.fixed_view_mut::<3, 3>(0, 0)
        .copy_from(pose.rotation.matrix());
    p.set_column(3, &pose.translation);
    p
}

/// Angle in radians between the two viewing rays of `point`.
pub fn parallax(a: &Pose, b: &Pose, point: &Vector3<f64>) -> f64 {
    let ra = point - a.centre();
    let rb = point - b.centre();
    (ra.dot(&rb) / (ra.norm() * rb.norm()))
        .clamp(-1.0, 1.0)
        .acos()
}

/// Relative pose of camera 2 with camera 1 at the identity, from an
/// essential matrix: the decomposition that puts the most correspondences in
/// front of both cameras. Returns the pose and that count.
pub fn relative_pose(e: &Matrix3<f64>, pairs: &[Pair]) -> Option<(Pose, usize)> {
    let first = Pose::identity();
    decompose_essential(e)?
        .into_iter()
        .map(|pose| {
            let in_front = pairs
                .iter()
                .filter(|(a, b)| {
                    triangulate(&[(first, *a), (pose, *b)]).is_some_and(|x| {
                        first.to_camera(&x).z > MIN_DEPTH && pose.to_camera(&x).z > MIN_DEPTH
                    })
                })
                .count();
            (pose, in_front)
        })
        .max_by_key(|(_, n)| *n)
}

/// Camera pose from ≥ 6 known 3D points and their normalised observations,
/// by the linear DLT on the 3×4 projection matrix, projected onto a rotation.
pub fn resect(points: &[(Vector3<f64>, Vector2<f64>)]) -> Option<Pose> {
    if points.len() < 6 {
        return None;
    }
    let mut ata = SMatrix::<f64, 12, 12>::zeros();
    for (x, u) in points {
        let h = x.push(1.0);
        let mut r1 = SVector::<f64, 12>::zeros();
        let mut r2 = SVector::<f64, 12>::zeros();
        for k in 0..4 {
            r1[k] = h[k];
            r1[8 + k] = -u.x * h[k];
            r2[4 + k] = h[k];
            r2[8 + k] = -u.y * h[k];
        }
        ata += r1 * r1.transpose() + r2 * r2.transpose();
    }
    let p = smallest_eigenvector(&ata);
    let mut p = Matrix3x4::from_row_slice(p.as_slice());
    // Choose the sign that puts the points in front of the camera.
    let depth_sign: f64 = points
        .iter()
        .map(|(x, _)| (p.row(2) * x.push(1.0))[0].signum())
        .sum();
    if depth_sign < 0.0 {
        p = -p;
    }
    let m = p.fixed_view::<3, 3>(0, 0).into_owned();
    let svd = m.svd(true, true);
    let (u, v_t) = (svd.u?, svd.v_t?);
    let mut r = u * v_t;
    let scale = svd.singular_values.mean();
    if r.determinant() < 0.0 {
        r = -r;
    }
    if scale <= 0.0 {
        return None;
    }
    let translation = p.column(3) / scale;
    Some(Pose {
        rotation: Rotation3::from_matrix_unchecked(r),
        translation,
    })
}

/// Refines one camera pose against fixed 3D points (Gauss–Newton with light
/// damping), minimising pixel reprojection error.
pub fn refine_pose(
    k: &Intrinsics,
    mut pose: Pose,
    points: &[(Vector3<f64>, Vector2<f64>)],
    iterations: usize,
) -> Pose {
    for _ in 0..iterations {
        let mut h = SMatrix::<f64, 6, 6>::zeros();
        let mut g = SVector::<f64, 6>::zeros();
        for (x, pixel) in points {
            let rotated = pose.rotation * x;
            let p = rotated + pose.translation;
            if p.z <= MIN_DEPTH {
                continue;
            }
            let r = Vector2::new(k.focal * p.x / p.z + k.cx, k.focal * p.y / p.z + k.cy) - pixel;
            let jp = projection_jacobian(k.focal, &p);
            let skew = Matrix3::new(
                0.0, -rotated.z, rotated.y, rotated.z, 0.0, -rotated.x, -rotated.y, rotated.x, 0.0,
            );
            let mut j = SMatrix::<f64, 2, 6>::zeros();
            j.fixed_view_mut::<2, 3>(0, 0).copy_from(&(jp * -skew));
            j.fixed_view_mut::<2, 3>(0, 3).copy_from(&jp);
            h += j.transpose() * j;
            g += j.transpose() * r;
        }
        for d in 0..6 {
            h[(d, d)] *= 1.0 + 1e-6;
            h[(d, d)] += 1e-12;
        }
        let Some(step) = h.cholesky().map(|c| -c.solve(&g)) else {
            break;
        };
        pose.rotation = Rotation3::new(step.fixed_rows::<3>(0).into_owned()) * pose.rotation;
        pose.translation += step.fixed_rows::<3>(3).into_owned();
        if step.norm() < 1e-12 {
            break;
        }
    }
    pose
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::camera::project;
    use crate::synthetic::{dolly_scene, Rng};

    fn normalised_pairs(cam_a: usize, cam_b: usize) -> (Pose, Pose, Vec<Pair>) {
        let scene = dolly_scene(10, 60, 0.0, 11);
        let k = scene.intrinsics;
        let (a, b) = (scene.poses[cam_a], scene.poses[cam_b]);
        let pairs = scene
            .points
            .iter()
            .filter_map(|x| {
                Some((
                    normalise(&k, &project(&k, &a, x)?),
                    normalise(&k, &project(&k, &b, x)?),
                ))
            })
            .collect();
        (a, b, pairs)
    }

    /// Pose of b relative to a: x_b = R x_a + t.
    fn relative(a: &Pose, b: &Pose) -> Pose {
        let rotation = b.rotation * a.rotation.inverse();
        Pose {
            rotation,
            translation: b.translation - rotation * a.translation,
        }
    }

    #[test]
    fn eight_point_essential_satisfies_the_epipolar_constraint() {
        let (_, _, pairs) = normalised_pairs(0, 9);
        let e = essential_eight_point(&pairs).unwrap();
        for (a, b) in &pairs {
            assert!(sampson_error(&e, a, b).sqrt() < 1e-9);
        }
    }

    #[test]
    fn recovers_the_relative_pose_up_to_scale() {
        let (a, b, pairs) = normalised_pairs(0, 9);
        let truth = relative(&a, &b);
        let e = essential_eight_point(&pairs).unwrap();
        let (pose, in_front) = relative_pose(&e, &pairs).unwrap();
        assert_eq!(in_front, pairs.len());
        assert!((pose.rotation.matrix() - truth.rotation.matrix()).norm() < 1e-8);
        let dir = truth.translation.normalize();
        assert!((pose.translation - dir).norm() < 1e-8);
    }

    #[test]
    fn triangulates_exactly_from_exact_views() {
        let scene = dolly_scene(4, 10, 0.0, 12);
        let k = scene.intrinsics;
        for x in &scene.points {
            let views: Vec<_> = scene
                .poses
                .iter()
                .filter_map(|p| Some((*p, normalise(&k, &project(&k, p, x)?))))
                .collect();
            if views.len() >= 2 {
                assert!((triangulate(&views).unwrap() - x).norm() < 1e-8);
            }
        }
    }

    #[test]
    fn resects_a_camera_from_known_points_and_refines_it() {
        let scene = dolly_scene(6, 60, 0.0, 13);
        let k = scene.intrinsics;
        let pose = scene.poses[4];
        let mut rng = Rng::new(14);
        let exact: Vec<_> = scene
            .points
            .iter()
            .filter_map(|x| Some((*x, project(&k, &pose, x)?)))
            .collect();
        let normalised: Vec<_> = exact
            .iter()
            .map(|(x, px)| (*x, normalise(&k, px)))
            .collect();
        let found = resect(&normalised).unwrap();
        assert!((found.rotation.matrix() - pose.rotation.matrix()).norm() < 1e-8);
        assert!((found.translation - pose.translation).norm() < 1e-8);

        // Start refinement from a nudged pose against noisy pixels.
        let noisy: Vec<_> = exact
            .iter()
            .map(|(x, px)| (*x, px + Vector2::new(rng.normal(), rng.normal()) * 0.3))
            .collect();
        let start = Pose {
            rotation: Rotation3::new(Vector3::new(0.01, -0.02, 0.005)) * pose.rotation,
            translation: pose.translation + Vector3::new(0.05, 0.0, -0.03),
        };
        let refined = refine_pose(&k, start, &noisy, 20);
        assert!((refined.rotation.matrix() - pose.rotation.matrix()).norm() < 2e-3);
        assert!((refined.translation - pose.translation).norm() < 0.02);
    }
}
