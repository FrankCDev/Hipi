import { resolve } from "node:path";

export function developmentServerOptions(ui, token) {
	if (!/^[a-f0-9]{64}$/.test(token)) throw new Error("Invalid development session token");
	const csp = `default-src 'none'; script-src 'self' 'nonce-${token}'; worker-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self'; connect-src 'self' ws://127.0.0.1:5173; frame-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'`;
	return {
		root: ui,
		configFile: resolve(ui, "vite.config.ts"),
		clearScreen: false,
		html: { cspNonce: token },
		server: {
			host: "127.0.0.1",
			port: 5173,
			strictPort: true,
			open: false,
			cors: false,
			headers: { "Content-Security-Policy": csp, "X-Content-Type-Options": "nosniff" },
			hmr: { host: "127.0.0.1", clientPort: 5173 },
		},
	};
}
