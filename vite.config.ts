import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";

// @ts-expect-error process is a nodejs global
const host = process.env.TAURI_DEV_HOST;

// https://vitejs.dev/config/
export default defineConfig(async () => ({
   plugins: [react()],

   // Vite options tailored for Tauri development and only applied in `tauri dev` or `tauri build`
   //
   // 1. prevent vite from obscuring rust errors
   clearScreen: false,
   // 2. tauri expects a fixed port, fail if that port is not available
   server: {
      port: 1420,
      strictPort: true,
      host: host || false,
      hmr: host ? { protocol: "ws", host, port: 1421 } : undefined,
      watch: {
         // 3. tell vite to ignore watching `src-tauri`
         ignored: ["**/src-tauri/**"],
      },
   },

   // Vitest. Tests are colocated with the code (Foo.tsx -> Foo.test.tsx) and run
   // in a jsdom environment so React components can be rendered and queried.
   test: {
      environment: "jsdom",
      globals: true,
      setupFiles: ["./src/test/setup.ts"],
      include: ["src/**/*.{test,spec}.{ts,tsx}"],
   },
}));
