import { createHash } from "node:crypto";
import { lstat, readdir, readFile } from "node:fs/promises";
import { join } from "node:path";

export const requiredFiles = [
	"dist/main.mjs",
	"dist/preload.cjs",
	"dist/runtime.mjs",
	"dist/preview-parser.mjs",
	"dist/maintenance.mjs",
	"dist/branding/icon.png",
	"dist/renderer/index.html",
	"dist/third-party/UI-NOTICES.md",
	"dist/third-party/pdfjs/asset-inventory.json",
	...["PDFJS", "CMAPS", "FOXIT", "LIBERATION"].map((name) => `dist/third-party/pdfjs/LICENSE_${name}`),
];

// Approved 256px product asset. Changing it requires a deliberate asset review.
export const brandIconSha256 = "20f84ebda7190ab7b5f81dfb00f6e680f8903a5a8e29caca342ab07cf28f1258";
export function assertBrandIcon(bytes) {
	if (
		bytes.length < 26 ||
		bytes.subarray(0, 8).toString("hex") !== "89504e470d0a1a0a" ||
		bytes.toString("ascii", 12, 16) !== "IHDR" ||
		bytes.readUInt32BE(16) !== 256 ||
		bytes.readUInt32BE(20) !== 256 ||
		sha256(bytes) !== brandIconSha256
	)
		throw new Error("Release brand icon differs from the approved PNG");
}

export function allowedPayload(path) {
	return requiredFiles.includes(path) || /^dist\/renderer\/assets\/[A-Za-z0-9_.-]+\.(?:js|mjs|css)$/.test(path);
}

export function assertPublicText(text, privateRoot) {
	if (text.includes("sourceMappingURL=") || (privateRoot && text.includes(privateRoot))) {
		throw new Error("Release payload contains a source map reference or private build path");
	}
}

export async function filesUnder(root, prefix = "") {
	const result = [];
	for (const entry of await readdir(join(root, prefix), { withFileTypes: true })) {
		const path = prefix ? `${prefix}/${entry.name}` : entry.name;
		if (entry.isSymbolicLink()) throw new Error(`Symlink forbidden in release input: ${path}`);
		if (entry.isDirectory()) result.push(...(await filesUnder(root, path)));
		else if (entry.isFile()) result.push(path);
		else throw new Error(`Non-regular release input: ${path}`);
	}
	return result.sort();
}

export async function requireFiles(root, files) {
	if (!files.length) throw new Error("An empty explicit file list is forbidden");
	for (const file of files) {
		if (!(await lstat(join(root, file))).isFile()) throw new Error(`Required regular file missing: ${file}`);
	}
}

export function sha256(bytes) {
	return createHash("sha256").update(bytes).digest("hex");
}

export async function inventory(root) {
	return Promise.all(
		(await filesUnder(root)).map(async (file) => {
			const bytes = await readFile(join(root, file));
			return { file, bytes: bytes.length, sha256: sha256(bytes) };
		}),
	);
}

export async function assertPackagingInputs(root, sourceSnapshot) {
	const files = ["package-lock.json", "apps/hipi-work-desktop/package.json"];
	const directories = ["apps/hipi-work-desktop/branding", "apps/hipi-work-desktop/packaging"];
	for (const directory of directories) {
		for (const file of await filesUnder(join(root, directory))) files.push(`${directory}/${file}`);
	}
	const expected = sourceSnapshot.filter(
		(entry) =>
			files.slice(0, 2).includes(entry.file) || directories.some((directory) => entry.file.startsWith(`${directory}/`)),
	);
	if (expected.length !== files.length || new Set(expected.map((entry) => entry.file)).size !== files.length)
		throw new Error("Packaging input set changed since staging; rebuild and stage first");
	for (const file of files) {
		if (expected.find((entry) => entry.file === file)?.sha256 !== sha256(await readFile(join(root, file))))
			throw new Error("Packaging input digest changed since staging; rebuild and stage first");
	}
}
