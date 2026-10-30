import type { Point, TrackState } from "../tracking/tracks";

/**
 * Export to Blender's movie clip editor, as a Python script the user runs in
 * Blender (Scripting workspace → Run Script) with the clip loaded. Blender has
 * no import format for 2D tracks, but its Python API can create them.
 *
 * Conventions (each checked against Blender 5.2's bpy, see the PR):
 * - Marker frames are *clip* frame numbers, which start at 1 whatever the
 *   clip's scene start frame: our frame index 0 is Blender frame 1. No
 *   timestamps or frameRate are involved, so variable-frame-rate clips map
 *   frame for frame.
 * - Marker positions are normalised to the frame with the origin at the
 *   bottom-left. Our display pixels have the origin at the top-left with
 *   pixel centres at .5, and Blender's are the same apart from the flip, so
 *   (x, y) → (x / width, 1 − y / height).
 * - Blender 5.2 applies the video's rotation metadata, as we do, so the clip
 *   size matches our display size. If it doesn't (an older Blender that shows
 *   the coded frame), the script maps display → coded positions using the
 *   rotation, when it can tell from the swapped size.
 * - Only keyed frames become markers. Blender holds a marker's position on
 *   the frames after it, as the viewer does.
 */

export interface BlenderExportInfo {
   /** File name, used to find the clip in the .blend. */
   clipName: string;
   /** Display size (after rotation). */
   width: number;
   height: number;
   frameCount: number;
   /** Informational: Blender's clip frame rate is printed if it differs. */
   frameRate: number;
   /** Clockwise rotation (0, 90, 180, 270) from display back to coded. */
   rotation: number;
}

/** Display pixels → Blender's normalised, bottom-left-origin marker coords. */
export function toBlenderCo(
   point: Point,
   width: number,
   height: number,
): [number, number] {
   return [point.x / width, 1 - point.y / height];
}

/** One track as exported: [Blender frame, x, y] per key, sorted by frame. */
export interface BlenderTrack {
   name: string;
   markers: [number, number, number][];
}

export function blenderTracks(
   state: TrackState,
   width: number,
   height: number,
): BlenderTrack[] {
   return state.tracks.map((track) => ({
      name: track.name,
      markers: [...track.keys]
         .sort(([a], [b]) => a - b)
         .map(([frame, point]) => [
            frame + 1,
            ...toBlenderCo(point, width, height),
         ]),
   }));
}

/** File name for the exported script, e.g. "shot.mp4" → "shot.tracks.py". */
export function blenderScriptName(clipName: string): string {
   const base = clipName.replace(/\.[^.]*$/, "") || "tracks";
   return `${base}.tracks.py`;
}

export function blenderScript(
   state: TrackState,
   info: BlenderExportInfo,
): string {
   // JSON is a valid Python literal for strings, numbers and lists.
   const data = JSON.stringify({
      clip: info.clipName,
      size: [info.width, info.height],
      frameCount: info.frameCount,
      frameRate: info.frameRate,
      rotation: info.rotation,
      tracks: blenderTracks(state, info.width, info.height),
   });
   return `# 2D tracks exported from camera-tracker for Blender's movie clip editor.
#
# Open the clip in Blender (Movie Clip Editor), then run this script from the
# Scripting workspace (Text > Open, then Run Script). It adds one track per
# exported tracker. Running it again adds the tracks again (Blender renames
# the copies with a .001 suffix).
#
# If the .blend has several clips, it uses the one named ${JSON.stringify(info.clipName)}.

import bpy

DATA = ${data}


def find_clip():
    clips = bpy.data.movieclips
    by_name = clips.get(DATA["clip"])
    if by_name is not None:
        return by_name
    space = getattr(bpy.context, "space_data", None)
    if getattr(space, "clip", None) is not None:
        return space.clip
    if len(clips) == 1:
        return clips[0]
    raise RuntimeError(
        "Open %s in the Movie Clip Editor first (found clips: %s)."
        % (DATA["clip"], ", ".join(c.name for c in clips) or "none")
    )


def converter(clip):
    """Maps exported (display) coords to this clip's coords."""
    width, height = DATA["size"]
    size = tuple(clip.size)
    rotation = DATA["rotation"] % 360
    if size == (width, height):
        return lambda x, y: (x, y)
    if size == (height, width) and rotation in (90, 270):
        # This Blender shows the coded (unrotated) frame.
        def unrotate(x, y):
            u, v = x, 1 - y  # top-left origin
            if rotation == 90:
                u, v = v, 1 - u
            else:
                u, v = 1 - v, u
            return u, 1 - v

        return unrotate
    raise RuntimeError(
        "Clip is %dx%d but the tracks are for %dx%d." % (size + (width, height))
    )


def main():
    clip = find_clip()
    convert = converter(clip)
    if clip.frame_duration != DATA["frameCount"]:
        print(
            "Warning: clip has %d frames, tracks are for %d."
            % (clip.frame_duration, DATA["frameCount"])
        )
    if abs(clip.fps - DATA["frameRate"]) > 0.01:
        print(
            "Note: clip is %.3f fps, tracks were made at %.3f fps. Markers are"
            " placed by frame number, so this only matters if frames differ."
            % (clip.fps, DATA["frameRate"])
        )
    tracking = clip.tracking
    for exported in DATA["tracks"]:
        if not exported["markers"]:
            continue
        first = exported["markers"][0][0]
        track = tracking.tracks.new(name=exported["name"], frame=first)
        # insert_frame since Blender 2.8; insert before that.
        insert = getattr(track.markers, "insert_frame", None) or track.markers.insert
        for frame, x, y in exported["markers"]:
            insert(frame, co=convert(x, y))
    print("Added %d tracks to %s." % (len(DATA["tracks"]), clip.name))


main()
`;
}
