import { cp, mkdir, readdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import maintenance from "../packaging/linux-maintenance.cjs";
import { assertFontAsset, fontAssets } from "./font-assets.mjs";
import {
	allowedPayload,
	assertBrandIcon,
	assertPublicText,
	filesUnder,
	inventory,
	requiredFiles,
	requireFiles,
	sha256,
} from "./release-policy.mjs";

const desktop = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const root = resolve(desktop, "../..");
const stage = resolve(root, ".artifacts/hipi-work/app");
const manifest = JSON.parse(await readFile(join(desktop, "package.json"), "utf8"));
const lock = JSON.parse(await readFile(join(root, "package-lock.json"), "utf8"));
let linuxMaintenance;
if (process.platform === "linux") {
	maintenance.assertRuntimeTarget(process.platform, process.arch);
	linuxMaintenance = await maintenance.verifyMaintenanceRuntime(join(root, ".artifacts/hipi-work/maintenance-runtime"));
}
const sourceSnapshot = JSON.parse(await readFile(join(root, ".artifacts/hipi-work/source-snapshot.json"), "utf8"));
for (const file of [
	"package-lock.json",
	"apps/hipi-work-desktop/package.json",
	"apps/hipi-work-desktop/branding/png/256x256.png",
	"apps/hipi-work-desktop/branding/asset-inventory.json",
]) {
	if (
		sourceSnapshot.sourceSnapshot.find((item) => item.file === file)?.sha256 !==
		sha256(await readFile(join(root, file)))
	) {
		throw new Error("Release dependency/version metadata changed after build; rebuild first");
	}
}
if (JSON.stringify(sourceSnapshot.bundles) !== JSON.stringify(await inventory(join(desktop, "dist")))) {
	throw new Error("Build output differs from the recorded source snapshot; run build-release.mjs again");
}
await requireFiles(desktop, requiredFiles);
const payload = (await filesUnder(join(desktop, "dist"))).map((file) => `dist/${file}`);
for (const file of payload) {
	// Build diagnostics are intentionally never shipped. Everything else must be reviewed.
	if (file.endsWith(".map") || file.endsWith(".meta.json")) continue;
	if (file === "dist/third-party/pdfjs/README.md") continue;
	if (!allowedPayload(file)) throw new Error(`Unexpected build payload: ${file}`);
	if (fontAssets.some((asset) => asset.payload === file)) assertFontAsset(file, await readFile(join(desktop, file)));
	else if (file === "dist/branding/icon.png") assertBrandIcon(await readFile(join(desktop, file)));
	else assertPublicText(await readFile(join(desktop, file), "utf8"), root);
}
await rm(stage, { recursive: true, force: true });
await mkdir(stage, { recursive: true });
for (const file of payload.filter(allowedPayload)) {
	await mkdir(dirname(join(stage, file)), { recursive: true });
	await cp(join(desktop, file), join(stage, file));
}
await cp(join(root, "LICENSE"), join(stage, "LICENSE"));
await writeFile(
	join(stage, "package.json"),
	JSON.stringify(
		{
			name: "hipi-work",
			productName: "Hipi Work",
			desktopName: "hipi-work.desktop",
			version: manifest.version,
			description: "Hipi Work desktop unsigned staging build",
			author: "Hipi Work contributors",
			license: "MIT",
			type: "module",
			main: "dist/main.mjs",
			private: true,
		},
		null,
		2,
	),
);

// Resolve package owners only for modules/assets actually retained by the bundlers.
// Build metafiles never enter the shipped application.
const inputs = JSON.parse(await readFile(join(desktop, "dist/bundle-inputs.meta.json"), "utf8")).inputs;
if (!Array.isArray(inputs) || inputs.length === 0) throw new Error("Missing bundle input provenance");
const queue = [];
for (const input of inputs) {
	if (typeof input !== "string" || input.startsWith("/") || input.split("/").includes(".."))
		throw new Error("Invalid bundle input path");
	let cursor = dirname(resolve(root, input));
	let found = false;
	while (cursor.startsWith(root)) {
		try {
			await requireFiles(cursor, ["package.json"]);
			queue.push(cursor);
			found = true;
			break;
		} catch (error) {
			if (error.code !== "ENOENT") throw error;
		}
		const parent = dirname(cursor);
		if (parent === cursor) break;
		cursor = parent;
	}
	if (!found) throw new Error(`Bundle input has no package owner: ${input}`);
}
const seen = new Set();
const dependencies = [];
while (queue.length) {
	const location = await realpath(queue.shift());
	if (seen.has(location)) continue;
	seen.add(location);
	const info = JSON.parse(await readFile(join(location, "package.json"), "utf8"));
	const id = `${info.name.replaceAll("/", "__")}@${info.version}`;
	const publicFiles = (await readdir(location)).filter((file) =>
		/^(?:licen[sc]e|copying|notice)(?:[._-].*)?$/i.test(file),
	);
	const licenseFiles = [];
	const workspaceOwned = !location.replaceAll("\\", "/").includes("/node_modules/");
	if (workspaceOwned && publicFiles.length === 0) licenseFiles.push("LICENSE");
	let licenseSource = workspaceOwned && publicFiles.length === 0 ? "repository-root-license" : "package-distribution";
	if (info.name === "isarray" && info.version === "1.0.0" && publicFiles.length === 0) {
		const readme = await readFile(join(location, "README.md"), "utf8");
		const start = readme.indexOf("## License\n");
		const notice = readme.slice(start + "## License\n".length);
		if (
			start < 0 ||
			!notice.includes("Copyright (c) 2013 Julian Gruber") ||
			!notice.includes("THE SOFTWARE IS PROVIDED")
		)
			throw new Error("isarray license text changed; review required");
		const target = `licenses/${id}/LICENSE-from-README`;
		await mkdir(dirname(join(stage, target)), { recursive: true });
		await writeFile(join(stage, target), notice);
		licenseFiles.push(target);
		licenseSource = "pinned-package-README-License-section";
	}
	if (info.name === "react-remove-scroll-bar" && info.version === "2.3.8" && publicFiles.length === 0) {
		if (info.license !== "MIT") throw new Error("react-remove-scroll-bar license declaration changed");
		const notice = await readFile(join(desktop, "packaging/licenses/react-remove-scroll-bar-2.3.8.LICENSE"));
		if (sha256(notice) !== "a79aae0c0f21990d9d963bb3c5a79cdcea9a46f8523ba55c58d7fe776b6ebc84")
			throw new Error("Supplemental upstream license digest mismatch");
		const target = `licenses/${id}/LICENSE-upstream-supplement`;
		await mkdir(dirname(join(stage, target)), { recursive: true });
		await writeFile(join(stage, target), notice);
		licenseFiles.push(target);
		licenseSource =
			"https://github.com/theKashey/react-remove-scroll-bar/blob/7301c160fda44cb8cf2b9fdfde61efad35736196/LICENSE";
	}
	for (const file of publicFiles) {
		const target = `licenses/${id}/${file}`;
		await requireFiles(location, [file]);
		await mkdir(dirname(join(stage, target)), { recursive: true });
		await cp(join(location, file), join(stage, target));
		licenseFiles.push(target);
	}
	const key = relative(root, location).replaceAll("\\", "/");
	const locked = lock.packages[key];
	dependencies.push({
		name: info.name,
		version: info.version,
		license: info.license ?? (workspaceOwned ? "MIT" : "UNDECLARED"),
		licenseFiles,
		integrity: locked?.integrity ?? null,
		licenseReview: licenseFiles.length ? "included" : "manual-review-required",
		licenseSource,
	});
}
await writeFile(
	join(stage, "dependency-licenses.json"),
	JSON.stringify(
		{
			scope: "retained-bundle-input-package-owners",
			packages: dependencies.sort((a, b) => a.name.localeCompare(b.name)),
		},
		null,
		2,
	),
);
const provenance = {
	schemaVersion: 1,
	product: "Hipi Work",
	version: manifest.version,
	channel: "unsigned-local-staging",
	createdAt: new Date().toISOString(),
	platform: process.platform,
	architecture: process.arch,
	node: process.version,
	electron: manifest.devDependencies.electron,
	electronBuilder: manifest.devDependencies["electron-builder"],
	vite: manifest.devDependencies.vite,
	lockSha256: sha256(await readFile(join(root, "package-lock.json"))),
	modelCatalogPin: JSON.parse(await readFile(join(desktop, "packaging/model-catalog.json"), "utf8")),
	...(linuxMaintenance ? { linuxMaintenanceRuntime: linuxMaintenance } : {}),
	sourceSnapshotSha256: sourceSnapshot.sourceSnapshotSha256,
	sourceSnapshot: sourceSnapshot.sourceSnapshot,
	validation: {
		signing: "not_run",
		notarization: "not_run",
		installation: "not_run",
		gui: "not_run",
		updateRecovery: "not_run",
	},
	licenseReviewRequired: dependencies.filter((item) => item.licenseReview !== "included").map((item) => item.name),
	payload: await inventory(stage),
};
await writeFile(join(stage, "build-provenance.json"), JSON.stringify(provenance, null, 2));
console.log(
	`Staged ${provenance.payload.length} allowlisted files; ${provenance.licenseReviewRequired.length} license records need review. Not an approved RC.`,
);
if (provenance.licenseReviewRequired.length)
	throw new Error(`Bundled license review required: ${provenance.licenseReviewRequired.join(", ")}`);
