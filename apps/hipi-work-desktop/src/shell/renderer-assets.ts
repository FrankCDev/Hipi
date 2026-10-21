import { readFile } from "node:fs/promises";
import { extname, resolve, sep } from "node:path";

const MIME: Readonly<Record<string, string>> = {
	".html": "text/html",
	".js": "text/javascript",
	".mjs": "text/javascript",
	".css": "text/css",
	".svg": "image/svg+xml",
	".woff2": "font/woff2",
};
export const RENDERER_CSP =
	"default-src 'none'; script-src 'self'; worker-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self'; connect-src 'none'; frame-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'";

/** Serve only local renderer assets, including the separately emitted PDF worker. */
export function createRendererAssetHandler(directory: string) {
	const assets = resolve(directory);
	return async (request: { url: string; method: string }): Promise<Response> => {
		let path: string;
		try {
			const url = new URL(request.url);
			if (
				url.protocol !== "hipi-work:" ||
				url.host !== "app" ||
				url.username ||
				url.password ||
				request.method !== "GET" ||
				url.search
			)
				return new Response(null, { status: 403 });
			path = resolve(assets, `.${decodeURIComponent(url.pathname)}`);
			if (!path.startsWith(`${assets}${sep}`) || !MIME[extname(path)]) return new Response(null, { status: 403 });
		} catch {
			return new Response(null, { status: 403 });
		}
		try {
			const data = await readFile(path);
			return new Response(new Uint8Array(data), {
				headers: {
					"Content-Type": MIME[extname(path)],
					"Content-Security-Policy": RENDERER_CSP,
					"X-Content-Type-Options": "nosniff",
				},
			});
		} catch {
			return new Response(null, { status: 404 });
		}
	};
}
