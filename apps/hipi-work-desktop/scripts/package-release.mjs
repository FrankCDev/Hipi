import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cp, mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import sevenZip from "app-builder-lib/out/toolsets/7zip.js";
import maintenance from "../packaging/linux-maintenance.cjs";
import appImageVerification from "../packaging/verify-appimage.cjs";
import linuxArtifacts from "../packaging/verify-linux-artifacts.cjs";
import verifyPack from "../packaging/verify-pack.cjs";
import {
	assertProductionDirectory,
	assertProductionVersion,
	prepareProductionStage,
	productionEnvironment,
	productionPolicy,
} from "./production-policy.mjs";
import { checksumsText, collectArtifacts, verifyReleaseArtifacts } from "./release-artifacts.mjs";
import { assertPackagingInputs, assertSourceSnapshot, sha256 } from "./release-policy.mjs";
import { verifyNativeArtifacts } from "./verify-native-release.mjs";

export async function packageRelease({ production = false, args = process.argv.slice(2) } = {}) {
	// Reject reader substitution before any packager, output or staging work occurs.
	appImageVerification.assertToolEnvironment(process.env);
	const desktop = resolve(dirname(fileURLToPath(import.meta.url)), "..");
	const root = resolve(desktop, "../..");
	if (args.some((arg) => !["--dir", "--x64", "--arm64"].includes(arg))) {
		throw new Error("Only --dir and --x64/--arm64 are accepted. Publishing and cross-OS builds are disabled.");
	}
	if (args.includes("--x64") && args.includes("--arm64")) throw new Error("Select one architecture per staging run");
	const platform = { darwin: "--mac", win32: "--win", linux: "--linux" }[process.platform];
	if (!platform) throw new Error("Unsupported packaging host");
	const architecture = args.includes("--arm64") ? "arm64" : args.includes("--x64") ? "x64" : process.arch;
	let policy;
	if (production) {
		if (args.includes("--dir") || new Set(args).size !== args.length || architecture !== process.arch)
			throw new Error("Production requires one native architecture and complete distributables");
		// Resolve explicit signing/notarization prerequisites before output creation
		// or invoking electron-builder. Never let builder's warning-only skip pass.
		policy = productionPolicy(process.platform, architecture, process.env);
		const manifest = JSON.parse(await readFile(join(desktop, "package.json"), "utf8"));
		const lock = JSON.parse(await readFile(join(root, "package-lock.json"), "utf8"));
		const changelog = await readFile(join(desktop, "CHANGELOG.md"), "utf8").catch((error) => {
			if (error.code === "ENOENT") return "";
			throw error;
		});
		assertProductionVersion(manifest, lock, changelog);
		policy.version = manifest.version;
		policy.releaseNotesSha256 = sha256(changelog);
		await prepareProductionStage(root, manifest, policy);
	}
	if (process.platform === "linux") maintenance.assertRuntimeTarget(process.platform, architecture);
	const base = join(root, ".artifacts/hipi-work", ...(production ? ["production"] : []));
	const provenancePath = join(base, "app/build-provenance.json");
	const provenanceBytes = await readFile(provenancePath);
	const provenance = JSON.parse(provenanceBytes.toString("utf8"));
	if (provenance.licenseReviewRequired?.length)
		throw new Error("Bundled license review is incomplete; packaging is blocked");
	await assertPackagingInputs(root, provenance.sourceSnapshot);
	if (process.platform === "linux") {
		const runtime = await maintenance.verifyMaintenanceRuntime(join(root, ".artifacts/hipi-work/maintenance-runtime"));
		if (JSON.stringify(runtime) !== JSON.stringify(provenance.linuxMaintenanceRuntime))
			throw new Error("Maintenance runtime changed since staging");
	}
	const output = join(base, "packages");
	await mkdir(output, { recursive: true });
	if (production) await assertProductionDirectory(root, ["production", "packages"]);
	if ((await readdir(output)).length)
		throw new Error("Package output is not empty; move the previous staging result before packaging again");
	// Staging forwards no signing settings. Production forwards only its explicit
	// already-provisioned native identity/profile; neither forwards publishing tokens.
	const env = production
		? productionEnvironment(process.env, policy)
		: Object.fromEntries(
				Object.entries(process.env).filter(
					([key]) => !/^(?:CSC_|WIN_CSC_|APPLE_|GH_TOKEN$|GITHUB_TOKEN$|AWS_|AZURE_)/.test(key),
				),
			);
	env.CSC_IDENTITY_AUTO_DISCOVERY = "false";
	env.ELECTRON_CACHE = join(root, ".artifacts/hipi-work/cache/electron");
	env.ELECTRON_BUILDER_CACHE = join(root, ".artifacts/hipi-work/cache/builder");
	env.ELECTRON_BUILDER_ALLOW_UNRESOLVED_DEPENDENCIES = "false";
	const result = spawnSync(
		process.execPath,
		[
			join(root, "node_modules/electron-builder/cli.js"),
			"--config",
			join(desktop, production ? "packaging/electron-builder-production.cjs" : "packaging/electron-builder.cjs"),
			platform,
			...args,
			"--publish",
			"never",
		],
		{
			cwd: root,
			stdio: "inherit",
			env,
		},
	);
	if (result.error) throw result.error;
	if (result.status !== 0) process.exit(result.status ?? 1);
	const identity = {
		version: provenance.version,
		platform: process.platform,
		architecture,
		channel: "production-candidate",
	};
	// Capture final distributable bytes before any content/native inspection.
	// Linux must get the same before/after binding as the signed platforms.
	const exact = production ? await collectArtifacts(output, identity) : undefined;
	let productionPackContext;
	if (production) {
		await assertProductionDirectory(root, ["production", "app"]);
		await assertProductionDirectory(root, ["production", "packages"]);
		const unpacked =
			process.platform === "linux"
				? "linux-unpacked"
				: process.platform === "darwin"
					? `mac${architecture === "x64" ? "" : `-${architecture}`}`
					: "win-unpacked";
		await assertProductionDirectory(root, ["production", "packages", unpacked]);
		productionPackContext = { appOutDir: join(output, unpacked), electronPlatformName: process.platform };
		await verifyPack(productionPackContext, provenanceBytes);
	}
	// afterPack runs BEFORE electron-builder 26.15.3 flips fuses. Assert the final
	// binary here instead of accepting the default fuse wire in that earlier hook.
	let linuxHardening;
	let linuxCriticalFiles;
	if (process.platform === "linux") {
		const directory = join(output, "linux-unpacked");
		linuxHardening = {
			fuses: await maintenance.verifyLinuxFuses(join(directory, "hipi-work")),
			maintenance: await maintenance.verifyLinuxMaintenancePackage(directory),
		};
		linuxCriticalFiles = await linuxArtifacts.linuxCriticalFiles(directory);
		linuxHardening.criticalFiles = linuxCriticalFiles;
	}
	if (!(await readFile(provenancePath)).equals(provenanceBytes))
		throw new Error("Staging changed during packaging; discard this mixed build and retry");
	await assertPackagingInputs(root, provenance.sourceSnapshot);
	const artifacts = [];
	for (const item of await readdir(output, { withFileTypes: true })) {
		if (!item.isFile() || !/\.(?:dmg|zip|exe|AppImage|tar\.gz)$/.test(item.name)) continue;
		if (item.name.endsWith(".AppImage")) {
			process.env.ELECTRON_BUILDER_CACHE = env.ELECTRON_BUILDER_CACHE;
			const stagedManifest = JSON.parse(await readFile(join(base, "app/package.json"), "utf8"));
			appImageVerification.verifyAppImage(
				join(output, item.name),
				stagedManifest.version,
				await sevenZip.getPath7za(),
				linuxCriticalFiles,
				production ? "production-candidate" : "unsigned-local-staging",
			);
		}
		if (process.platform === "linux" && item.name.endsWith(".tar.gz"))
			linuxArtifacts.verifyLinuxTar(
				join(output, item.name),
				linuxCriticalFiles,
				production ? provenance.version : undefined,
			);
		const bytes = await readFile(join(output, item.name));
		artifacts.push({ file: item.name, bytes: bytes.length, sha256: sha256(bytes) });
	}
	if (!args.includes("--dir")) {
		const extensions = { darwin: [".dmg", ".zip"], win32: [".exe", ".zip"], linux: [".AppImage", ".tar.gz"] }[
			process.platform
		];
		for (const extension of extensions) {
			if (!artifacts.some((item) => item.file.endsWith(extension)))
				throw new Error(`Missing expected artifact: ${extension}`);
		}
	}
	if (production) {
		const native =
			process.platform === "linux"
				? { signing: "not_applicable", notarization: "not_applicable", linuxHardening: "verified" }
				: await verifyNativeArtifacts(output, exact, policy);
		await verifyPack(productionPackContext, provenanceBytes);
		assert.deepEqual(
			await collectArtifacts(output, identity),
			exact,
			"Artifacts changed during final content verification",
		);
		await assertSourceSnapshot(root, provenance.sourceSnapshot);
		assert.equal(
			sha256(await readFile(join(desktop, "CHANGELOG.md"))),
			provenance.releaseNotesSha256,
			"Desktop release notes changed during packaging",
		);
		if (!(await readFile(provenancePath)).equals(provenanceBytes))
			throw new Error("Candidate staging changed during final verification");
		const distribution = join(base, "distribution");
		await mkdir(distribution);
		await assertProductionDirectory(root, ["production", "distribution"]);
		for (const item of exact)
			await cp(join(output, item.file), join(distribution, item.file), { force: false, errorOnExist: true });
		assert.deepEqual(
			await collectArtifacts(distribution, identity),
			exact,
			"Distribution copy differs from verified artifacts",
		);
		await writeFile(join(distribution, "SHA256SUMS"), checksumsText(exact), { flag: "wx" });
		await writeFile(
			join(distribution, "release-provenance.json"),
			JSON.stringify(
				{
					...provenance,
					...(linuxHardening ? { linuxHardening } : {}),
					artifacts: exact,
					productionVerification: { scope: "artifact-bytes-and-native-signatures", artifacts: exact, native },
					validation: {
						...provenance.validation,
						signing: native.signing,
						notarization: native.notarization ?? "not_applicable",
					},
					packageValidation:
						"Production candidate artifact verification only; installation, GUI and upgrade/recovery not run",
				},
				null,
				2,
			),
			{ flag: "wx" },
		);
		await verifyReleaseArtifacts(distribution, identity);
		console.log("Production candidate verified locally. No publication or product acceptance performed.");
		return;
	}
	await writeFile(join(output, "SHA256SUMS"), artifacts.map((item) => `${item.sha256}  ${item.file}\n`).join(""));
	await writeFile(
		join(output, "release-provenance.json"),
		JSON.stringify(
			{
				...provenance,
				...(linuxHardening ? { linuxHardening } : {}),
				artifacts,
				packageValidation: "ASAR allowlist and hashes passed; no install or GUI claim",
			},
			null,
			2,
		),
	);
	console.log(
		"Unsigned local staging finished. Signing, installation, GUI and update/recovery acceptance remain pending.",
	);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await packageRelease();
