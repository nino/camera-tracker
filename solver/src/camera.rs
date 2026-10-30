use nalgebra::{Matrix2, Matrix2x3, Rotation3, Vector2, Vector3};

/// Camera intrinsics in display pixels: a pinhole with radial lens
/// distortion.
///
/// Distortion is the polynomial (Brown) radial model in normalised
/// coordinates, the same as Blender's "Polynomial" lens model, so k1 and k2
/// carry over to Blender as they are: a camera-space point projects to
/// `x = p.x / p.z`, `y = p.y / p.z`, `r² = x² + y²`,
/// `d = 1 + k1·r² + k2·r⁴`, and the pixel `(f·d·x + cx, f·d·y + cy)`.
/// k1 < 0 is barrel distortion (wide lenses), k1 > 0 pincushion.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Intrinsics {
    /// Focal length in pixels (same for x and y: square pixels).
    pub focal: f64,
    /// Principal point; normally the frame centre.
    pub cx: f64,
    pub cy: f64,
    pub k1: f64,
    pub k2: f64,
}

impl Intrinsics {
    /// No distortion, principal point at the centre of a `width` × `height`
    /// frame.
    pub fn centred(focal: f64, width: f64, height: f64) -> Self {
        Self {
            focal,
            cx: width / 2.0,
            cy: height / 2.0,
            k1: 0.0,
            k2: 0.0,
        }
    }

    /// Radial factor `d` at squared radius `r2`.
    fn radial(&self, r2: f64) -> f64 {
        1.0 + r2 * (self.k1 + self.k2 * r2)
    }

    /// Normalised (undistorted) image coordinates → pixels.
    pub fn to_pixel(&self, n: &Vector2<f64>) -> Vector2<f64> {
        let d = self.radial(n.norm_squared());
        Vector2::new(
            self.focal * d * n.x + self.cx,
            self.focal * d * n.y + self.cy,
        )
    }

    /// Pixels → normalised, undistorted image coordinates: where the pixel's
    /// ray crosses the plane z = 1. Inverts the radial model numerically
    /// (Newton on the radius); exact for k1 = k2 = 0.
    pub fn to_normalised(&self, pixel: &Vector2<f64>) -> Vector2<f64> {
        let distorted = Vector2::new(
            (pixel.x - self.cx) / self.focal,
            (pixel.y - self.cy) / self.focal,
        );
        if self.k1 == 0.0 && self.k2 == 0.0 {
            return distorted;
        }
        // Solve r·d(r²) = rd for the undistorted radius r.
        let rd = distorted.norm();
        if rd == 0.0 {
            return distorted;
        }
        let mut r = rd;
        for _ in 0..20 {
            let r2 = r * r;
            let f = r * self.radial(r2) - rd;
            let df = 1.0 + 3.0 * self.k1 * r2 + 5.0 * self.k2 * r2 * r2;
            if df.abs() < 1e-12 {
                break;
            }
            let step = f / df;
            r -= step;
            if step.abs() < 1e-15 {
                break;
            }
        }
        distorted * (r / rd)
    }

    /// Derivative of the pixel with respect to normalised coordinates.
    fn normalised_jacobian(&self, n: &Vector2<f64>) -> Matrix2<f64> {
        let r2 = n.norm_squared();
        let d = self.radial(r2);
        // ∂d/∂x = 2x·(k1 + 2·k2·r²), likewise for y.
        let g = 2.0 * (self.k1 + 2.0 * self.k2 * r2);
        self.focal
            * Matrix2::new(
                d + g * n.x * n.x,
                g * n.x * n.y,
                g * n.x * n.y,
                d + g * n.y * n.y,
            )
    }

    /// Derivative of the projected pixel with respect to the camera-space
    /// point.
    pub fn point_jacobian(&self, p: &Vector3<f64>) -> Matrix2x3<f64> {
        let iz = 1.0 / p.z;
        let n = Vector2::new(p.x * iz, p.y * iz);
        let dn = Matrix2x3::new(iz, 0.0, -n.x * iz, 0.0, iz, -n.y * iz);
        self.normalised_jacobian(&n) * dn
    }

    /// Derivative of the projected pixel with respect to (focal, k1, k2).
    pub fn intrinsics_jacobian(&self, p: &Vector3<f64>) -> Matrix2x3<f64> {
        let n = Vector2::new(p.x / p.z, p.y / p.z);
        let r2 = n.norm_squared();
        let d = self.radial(r2);
        let f = self.focal;
        Matrix2x3::new(
            d * n.x,
            f * n.x * r2,
            f * n.x * r2 * r2,
            d * n.y,
            f * n.y * r2,
            f * n.y * r2 * r2,
        )
    }
}

/// World-to-camera transform: `p_cam = rotation * p_world + translation`.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Pose {
    pub rotation: Rotation3<f64>,
    pub translation: Vector3<f64>,
}

impl Pose {
    pub fn identity() -> Self {
        Self {
            rotation: Rotation3::identity(),
            translation: Vector3::zeros(),
        }
    }

    pub fn to_camera(&self, world: &Vector3<f64>) -> Vector3<f64> {
        self.rotation * world + self.translation
    }

    /// Camera centre in world coordinates.
    pub fn centre(&self) -> Vector3<f64> {
        -(self.rotation.inverse() * self.translation)
    }

    /// A camera at `centre` looking at `target`, with image-down roughly along
    /// world `down`.
    pub fn look_at(centre: Vector3<f64>, target: Vector3<f64>, down: Vector3<f64>) -> Self {
        let z = (target - centre).normalize();
        let x = down.cross(&z).normalize();
        let y = z.cross(&x);
        // Rows are the camera axes expressed in world coordinates.
        let rotation = Rotation3::from_matrix_unchecked(nalgebra::Matrix3::from_rows(&[
            x.transpose(),
            y.transpose(),
            z.transpose(),
        ]));
        let translation = -(rotation * centre);
        Self {
            rotation,
            translation,
        }
    }
}

/// Smallest camera-space depth a point may have and still be projected.
pub const MIN_DEPTH: f64 = 1e-9;

/// Projects a camera-space point to pixels; `None` if it is behind the camera.
pub fn project_camera(intrinsics: &Intrinsics, p: &Vector3<f64>) -> Option<Vector2<f64>> {
    if p.z <= MIN_DEPTH {
        return None;
    }
    Some(intrinsics.to_pixel(&Vector2::new(p.x / p.z, p.y / p.z)))
}

pub fn project(intrinsics: &Intrinsics, pose: &Pose, world: &Vector3<f64>) -> Option<Vector2<f64>> {
    project_camera(intrinsics, &pose.to_camera(world))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn projects_the_optical_axis_to_the_principal_point() {
        let k = Intrinsics::centred(500.0, 640.0, 360.0);
        let pose = Pose::identity();
        let px = project(&k, &pose, &Vector3::new(0.0, 0.0, 5.0)).unwrap();
        assert_eq!(px, Vector2::new(320.0, 180.0));
        // +x right, +y down.
        let px = project(&k, &pose, &Vector3::new(1.0, 1.0, 5.0)).unwrap();
        assert_eq!(px, Vector2::new(420.0, 280.0));
        assert!(project(&k, &pose, &Vector3::new(0.0, 0.0, -1.0)).is_none());
    }

    #[test]
    fn look_at_puts_the_target_on_the_optical_axis() {
        let k = Intrinsics::centred(800.0, 100.0, 100.0);
        let centre = Vector3::new(3.0, -2.0, -10.0);
        let target = Vector3::new(0.5, 0.25, 1.0);
        let pose = Pose::look_at(centre, target, Vector3::new(0.0, 1.0, 0.0));
        let px = project(&k, &pose, &target).unwrap();
        assert!((px - Vector2::new(50.0, 50.0)).norm() < 1e-9);
        assert!((pose.centre() - centre).norm() < 1e-9);
        // A point below the target (world +y) projects below it in the image.
        let below = project(&k, &pose, &(target + Vector3::new(0.0, 1.0, 0.0))).unwrap();
        assert!(below.y > 50.0);
    }

    fn distorted() -> Intrinsics {
        Intrinsics {
            k1: -0.2,
            k2: 0.05,
            ..Intrinsics::centred(700.0, 640.0, 360.0)
        }
    }

    #[test]
    fn point_jacobian_matches_finite_differences() {
        for k in [Intrinsics::centred(700.0, 0.0, 0.0), distorted()] {
            let p = Vector3::new(0.3, -0.2, 1.5);
            let j = k.point_jacobian(&p);
            let h = 1e-6;
            for axis in 0..3 {
                let mut dp = Vector3::zeros();
                dp[axis] = h;
                let numeric = (project_camera(&k, &(p + dp)).unwrap()
                    - project_camera(&k, &(p - dp)).unwrap())
                    / (2.0 * h);
                assert!((j.column(axis) - numeric).norm() < 1e-4, "axis {axis}");
            }
        }
    }

    #[test]
    fn intrinsics_jacobian_matches_finite_differences() {
        let k = distorted();
        let p = Vector3::new(0.4, 0.3, 1.2);
        let j = k.intrinsics_jacobian(&p);
        let h = 1e-6;
        let bump = |i: usize, s: f64| {
            let mut k = k;
            match i {
                0 => k.focal += s,
                1 => k.k1 += s,
                _ => k.k2 += s,
            }
            project_camera(&k, &p).unwrap()
        };
        for i in 0..3 {
            let numeric = (bump(i, h) - bump(i, -h)) / (2.0 * h);
            assert!((j.column(i) - numeric).norm() < 1e-3, "column {i}");
        }
    }

    #[test]
    fn undistortion_inverts_distortion() {
        let k = distorted();
        for n in [
            Vector2::new(0.0, 0.0),
            Vector2::new(0.3, -0.2),
            Vector2::new(-0.5, 0.28),
        ] {
            let back = k.to_normalised(&k.to_pixel(&n));
            assert!((back - n).norm() < 1e-12, "{n:?} -> {back:?}");
        }
        // Barrel distortion pulls the corners in.
        let corner = Vector2::new(0.45, 0.25);
        let plain = Intrinsics::centred(700.0, 640.0, 360.0);
        assert!(
            (k.to_pixel(&corner) - Vector2::new(320.0, 180.0)).norm()
                < (plain.to_pixel(&corner) - Vector2::new(320.0, 180.0)).norm()
        );
    }
}
