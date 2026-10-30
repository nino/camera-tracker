//! JSON interface to the solver, for the app. The request mirrors the
//! frontend's track data (display pixels, keys only); the response gives
//! each frame's camera and each track's 3D point.
//!
//! Both a WebAssembly export and a native (Tauri) command can wrap
//! `solve_json`, so the frontend talks to one format either way.

use nalgebra::Vector2;
use serde::{Deserialize, Serialize};

use crate::solve::{solve, SolveInput, SolveOptions};

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Request {
    pub width: f64,
    pub height: f64,
    pub frame_count: usize,
    /// Focal length guess in pixels.
    pub focal: f64,
    #[serde(default)]
    pub refine_focal: bool,
    /// Radial distortion guess (camera.rs); 0 if absent.
    #[serde(default)]
    pub k1: f64,
    #[serde(default)]
    pub k2: f64,
    #[serde(default)]
    pub refine_distortion: bool,
    pub tracks: Vec<RequestTrack>,
}

#[derive(Debug, Deserialize)]
pub struct RequestTrack {
    pub id: u32,
    /// `[frame, x, y]` per keyed frame.
    pub keys: Vec<[f64; 3]>,
}

#[derive(Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Camera {
    pub frame: usize,
    /// World-to-camera rotation, row-major 3×3.
    pub rotation: [f64; 9],
    /// World-to-camera translation.
    pub translation: [f64; 3],
    /// Camera centre in world coordinates.
    pub centre: [f64; 3],
}

#[derive(Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Point {
    pub id: u32,
    pub position: [f64; 3],
    /// RMS reprojection error of this track, pixels.
    pub error: f64,
}

#[derive(Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase", tag = "status")]
pub enum Response {
    #[serde(rename = "solved")]
    Solved {
        focal: f64,
        k1: f64,
        k2: f64,
        rms: f64,
        keyframes: [usize; 2],
        /// Solved frames only, in frame order.
        cameras: Vec<Camera>,
        /// Triangulated tracks only.
        points: Vec<Point>,
        /// Keys rejected as outliers, as `[track id, frame]`.
        outliers: Vec<[u32; 2]>,
    },
    #[serde(rename = "failed")]
    Failed { message: String },
}

pub fn run(request: &Request) -> Response {
    let mut tracks = Vec::with_capacity(request.tracks.len());
    for track in &request.tracks {
        let mut keys = Vec::with_capacity(track.keys.len());
        for &[frame, x, y] in &track.keys {
            let valid = frame >= 0.0
                && frame.fract() == 0.0
                && (frame as usize) < request.frame_count
                && x.is_finite()
                && y.is_finite();
            if !valid {
                return Response::Failed {
                    message: format!("Track {} has an invalid key {:?}.", track.id, [frame, x, y]),
                };
            }
            keys.push((frame as usize, Vector2::new(x, y)));
        }
        tracks.push(keys);
    }
    if !(request.focal.is_finite() && request.focal > 0.0) {
        return Response::Failed {
            message: "The focal length must be positive.".into(),
        };
    }
    if !(request.k1.is_finite() && request.k2.is_finite()) {
        return Response::Failed {
            message: "The distortion must be a number.".into(),
        };
    }
    let input = SolveInput {
        width: request.width,
        height: request.height,
        frame_count: request.frame_count,
        tracks,
        focal: request.focal,
        refine_focal: request.refine_focal,
        k1: request.k1,
        k2: request.k2,
        refine_distortion: request.refine_distortion,
    };
    let solution = match solve(&input, &SolveOptions::default()) {
        Ok(solution) => solution,
        Err(err) => {
            return Response::Failed {
                message: err.to_string(),
            }
        }
    };
    let ids: Vec<u32> = request.tracks.iter().map(|t| t.id).collect();
    Response::Solved {
        focal: solution.intrinsics.focal,
        k1: solution.intrinsics.k1,
        k2: solution.intrinsics.k2,
        rms: solution.rms,
        keyframes: [solution.keyframes.0, solution.keyframes.1],
        cameras: solution
            .poses
            .iter()
            .enumerate()
            .filter_map(|(frame, pose)| {
                let pose = pose.as_ref()?;
                let m = pose.rotation.matrix();
                let c = pose.centre();
                Some(Camera {
                    frame,
                    rotation: [
                        m[(0, 0)],
                        m[(0, 1)],
                        m[(0, 2)],
                        m[(1, 0)],
                        m[(1, 1)],
                        m[(1, 2)],
                        m[(2, 0)],
                        m[(2, 1)],
                        m[(2, 2)],
                    ],
                    translation: [pose.translation.x, pose.translation.y, pose.translation.z],
                    centre: [c.x, c.y, c.z],
                })
            })
            .collect(),
        points: solution
            .points
            .iter()
            .zip(&solution.track_errors)
            .zip(&ids)
            .filter_map(|((p, e), &id)| {
                let p = p.as_ref()?;
                Some(Point {
                    id,
                    position: [p.x, p.y, p.z],
                    error: e.unwrap_or(0.0),
                })
            })
            .collect(),
        outliers: solution
            .outliers
            .iter()
            .map(|&(t, f)| [ids[t], f as u32])
            .collect(),
    }
}

/// JSON in, JSON out. Malformed JSON becomes a `failed` response.
pub fn solve_json(request: &str) -> String {
    let response = match serde_json::from_str::<Request>(request) {
        Ok(request) => run(&request),
        Err(err) => Response::Failed {
            message: format!("Bad solve request: {err}"),
        },
    };
    serde_json::to_string(&response).expect("responses always serialise")
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::synthetic::{dolly_scene, HEIGHT, WIDTH};
    use serde_json::{json, Value};

    #[test]
    fn solves_a_request_and_reports_cameras_and_points() {
        let truth = dolly_scene(20, 80, 0.2, 31);
        let mut tracks: Vec<Value> = Vec::new();
        for (i, _) in truth.points.iter().enumerate() {
            let keys: Vec<Value> = truth
                .observations
                .iter()
                .filter(|o| o.point == i)
                .map(|o| json!([o.camera, o.pixel.x, o.pixel.y]))
                .collect();
            tracks.push(json!({ "id": 100 + i, "keys": keys }));
        }
        let request = json!({
            "width": WIDTH, "height": HEIGHT, "frameCount": 20,
            "focal": truth.intrinsics.focal, "tracks": tracks,
        });
        let response: Value = serde_json::from_str(&solve_json(&request.to_string())).unwrap();
        assert_eq!(response["status"], "solved", "{response}");
        assert_eq!(response["cameras"].as_array().unwrap().len(), 20);
        assert_eq!(response["cameras"][0]["frame"], 0);
        assert!(response["rms"].as_f64().unwrap() < 0.3);
        assert_eq!(response["k1"], 0.0);
        let first_id = response["points"][0]["id"].as_u64().unwrap();
        assert!(first_id >= 100);
        // The first keyframe is the world origin.
        let k0 = response["keyframes"][0].as_u64().unwrap() as usize;
        let cam = &response["cameras"][k0];
        for v in cam["centre"].as_array().unwrap() {
            assert!(v.as_f64().unwrap().abs() < 1e-9);
        }
    }

    #[test]
    fn explains_failures() {
        let failed = |body: &str| -> String {
            let v: Value = serde_json::from_str(&solve_json(body)).unwrap();
            assert_eq!(v["status"], "failed");
            v["message"].as_str().unwrap().to_owned()
        };
        assert!(failed("not json").starts_with("Bad solve request"));
        let base =
            json!({ "width": 640, "height": 360, "frameCount": 5, "focal": 500, "tracks": [] });
        assert!(failed(&base.to_string()).contains("at least 8 tracks"));
        let mut bad_key = base.clone();
        bad_key["tracks"] = json!([{ "id": 7, "keys": [[9, 1, 1]] }]);
        assert!(failed(&bad_key.to_string()).contains("Track 7"));
        let mut bad_focal = base;
        bad_focal["focal"] = json!(0);
        assert!(failed(&bad_focal.to_string()).contains("focal"));
    }
}

#[cfg(test)]
mod dump {
    #[test]
    #[ignore]
    fn run_file() {
        let req = std::fs::read_to_string(std::env::var("REQ").unwrap()).unwrap();
        let t = std::time::Instant::now();
        let out = super::solve_json(&req);
        eprintln!(
            "NATIVE ms {} {}",
            t.elapsed().as_millis(),
            &out[..120.min(out.len())]
        );
        if let Ok(v) = serde_json::from_str::<serde_json::Value>(&out) {
            if let Some(c) = v["cameras"].as_array() {
                let frames: Vec<_> = c.iter().map(|c| c["frame"].as_u64().unwrap()).collect();
                eprintln!("NATIVE frames {frames:?}");
            }
        }
    }

    #[test]
    #[ignore]
    fn dump_request() {
        use crate::synthetic::{dolly_scene, wide_dolly_scene, HEIGHT, WIDTH};
        let env = |k: &str, d: usize| {
            std::env::var(k)
                .ok()
                .and_then(|v| v.parse().ok())
                .unwrap_or(d)
        };
        let frames = env("FRAMES", 200);
        let window = env("WINDOW", frames);
        let wide = env("WIDE", 0) == 1;
        let scene = if wide { wide_dolly_scene } else { dolly_scene };
        let truth = scene(frames, env("POINTS", 300), 0.3, 77);
        let mut rng = crate::rng::Rng::new(5);
        let tracks: Vec<serde_json::Value> = (0..truth.points.len())
            .map(|i| {
                let start = (rng.uniform() * (frames - window + 1) as f64) as usize;
                let keys: Vec<_> = truth
                    .observations
                    .iter()
                    .filter(|o| o.point == i && o.camera >= start && o.camera < start + window)
                    .map(|o| serde_json::json!([o.camera, o.pixel.x, o.pixel.y]))
                    .collect();
                serde_json::json!({"id": i, "keys": keys})
            })
            .collect();
        let req = serde_json::json!({"width": WIDTH, "height": HEIGHT, "frameCount": frames, "focal": if wide { 450.0 } else { 800.0 }, "refineFocal": wide, "refineDistortion": wide, "tracks": tracks});
        std::fs::write(std::env::var("DUMP").unwrap(), req.to_string()).unwrap();
        let t = std::time::Instant::now();
        let out = super::solve_json(&req.to_string());
        eprintln!("NATIVE ms {} {}", t.elapsed().as_millis(), &out[..80]);
    }
}
