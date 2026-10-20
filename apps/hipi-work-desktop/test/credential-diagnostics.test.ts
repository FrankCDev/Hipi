import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import { test } from "node:test";
import { runInNewContext } from "node:vm";

test("main emits only bounded fixed status markers for an isolated deterministic smoke launch", () => {
	const source = readFileSync(new URL("../src/main.ts", import.meta.url), "utf8");
	const begin = source.indexOf("\tconst credentialStages =");
	const end = source.indexOf("\n\tconst assets =", begin);
	assert.ok(begin > 0 && end > begin);
	const assembly = stripTypeScriptTypes(source.slice(begin, end));
	for (const mode of ["production", "deterministic"]) {
		for (const isolated of [false, true]) {
			let observe: ((stage: string) => void) | undefined;
			const lines: string[] = [];
			runInNewContext(assembly, {
				mode,
				process: { platform: "darwin", argv: isolated ? ["--smoke-data-root=/validated-owned-root"] : [] },
				app: { getPath: () => "/validated-owned-root/profile" },
				join: (...parts: string[]) => parts.join("/"),
				safeStorage: {},
				CredentialStore: class {
					constructor(
						_path: unknown,
						_storage: unknown,
						_platform: unknown,
						_replace: unknown,
						observer: typeof observe,
					) {
						observe = observer;
					}
				},
				writeSync: (descriptor: number, line: string) => {
					assert.equal(descriptor, 2);
					lines.push(line);
				},
			});
			if (mode !== "deterministic" || !isolated) {
				assert.equal(observe, undefined);
				continue;
			}
			assert.ok(observe);
			const stages = [
				"status-enter",
				"availability-enter",
				"availability-return",
				"file-read-enter",
				"file-read-return",
				"status-return",
			];
			for (const stage of [...stages, ...stages, "unknown", "status-enter secret-value"]) observe(stage);
			assert.deepEqual(
				lines,
				stages.map((stage) => `[Hipi smoke credential-status] ${stage}\n`),
			);
		}
	}
});
