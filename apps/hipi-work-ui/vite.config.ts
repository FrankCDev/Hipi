import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";
import { cssCascadeGate } from "./css-cascade.ts";

export default defineConfig({
	plugins: [react(), tailwindcss(), cssCascadeGate()],
	publicDir: "vendor/fonts/public",
	resolve: { alias: { "@": new URL("./src", import.meta.url).pathname } },
	server: { host: "127.0.0.1", port: 5173, strictPort: true },
});
