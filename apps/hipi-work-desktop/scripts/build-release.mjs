import { spawnSync } from "node:child_process";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { filesUnder, inventory, sha256 } from "./release-policy.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
async function sourceSnapshot() {
	const files = [
		"package.json",
		"package-lock.json",
		"nix/model-catalog.json",
		"tsconfig.base.json",
		"tsconfig.json",
		"apps/hipi-work-ui/index.html",
		"apps/hipi-work-ui/THIRD_PARTY_NOTICES.md",
		"LICENSE",
	];
	for (const directory of ["packages", "apps"]) {
		for (const entry of await readdir(join(root, directory), { withFileTypes: true })) {
			if (!entry.isDirectory()) continue;
			const base = `${directory}/${entry.name}`;
			for (const file of await readdir(join(root, base))) {
				if (/^(?:package\.json|tsconfig.*\.json|vite\.config\.ts)$/.test(file)) files.push(`${base}/${file}`);
			}
			try {
				for (const file of await filesUnder(join(root, base, "src"))) files.push(`${base}/src/${file}`);
			} catch (error) {
				if (error.code !== "ENOENT") throw error;
			}
		}
	}
	for (const directory of [
		"apps/hipi-work-desktop/scripts",
		"apps/hipi-work-desktop/packaging",
		"apps/hipi-work-desktop/branding",
		"apps/hipi-work-ui/vendor",
	]) {
		for (const file of await filesUnder(join(root, directory))) files.push(`${directory}/${file}`);
	}
	try {
		for (const file of await filesUnder(join(root, "apps/hipi-work-ui/public")))
			files.push(`apps/hipi-work-ui/public/${file}`);
	} catch (error) {
		if (error.code !== "ENOENT") throw error;
	}
	return Promise.all(files.sort().map(async (file) => ({ file, sha256: sha256(await readFile(join(root, file))) })));
}
const before = await sourceSnapshot();
const result = spawnSync(process.execPath, [join(root, "apps/hipi-work-desktop/scripts/prepare.mjs"), "--release"], {
	cwd: root,
	stdio: "inherit",
});
if (result.error) throw result.error;
if (result.status !== 0) process.exit(result.status ?? 1);
if (JSON.stringify(before) !== JSON.stringify(await sourceSnapshot()))
	throw new Error("Source inputs changed during release build; rebuild from a stable snapshot");
const directory = join(root, ".artifacts/hipi-work");
await mkdir(directory, { recursive: true });
await writeFile(
	join(directory, "source-snapshot.json"),
	JSON.stringify(
		{
			schemaVersion: 1,
			sourceSnapshotSha256: sha256(JSON.stringify(before)),
			sourceSnapshot: before,
			bundles: await inventory(join(root, "apps/hipi-work-desktop/dist")),
		},
		null,
		2,
	),
);
console.log("Release build input snapshot and generated bundle hashes recorded.");
