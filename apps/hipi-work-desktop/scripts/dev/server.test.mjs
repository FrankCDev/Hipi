import assert from "node:assert/strict";
import { createServer as createNetServer } from "node:net";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { createLogger, createServer } from "vite";
import { developmentServerOptions } from "./server.mjs";

const ui = fileURLToPath(new URL("../../../hipi-work-ui", import.meta.url));
const token = "b".repeat(64);
test("desktop dev server is strict loopback, serves nonce CSP and real React Refresh", async () => {
	const options = developmentServerOptions(ui, token);
	assert.equal(options.server.host, "127.0.0.1");
	assert.equal(options.server.strictPort, true);
	assert.equal(options.server.cors, false);
	assert.throws(() => developmentServerOptions(ui, "' unsafe-inline"));
	const errors = [];
	const logger = createLogger();
	const server = await createServer({
		...options,
		customLogger: {
			...logger,
			error(message, detail) {
				errors.push(message);
				logger.error(message, detail);
			},
		},
	});
	try {
		await server.listen();
		const response = await fetch(`http://127.0.0.1:5173/?desktop=${token}`, { signal: AbortSignal.timeout(5000) });
		assert.equal(response.status, 200);
		const html = await response.text();
		assert.ok(html.includes(`nonce="${token}"`));
		assert.ok(html.includes("/@react-refresh"));
		assert.ok(response.headers.get("content-security-policy").includes(`script-src 'self' 'nonce-${token}'`));
		assert.equal(response.headers.get("access-control-allow-origin"), null);
		const module = await server.transformRequest("/src/app/desktop-app.tsx");
		assert.ok(module?.code.includes("$RefreshReg$"), "actual component must contain React refresh instrumentation");
	} finally {
		await server.close();
	}
	assert.deepEqual(errors, [], "Vite must not log background transform failures");
});
test("an occupied development port fails instead of attaching to another service or switching ports", async () => {
	const occupied = createNetServer();
	await new Promise((resolve, reject) => {
		occupied.once("error", reject);
		occupied.listen(5173, "127.0.0.1", resolve);
	});
	const server = await createServer(developmentServerOptions(ui, token));
	try {
		await assert.rejects(server.listen(), /already in use/);
	} finally {
		await server.close();
		await new Promise((resolve) => occupied.close(resolve));
	}
});
