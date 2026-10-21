import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import { test } from "node:test";
import { runInNewContext } from "node:vm";
import { WindowLifecycle } from "../src/shell/window-lifecycle.ts";

test("main emits only bounded fixed status markers for an isolated deterministic smoke launch", () => {
	const source = readFileSync(new URL("../src/main.ts", import.meta.url), "utf8");
	const begin = source.indexOf("\tconst credentialStages =");
	const end = source.indexOf("\n\tconst assets =", begin);
	assert.ok(begin > 0 && end > begin);
	const assembly = stripTypeScriptTypes(source.slice(begin, end));
	for (const mode of ["production", "deterministic"]) {
		for (const isolated of [false, true]) {
			let observe: ((stage: string) => void) | undefined;
			let observeLifecycle: ((stage: string) => void) | undefined;
			const lines: string[] = [];
			runInNewContext(`${assembly}\nregisterLifecycle(observeLifecycle);`, {
				registerLifecycle: (observer: typeof observeLifecycle) => {
					observeLifecycle = observer;
				},
				mode,
				process: { platform: "darwin", argv: isolated ? ["--smoke-data-root=/validated-owned-root"] : [] },
				app: { getPath: () => "/validated-owned-root/profile" },
				join: (...parts: string[]) => parts.join("/"),
				safeStorage: {},
				createCredentialCrypto: (storage: unknown) => storage,
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
			assert.ok(observeLifecycle);
			const lifecycleStages = [
				"quit-request",
				"window-closed",
				"runtime-close-enter",
				"runtime-close-return",
				"app-exit-enter",
			];
			for (const stage of [...lifecycleStages, ...lifecycleStages, "unknown", "app-exit-enter private"])
				observeLifecycle(stage);
			if (mode !== "deterministic" || !isolated) {
				assert.equal(observe, undefined);
				assert.deepEqual(lines, []);
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
				"async-ready-enter",
				"async-ready-return",
				"probe-encrypt-enter",
				"probe-encrypt-return",
				"probe-decrypt-enter",
				"probe-decrypt-return",
			];
			for (const stage of [...stages, ...stages, "unknown", "status-enter secret-value"]) observe(stage);
			assert.deepEqual(lines, [
				...lifecycleStages.map((stage) => `[Hipi smoke host-lifecycle] ${stage}\n`),
				...stages.map((stage) => `[Hipi smoke credential-status] ${stage}\n`),
			]);
		}
	}
});

test("lifecycle diagnostics preserve window approval, pending runtime close and actual exit ordering", async () => {
	const source = readFileSync(new URL("../src/main.ts", import.meta.url), "utf8");
	const begin = source.indexOf("\tconst lifecycle = new WindowLifecycle(");
	const end = source.indexOf('\n\tapp.on("window-all-closed"', begin);
	assert.ok(begin > 0 && end > begin);
	const events: string[] = [];
	const closed = Promise.withResolvers<boolean>();
	let beforeQuit: ((event: { preventDefault(): void }) => void) | undefined;
	let windowClosed: (() => void) | undefined;
	runInNewContext(stripTypeScriptTypes(source.slice(begin, end)), {
		WindowLifecycle,
		recoveringStartup: false,
		clearRenderer: () => events.push("clear-renderer"),
		observeLifecycle: (stage: string) => events.push(stage),
		activeSupervisor: { close: () => closed.promise },
		window: {
			isDestroyed: () => false,
			close: () => events.push("request-window-close"),
			once: (event: string, callback: () => void) => {
				assert.equal(event, "closed");
				windowClosed = callback;
			},
		},
		app: {
			on: (event: string, callback: typeof beforeQuit) => {
				assert.equal(event, "before-quit");
				beforeQuit = callback;
			},
			exit: (code: number) => events.push(`exit:${code}`),
		},
	});
	assert.ok(beforeQuit && windowClosed);
	beforeQuit({ preventDefault: () => events.push("prevent-default") });
	assert.deepEqual(events, ["quit-request", "prevent-default", "request-window-close"]);
	windowClosed();
	assert.deepEqual(events.slice(3), ["window-closed", "clear-renderer", "runtime-close-enter"]);
	closed.resolve(true);
	await new Promise((resolve) => setTimeout(resolve, 0));
	assert.deepEqual(events.slice(6), ["runtime-close-return", "app-exit-enter", "exit:0"]);
});

test("a failed lifecycle diagnostic write is isolated and never retried", () => {
	const source = readFileSync(new URL("../src/main.ts", import.meta.url), "utf8");
	const begin = source.indexOf("\ttype LifecycleStage =");
	const end = source.indexOf("\n\tconst assets =", begin);
	assert.ok(begin > 0 && end > begin);
	let writes = 0;
	assert.doesNotThrow(() =>
		runInNewContext(
			`${stripTypeScriptTypes(source.slice(begin, end))}\nobserveLifecycle('quit-request'); observeLifecycle('quit-request');`,
			{
				smokeDiagnostics: true,
				writeSync: () => {
					writes++;
					throw new Error("broken diagnostic pipe");
				},
			},
		),
	);
	assert.equal(writes, 1);
});
