// Copied outside the checkout and executed by the relocated packaged Electron in Node mode.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { Worker } from "node:worker_threads";

const resources = process.argv[2];
const build = JSON.parse(await readFile(join(resources, "app.asar/build-provenance.json"), "utf8"));
const icon = await readFile(join(resources, "app.asar/dist/branding/icon.png"));
const iconSha256 = createHash("sha256").update(icon).digest("hex");
assert.equal(iconSha256, process.argv[3]);
const db = new DatabaseSync(":memory:");
let sqlite;
try {
	assert.equal(db.prepare("SELECT 42 AS value").get().value, 42);
	sqlite = db.prepare("SELECT sqlite_version() AS version").get().version;
} finally {
	db.close();
}
const worker = new Worker(join(resources, "app.asar.unpacked/dist/preview-parser.mjs"));
try {
	const result = await new Promise((resolve, reject) => {
		const timer = setTimeout(() => reject(new Error("Parser timeout")), 15000);
		worker.once("message", (message) => {
			clearTimeout(timer);
			resolve(message);
		});
		worker.once("error", (error) => {
			clearTimeout(timer);
			reject(error);
		});
		worker.once("exit", (code) => {
			clearTimeout(timer);
			reject(new Error(`Parser exited before result: ${code}`));
		});
		worker.postMessage({ format: "csv", bytes: new TextEncoder().encode("name,value\n中文,42") });
	});
	assert.equal(result.ok, true);
	assert.deepEqual(
		result.preview.sheets[0].rows[1].map((cell) => cell.value),
		["中文", "42"],
	);
	console.log(
		JSON.stringify({
			sourceSnapshotSha256: build.sourceSnapshotSha256,
			parser: "passed",
			iconSha256,
			sqlite,
			electron: process.versions.electron,
			node: process.versions.node,
			platform: process.platform,
			architecture: process.arch,
		}),
	);
} finally {
	await worker.terminate();
}
