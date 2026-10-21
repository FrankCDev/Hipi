import assert from "node:assert/strict";
import { relative, resolve } from "node:path";
import test from "node:test";
import { checkProcessGraph, valueDependencies } from "./boundary-graph.mjs";

const root = resolve("/desktop-boundary-fixture");
function check(files, role = "main") {
	return checkProcessGraph({
		root,
		entry: role === "preload" ? "preload.ts" : "main.ts",
		role,
		resolveExternal: () => {
			throw new Error("Unexpected external contract in fixture");
		},
		read: async (file) => {
			const source = files[relative(resolve(root, "src"), file).split("\\").join("/")];
			assert.notEqual(source, undefined, `Missing fixture ${file}`);
			return source;
		},
	});
}

test("explicit type clauses erase; empty value imports and mixed imports retain runtime edges", async () => {
	assert.deepEqual(
		await valueDependencies(
			`
		import type { A } from "types-a";
		import { type B } from "types-b";
		export type { C } from "types-c";
		export { type D } from "types-d";
		import { type E, value } from "mixed";
		export { value as other } from "reexport";
		import "side-effect";
	`,
			"/fixture.ts",
		),
		["types-b", "types-d", "mixed", "reexport", "side-effect"],
	);
});

test("main rejects transitive database and runtime imports, including reexports", async () => {
	for (const dependency of [
		"node:sqlite",
		"sqlite",
		"@hipi/work-runtime",
		"@hipi/work-runtime/node",
		"@hipi/work-runtime/testing",
	]) {
		await assert.rejects(
			check({ "main.ts": 'import "./shell/indirect.ts";', "shell/indirect.ts": `export * from "${dependency}";` }),
			/SQLite|Privileged dependency/,
		);
	}
});

test("main rejects utility leaves even when their external dependencies are erased", async () => {
	await assert.rejects(
		check({ "main.ts": 'import "./runtime/router.ts";', "runtime/router.ts": "export const router = 1;" }),
		/utility implementation/,
	);
});

test("preload rejects private credentials and indirect Node imports", async () => {
	await assert.rejects(check({ "preload.ts": 'import "./credentials/rpc.ts";' }, "preload"), /Non-contract module/);
	await assert.rejects(
		check({ "preload.ts": 'import "./ipc/protocol.ts";', "ipc/protocol.ts": 'import "node:fs";' }, "preload"),
		/Privileged dependency/,
	);
});

test("composition roots and runtime cycles are rejected", async () => {
	await assert.rejects(
		check({ "main.ts": 'import "./shell/a.ts";', "shell/a.ts": 'import "../preload.ts";' }),
		/process root/,
	);
	await assert.rejects(
		check({ "main.ts": 'import "./shell/a.ts";', "shell/a.ts": 'import "./b.ts";', "shell/b.ts": 'import "./a.ts";' }),
		/Cyclic/,
	);
});

test("valid main graph preserves native services and erased fixture types", async () => {
	const visited = await check({
		"main.ts": 'import "electron"; import "./launch/profile.ts";',
		"launch/profile.ts": 'import "node:fs"; import type { Fixture } from "@hipi/work-runtime/testing";',
	});
	assert.equal(visited.size, 2);
});

test("dynamic and require dependencies fail closed", async () => {
	for (const source of ['import("./hidden.ts");', 'require("./hidden.ts");', "import(path);", "require(path);"]) {
		await assert.rejects(
			valueDependencies(source, "/fixture.ts"),
			/Unexpected dynamic dependency|not a string literal/,
		);
	}
});

test("logging backend is confined to the main composition root", async () => {
	await check({ "main.ts": 'import "@hipi/work-logging";' });
	for (const dependency of ["pino", "rotating-file-stream", "electron-log", "electron-log/main", "electron-log/node"]) {
		await assert.rejects(check({ "main.ts": `import "${dependency}";` }), /Privileged dependency/);
		await assert.rejects(check({ "preload.ts": `import "${dependency}";` }, "preload"), /Privileged dependency/);
	}
	await assert.rejects(check({ "preload.ts": 'import "@hipi/work-logging";' }, "preload"), /main-only/);
	await assert.rejects(
		check({ "main.ts": 'import "./shell/indirect.ts";', "shell/indirect.ts": 'import "@hipi/work-logging";' }),
		/Only composition root/,
	);
});
