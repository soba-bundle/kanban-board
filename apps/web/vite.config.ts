import { env } from "node:process";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

const backendPort = env.KANBAN_BACKEND_PORT ?? "3000";

export default defineConfig({
  plugins: [react()],
  server: {
    proxy: { "/api": `http://127.0.0.1:${backendPort}` },
  },
});
