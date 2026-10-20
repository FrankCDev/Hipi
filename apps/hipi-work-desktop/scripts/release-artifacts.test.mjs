import assert from "node:assert/strict";
import { link, mkdtemp, readFile, rename, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { checksumsText, collectArtifacts, expectedArtifacts, verifyReleaseArtifacts } from "./release-artifacts.mjs";

const identity = { version: "1.0.0", platform: "linux", architecture: "x64", channel: "production-candidate" };

test("artifact identity has exact native target names including the AppImage architecture spelling", () => {
	assert.deepEqual(expectedArtifacts(identity), [
		"Hipi-Work-1.0.0-linux-x64.tar.gz",
		"Hipi-Work-1.0.0-linux-x86_64.AppImage",
	]);
	assert.deepEqual(expectedArtifacts({ ...identity, channel: "unsigned-local-staging" }), [
		"Hipi-Work-1.0.0-linux-x64-unsigned.tar.gz",
		"Hipi-Work-1.0.0-linux-x86_64-unsigned.AppImage",
	]);
	assert.deepEqual(expectedArtifacts({ ...identity, platform: "darwin", architecture: "arm64" }), [
		"Hipi-Work-1.0.0-mac-arm64.dmg",
		"Hipi-Work-1.0.0-mac-arm64.zip",
	]);
	assert.deepEqual(expectedArtifacts({ ...identity, platform: "win32" }), [
		"Hipi-Work-1.0.0-win-x64.exe",
		"Hipi-Work-1.0.0-win-x64.zip",
	]);
	for (const change of [{ version: "../../1" }, { architecture: "arm64" }, { channel: "production" }])
		assert.throws(() => expectedArtifacts({ ...identity, ...change }));
});

async function fixture() {
	const directory = await mkdtemp(join(tmpdir(), "hipi-release-artifacts-"));
	for (const file of expectedArtifacts(identity)) await writeFile(join(directory, file), `inert fixture ${file}`);
	const artifacts = await collectArtifacts(directory, identity);
	const provenance = {
		schemaVersion: 1,
		product: "Hipi Work",
		...identity,
		artifacts,
		productionVerification: { scope: "artifact-bytes-and-native-signatures", artifacts },
		validation: { installation: "not_run", gui: "not_run", updateRecovery: "not_run" },
	};
	await writeFile(join(directory, "release-provenance.json"), JSON.stringify(provenance));
	await writeFile(join(directory, "SHA256SUMS"), checksumsText(artifacts));
	return { directory, provenance };
}

test("manifest verifier recomputes actual bytes, exact identity and checksum set without trusting passed strings", async () => {
	const { directory, provenance } = await fixture();
	try {
		assert.deepEqual(await verifyReleaseArtifacts(directory, identity), provenance.artifacts);
		for (const change of [{ version: "1.0.1" }, { architecture: "arm64" }, { channel: "unsigned-local-staging" }])
			await assert.rejects(verifyReleaseArtifacts(directory, { ...identity, ...change }), /identity mismatch/);
		await writeFile(join(directory, provenance.artifacts[0].file), "corrupted");
		await assert.rejects(verifyReleaseArtifacts(directory, identity), /actual bytes/);
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
});

test("manifest rejects extra assets, missing assets, unsafe names, duplicate records and false acceptance claims", async () => {
	const { directory, provenance } = await fixture();
	try {
		const manifest = join(directory, "release-provenance.json");
		for (const altered of [
			{ ...provenance, artifacts: [...provenance.artifacts, provenance.artifacts[0]] },
			{
				...provenance,
				artifacts: [{ ...provenance.artifacts[0], file: "../escape" }, ...provenance.artifacts.slice(1)],
			},
			{ ...provenance, productionVerification: { ...provenance.productionVerification, artifacts: [] } },
			{ ...provenance, validation: { ...provenance.validation, installation: "passed" } },
		]) {
			await writeFile(manifest, JSON.stringify(altered));
			await assert.rejects(verifyReleaseArtifacts(directory, identity));
		}
		await writeFile(manifest, JSON.stringify(provenance));
		await writeFile(join(directory, "old.exe"), "extra");
		await assert.rejects(verifyReleaseArtifacts(directory, identity), /unexpected distributable/);
		await rm(join(directory, "old.exe"));
		await writeFile(join(directory, "private.log"), "extra");
		await assert.rejects(verifyReleaseArtifacts(directory, identity), /Unexpected file/);
		await rm(join(directory, "private.log"));
		const sums = await readFile(join(directory, "SHA256SUMS"));
		await writeFile(join(directory, "SHA256SUMS"), `${sums}extra\n`);
		await assert.rejects(verifyReleaseArtifacts(directory, identity), /Checksum/);
		await writeFile(join(directory, "SHA256SUMS"), sums);
		await rm(join(directory, provenance.artifacts[0].file));
		await assert.rejects(verifyReleaseArtifacts(directory, identity), /Missing/);
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
});

test("nonempty regular artifacts are required and symlinks are never followed", async () => {
	const { directory, provenance } = await fixture();
	try {
		const path = join(directory, provenance.artifacts[0].file);
		await writeFile(path, "");
		await assert.rejects(collectArtifacts(directory, identity), /nonempty regular/);
		if (process.platform !== "win32") {
			await rm(path);
			await symlink(join(directory, provenance.artifacts[1].file), path);
			await assert.rejects(collectArtifacts(directory, identity), /nonempty regular/);
		}
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
});

test("standalone verifier rejects linked metadata and a redirected distribution root", async () => {
	const { directory } = await fixture();
	const alias = `${directory}-alias`;
	try {
		for (const file of ["release-provenance.json", "SHA256SUMS"]) {
			const path = join(directory, file);
			const original = `${path}.original`;
			await rename(path, original);
			await link(original, path);
			await assert.rejects(verifyReleaseArtifacts(directory, identity), /regular file/);
			await rm(path);
			if (process.platform !== "win32") {
				await symlink(original, path);
				await assert.rejects(verifyReleaseArtifacts(directory, identity), /regular file/);
				await rm(path);
			}
			await rename(original, path);
		}
		await symlink(directory, alias, process.platform === "win32" ? "junction" : "dir");
		await assert.rejects(verifyReleaseArtifacts(alias, identity), /real directory/);
		await assert.rejects(collectArtifacts(alias, identity), /real directory/);
	} finally {
		await rm(alias, { force: true });
		await rm(directory, { recursive: true, force: true });
	}
});
