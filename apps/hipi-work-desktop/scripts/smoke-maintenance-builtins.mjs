// Source-only probe copied outside the checkout. Runs with the packaged official
// Node, not Electron. Real Electron utility/SQLite behavior remains a GUI gate.
import assert from "node:assert/strict";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { Worker } from "node:worker_threads";

assert.equal(process.versions.electron, undefined, "Maintenance must not use Electron Node mode");
const db = new DatabaseSync(":memory:");
let sqlite;
try {
	assert.equal(db.prepare("SELECT 42 AS value").get().value, 42);
	sqlite = db.prepare("SELECT sqlite_version() AS version").get().version;
} finally {
	db.close();
}
const worker = new Worker(join(process.argv[2], "app.asar.unpacked/dist/preview-parser.mjs"));
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
			parser: "passed",
			sqlite,
			node: process.versions.node,
			platform: process.platform,
			architecture: process.arch,
		}),
	);
} finally {
	await worker.terminate();
}
