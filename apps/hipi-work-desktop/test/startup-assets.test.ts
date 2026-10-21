import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { providerMode } from "../src/launch/provider-mode.ts";
import { createRendererAssetHandler, RENDERER_CSP } from "../src/shell/renderer-assets.ts";

test("OS launch defaults to production; deterministic store is explicit and malformed overrides fail", () => {
	assert.equal(providerMode(["/Applications/Hipi Work"]), "production");
	assert.equal(providerMode(["electron", ".", "--provider=production"]), "production");
	assert.equal(providerMode(["electron", ".", "--provider=deterministic"]), "deterministic");
	for (const input of [
		["--provider=unknown"],
		["--provider="],
		["--provider", "deterministic"],
		["--provider=production", "--provider=production"],
		["--provider=deterministic", "--provider=production"],
	])
		assert.throws(() => providerMode(input));
});

test("local JS and MJS worker assets have strict MIME and CSP without network access", async () => {
	const directory = await mkdtemp(join(tmpdir(), "hipi-worker-assets-"));
	try {
		await mkdir(join(directory, "assets"));
		const serve = createRendererAssetHandler(directory);
		for (const extension of ["js", "mjs"]) {
			await writeFile(join(directory, "assets", `pdf.worker-fixture.${extension}`), "self.onmessage = () => {};\n");
			const response = await serve({ url: `hipi-work://app/assets/pdf.worker-fixture.${extension}`, method: "GET" });
			assert.equal(response.status, 200);
			assert.equal(response.headers.get("Content-Type"), "text/javascript");
			assert.equal(response.headers.get("X-Content-Type-Options"), "nosniff");
			assert.equal(response.headers.get("Content-Security-Policy"), RENDERER_CSP);
			assert.match(RENDERER_CSP, /worker-src 'self';/);
			assert.match(RENDERER_CSP, /connect-src 'none';/);
		}
		for (const url of [
			"https://app/assets/pdf.worker-fixture.js",
			"hipi-work://other/assets/pdf.worker-fixture.js",
			"hipi-work://app/assets/%2e%2e%2f%2e%2e%2fsecret.js",
			"hipi-work://app/assets/pdf.worker-fixture.js?url=remote",
			"hipi-work://app/assets/%ZZ.js",
			"hipi-work://app/private.ts",
		])
			assert.equal((await serve({ url, method: "GET" })).status, 403);
		assert.equal((await serve({ url: "hipi-work://app/assets/pdf.worker-fixture.js", method: "POST" })).status, 403);
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
});
