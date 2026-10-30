import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import { MediabunnyFrameSource } from "./video/mediabunny-source";

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
   <React.StrictMode>
      <App openSource={(file) => MediabunnyFrameSource.open(file)} />
   </React.StrictMode>,
);
