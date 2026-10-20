import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rename, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import builder from "../packaging/electron-builder.cjs";
import appImage from "../packaging/verify-appimage.cjs";
import {
	assertProductionVersion,
	prepareProductionStage,
	productionBuilderConfig,
	productionEnvironment,
	productionPolicy,
} from "./production-policy.mjs";
import { inventory, sha256, sourceSnapshot } from "./release-policy.mjs";

const mac = {
	HIPI_MAC_IDENTITY: "Example Company (ABCDEFGHIJ)",
	HIPI_MAC_TEAM_ID: "ABCDEFGHIJ",
	HIPI_MAC_KEYCHAIN: "/fixture/keychain",
	APPLE_KEYCHAIN_PROFILE: "already-provisioned-profile",
};
const windows = { HIPI_WIN_CERT_SHA1: "A".repeat(40), HIPI_WIN_PUBLISHER: "Example Company" };

test("production signing policy fails closed without one explicit complete native configuration", () => {
	for (const key of Object.keys(mac)) {
		const incomplete = { ...mac };
		delete incomplete[key];
		assert.throws(() => productionPolicy("darwin", "arm64", incomplete), /Required setting/);
	}
	for (const key of Object.keys(windows)) {
		const incomplete = { ...windows };
		delete incomplete[key];
		assert.throws(() => productionPolicy("win32", "x64", incomplete), /Required setting/);
	}
	assert.throws(() => productionPolicy("darwin", "x64", { ...mac, HIPI_MAC_IDENTITY: "-" }));
	assert.throws(() => productionPolicy("darwin", "x64", { ...mac, HIPI_MAC_TEAM_ID: "ZZZZZZZZZZ" }));
	assert.throws(() => productionPolicy("darwin", "x64", { ...mac, HIPI_MAC_KEYCHAIN: "relative" }));
	assert.throws(() => productionPolicy("win32", "x64", { ...windows, HIPI_WIN_CERT_SHA1: "unknown" }));
	for (const target of [
		["win32", "arm64"],
		["linux", "arm64"],
		["darwin", "universal"],
		["other", "x64"],
	])
		assert.throws(() => productionPolicy(...target, {}), /Unreviewed/);
	assert.deepEqual(productionPolicy("linux", "x64", {}), { platform: "linux", architecture: "x64" });
	for (const key of [
		"CSC_LINK",
		"WIN_CSC_LINK",
		"APPLE_ID",
		"APPLE_API_KEY",
		"AZURE_CLIENT_SECRET",
		"NODE_OPTIONS",
		"NODE_PATH",
		"DEBUG",
	])
		assert.throws(
			() => productionPolicy("darwin", "x64", { ...mac, [key]: "must-not-be-used-or-printed" }),
			/Unsupported/,
		);
});

test("production child environment forwards only chosen local signing selectors, never ambient secrets", () => {
	const environment = {
		...mac,
		PATH: "/tools",
		HOME: "/home",
		GH_TOKEN: "secret",
		GITHUB_TOKEN: "secret",
		AWS_SECRET_ACCESS_KEY: "secret",
		PRIVATE_TOKEN: "secret",
		ELECTRON_RUN_AS_NODE: "1",
	};
	const result = productionEnvironment(environment, productionPolicy("darwin", "arm64", environment));
	assert.equal(result.PATH, "/tools");
	assert.equal(result.APPLE_KEYCHAIN_PROFILE, mac.APPLE_KEYCHAIN_PROFILE);
	assert.equal(result.CSC_KEYCHAIN, mac.HIPI_MAC_KEYCHAIN);
	assert.equal(result.CSC_IDENTITY_AUTO_DISCOVERY, "false");
	assert.ok(!JSON.stringify(result).includes("secret"));
	assert.equal(result.ELECTRON_RUN_AS_NODE, undefined);
});

test("production configuration preserves unsigned defaults and cannot enable publishing", () => {
	assert.equal(builder.mac.identity, null);
	assert.equal(builder.mac.notarize, false);
	assert.equal(builder.win.signExecutable, false);
	for (const [platform, architecture, environment] of [
		["darwin", "arm64", mac],
		["win32", "x64", windows],
		["linux", "x64", {}],
	]) {
		const result = productionBuilderConfig(
			builder,
			productionPolicy(platform, architecture, environment),
			"/reviewed/entitlements.plist",
		);
		assert.equal(result.publish, null);
		assert.equal(result.forceCodeSigning, platform !== "linux");
		assert.equal(result.mac.notarize, platform === "darwin");
		assert.equal(result.win.signExecutable, true);
		assert.ok(result.directories.app.endsWith(join("hipi-work", "production", "app")));
		assert.ok(result.directories.output.endsWith(join("hipi-work", "production", "packages")));
		assert.equal(result.appId, builder.appId);
		assert.equal(result.productName, builder.productName);
		assert.equal(result.mac.entitlements, "/reviewed/entitlements.plist");
		assert.equal(result.mac.hardenedRuntime, true);
	}
	assert.equal(builder.mac.identity, null);
	assert.equal(builder.win.signExecutable, false);
});

test("desktop version authority ignores root Pi version and requires a real dated desktop section", () => {
	const manifest = { version: "1.0.0" };
	const lock = { version: "0.0.3", packages: { "apps/hipi-work-desktop": { version: "1.0.0" } } };
	const notes =
		"# Desktop changelog\n\n## [Unreleased]\n\n## [1.0.0] - 2026-10-20\n\n### Added\n\n- Initial desktop release.\n";
	assertProductionVersion(manifest, lock, notes);
	for (const version of ["0.0.1", "1.0.0-rc.1", "1.0.0+build", "01.0.0"])
		assert.throws(() => assertProductionVersion({ version }, lock, notes));
	assert.throws(() => assertProductionVersion(manifest, { packages: {} }, notes), /lock version/);
	for (const text of ["", "## [1.0.0]\n- Notes", "## [1.0.0] - 2026-10-20\n\n## [0.1.0] - 2026-10-19\n- Other release"])
		assert.throws(() => assertProductionVersion(manifest, lock, text), /changelog/);
});

test("AppImage production metadata cannot be mistaken for unsigned staging", () => {
	const staging = appImage.expectedDesktop("1.0.0");
	const production = appImage.expectedDesktop("1.0.0", "production-candidate");
	assert.match(staging, /unsigned staging build/);
	assert.match(production, /production candidate/);
	assert.ok(!production.includes("unsigned"));
	assert.throws(() => appImage.expectedDesktop("1.0.0", "arbitrary"));
});

async function stagingFixture() {
	const root = await mkdtemp(join(tmpdir(), "hipi-production-policy-"));
	const files = [
		"package.json",
		"package-lock.json",
		"nix/model-catalog.json",
		"tsconfig.base.json",
		"tsconfig.json",
		"apps/hipi-work-ui/index.html",
		"apps/hipi-work-ui/THIRD_PARTY_NOTICES.md",
		"LICENSE",
		"apps/hipi-work-desktop/package.json",
		"apps/hipi-work-desktop/packaging/config.cjs",
		"apps/hipi-work-desktop/branding/icon.png",
		"apps/hipi-work-desktop/scripts/release.mjs",
		"apps/hipi-work-ui/vendor/license",
		"packages/runtime/src/runtime.ts",
	];
	for (const file of files) {
		await mkdir(dirname(join(root, file)), { recursive: true });
		await writeFile(join(root, file), file);
	}
	const stage = join(root, ".artifacts/hipi-work/app");
	await mkdir(stage, { recursive: true });
	await writeFile(
		join(stage, "package.json"),
		JSON.stringify({ name: "hipi-work", version: "1.0.0", main: "dist/main.mjs", description: "unsigned" }),
	);
	await writeFile(join(stage, "LICENSE"), "fixture license");
	const snapshot = await sourceSnapshot(root);
	const provenance = {
		schemaVersion: 1,
		product: "Hipi Work",
		version: "1.0.0",
		platform: "linux",
		architecture: "x64",
		channel: "unsigned-local-staging",
		licenseReviewRequired: [],
		sourceSnapshot: snapshot,
		sourceSnapshotSha256: sha256(JSON.stringify(snapshot)),
		payload: await inventory(stage),
	};
	await writeFile(join(stage, "build-provenance.json"), JSON.stringify(provenance));
	return { root, stage };
}

test("candidate preparation preserves unsigned staging, verifies its copy and refuses an existing candidate", async () => {
	const { root, stage } = await stagingFixture();
	try {
		const before = await inventory(stage);
		const candidate = await prepareProductionStage(
			root,
			{ version: "1.0.0" },
			{ platform: "linux", architecture: "x64" },
		);
		assert.deepEqual(await inventory(stage), before);
		assert.equal(candidate.channel, "production-candidate");
		assert.equal(candidate.validation.signing, "not_run");
		assert.equal(candidate.validation.updateRecovery, "not_run");
		const output = join(root, ".artifacts/hipi-work/production/app");
		assert.deepEqual(
			(await inventory(output)).filter((item) => item.file !== "build-provenance.json"),
			candidate.payload,
		);
		assert.match(await readFile(join(output, "package.json"), "utf8"), /production candidate/);
		await assert.rejects(
			prepareProductionStage(root, { version: "1.0.0" }, { platform: "linux", architecture: "x64" }),
			{ code: "EEXIST" },
		);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("candidate preparation rejects staging tampering before creating production output", async () => {
	const { root, stage } = await stagingFixture();
	try {
		await writeFile(join(stage, "LICENSE"), "changed");
		await assert.rejects(
			prepareProductionStage(root, { version: "1.0.0" }, { platform: "linux", architecture: "x64" }),
			/payload drift/,
		);
		await assert.rejects(readFile(join(root, ".artifacts/hipi-work/production/app/package.json")), { code: "ENOENT" });
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("candidate rejects redirected artifact ancestors and leaves unsigned bytes untouched", async () => {
	for (const component of [
		".artifacts",
		".artifacts/hipi-work",
		".artifacts/hipi-work/app",
		".artifacts/hipi-work/production",
	]) {
		const { root, stage } = await stagingFixture();
		const redirected = join(root, "redirected");
		try {
			const before = await inventory(stage);
			const path = join(root, component);
			if (component.endsWith("/production")) await mkdir(redirected);
			else await rename(path, redirected);
			await symlink(redirected, path, process.platform === "win32" ? "junction" : "dir");
			await assert.rejects(
				prepareProductionStage(root, { version: "1.0.0" }, { platform: "linux", architecture: "x64" }),
			);
			assert.deepEqual(await inventory(stage), before, component);
			if (component.endsWith("/production"))
				await assert.rejects(readFile(join(redirected, "app/package.json")), { code: "ENOENT" });
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	}
});

test("canonical checkout aliases remain valid without allowing links inside staging", async () => {
	const { root, stage } = await stagingFixture();
	const alias = `${root}-alias`;
	try {
		const before = await inventory(stage);
		await symlink(root, alias, process.platform === "win32" ? "junction" : "dir");
		await prepareProductionStage(alias, { version: "1.0.0" }, { platform: "linux", architecture: "x64" });
		assert.deepEqual(await inventory(stage), before);
	} finally {
		await rm(alias, { force: true });
		await rm(root, { recursive: true, force: true });
	}
});
