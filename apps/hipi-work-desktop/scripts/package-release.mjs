import { spawnSync } from "node:child_process";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import sevenZip from "app-builder-lib/out/toolsets/7zip.js";
import appImageVerification from "../packaging/verify-appimage.cjs";
import { assertPackagingInputs, sha256 } from "./release-policy.mjs";

// Reject reader substitution before any packager, output or staging work occurs.
appImageVerification.assertToolEnvironment(process.env);
const desktop = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const root = resolve(desktop, "../..");
const args = process.argv.slice(2);
if (args.some((arg) => !["--dir", "--x64", "--arm64"].includes(arg))) {
	throw new Error("Only --dir and --x64/--arm64 are accepted. Publishing and cross-OS builds are disabled.");
}
if (args.includes("--x64") && args.includes("--arm64")) throw new Error("Select one architecture per staging run");
const platform = { darwin: "--mac", win32: "--win", linux: "--linux" }[process.platform];
if (!platform) throw new Error("Unsupported packaging host");
const provenancePath = join(root, ".artifacts/hipi-work/app/build-provenance.json");
const provenanceBytes = await readFile(provenancePath);
const provenance = JSON.parse(provenanceBytes.toString("utf8"));
if (provenance.licenseReviewRequired?.length)
	throw new Error("Bundled license review is incomplete; packaging is blocked");
await assertPackagingInputs(root, provenance.sourceSnapshot);
const output = join(root, ".artifacts/hipi-work/packages");
await mkdir(output, { recursive: true });
if ((await readdir(output)).length)
	throw new Error("Package output is not empty; move the previous staging result before packaging again");
// No certificate discovery, publishing tokens, or signing environment forwarded to the packager.
const env = Object.fromEntries(
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
		join(desktop, "packaging/electron-builder.cjs"),
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
if (!(await readFile(provenancePath)).equals(provenanceBytes))
	throw new Error("Staging changed during packaging; discard this mixed build and retry");
await assertPackagingInputs(root, provenance.sourceSnapshot);
const artifacts = [];
for (const item of await readdir(output, { withFileTypes: true })) {
	if (!item.isFile() || !/\.(?:dmg|zip|exe|AppImage|tar\.gz)$/.test(item.name)) continue;
	if (item.name.endsWith(".AppImage")) {
		process.env.ELECTRON_BUILDER_CACHE = env.ELECTRON_BUILDER_CACHE;
		const stagedManifest = JSON.parse(await readFile(join(root, ".artifacts/hipi-work/app/package.json"), "utf8"));
		appImageVerification.verifyAppImage(join(output, item.name), stagedManifest.version, await sevenZip.getPath7za());
	}
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
await writeFile(join(output, "SHA256SUMS"), artifacts.map((item) => `${item.sha256}  ${item.file}\n`).join(""));
await writeFile(
	join(output, "release-provenance.json"),
	JSON.stringify(
		{ ...provenance, artifacts, packageValidation: "ASAR allowlist and hashes passed; no install or GUI claim" },
		null,
		2,
	),
);
console.log(
	"Unsigned local staging finished. Signing, installation, GUI and update/recovery acceptance remain pending.",
);
