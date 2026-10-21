import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { checkProcessGraph } from "./boundary-graph.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(import.meta.url);
for (const [entry, role] of [
	["preload.ts", "preload"],
	["main.ts", "main"],
	["runtime-entry.ts", "utility"],
]) {
	await checkProcessGraph({ root, entry, role, resolveExternal: (specifier) => require.resolve(specifier) });
}
process.stdout.write("Desktop transitive process ownership and sandbox boundaries passed.\n");
