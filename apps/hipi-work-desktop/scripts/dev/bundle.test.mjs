import assert from "node:assert/strict";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const root = fileURLToPath(new URL("../../", import.meta.url));
test("production bundle eliminates development control, profile and local server entry", async () => {
	for (const development of [false, true]) {
		const result = await build({
			absWorkingDir: root,
			entryPoints: ["src/main.ts"],
			bundle: true,
			write: false,
			platform: "node",
			format: "esm",
			external: ["electron"],
			conditions: ["source"],
			define: { HIPI_DESKTOP_DEV: String(development) },
		});
		const source = result.outputFiles[0].text;
		for (const marker of [
			"HIPI_DESKTOP_DEVELOPMENT_READY",
			"HIPI_DESKTOP_DEVELOPMENT_QUIT",
			"Hipi Work Development",
			"http://127.0.0.1:5173",
		])
			assert.equal(source.includes(marker), development, marker);
		assert.ok(source.includes("sandbox: true"));
		assert.ok(source.includes("contextIsolation: true"));
		assert.ok(source.includes("nodeIntegration: false"));
		assert.ok(source.includes("webSecurity: true"));
		assert.ok(source.includes("hipi-work://app/index.html"));
	}
});
