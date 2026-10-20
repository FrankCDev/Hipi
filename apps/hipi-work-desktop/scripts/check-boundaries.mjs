import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(import.meta.url);
const visited = new Set();
async function visit(path) {
	if (visited.has(path)) return;
	visited.add(path);
	const source = await readFile(path, "utf8");
	assert.doesNotMatch(source, /\brequire\s*\(|\bimport\s*\(/, `Unexpected dynamic dependency in ${path}`);
	for (const match of source.matchAll(/\b(?:import|export)\s+(?:[^;]*?\s+from\s+)?["']([^"']+)["']/g)) {
		const specifier = match[1];
		if (specifier === "electron" && path === resolve(root, "src/preload.ts")) continue;
		if (specifier.startsWith(".")) await visit(resolve(dirname(path), specifier));
		else {
			assert.ok(
				[
					"@hipi/work-runtime/appearance",
					"@hipi/work-runtime/contracts",
					"@hipi/work-runtime/credentials",
					"@hipi/work-runtime/files",
					"@hipi/work-runtime/files/protocol",
					"@hipi/work-runtime/previews/contracts",
					"@hipi/work-runtime/previews/protocol",
				].includes(specifier),
				`Privileged dependency reached sandbox preload: ${specifier}`,
			);
			await visit(require.resolve(specifier));
		}
	}
}
await visit(resolve(root, "src/preload.ts"));
for (const file of ["src/main.ts", "src/supervisor.ts", "src/host-connection.ts"]) {
	const source = await readFile(resolve(root, file), "utf8");
	assert.doesNotMatch(
		source,
		/["']@hipi\/work-runtime(?:["']|\/(?:node|testing)["'])/,
		"Main must not own a runtime or database",
	);
	assert.doesNotMatch(source, /["']node:sqlite["']/, "Main must not open SQLite");
}
process.stdout.write("Desktop preload graph and main/runtime ownership boundaries passed.\n");
