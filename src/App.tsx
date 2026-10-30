import React from "react";
import "./App.css";
import type { FrameSource } from "./video/frame-source";
import { clipKeyForFile } from "./tracking/storage";
import { FrameViewer } from "./video/FrameViewer";

export interface AppProps {
   /**
    * Opens a dropped file as a FrameSource. Injected so tests can pass a fake;
    * `main.tsx` passes `MediabunnyFrameSource.open`.
    */
   openSource: (file: File) => Promise<FrameSource>;
}

type LoadState =
   | { status: "empty" }
   | { status: "loading"; name: string }
   | {
        status: "ready";
        id: number;
        name: string;
        clipKey: string;
        source: FrameSource;
     }
   | { status: "error"; message: string };

function App({ openSource }: AppProps) {
   const [state, setState] = React.useState<LoadState>({ status: "empty" });
   const [dragging, setDragging] = React.useState(false);
   // Bumped on every open so a slow earlier open can't replace a newer one.
   const openId = React.useRef(0);

   // Dispose the current source when it's replaced or the app unmounts.
   const source = state.status === "ready" ? state.source : null;
   React.useEffect(() => () => source?.dispose(), [source]);

   async function open(file: File) {
      const id = ++openId.current;
      setState({ status: "loading", name: file.name });
      try {
         const opened = await openSource(file);
         if (id !== openId.current) {
            opened.dispose();
            return;
         }
         setState({
            status: "ready",
            id,
            name: file.name,
            clipKey: clipKeyForFile(file),
            source: opened,
         });
      } catch (err) {
         if (id === openId.current) {
            const message = err instanceof Error ? err.message : String(err);
            setState({ status: "error", message });
         }
      }
   }

   function onDrop(event: React.DragEvent) {
      event.preventDefault();
      setDragging(false);
      const file = event.dataTransfer.files[0];
      if (file != null) {
         void open(file);
      }
   }

   function onPick(event: React.ChangeEvent<HTMLInputElement>) {
      const file = event.target.files?.[0];
      if (file != null) {
         void open(file);
      }
      event.target.value = "";
   }

   return (
      <main
         className={dragging ? "app dragging" : "app"}
         data-testid="drop-zone"
         onDragOver={(event) => {
            event.preventDefault();
            setDragging(true);
         }}
         onDragLeave={() => setDragging(false)}
         onDrop={onDrop}
      >
         <header className="toolbar">
            <label className="open-button">
               Open video…
               <input
                  type="file"
                  accept="video/*"
                  onChange={onPick}
                  aria-label="Open video"
                  hidden
               />
            </label>
            {(state.status === "ready" || state.status === "loading") && (
               <span className="file-name">{state.name}</span>
            )}
         </header>

         {state.status === "empty" && (
            <p className="hint">
               Drop a video file here, or click “Open video…”.
            </p>
         )}
         {state.status === "loading" && <p className="hint">Opening…</p>}
         {state.status === "error" && (
            <p className="error" role="alert">
               Couldn’t open that file: {state.message}
            </p>
         )}
         {state.status === "ready" && (
            // Keyed so the playhead resets to frame 0 for each new file.
            <FrameViewer
               key={state.id}
               source={state.source}
               clipKey={state.clipKey}
               clipName={state.name}
            />
         )}
      </main>
   );
}

export default App;
