import { spawnSync } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { assertSourceSnapshot, inventory, sha256, sourceSnapshot } from "./release-policy.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const before = await sourceSnapshot(root);
const result = spawnSync(process.execPath, [join(root, "apps/hipi-work-desktop/scripts/prepare.mjs"), "--release"], {
	cwd: root,
	stdio: "inherit",
});
if (result.error) throw result.error;
if (result.status !== 0) process.exit(result.status ?? 1);
await assertSourceSnapshot(root, before);
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
