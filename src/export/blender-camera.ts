import { FILM_MM, focalMillimetres } from "../solve/request";
import type { Solution, SolvedCamera, Vec3 } from "../solve/solve-types";

/**
 * Export of a camera solve to Blender, as a Python script (like the 2D
 * tracks in blender.ts). It adds a camera animated along the solved path and
 * an empty at each solved track's 3D point.
 *
 * Conventions (checked by projecting the empties through the camera in
 * Blender 5.2 and comparing with the tracks; see the PR):
 * - Frames: our frame index i is the clip's frame i + 1, as for markers, and
 *   the scene shows the clip's frames 1:1 from scene frame 1.
 * - Axes: the solver's world has x right, y down and z forward (the first
 *   keyframe camera's view). Blender is z up, so (x, y, z) → (x, z, −y): the
 *   first camera looks along Blender's +y, level if the shot starts level.
 * - Camera: Blender cameras look down their local −z with y up, ours down +z
 *   with y down, so the camera's matrix is W · Rᵀ · diag(1, −1, −1).
 * - Lens: sensor 36 mm on the longer side (fit Auto), so the focal length
 *   in mm is the same full-frame equivalent the app shows.
 * - Lens distortion goes on the clip (Movie Clip Editor → Track → Camera →
 *   Lens), as Blender's Polynomial model, whose k1 and k2 are ours exactly
 *   (both normalise by the focal length in pixels about the frame centre).
 *   Blender's camera renders without distortion; the clip's settings drive
 *   the compositor's Movie Distortion node, which distorts the render to
 *   match the plate.
 * - Scale is arbitrary (the solve fixes it only up to scale). The distance
 *   between the two keyframe cameras is 1 unit.
 */

export interface BlenderCameraInfo {
   clipName: string;
   width: number;
   height: number;
   frameCount: number;
   frameRate: number;
}

/** Solver world → Blender world. */
export function toBlenderWorld([x, y, z]: Vec3): Vec3 {
   return [x, z, -y];
}

/**
 * The camera's matrix_world in Blender, row-major 4×4 (rotation and
 * location; no scale).
 */
export function blenderCameraMatrix(camera: SolvedCamera): number[] {
   const r = camera.rotation;
   // R's rows (Rᵀ's columns) are the camera's axes in world coordinates.
   const axis = (i: number): Vec3 => [r[3 * i], r[3 * i + 1], r[3 * i + 2]];
   const right = toBlenderWorld(axis(0));
   const down = toBlenderWorld(axis(1));
   const forward = toBlenderWorld(axis(2));
   // Blender camera axes: x = right, y = up = −down, z = back = −forward.
   const c = toBlenderWorld(camera.centre);
   const m: number[] = [];
   for (let row = 0; row < 3; row++) {
      m.push(right[row], -down[row], -forward[row], c[row]);
   }
   m.push(0, 0, 0, 1);
   return m;
}

export function blenderCameraScriptName(clipName: string): string {
   const base = clipName.replace(/\.[^.]*$/, "") || "camera";
   return `${base}.camera.py`;
}

export function blenderCameraScript(
   solution: Solution,
   info: BlenderCameraInfo,
   trackNames: ReadonlyMap<number, string>,
): string {
   const byFrame = new Map(solution.cameras.map((c) => [c.frame, c]));
   const k0 = byFrame.get(solution.keyframes[0]);
   const k1 = byFrame.get(solution.keyframes[1]);
   const baseline =
      k0 && k1 ? Math.hypot(...k0.centre.map((v, i) => v - k1.centre[i])) : 1;
   const scale = baseline > 0 ? 1 / baseline : 1;
   const round = (v: number) => Math.round(v * 1e6) / 1e6;
   const data = JSON.stringify({
      clip: info.clipName,
      size: [info.width, info.height],
      frameCount: info.frameCount,
      frameRate: info.frameRate,
      lens: round(focalMillimetres(solution.focal, info.width, info.height)),
      focalPx: round(solution.focal),
      k1: round(solution.k1),
      k2: round(solution.k2),
      sensor: FILM_MM,
      rms: round(solution.rms),
      cameras: solution.cameras.map((camera) => {
         const m = blenderCameraMatrix(camera);
         for (const i of [3, 7, 11]) {
            m[i] *= scale;
         }
         return [camera.frame + 1, m.map(round)];
      }),
      points: solution.points.map((point) => [
         trackNames.get(point.id) ?? `Track ${point.id}`,
         toBlenderWorld(point.position).map((v) => round(v * scale)),
      ]),
   });
   return `# Camera solve exported from camera-tracker.
#
# Run it from Blender's Scripting workspace (Text > Open, then Run Script).
# It adds a camera that follows the solved path, with the clip as its
# background, and an empty at each solved track. Running it again adds
# another set. Scale is arbitrary: the two keyframe cameras are 1 unit apart.
#
# The clip, if it's in the .blend (the one named ${JSON.stringify(info.clipName)}, or the only one),
# becomes the camera's background, and gets the solved lens (focal length and
# distortion) in its tracking camera settings. Blender renders without lens
# distortion; to match the plate, run renders through a Movie Distortion node
# (Distort) set to this clip.

import bpy
from mathutils import Matrix

DATA = ${data}


def find_clip():
    clips = bpy.data.movieclips
    clip = clips.get(DATA["clip"])
    if clip is None and len(clips) == 1:
        clip = clips[0]
    return clip


def main():
    scene = bpy.context.scene
    width, height = DATA["size"]
    clip = find_clip()

    collection = bpy.data.collections.new("Camera solve")
    scene.collection.children.link(collection)

    cam_data = bpy.data.cameras.new("Solved camera")
    cam_data.sensor_fit = "AUTO"
    cam_data.sensor_width = DATA["sensor"]
    cam_data.lens = DATA["lens"]
    cam = bpy.data.objects.new("Solved camera", cam_data)
    collection.objects.link(cam)
    cam.rotation_mode = "XYZ"
    previous = None
    for frame, m in DATA["cameras"]:
        matrix = Matrix([m[0:4], m[4:8], m[8:12], m[12:16]])
        cam.location = matrix.to_translation()
        # Pass the previous angles so the curves don't jump by 360°.
        euler = matrix.to_3x3().to_euler("XYZ", previous) if previous else matrix.to_3x3().to_euler("XYZ")
        cam.rotation_euler = euler
        previous = euler
        cam.keyframe_insert("location", frame=frame)
        cam.keyframe_insert("rotation_euler", frame=frame)

    for name, position in DATA["points"]:
        empty = bpy.data.objects.new(name, None)
        empty.empty_display_type = "PLAIN_AXES"
        empty.empty_display_size = 0.02
        empty.location = position
        collection.objects.link(empty)

    scene.camera = cam
    scene.render.resolution_x = width
    scene.render.resolution_y = height
    scene.render.resolution_percentage = 100
    scene.render.pixel_aspect_x = 1
    scene.render.pixel_aspect_y = 1
    scene.frame_start = 1
    scene.frame_end = DATA["frameCount"]
    if clip is not None:
        scene.active_clip = clip
        clip.frame_start = 1
        # The solved lens, for the Movie Distortion node and further tracking.
        lens = clip.tracking.camera
        lens.focal_length_pixels = DATA["focalPx"]
        lens.principal_point_pixels = (width / 2, height / 2)
        lens.distortion_model = "POLYNOMIAL"
        lens.k1 = DATA["k1"]
        lens.k2 = DATA["k2"]
        lens.k3 = 0
        cam_data.show_background_images = True
        background = cam_data.background_images.new()
        background.source = "MOVIE_CLIP"
        background.clip = clip
        background.use_camera_clip = False
    else:
        print("No clip %s in this file; the camera has no background." % DATA["clip"])
    print(
        "Added a camera over %d frames and %d points (solve error %.2f px)."
        % (len(DATA["cameras"]), len(DATA["points"]), DATA["rms"])
    )


main()
`;
}
