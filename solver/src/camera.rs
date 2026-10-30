use nalgebra::{Matrix2x3, Rotation3, Vector2, Vector3};

/// Pinhole intrinsics in display pixels. No lens distortion yet.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Intrinsics {
    /// Focal length in pixels (same for x and y: square pixels).
    pub focal: f64,
    /// Principal point; normally the frame centre.
    pub cx: f64,
    pub cy: f64,
}

impl Intrinsics {
    /// Principal point at the centre of a `width` × `height` frame.
    pub fn centred(focal: f64, width: f64, height: f64) -> Self {
        Self {
            focal,
            cx: width / 2.0,
            cy: height / 2.0,
        }
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
    Some(Vector2::new(
        intrinsics.focal * p.x / p.z + intrinsics.cx,
        intrinsics.focal * p.y / p.z + intrinsics.cy,
    ))
}

pub fn project(intrinsics: &Intrinsics, pose: &Pose, world: &Vector3<f64>) -> Option<Vector2<f64>> {
    project_camera(intrinsics, &pose.to_camera(world))
}

/// Derivative of the projected pixel with respect to the camera-space point.
pub fn projection_jacobian(focal: f64, p: &Vector3<f64>) -> Matrix2x3<f64> {
    let iz = 1.0 / p.z;
    let iz2 = iz * iz;
    Matrix2x3::new(
        focal * iz,
        0.0,
        -focal * p.x * iz2,
        0.0,
        focal * iz,
        -focal * p.y * iz2,
    )
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

    #[test]
    fn projection_jacobian_matches_finite_differences() {
        let k = Intrinsics::centred(700.0, 0.0, 0.0);
        let p = Vector3::new(0.3, -0.2, 4.0);
        let j = projection_jacobian(k.focal, &p);
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
