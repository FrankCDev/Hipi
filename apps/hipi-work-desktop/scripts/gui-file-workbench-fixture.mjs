// Source-only synthetic inputs; never bundled in the production application.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { realpathSync } from "node:fs";
import { lstat, mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { createModels, fauxProvider } from "@earendil-works/pi-ai";
import { openRuntime } from "@hipi/work-runtime/node";
import { fileFixture } from "./gui-file-fixture-data.mjs";
import { createPreviewFixtureFiles } from "./gui-file-preview-fixtures.mjs";

export { fileFixture };
// A single original RGBA pixel (40, 120, 200, 255), with valid PNG chunk CRCs.
const image = Buffer.from(
	"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGPQqDjxHwAEnAJobhvlygAAAABJRU5ErkJggg==",
	"base64",
);
const digest = (value) => createHash("sha256").update(value).digest("hex");
const previewFiles = createPreviewFixtureFiles();
export const fileFixtureNames = Object.freeze([
	fileFixture.textName,
	fileFixture.secondName,
	fileFixture.csvName,
	fileFixture.imageName,
	...previewFiles.map(([name]) => name),
]);

/** Only caller-created private mkdtemp profiles are accepted; JSON evidence is not authority. */
export async function ownedFileDirectory(ownedProfileRoot, { create = false } = {}) {
	// Match smokeProfile's canonicalizer exactly. On Windows, the promise/native variant
	// can expand short path names or casing differently from the synchronous path walk.
	const root = realpathSync(ownedProfileRoot);
	assert.equal(root, ownedProfileRoot, "File profile must be canonical");
	assert.equal(dirname(root), realpathSync(tmpdir()), "File profile must be a direct temporary child");
	assert.match(basename(root), /^Hipi GUI profile-[A-Za-z0-9]+$/);
	const info = await lstat(root);
	assert.ok(info.isDirectory() && !info.isSymbolicLink());
	if (process.platform !== "win32") {
		assert.equal(info.uid, process.getuid());
		assert.equal(info.mode & 0o077, 0, "File profile must be private");
	}
	// The native launch boundary permits only its four known children at the profile root.
	// Keep synthetic files inside userData, separate from the deterministic runtime store.
	const userData = join(root, "profile");
	if (create) {
		try {
			await mkdir(userData, { mode: 0o700 });
		} catch (error) {
			if (error.code !== "EEXIST") throw error;
		}
	}
	assert.equal(realpathSync(userData), userData, "File userData escaped owned profile");
	const parent = await lstat(userData);
	assert.ok(parent.isDirectory() && !parent.isSymbolicLink());
	if (process.platform !== "win32") {
		assert.equal(parent.uid, process.getuid());
		assert.equal(parent.mode & 0o077, 0, "File userData must be private");
	}
	const directory = join(userData, fileFixture.folder);
	if (create) await mkdir(directory, { mode: 0o700 });
	assert.equal(realpathSync(directory), directory, "File fixture escaped owned profile");
	const files = await lstat(directory);
	assert.ok(files.isDirectory() && !files.isSymbolicLink());
	return directory;
}

export async function readOwnedFixture(ownedProfileRoot, name = fileFixture.textName) {
	assert.ok(fileFixtureNames.includes(name));
	const path = join(await ownedFileDirectory(ownedProfileRoot), name);
	const info = await lstat(path);
	assert.ok(info.isFile() && !info.isSymbolicLink() && info.nlink === 1 && info.size < 65536);
	assert.equal(realpathSync(path), path);
	return readFile(path);
}

/** Simulate a separate editor only in the owned synthetic file, after confirmed GUI save. */
export async function changeOwnedFixture(ownedProfileRoot) {
	assert.equal((await readOwnedFixture(ownedProfileRoot)).toString("utf8"), fileFixture.saved);
	await writeFile(join(await ownedFileDirectory(ownedProfileRoot), fileFixture.textName), fileFixture.external, {
		flag: "r+",
	});
	// The external string is deliberately longer than the saved one; no stale suffix can survive r+.
	assert.ok(Buffer.byteLength(fileFixture.external) > Buffer.byteLength(fileFixture.saved));
	assert.equal((await readOwnedFixture(ownedProfileRoot)).toString("utf8"), fileFixture.external);
}

/** One known closed, clean synthetic file only; native UI must subsequently restore its expected bytes. */
export async function changeClosedSecondFixture(ownedProfileRoot) {
	assert.equal(
		(await readOwnedFixture(ownedProfileRoot, fileFixture.secondName)).toString("utf8"),
		fileFixture.secondClosed,
	);
	assert.ok(Buffer.byteLength(fileFixture.secondReopened) > Buffer.byteLength(fileFixture.secondClosed));
	await writeFile(
		join(await ownedFileDirectory(ownedProfileRoot), fileFixture.secondName),
		fileFixture.secondReopened,
		{
			flag: "r+",
		},
	);
	assert.equal(
		(await readOwnedFixture(ownedProfileRoot, fileFixture.secondName)).toString("utf8"),
		fileFixture.secondReopened,
	);
}

function runtimeOptions() {
	const models = createModels({ authContext: { env: async () => undefined, fileExists: async () => false } });
	models.setProvider(fauxProvider({ models: [{ id: "faux-1" }] }).provider);
	return { models, model: { provider: "faux", modelId: "faux-1" } };
}

export async function seedFileWorkbench({ ownedProfileRoot, assertAllOwnedProcessesExited }) {
	await assertAllOwnedProcessesExited();
	const directory = await ownedFileDirectory(ownedProfileRoot, { create: true });
	for (const [name, contents] of [
		[fileFixture.textName, fileFixture.initial],
		[fileFixture.secondName, fileFixture.secondInitial],
		[fileFixture.csvName, fileFixture.csv],
		[fileFixture.imageName, image],
		...previewFiles,
	])
		await writeFile(join(directory, name), contents, { flag: "wx", mode: 0o600 });
	const profile = join(ownedProfileRoot, "profile");
	const store = join(profile, "deterministic-store");
	const runtime = await openRuntime(store, runtimeOptions());
	try {
		await runtime.call("createWorkspace", { workspaceId: fileFixture.workspaceId, name: fileFixture.workspaceTitle });
		await runtime.call("createWorkspace", {
			workspaceId: fileFixture.otherWorkspaceId,
			name: fileFixture.otherWorkspaceTitle,
		});
		const conversation = await runtime.call("createConversation", {
			workspaceId: fileFixture.workspaceId,
			requestId: "file-gui-create",
			title: fileFixture.conversationTitle,
		});
		return {
			workspaceId: fileFixture.workspaceId,
			otherWorkspaceId: fileFixture.otherWorkspaceId,
			conversationId: conversation.conversationId,
			files: fileFixtureNames,
			initialSha256: digest(fileFixture.initial),
			secondInitialSha256: digest(fileFixture.secondInitial),
			csvSha256: digest(fileFixture.csv),
			imageSha256: digest(image),
			previewSha256: Object.fromEntries(previewFiles.map(([name, bytes]) => [name, digest(bytes)])),
			syntheticOnly: true,
			seedViaPublicRuntime: true,
			grantsPreseeded: false,
		};
	} finally {
		await runtime.close();
	}
}

export async function verifyColdFileWorkbench({ ownedProfileRoot, assertAllOwnedProcessesExited, gui }) {
	await assertAllOwnedProcessesExited();
	assert.equal(gui.conflictDraftPreserved, true);
	assert.equal(gui.savedBytesVerified, true);
	assert.equal(gui.backgroundAutosave, true);
	assert.equal(gui.conditionalCloseSaved, true);
	assert.deepEqual((await readdir(await ownedFileDirectory(ownedProfileRoot))).sort(), [...fileFixtureNames].sort());
	assert.equal((await readOwnedFixture(ownedProfileRoot)).toString("utf8"), fileFixture.external);
	assert.equal(
		(await readOwnedFixture(ownedProfileRoot, fileFixture.secondName)).toString("utf8"),
		fileFixture.secondClosed,
	);
	assert.equal((await readOwnedFixture(ownedProfileRoot, fileFixture.csvName)).toString("utf8"), fileFixture.csv);
	assert.deepEqual(await readOwnedFixture(ownedProfileRoot, fileFixture.imageName), image);
	for (const [name, bytes] of previewFiles) assert.deepEqual(await readOwnedFixture(ownedProfileRoot, name), bytes);
	return {
		finalDiskSha256: digest(fileFixture.external),
		secondDiskSha256: digest(fileFixture.secondClosed),
		syntheticFilesIntact: true,
		externalEditPreserved: true,
	};
}
