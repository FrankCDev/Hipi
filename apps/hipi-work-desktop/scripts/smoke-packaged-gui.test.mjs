import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { realpathSync } from "node:fs";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { runInNewContext } from "node:vm";
import { smokeProfile } from "../src/smoke-profile.ts";
import { sidebarWorkspaceIds } from "./gui/sidebar/manifest.mjs";
import { virtualizationWorkspaceIds } from "./gui/sidebar/virtualization-manifest.mjs";
import { fileFixture } from "./gui-file-fixture-data.mjs";
import {
	assertScenarioWorkspaceDatabases,
	baselineResponseArguments,
	createGuiProfile,
	guiAcceptanceResult,
	sourceProvenanceEvidence,
} from "./smoke-packaged-gui.mjs";

test("plain-Node packaged GUI entry imports without source conditions or package builds", () => {
	const entry = new URL("./smoke-packaged-gui.mjs", import.meta.url).href;
	const output = execFileSync(
		process.execPath,
		[
			"--input-type=module",
			"--eval",
			`import { baselineResponseArguments } from ${JSON.stringify(entry)};
				console.log(JSON.stringify(baselineResponseArguments("baseline")));`,
		],
		{ encoding: "utf8", env: { ...process.env, NODE_OPTIONS: "" }, timeout: 10000 },
	);
	assert.deepEqual(JSON.parse(output), ["--smoke-response=baseline-stream", "--smoke-scenario=baseline"]);
});

test("known stream response is opt-in only for the isolated baseline scenario", () => {
	assert.deepEqual(baselineResponseArguments("baseline"), [
		"--smoke-response=baseline-stream",
		"--smoke-scenario=baseline",
	]);
	for (const scenario of ["long-history", "file-workbench", "sidebar", "sidebar-virtualization"])
		assert.deepEqual(baselineResponseArguments(scenario), []);
	for (const scenario of [undefined, "normal", "production", "baseline-other"])
		assert.throws(() => baselineResponseArguments(scenario), /Unknown fixed GUI scenario/);
});

test("GUI acceptance preserves void validators and requires explicit incomplete evidence", () => {
	assert.deepEqual(guiAcceptanceResult(undefined), { status: "passed" });
	assert.deepEqual(guiAcceptanceResult({ status: "passed" }), { status: "passed" });
	const unqualified = { status: "unqualified", reason: "Overlay thumb unavailable", missing: ["native-thumb-drag"] };
	assert.deepEqual(guiAcceptanceResult(unqualified), unqualified);
	assert.notEqual(guiAcceptanceResult(unqualified).missing, unqualified.missing);
	for (const invalid of [
		null,
		true,
		"passed",
		{},
		{ status: "failed" },
		{ status: "unqualified" },
		{ ...unqualified, reason: " " },
		{ ...unqualified, missing: [] },
		{ ...unqualified, missing: [null] },
	])
		assert.throws(() => guiAcceptanceResult(invalid));
});

test("lifecycle retains partial evidence but never reports unavailable qualification as passed", async () => {
	const source = await readFile(new URL("./smoke-packaged-gui.mjs", import.meta.url), "utf8");
	const start = source.indexOf("\t\tconst acceptance = guiAcceptanceResult(");
	const end = source.indexOf("\n\t} catch (error)", start);
	assert.ok(start >= 0 && end > start);
	for (const result of [
		undefined,
		{ status: "passed" },
		{ status: "unqualified", reason: "Overlay thumb unavailable", missing: ["native-thumb-drag"] },
	]) {
		const evidence = { checks: [{ wheel: true, keyboard: true }] };
		const process = {};
		const firstFlow = { rawFrames: 200 },
			reopenedFlow = { rawFrames: 300 };
		let stopped = false,
			snapshotChecked = false;
		const context = {
			evidence,
			process,
			firstFlow,
			reopenedFlow,
			guiAcceptanceResult,
			validate(input) {
				assert.equal(input.first, firstFlow);
				assert.equal(input.reopened, reopenedFlow);
				return result;
			},
			xvfb: {
				async terminate() {
					stopped = true;
				},
			},
			safeCleanup: false,
			root: "unused",
			provenance: { sourceSnapshot: [] },
			async assertSourceSnapshot() {
				snapshotChecked = true;
			},
		};
		await runInNewContext(`(async()=>{${source.slice(start, end)}})()`, context);
		assert.equal(evidence.status, result?.status ?? "passed");
		assert.deepEqual(evidence.acceptance, guiAcceptanceResult(result));
		assert.deepEqual(evidence.checks, [{ wheel: true, keyboard: true }]);
		assert.equal(process.exitCode, result?.status === "unqualified" ? 1 : undefined);
		assert.equal(stopped && snapshotChecked && context.safeCleanup, true);
	}
});

test("large sidebar requires seven exact workspace identities and both databases", async () => {
	const root = await createGuiProfile();
	try {
		for (const workspace of virtualizationWorkspaceIds) {
			await mkdir(join(root, workspace));
			for (const file of ["owner.sqlite", "workspace.sqlite"]) await writeFile(join(root, workspace, file), "fixture");
		}
		await assertScenarioWorkspaceDatabases(root, "sidebar-virtualization");
		await rename(join(root, virtualizationWorkspaceIds[0]), join(root, "wrong-identity"));
		await assert.rejects(
			assertScenarioWorkspaceDatabases(root, "sidebar-virtualization"),
			/exact fixture database identities/,
		);
		await rename(join(root, "wrong-identity"), join(root, virtualizationWorkspaceIds[0]));
		await mkdir(join(root, "unexpected"));
		await assert.rejects(assertScenarioWorkspaceDatabases(root, "sidebar-virtualization"), /workspace count/);
		await rm(join(root, "unexpected"), { recursive: true });
		for (const file of ["owner.sqlite", "workspace.sqlite"]) {
			const path = join(root, virtualizationWorkspaceIds[6], file);
			await rm(path);
			await assert.rejects(assertScenarioWorkspaceDatabases(root, "sidebar-virtualization"), /ENOENT/);
			await writeFile(path, "fixture");
		}
		await rm(join(root, virtualizationWorkspaceIds[6]), { recursive: true });
		await assert.rejects(assertScenarioWorkspaceDatabases(root, "sidebar-virtualization"), /workspace count/);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("sidebar accepts only exact default Chats and two project database identities", async () => {
	const root = await createGuiProfile();
	try {
		for (const workspace of sidebarWorkspaceIds) {
			await mkdir(join(root, workspace));
			for (const file of ["owner.sqlite", "workspace.sqlite"]) await writeFile(join(root, workspace, file), "fixture");
		}
		await assertScenarioWorkspaceDatabases(root, "sidebar");
		await rename(join(root, sidebarWorkspaceIds[1]), join(root, "same-visible-title-wrong-identity"));
		await assert.rejects(assertScenarioWorkspaceDatabases(root, "sidebar"), /exact default/);
		await rename(join(root, "same-visible-title-wrong-identity"), join(root, sidebarWorkspaceIds[1]));
		await mkdir(join(root, "unexpected"));
		await assert.rejects(assertScenarioWorkspaceDatabases(root, "sidebar"), /workspace count/);
		await rm(join(root, "unexpected"), { recursive: true });
		await rm(join(root, sidebarWorkspaceIds[1], "workspace.sqlite"));
		await assert.rejects(assertScenarioWorkspaceDatabases(root, "sidebar"), /ENOENT/);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("exact final counts are baseline two, file binding three, long history one, with every database required", async () => {
	const root = await createGuiProfile();
	try {
		for (const workspace of [fileFixture.workspaceId, fileFixture.otherWorkspaceId]) {
			await mkdir(join(root, workspace));
			for (const file of ["owner.sqlite", "workspace.sqlite"]) await writeFile(join(root, workspace, file), "fixture");
		}
		await assertScenarioWorkspaceDatabases(root, "baseline");
		await assert.rejects(assertScenarioWorkspaceDatabases(root, "file-workbench"), /workspace count/);
		await assert.rejects(assertScenarioWorkspaceDatabases(root, "long-history"), /workspace count/);
		await mkdir(join(root, "native-third"));
		for (const scenario of ["baseline", "long-history"])
			await assert.rejects(assertScenarioWorkspaceDatabases(root, scenario), /workspace count/);
		await assert.rejects(assertScenarioWorkspaceDatabases(root, "file-workbench", "native-third"), /ENOENT/);
		for (const file of ["owner.sqlite", "workspace.sqlite"])
			await writeFile(join(root, "native-third", file), "fixture");
		await assertScenarioWorkspaceDatabases(root, "file-workbench", "native-third");
		for (const original of [fileFixture.workspaceId, fileFixture.otherWorkspaceId]) {
			await rename(join(root, original), join(root, "replacement"));
			await assert.rejects(assertScenarioWorkspaceDatabases(root, "file-workbench", "native-third"), /exact A\/B/);
			await rename(join(root, "replacement"), join(root, original));
		}
		for (const identity of [undefined, "not-created"])
			await assert.rejects(assertScenarioWorkspaceDatabases(root, "file-workbench", identity), /identity is missing/);
		for (const identity of [fileFixture.workspaceId, fileFixture.otherWorkspaceId])
			await assert.rejects(assertScenarioWorkspaceDatabases(root, "file-workbench", identity), /exact A\/B/);
		await rm(join(root, "native-third", "owner.sqlite"));
		await assert.rejects(assertScenarioWorkspaceDatabases(root, "file-workbench", "native-third"), /ENOENT/);
		await writeFile(join(root, "native-third", "owner.sqlite"), "fixture");
		await mkdir(join(root, "unexpected-fourth"));
		await assert.rejects(assertScenarioWorkspaceDatabases(root, "file-workbench"), /workspace count/);
		await rm(join(root, "unexpected-fourth"), { recursive: true });
		await rm(join(root, "native-third"), { recursive: true });
		await rm(join(root, fileFixture.otherWorkspaceId, "workspace.sqlite"));
		await assert.rejects(assertScenarioWorkspaceDatabases(root, "baseline"), /ENOENT/);
		await rm(join(root, fileFixture.otherWorkspaceId), { recursive: true });
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
