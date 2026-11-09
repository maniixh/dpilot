import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    host: "localhost",
    port: 5173,
    // The server prints this exact URL in --dev mode.
    strictPort: true,
    // Keep the browser's Host so the server's same-origin check sees localhost:5173.
    proxy: { "/api": { target: "http://127.0.0.1:7311", changeOrigin: false } },
  },
});
