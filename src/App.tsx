import React from "react";
import "./App.css";

// Throwaway diagnostic: confirm whether Tauri's WKWebView exposes WebGPU.
// Once we know the answer, this whole component gets deleted.
type ProbeState =
  | { status: "checking" }
  | { status: "unavailable"; reason: string }
  | { status: "ok"; adapter: string; features: string[] };

function App() {
  const [probe, setProbe] = React.useState<ProbeState>({ status: "checking" });

  React.useEffect(() => {
    async function probeWebGpu() {
      const gpu = navigator.gpu;
      if (gpu == null) {
        const reason =
          "navigator.gpu is undefined — WebGPU is not exposed in this webview.";
        console.log("[WEBGPU-PROBE] UNAVAILABLE:", reason);
        setProbe({ status: "unavailable", reason });
        return;
      }
      try {
        const adapter = await gpu.requestAdapter();
        if (adapter == null) {
          const reason =
            "requestAdapter() returned null — no compatible GPU adapter.";
          console.log("[WEBGPU-PROBE] UNAVAILABLE:", reason);
          setProbe({ status: "unavailable", reason });
          return;
        }
        const device = await adapter.requestDevice();
        const features = Array.from(device.features.values());
        const info = adapter.info ?? null;
        const adapterName =
          info?.description ?? info?.vendor ?? info?.architecture ?? "unknown adapter";
        console.log(
          "[WEBGPU-PROBE] OK:",
          adapterName,
          "| features:",
          features.join(", ") || "(none)",
        );
        setProbe({ status: "ok", adapter: adapterName, features });
      } catch (err) {
        const reason = err instanceof Error ? err.message : String(err);
        console.log("[WEBGPU-PROBE] ERROR:", reason);
        setProbe({ status: "unavailable", reason });
      }
    }
    probeWebGpu();
  }, []);

  return (
    <main className="container">
      <h1>WebGPU probe</h1>
      {probe.status === "checking" && <p>Checking for WebGPU…</p>}
      {probe.status === "unavailable" && (
        <>
          <p style={{ color: "#e5484d" }}>❌ WebGPU unavailable</p>
          <p>{probe.reason}</p>
        </>
      )}
      {probe.status === "ok" && (
        <>
          <p style={{ color: "#30a46c" }}>✅ WebGPU is working</p>
          <p>Adapter: {probe.adapter}</p>
          <p>
            Features:{" "}
            {probe.features.length > 0 ? probe.features.join(", ") : "(none)"}
          </p>
        </>
      )}
    </main>
  );
}

export default App;
