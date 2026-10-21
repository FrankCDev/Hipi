import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { isBuiltin } from "node:module";
import { dirname, relative, resolve } from "node:path";
import { build } from "esbuild";

const contracts = new Set([
	"@hipi/work-runtime/appearance",
	"@hipi/work-runtime/contracts",
	"@hipi/work-runtime/credentials",
	"@hipi/work-runtime/files",
	"@hipi/work-runtime/files/protocol",
	"@hipi/work-runtime/previews/contracts",
	"@hipi/work-runtime/previews/protocol",
]);
const portableLeaves = new Set([
	"appearance/protocol.ts",
	"credentials/protocol.ts",
	"files/protocol.ts",
	"previews/protocol.ts",
	"ipc/protocol.ts",
	"ipc/invocation-gate.ts",
]);
const utilityLeaves = new Set(["runtime-entry.ts", "runtime/router.ts", "files/runtime.ts", "previews/runtime.ts"]);

/** Use the bundler parser with verbatim imports: explicit type-only clauses erase; import {} still evaluates. */
export async function valueDependencies(source, file) {
	const dependencies = [];
	await build({
		stdin: { contents: source, sourcefile: file, loader: "ts", resolveDir: dirname(file) },
		bundle: true,
		write: false,
		platform: "neutral",
		format: "esm",
		logLevel: "silent",
		logOverride: { "unsupported-dynamic-import": "error", "unsupported-require-call": "error" },
		treeShaking: false,
		tsconfigRaw: { compilerOptions: { verbatimModuleSyntax: true } },
		plugins: [
			{
				name: "desktop-boundaries",
				setup(builder) {
					builder.onResolve({ filter: /.*/ }, (args) => {
						assert.equal(args.kind, "import-statement", `Unexpected dynamic dependency in ${file}: ${args.kind}`);
						dependencies.push(args.path);
						return { path: args.path, external: true };
					});
				},
			},
		],
	});
	return dependencies;
}

/** Entry-point reachability, not folder shape, defines the privilege boundary. */
export async function checkProcessGraph({
	root,
	entry,
	role,
	resolveExternal,
	read = (file) => readFile(file, "utf8"),
}) {
	const complete = new Set();
	const visiting = new Set();
	const sourceRoot = resolve(root, "src");
	const start = resolve(sourceRoot, entry);
	async function visit(file) {
		assert.ok(!visiting.has(file), `Cyclic ${role} dependency: ${file}`);
		if (complete.has(file)) return;
		visiting.add(file);
		for (const specifier of await valueDependencies(await read(file), file)) {
			if (specifier.startsWith(".")) {
				const target = resolve(dirname(file), specifier);
				const local = relative(sourceRoot, target).split("\\").join("/");
				if (!local.startsWith("../")) {
					assert.ok(
						!["main.ts", "preload.ts", "runtime-entry.ts"].includes(local),
						`Implementation imports process root: ${local}`,
					);
					if (role === "preload")
						assert.ok(portableLeaves.has(local), `Non-contract module reached sandbox preload: ${local}`);
					if (role === "main") assert.ok(!utilityLeaves.has(local), `Main reached utility implementation: ${local}`);
				}
				await visit(target);
			} else if (specifier === "@hipi/work-logging") {
				assert.equal(role, "main", "Logging backend is main-only");
				assert.equal(file, start, "Only composition root may import logging backend");
				// Exact Node-only workspace backend has separate dependency and relocation tests.
			} else if (role === "utility") {
				assert.notEqual(specifier, "electron", "Utility must not import Electron");
			} else if (specifier === "electron" && file === start) {
				// Only the process composition root imports Electron runtime values.
			} else if (role === "main" && isBuiltin(specifier)) {
				assert.ok(!["sqlite", "node:sqlite"].includes(specifier), "Main must not open SQLite");
			} else {
				assert.ok(contracts.has(specifier), `Privileged dependency reached ${role}: ${specifier}`);
				await visit(resolveExternal(specifier));
			}
		}
		visiting.delete(file);
		complete.add(file);
	}
	await visit(start);
	return complete;
}
