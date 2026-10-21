import { randomBytes } from "node:crypto";
import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { createNodeLogger } from "@hipi/work-logging";
import { context } from "esbuild";
import { createServer } from "vite";
import { validateGeneratedModelData } from "../../../../packages/ai/scripts/model-data.ts";
import { createDevelopmentOutput, restartCoordinator, startDesktop } from "./process.mjs";
import { developmentServerOptions } from "./server.mjs";

const desktop = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const repository = resolve(desktop, "../..");
const ui = resolve(desktop, "../hipi-work-ui");
const token = randomBytes(32).toString("hex");
const require = createRequire(import.meta.url);
const contexts = [];
const builds = new Map();
let server;
let child;
let stopping;
let debounce;
let coordinator;
let failureEvent = "dev.usage.invalid";
const logger = createNodeLogger({ role: "dev", console: true });
logger.record("dev.start");

async function stopChild() {
	if (!child) return;
	const previous = child;
	logger.record("dev.restart.requested");
	const reminder = setTimeout(() => logger.record("dev.shutdown.waiting"), 10000);
	try {
		const result = await previous.quit();
		if (result.code !== 0) throw new Error("Desktop shutdown was not clean; refusing to reopen its profile");
	} finally {
		clearTimeout(reminder);
		if (previous.exited && child === previous) child = undefined;
	}
}

function shutdown(code = 0) {
	if (stopping) {
		void child?.quit(true);
		return stopping;
	}
	process.exitCode = code;
	clearTimeout(debounce);
	stopping = (async () => {
		logger.record("dev.shutdown.requested");
		await Promise.all(contexts.map((build) => build.dispose()));
		try {
			await coordinator?.close();
		} finally {
			await server?.close();
		}
		logger.record("dev.stopped");
	})()
		.catch(() => {
			process.exitCode = 1;
			logger.record("dev.shutdown.failed");
		})
		.finally(async () => {
			if ((await logger.close()) !== "flushed") {
				process.exitCode = 1;
			}
		});
	return stopping;
}
process.on("SIGINT", () => {
	void shutdown();
});
process.on("SIGTERM", () => {
	void shutdown();
});

try {
	const { values } = parseArgs({ options: { provider: { type: "string", default: "production" } } });
	if (!["production", "deterministic"].includes(values.provider))
		throw new Error("Use --provider=production or --provider=deterministic");
	failureEvent = "dev.models.missing";
	try {
		validateGeneratedModelData(resolve(repository, "packages/ai"));
	} catch {
		throw new Error("Model data is missing or stale. Run npm run hydrate:model-data, then npm run check:model-data.");
	}
	// Do not import electron: its package entry can silently download a missing executable.
	failureEvent = "dev.electron.missing";
	const electronRoot = dirname(require.resolve("electron/package.json"));
	let binary;
	try {
		const executable = (await readFile(resolve(electronRoot, "path.txt"), "utf8")).trim();
		binary = resolve(electronRoot, "dist", executable);
		const childPath = relative(resolve(electronRoot, "dist"), binary);
		if (!childPath || childPath.startsWith("..") || isAbsolute(childPath)) throw new Error();
		await access(binary);
	} catch {
		throw new Error(
			"Electron binary is missing. Complete the documented Electron installation step first; dev never downloads executables automatically.",
		);
	}
	failureEvent = "dev.startup.failed";
	// Separate from release dist/provenance; ignored by the existing .artifacts rule.
	const output = await createDevelopmentOutput(repository);
	await mkdir(resolve(output, "branding"), { recursive: true });
	await writeFile(resolve(output, "branding/icon.png"), await readFile(resolve(desktop, "branding/png/256x256.png")));
	await writeFile(
		resolve(output, "package.json"),
		JSON.stringify({ name: "hipi-work-development", version: "0.0.1", type: "module", main: "main.mjs" }),
	);
	if (stopping) throw new Error("Development startup cancelled");
	failureEvent = "dev.server.failed";
	server = await createServer(developmentServerOptions(ui, token));
	if (stopping) {
		await server.close();
		throw new Error("Development startup cancelled");
	}
	await server.listen();
	if (stopping) {
		await server.close();
		throw new Error("Development startup cancelled");
	}
	logger.record("dev.server.ready");
	failureEvent = "dev.startup.failed";
	coordinator = restartCoordinator({
		stop: stopChild,
		publish: async () => {
			if (builds.size !== 2 || [...builds.values()].some((build) => !build)) return false;
			const snapshot = [...builds.values()];
			for (const files of snapshot) for (const file of files) await writeFile(file.path, file.contents);
			return true;
		},
		start: async () => {
			if (stopping) return;
			logger.record("dev.desktop.starting");
			const environment = { ...process.env, HIPI_WORK_DEV_TOKEN: token };
			delete environment.ELECTRON_RUN_AS_NODE;
			delete environment.NODE_OPTIONS;
			child = startDesktop(binary, [output, `--provider=${values.provider}`], {
				cwd: repository,
				env: environment,
				// Developer-only child diagnostics, not operational records or persistent logs.
				onOutput: (text) => process.stderr.write(text),
			});
			const current = child;
			void current.completion.then((result) => {
				logger.record("dev.desktop.exited", { exitCode: result.code });
				if (!result.requested && !stopping) void shutdown(result.code === 0 && current.isReady ? 0 : 1);
			});
			await current.ready;
			logger.record("dev.desktop.ready");
		},
		failed: () => {
			logger.record("dev.desktop.failed");
			void shutdown(1);
		},
	});
	const nodeEntries = {
		main: "src/main.ts",
		runtime: "src/runtime-entry.ts",
		maintenance: "../../packages/work-runtime/src/store-cli.ts",
		"preview-parser": "../../packages/work-runtime/src/previews/parser-worker.ts",
	};
	for (const [name, options] of [
		[
			"host",
			{
				entryPoints: nodeEntries,
				platform: "node",
				format: "esm",
				outExtension: { ".js": ".mjs" },
				banner: {
					js: "import { createRequire as createNodeRequire } from 'node:module'; const require = createNodeRequire(import.meta.url);",
				},
			},
		],
		[
			"preload",
			{
				entryPoints: { preload: "src/preload.ts" },
				platform: "browser",
				format: "cjs",
				outExtension: { ".js": ".cjs" },
			},
		],
	]) {
		const build = await context({
			absWorkingDir: desktop,
			bundle: true,
			sourcemap: true,
			conditions: ["source"],
			external: ["electron"],
			outdir: output,
			write: false,
			define: { HIPI_DESKTOP_DEV: "true" },
			...options,
			plugins: [
				{
					name: "desktop-development-lifecycle",
					setup(builder) {
						builder.onStart(() => {
							logger.record("dev.build.started");
							builds.set(name, undefined);
							clearTimeout(debounce);
						});
						builder.onEnd((result) => {
							if (stopping) return;
							builds.set(name, result.errors.length ? undefined : result.outputFiles);
							if (result.errors.length) {
								logger.record("dev.build.failed");
							} else if (builds.size === 2 && [...builds.values()].every(Boolean)) {
								clearTimeout(debounce);
								debounce = setTimeout(() => coordinator.request(), 150);
							}
						});
					},
				},
			],
		});
		contexts.push(build);
		if (stopping) {
			await build.dispose();
			break;
		}
		await build.watch();
	}
} catch {
	if (!stopping) logger.record(failureEvent);
	await shutdown(stopping ? process.exitCode : 1);
}
