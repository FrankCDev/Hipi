import tailwindcss from "@tailwindcss/vite";
import { defineConfig } from "vite";

export default defineConfig({
	plugins: [tailwindcss()],
	publicDir: "vendor/fonts/public",
	resolve: { alias: { "@": new URL("./src", import.meta.url).pathname } },
	server: { host: "127.0.0.1", port: 5173, strictPort: true },
});
