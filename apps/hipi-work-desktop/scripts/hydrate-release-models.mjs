import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { hydrateModelCatalog } from "../../../packages/ai/scripts/hydrate-model-catalog.ts";
import { boundedCatalogBytes } from "./release-download.mjs";
import { sha256 } from "./release-policy.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const { revision } = JSON.parse(
	await readFile(resolve(root, "apps/hipi-work-desktop/packaging/model-catalog.json"), "utf8"),
);
if (!/^sha256-[a-f0-9]{64}$/.test(revision)) throw new Error("Invalid pinned model catalog revision");
const response = await fetch(`https://pi.dev/api/models/revisions/${revision}?types=chat,image,classifier`, {
	signal: AbortSignal.timeout(60_000),
	redirect: "error",
});
if (!response.ok) throw new Error(`Pinned model catalog unavailable: HTTP ${response.status}`);
const bytes = await boundedCatalogBytes(response);
if (`sha256-${sha256(bytes)}` !== revision) throw new Error("Pinned model catalog digest mismatch");
const directory = resolve(root, ".artifacts/hipi-work/model-catalog");
await mkdir(directory, { recursive: true });
const path = resolve(directory, "models.all.json");
await writeFile(path, bytes);
hydrateModelCatalog(resolve(root, "packages/ai"), path);
console.log(`Hydrated verified model catalog ${revision}`);
