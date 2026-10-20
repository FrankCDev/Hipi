import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { realpathSync } from "node:fs";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { runInNewContext } from "node:vm";
import { smokeProfile } from "../src/smoke-profile.ts";
import {
	assertScenarioWorkspaceDatabases,
	baselineResponseArguments,
	createGuiProfile,
	sourceProvenanceEvidence,
} from "./smoke-packaged-gui.mjs";

test("known stream response is opt-in only for the isolated baseline scenario", () => {
	assert.deepEqual(baselineResponseArguments("baseline"), [
		"--smoke-response=baseline-stream",
		"--smoke-scenario=baseline",
	]);
	for (const scenario of ["long-history", "file-workbench"]) assert.deepEqual(baselineResponseArguments(scenario), []);
	for (const scenario of [undefined, "normal", "production", "baseline-other"])
		assert.throws(() => baselineResponseArguments(scenario), /Unknown fixed GUI scenario/);
});

test("baseline and file flow validate both exact owned workspace databases; long history retains one", async () => {
	const root = await createGuiProfile();
	try {
		for (const workspace of ["a", "b"]) {
			await mkdir(join(root, workspace));
			for (const file of ["owner.sqlite", "workspace.sqlite"]) await writeFile(join(root, workspace, file), "fixture");
		}
		for (const scenario of ["baseline", "file-workbench"]) await assertScenarioWorkspaceDatabases(root, scenario);
		await assert.rejects(assertScenarioWorkspaceDatabases(root, "long-history"), /workspace count/);
		await mkdir(join(root, "unexpected-third"));
		for (const scenario of ["baseline", "file-workbench", "long-history"])
			await assert.rejects(assertScenarioWorkspaceDatabases(root, scenario), /workspace count/);
		await rm(join(root, "unexpected-third"), { recursive: true });
		await rm(join(root, "b", "workspace.sqlite"));
		for (const scenario of ["baseline", "file-workbench"])
			await assert.rejects(assertScenarioWorkspaceDatabases(root, scenario), /ENOENT/);
		await rm(join(root, "b"), { recursive: true });
		for (const scenario of ["baseline", "file-workbench"])
			await assert.rejects(assertScenarioWorkspaceDatabases(root, scenario), /workspace count/);
		await assertScenarioWorkspaceDatabases(root, "long-history");
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("failure evidence snapshots exit and close events before cleanup without process details", async () => {
	const source = await readFile(new URL("./smoke-packaged-gui.mjs", import.meta.url), "utf8");
	const begin = source.indexOf('evidence.status = "failed";');
	const end = source.indexOf("\n\t\tif (native &&", begin);
	assert.ok(begin >= 0 && end > begin);
	for (const native of [
		undefined,
		{ exited: false, closed: false },
		{ exited: true, closed: false },
		{ exited: true, closed: true },
	]) {
		const evidence = {};
		runInNewContext(source.slice(begin, end), {
			evidence,
			native: native && { ...native, child: { pid: "private" }, output: "private" },
			recordGuiFailure: () => {},
			error: new Error("failure"),
			owned: "private",
			profile: "private",
		});
		assert.deepEqual(JSON.parse(JSON.stringify(evidence)), {
			status: "failed",
			...(native ? { nativeProcessAtFailure: native } : {}),
		});
	}
});

test("GUI-created profile passes the unchanged native startup boundary on first launch and reopen", async () => {
	const root = await createGuiProfile();
	try {
		assert.equal(root, realpathSync(root));
		assert.equal(dirname(root), realpathSync(tmpdir()));
		const args = [`--smoke-data-root=${root}`];
		const paths = smokeProfile(args, "deterministic");
		assert.equal(paths.userData, join(root, "profile"));
		assert.deepEqual(smokeProfile(args, "deterministic"), paths);
		await mkdir(join(root, "unexpected"));
		assert.throws(() => smokeProfile(args, "deterministic"), /Unexpected smoke profile contents/);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("GUI evidence retains exact source path/hash manifest and rejects a mismatched checksum", () => {
	const sourceSnapshot = [{ file: "apps/hipi-work-ui/src/app.tsx", sha256: "a".repeat(64) }];
	const sourceSnapshotSha256 = createHash("sha256").update(JSON.stringify(sourceSnapshot)).digest("hex");
	const report = sourceProvenanceEvidence({ sourceSnapshot, sourceSnapshotSha256, unrelatedMetadata: "not copied" });
	assert.deepEqual(report, { sourceSnapshot, sourceSnapshotSha256 });
	assert.notEqual(report.sourceSnapshot, sourceSnapshot);
	assert.notEqual(report.sourceSnapshot[0], sourceSnapshot[0]);
	assert.throws(() => sourceProvenanceEvidence({ sourceSnapshot, sourceSnapshotSha256: "b".repeat(64) }));
	const withExtra = [{ ...sourceSnapshot[0], environment: "must not enter source evidence" }];
	assert.throws(() =>
		sourceProvenanceEvidence({
			sourceSnapshot: withExtra,
			sourceSnapshotSha256: createHash("sha256").update(JSON.stringify(withExtra)).digest("hex"),
		}),
	);
});
