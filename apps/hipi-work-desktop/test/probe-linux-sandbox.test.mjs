import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";

test("Linux sandbox host probe reports actual capability without claiming GUI acceptance", () => {
	const result = spawnSync(
		process.execPath,
		[fileURLToPath(new URL("../scripts/probe-linux-sandbox.mjs", import.meta.url))],
		{ encoding: "utf8", timeout: 15000, maxBuffer: 16384 },
	);
	assert.ifError(result.error);
	assert.equal(result.signal, null);
	assert.equal(result.stderr, "");
	const report = JSON.parse(result.stdout);
	assert.equal(report.probe, "linux-sandbox-capability");
	assert.equal(report.platform, process.platform);
	assert.equal(report.productGuiValidated, false);
	if (process.platform !== "linux") {
		assert.equal(report.status, "not_applicable");
		assert.equal(result.status, 0);
		return;
	}
	assert.equal(typeof report.executables.Xvfb, "boolean");
	assert.equal(typeof report.executables.unshare, "boolean");
	assert.ok(["completed", "blocked", "not_attempted"].includes(report.namespace.status));
	for (const value of Object.values(report.sysctls)) assert.ok(Number.isSafeInteger(value) || value === "unavailable");
	const candidate = report.uid !== 0 && report.executables.Xvfb && report.namespace.status === "completed";
	assert.equal(report.status, candidate ? "candidate_requires_packaged_gui_validation" : "blocked");
	assert.equal(result.status, candidate ? 0 : 1);
});

test(
	"missing host tools remain blocked rather than becoming GUI success",
	{ skip: process.platform !== "linux" },
	() => {
		const result = spawnSync(
			process.execPath,
			[fileURLToPath(new URL("../scripts/probe-linux-sandbox.mjs", import.meta.url))],
			{ encoding: "utf8", timeout: 15000, maxBuffer: 16384, env: { PATH: "" } },
		);
		assert.ifError(result.error);
		assert.equal(result.status, 1);
		const report = JSON.parse(result.stdout);
		assert.equal(report.status, "blocked");
		assert.equal(report.productGuiValidated, false);
		assert.deepEqual(report.executables, { Xvfb: false, unshare: false, true: false });
		assert.equal(report.namespace.status, "not_attempted");
	},
);
