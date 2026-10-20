import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import maintenance from "../packaging/linux-maintenance.cjs";
import { boundedCatalogBytes } from "./release-download.mjs";
import { sha256 } from "./release-policy.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
if (process.argv.length !== 2) throw new Error("Maintenance hydration accepts no overrides");
maintenance.assertRuntimeTarget(process.platform, process.arch);
const { pin } = maintenance;
const cache = join(root, ".artifacts/hipi-work/cache/node");
const archive = join(cache, pin.archive);
await mkdir(cache, { recursive: true });
let bytes;
try {
	bytes = await readFile(archive);
} catch (error) {
	if (error.code !== "ENOENT") throw error;
	const response = await fetch(pin.url, { signal: AbortSignal.timeout(120_000), redirect: "error" });
	if (!response.ok) throw new Error(`Official pinned Node runtime unavailable: HTTP ${response.status}`);
	bytes = await boundedCatalogBytes(response, 64 * 1024 * 1024);
	if (sha256(bytes) !== pin.sha256) throw new Error("Official Node archive digest mismatch");
	await writeFile(archive, bytes, { flag: "wx", mode: 0o644 });
}
if (sha256(bytes) !== pin.sha256) throw new Error("Official Node archive digest mismatch");
await maintenance.prepareMaintenanceRuntime(archive, join(root, ".artifacts/hipi-work/maintenance-runtime"));
console.log(
	`Prepared official Node ${pin.version} ${pin.platform}-${pin.architecture} for offline maintenance; no npm or system installation.`,
);
