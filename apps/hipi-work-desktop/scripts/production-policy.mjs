import assert from "node:assert/strict";
import { constants } from "node:fs";
import { cp, lstat, mkdir, open, readdir, readFile, realpath } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { assertSourceSnapshot, inventory, sha256 } from "./release-policy.mjs";

export function productionPolicy(platform, architecture, environment) {
	assert.ok(
		["darwin-x64", "darwin-arm64", "win32-x64", "linux-x64"].includes(`${platform}-${architecture}`),
		"Unreviewed production target",
	);
	for (const key of Object.keys(environment)) {
		if (
			/^(?:CSC_LINK|CSC_KEY_PASSWORD|CSC_NAME|CSC_FOR_PULL_REQUEST|WIN_CSC_|APPLE_ID|APPLE_APP_SPECIFIC_PASSWORD|APPLE_API_|AZURE_|NODE_OPTIONS|NODE_PATH|DEBUG$)/i.test(
				key,
			)
		)
			throw new Error(`Unsupported production signing or execution override: ${key}`);
	}
	const value = (key) => {
		const result = environment[key];
		assert.ok(typeof result === "string" && result.trim() === result && result.length > 0, `Required setting: ${key}`);
		// biome-ignore lint/suspicious/noControlCharactersInRegex: reject control characters at the process boundary.
		assert.ok(!/[\x00-\x1f\x7f]/.test(result), `Invalid setting: ${key}`);
		return result;
	};
	if (platform === "darwin") {
		const identity = value("HIPI_MAC_IDENTITY");
		const teamId = value("HIPI_MAC_TEAM_ID");
		assert.match(teamId, /^[A-Z0-9]{10}$/, "Invalid Apple Team ID");
		assert.ok(
			identity.endsWith(` (${teamId})`) && !identity.startsWith("Developer ID") && identity !== "-",
			"Explicit Developer ID qualifier with the expected team is required",
		);
		const keychain = value("HIPI_MAC_KEYCHAIN");
		assert.ok(isAbsolute(keychain), "An explicit absolute signing keychain is required");
		// Builder 26.15.3 otherwise warns and skips notarization. We support one
		// already-provisioned route only; this code never creates/imports secrets.
		return { platform, architecture, identity, teamId, keychain, notarizationProfile: value("APPLE_KEYCHAIN_PROFILE") };
	}
	if (platform === "win32") {
		const certificateSha1 = value("HIPI_WIN_CERT_SHA1").toUpperCase();
		assert.match(certificateSha1, /^[A-F0-9]{40}$/, "Explicit Windows certificate thumbprint is required");
		return { platform, architecture, certificateSha1, publisher: value("HIPI_WIN_PUBLISHER") };
	}
	return { platform, architecture };
}

export function productionEnvironment(environment, policy) {
	const allowed =
		/^(?:PATH|SYSTEMROOT|WINDIR|COMSPEC|PATHEXT|HOME|USERPROFILE|HOMEDRIVE|HOMEPATH|LOCALAPPDATA|APPDATA|PROGRAMDATA|PROGRAMFILES(?:\(X86\))?|TMP|TEMP|TMPDIR|LANG|LC_ALL)$/i;
	const result = Object.fromEntries(Object.entries(environment).filter(([key]) => allowed.test(key)));
	result.CSC_IDENTITY_AUTO_DISCOVERY = "false";
	if (policy.platform === "darwin") {
		Object.assign(result, {
			HIPI_MAC_IDENTITY: policy.identity,
			HIPI_MAC_TEAM_ID: policy.teamId,
			HIPI_MAC_KEYCHAIN: policy.keychain,
			CSC_KEYCHAIN: policy.keychain,
			APPLE_KEYCHAIN: policy.keychain,
			APPLE_KEYCHAIN_PROFILE: policy.notarizationProfile,
		});
	} else if (policy.platform === "win32") {
		result.HIPI_WIN_CERT_SHA1 = policy.certificateSha1;
		result.HIPI_WIN_PUBLISHER = policy.publisher;
	}
	return result;
}

export function productionBuilderConfig(base, policy, entitlements) {
	return {
		...base,
		directories: {
			app: join(base.directories.app, "../production/app"),
			output: join(base.directories.output, "../production/packages"),
		},
		// biome-ignore lint/suspicious/noTemplateCurlyInString: electron-builder macros.
		artifactName: "Hipi-Work-${version}-${os}-${arch}.${ext}",
		publish: null,
		forceCodeSigning: policy.platform !== "linux",
		mac: {
			...base.mac,
			identity: policy.platform === "darwin" ? policy.identity : null,
			type: "distribution",
			notarize: policy.platform === "darwin",
			hardenedRuntime: true,
			strictVerify: true,
			entitlements,
			entitlementsInherit: entitlements,
		},
		win: {
			...base.win,
			signExecutable: true,
			signAndEditExecutable: true,
			signtoolOptions: {
				certificateSha1: policy.certificateSha1,
				publisherName: policy.publisher,
				signingHashAlgorithms: ["sha256"],
			},
		},
	};
}

export function assertProductionVersion(manifest, lock, changelog) {
	assert.match(
		manifest.version,
		/^[1-9]\d*\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/,
		"Production requires a stable desktop version >= 1.0.0",
	);
	assert.equal(lock.packages?.["apps/hipi-work-desktop"]?.version, manifest.version, "Desktop lock version mismatch");
	const escaped = manifest.version.replaceAll(".", "\\.");
	const section = new RegExp(
		`^## \\[${escaped}\\] - \\d{4}-\\d{2}-\\d{2}\\r?\\n([\\s\\S]*?)(?=^## |$(?![\\s\\S]))`,
		"m",
	).exec(changelog);
	assert.ok(section?.[1].trim(), "A nonempty dated desktop changelog section is required");
}

// Canonicalize the checkout boundary once, allowing OS aliases such as macOS
// /tmp -> /private/tmp, but never redirects inside the owned artifact tree.
export async function assertProductionDirectory(root, components) {
	let directory = await realpath(root);
	for (const component of [".artifacts", "hipi-work", ...components]) {
		assert.ok(component && !component.includes("/") && !component.includes("\\") && component !== "..");
		directory = join(directory, component);
		assert.ok((await lstat(directory)).isDirectory(), "Production path must be a real directory");
		assert.equal(await realpath(directory), directory, "Production directory redirect forbidden");
	}
	return directory;
}

export async function prepareProductionStage(root, manifest, policy) {
	root = await realpath(root);
	const source = await assertProductionDirectory(root, ["app"]);
	const provenanceBytes = await readFile(join(source, "build-provenance.json"));
	const provenance = JSON.parse(provenanceBytes.toString("utf8"));
	assert.equal(provenance.schemaVersion, 1);
	assert.equal(provenance.product, "Hipi Work");
	assert.equal(provenance.channel, "unsigned-local-staging");
	assert.equal(provenance.version, manifest.version);
	assert.equal(provenance.platform, policy.platform);
	assert.equal(provenance.architecture, policy.architecture);
	assert.deepEqual(provenance.licenseReviewRequired, []);
	assert.equal(provenance.sourceSnapshotSha256, sha256(JSON.stringify(provenance.sourceSnapshot)));
	await assertSourceSnapshot(root, provenance.sourceSnapshot);
	const original = await inventory(source);
	assert.deepEqual(
		original.filter((item) => item.file !== "build-provenance.json"),
		provenance.payload,
		"Staged payload drift",
	);
	const stagedManifest = JSON.parse(await readFile(join(source, "package.json"), "utf8"));
	assert.equal(stagedManifest.version, manifest.version);
	assert.equal(stagedManifest.name, "hipi-work");
	assert.equal(stagedManifest.main, "dist/main.mjs");
	const production = join(root, ".artifacts/hipi-work/production");
	// Allocate exclusively. A failed candidate is retained, never overwritten.
	await mkdir(production);
	const destination = join(production, "app");
	await mkdir(destination);
	try {
		await assertProductionDirectory(root, ["app"]);
		await assertProductionDirectory(root, ["production", "app"]);
		for (const entry of await readdir(source))
			await cp(join(source, entry), join(destination, entry), {
				recursive: true,
				errorOnExist: true,
				force: false,
				filter: async (file) => {
					const info = await lstat(file);
					assert.ok(info.isDirectory() || (info.isFile() && info.nlink === 1), "Linked release input forbidden");
					return true;
				},
			});
		assert.deepEqual(await inventory(destination), original, "Candidate copy differs from verified staging");
		const replaceMetadata = async (file, value) => {
			await assertProductionDirectory(root, ["production", "app"]);
			const handle = await open(join(destination, file), constants.O_RDWR | constants.O_NOFOLLOW);
			try {
				const info = await handle.stat();
				assert.ok(info.isFile() && info.nlink === 1, "Candidate metadata must be an independent regular file");
				const sourceInfo = await lstat(join(source, file));
				assert.ok(info.dev !== sourceInfo.dev || info.ino !== sourceInfo.ino, "Candidate metadata aliases staging");
				await handle.truncate(0);
				await handle.writeFile(JSON.stringify(value, null, 2));
			} finally {
				await handle.close();
			}
		};
		await replaceMetadata("package.json", { ...stagedManifest, description: "Hipi Work desktop production candidate" });
		const payload = (await inventory(destination)).filter((item) => item.file !== "build-provenance.json");
		const candidate = {
			...provenance,
			channel: "production-candidate",
			stagingProvenanceSha256: sha256(provenanceBytes),
			releaseNotesSha256: policy.releaseNotesSha256,
			validation: {
				signing: "not_run",
				notarization: "not_run",
				installation: "not_run",
				gui: "not_run",
				updateRecovery: "not_run",
			},
			payload,
		};
		await replaceMetadata("build-provenance.json", candidate);
		return candidate;
	} finally {
		await assertProductionDirectory(root, ["app"]);
		assert.deepEqual(await inventory(source), original, "Staging changed during candidate preparation");
	}
}
