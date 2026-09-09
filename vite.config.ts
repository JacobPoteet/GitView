import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// Tauri drives this dev server, so the port is fixed and failure to bind is fatal
// rather than silently moving to the next free port.
//
// 5183 rather than Vite's default 5173: GitView is for people running several dev
// servers at once, so it must not squat the port every other Vite project wants.
// Colliding with LunchSpecial's server is what surfaced this.
export default defineConfig({
  plugins: [react()],
  clearScreen: false,
  server: {
    port: 5183,
    strictPort: true,
    watch: {
      ignored: ["**/src-tauri/**"],
    },
  },
  build: {
    target: "chrome120",
    outDir: "dist",
    emptyOutDir: true,
    sourcemap: false,
  },
});
