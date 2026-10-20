import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { lstat, readdir, readFile } from "node:fs/promises";
import { join } from "node:path";

export function expectedArtifacts({ version, platform, architecture, channel }) {
	assert.match(version, /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/, "Invalid desktop version");
	assert.ok(["unsigned-local-staging", "production-candidate"].includes(channel), "Unknown release channel");
	const targets = {
		"darwin-x64": ["mac", ["dmg", "zip"]],
		"darwin-arm64": ["mac", ["dmg", "zip"]],
		"win32-x64": ["win", ["exe", "zip"]],
		"linux-x64": ["linux", ["AppImage", "tar.gz"]],
	};
	const target = targets[`${platform}-${architecture}`];
	assert.ok(target, "Unreviewed release target");
	const suffix = channel === "unsigned-local-staging" ? "-unsigned" : "";
	return target[1]
		.map((extension) => {
			const arch = extension === "AppImage" ? "x86_64" : architecture;
			return `Hipi-Work-${version}-${target[0]}-${arch}${suffix}.${extension}`;
		})
		.sort();
}

export async function artifactDigest(file) {
	const before = await lstat(file);
	assert.ok(before.isFile() && before.nlink === 1 && before.size > 0, "Artifact must be a nonempty regular file");
	const hash = createHash("sha256");
	let bytes = 0;
	for await (const chunk of createReadStream(file)) {
		hash.update(chunk);
		bytes += chunk.length;
	}
	const after = await lstat(file);
	assert.ok(
		after.isFile() &&
			after.nlink === 1 &&
			before.dev === after.dev &&
			before.ino === after.ino &&
			before.size === after.size &&
			before.mtimeMs === after.mtimeMs &&
			bytes === before.size,
		"Artifact changed while hashing",
	);
	return { bytes, sha256: hash.digest("hex") };
}

export async function collectArtifacts(directory, identity) {
	assert.ok((await lstat(directory)).isDirectory(), "Artifact root must be a real directory");
	const expected = expectedArtifacts(identity);
	const present = (await readdir(directory, { withFileTypes: true }))
		.filter((entry) => /\.(?:dmg|zip|exe|AppImage|tar\.gz)$/i.test(entry.name))
		.map((entry) => entry.name)
		.sort();
	assert.deepEqual(present, expected, "Missing or unexpected distributable artifact");
	return Promise.all(expected.map(async (file) => ({ file, ...(await artifactDigest(join(directory, file))) })));
}

export function checksumsText(artifacts) {
	return artifacts.map((item) => `${item.sha256}  ${item.file}\n`).join("");
}

// This checks bytes and identity, not the authenticity of a manifest obtained
// from an arbitrary source. Native signatures and the distribution source are
// separate trust checks; a JSON "passed" value is never treated as proof.
export async function verifyReleaseArtifacts(directory, identity) {
	assert.ok((await lstat(directory)).isDirectory(), "Artifact root must be a real directory");
	const metadata = {};
	for (const file of ["release-provenance.json", "SHA256SUMS"]) {
		const location = join(directory, file);
		const digest = await artifactDigest(location);
		const bytes = await readFile(location);
		assert.equal(
			createHash("sha256").update(bytes).digest("hex"),
			digest.sha256,
			"Release metadata changed while reading",
		);
		metadata[file] = bytes.toString("utf8");
	}
	const provenance = JSON.parse(metadata["release-provenance.json"]);
	for (const key of ["version", "platform", "architecture", "channel"])
		assert.equal(provenance[key], identity[key], `Release identity mismatch: ${key}`);
	assert.equal(provenance.product, "Hipi Work");
	assert.equal(provenance.schemaVersion, 1);
	const actual = await collectArtifacts(directory, identity);
	assert.deepEqual(provenance.artifacts, actual, "Artifact manifest differs from actual bytes");
	assert.equal(metadata.SHA256SUMS, checksumsText(actual), "Checksum list mismatch");
	if (identity.channel === "production-candidate") {
		assert.deepEqual(
			(await readdir(directory)).sort(),
			[...actual.map((item) => item.file), "SHA256SUMS", "release-provenance.json"].sort(),
			"Unexpected file in production distribution",
		);
		assert.equal(provenance.productionVerification?.scope, "artifact-bytes-and-native-signatures");
		assert.deepEqual(provenance.productionVerification.artifacts, actual, "Verification is bound to other artifacts");
		for (const gate of ["installation", "gui", "updateRecovery"])
			assert.equal(provenance.validation?.[gate], "not_run", "Packaging cannot approve product acceptance");
	}
	return actual;
}
