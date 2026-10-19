// Verifies emitted PDF assets through the production protocol handler, without launching Electron.
import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { createRendererAssetHandler } from "../src/renderer-assets.ts";

const root = new URL("../dist/renderer/", import.meta.url);
const names = await readdir(new URL("assets/", root));
const workers = names.filter((name) => /^pdf\.worker-[\w-]+\.(?:js|mjs)$/.test(name));
assert.equal(workers.length, 1, "Expected one separately emitted local PDF worker");
const name = workers[0];
const rendererScripts = await Promise.all(
	names
		.filter((name) => /^index-[\w-]+\.js$/.test(name))
		.map((name) => readFile(new URL(`assets/${name}`, root), "utf8")),
);
assert.ok(
	rendererScripts.some((source) => source.includes(name)),
	"Renderer must reference the emitted worker asset",
);
const serve = createRendererAssetHandler(fileURLToPath(root));
const response = await serve({ url: `hipi-work://app/assets/${name}`, method: "GET" });
assert.equal(response.status, 200);
assert.equal(response.headers.get("Content-Type"), "text/javascript");
assert.equal(response.headers.get("X-Content-Type-Options"), "nosniff");
const csp = response.headers.get("Content-Security-Policy");
assert.ok(csp.includes("worker-src 'self';"));
assert.ok(csp.includes("connect-src 'none';"));
assert.ok(csp.includes("frame-src 'none';"));
assert.deepEqual(Buffer.from(await response.arrayBuffer()), await readFile(new URL(`assets/${name}`, root)));
assert.equal((await serve({ url: `https://app/assets/${name}`, method: "GET" })).status, 403);
process.stdout.write(
	`PDF worker ${name}: emitted renderer reference, local path, JavaScript MIME, self-only workers, and no network connect passed.\n`,
);
process.stdout.write("Native Electron custom-scheme worker execution remains unqualified until GUI acceptance.\n");
