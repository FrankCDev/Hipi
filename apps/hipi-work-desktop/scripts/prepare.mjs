// Explicit build, never an install lifecycle hook. Follow root AGENTS.md authorization requirements.
import { cp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { build } from "esbuild";
import { build as buildRenderer } from "vite";
import { prepareFontAssets } from "./font-assets.mjs";
import { assertMaintenanceBundle } from "./maintenance-bundle.mjs";
import { assertBrandIcon, brandIconSha256 } from "./release-policy.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const ui = resolve(root, "../hipi-work-ui");
const { values } = parseArgs({ options: { release: { type: "boolean", default: false } } });
const options = {
	absWorkingDir: root,
	bundle: true,
	sourcemap: !values.release,
	logLevel: "info",
	conditions: ["source"],
	metafile: true,
	define: { HIPI_DESKTOP_DEV: "false" },
};
const bundleInputs = new Set();
async function bundle(options) {
	const result = await build(options);
	await writeFile(
		resolve(root, options.outfile.replace(/\.(?:mjs|cjs)$/, ".meta.json")),
		JSON.stringify(result.metafile, null, 2),
	);
	for (const output of Object.values(result.metafile.outputs)) {
		for (const [file, info] of Object.entries(output.inputs)) {
			if (info.bytesInOutput > 0) bundleInputs.add(resolve(root, file));
		}
	}
	return result;
}
// A release never inherits stale files from an earlier development build.
if (values.release) await rm(resolve(root, "dist"), { recursive: true, force: true });
await mkdir(resolve(root, "dist"), { recursive: true });
const brandIcon = await readFile(resolve(root, "branding/png/256x256.png"));
const brandInventory = JSON.parse(await readFile(resolve(root, "branding/asset-inventory.json"), "utf8"));
if (brandInventory.files.find((entry) => entry.file === "png/256x256.png")?.sha256 !== brandIconSha256)
	throw new Error("Brand inventory does not identify the approved PNG");
assertBrandIcon(brandIcon);
await mkdir(resolve(root, "dist/branding"), { recursive: true });
await writeFile(resolve(root, "dist/branding/icon.png"), brandIcon);
await cp(resolve(ui, "vendor/pdfjs"), resolve(root, "dist/third-party/pdfjs"), { recursive: true });
await cp(resolve(ui, "THIRD_PARTY_NOTICES.md"), resolve(root, "dist/third-party/UI-NOTICES.md"));
await prepareFontAssets(ui, root);
await bundle({
	...options,
	entryPoints: ["src/main.ts"],
	outfile: "dist/main.mjs",
	banner: {
		js: "import { createRequire as createNodeRequire } from 'node:module'; const require = createNodeRequire(import.meta.url);",
	},
	platform: "node",
	format: "esm",
	external: ["electron"],
});
await bundle({
	...options,
	entryPoints: ["src/preload.ts"],
	outfile: "dist/preload.cjs",
	platform: "browser",
	format: "cjs",
	external: ["electron"],
});
await bundle({
	...options,
	entryPoints: ["src/runtime-entry.ts"],
	outfile: "dist/runtime.mjs",
	platform: "node",
	format: "esm",
	banner: {
		js: "import { createRequire as createNodeRequire } from 'node:module'; const require = createNodeRequire(import.meta.url);",
	},
});
// Workers resolve relative to runtime.mjs after packaging or relocation.
const maintenanceBuild = await bundle({
	...options,
	entryPoints: ["../../packages/work-runtime/src/store-cli.ts"],
	outfile: "dist/maintenance.mjs",
	platform: "node",
	format: "esm",
});
assertMaintenanceBundle(maintenanceBuild.metafile);

const parserBuild = await bundle({
	metafile: true,
	...options,
	entryPoints: ["../../packages/work-runtime/src/previews/parser-worker.ts"],
	outfile: "dist/preview-parser.mjs",
	platform: "node",
	format: "esm",
	banner: {
		js: "import { createRequire as createNodeRequire } from 'node:module'; const require = createNodeRequire(import.meta.url);",
	},
});
await writeFile(resolve(root, "dist/preview-parser.meta.json"), JSON.stringify(parserBuild.metafile, null, 2));
await buildRenderer({
	root: ui,
	configFile: resolve(ui, "vite.config.ts"),
	base: "./",
	plugins: [
		{
			name: "hipi-release-input-provenance",
			generateBundle(_options, outputs) {
				for (const output of Object.values(outputs)) {
					if (output.type !== "chunk") continue;
					for (const [id, info] of Object.entries(output.modules)) {
						const file = id.split("?")[0];
						if (info.renderedLength !== 0 && isAbsolute(file)) bundleInputs.add(file);
					}
				}
			},
		},
	],
	build: { outDir: resolve(root, "dist/renderer"), emptyOutDir: true },
});
await writeFile(
	resolve(root, "dist/bundle-inputs.meta.json"),
	JSON.stringify(
		{
			schemaVersion: 1,
			inputs: [...bundleInputs].map((file) => relative(resolve(root, "../.."), file).replaceAll("\\", "/")).sort(),
		},
		null,
		2,
	),
);
