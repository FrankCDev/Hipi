import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { link, mkdir, mkdtemp, readdir, readFile, rm, stat, symlink, utimes, writeFile } from "node:fs/promises";
import { isBuiltin } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";
import { RotatingFileStream } from "rotating-file-stream";
import { createNodeLogger, LOG_LIMITS } from "../src/index.mjs";

const backend = new URL("../src/index.mjs", import.meta.url).href;
async function fixture(t) {
	const directory = await mkdtemp(join(tmpdir(), "hipi-logging-"));
	t.after(() => rm(directory, { recursive: true, force: true }));
	return directory;
}
function child(source) {
	const result = spawnSync(
		process.execPath,
		["--input-type=module", "-e", `import {createNodeLogger, LOG_LIMITS} from ${JSON.stringify(backend)}; ${source}`],
		{ encoding: "utf8" },
	);
	assert.equal(result.status, 0, result.stderr);
	assert.equal(result.stdout, "", "Logs must not pollute protocol stdout");
	return result.stderr;
}

test("JSONL allowlists context, suppresses content and uses private new files", async (t) => {
	const directory = await fixture(t);
	const logger = createNodeLogger({ role: "main", directory });
	const secret = "SECRET_SENTINEL_prompt_key_path";
	logger.record("runtime.diagnostic", {
		stage: "storage-open",
		category: "storage",
		generation: logger.sessionId,
		durationMs: Infinity,
		requestId: secret,
		error: new Error(secret),
		prompt: secret,
		toJSON: () => secret,
	});
	logger.record(secret);
	logger.record("request.completed");
	assert.equal(await logger.close(), "flushed");
	logger.record("app.start");
	const lines = (await readFile(join(directory, "desktop.log"), "utf8")).trim().split("\n");
	assert.equal(lines.length, 1);
	assert.equal(lines[0].includes(secret), false);
	const record = JSON.parse(lines[0]);
	assert.deepEqual(record.context, { stage: "storage-open", category: "storage", generation: logger.sessionId });
	assert.equal(record.level, "error");
	assert.ok(Buffer.byteLength(lines[0]) <= LOG_LIMITS.recordBytes);
	if (process.platform !== "win32") assert.equal((await stat(join(directory, "desktop.log"))).mode & 0o777, 0o600);
});
test("real rotation retains active plus one JSONL archive within documented bound", async (t) => {
	const directory = await fixture(t);
	const logger = createNodeLogger({ role: "main", directory });
	for (let i = 0; i < 60000; ) {
		if (logger.record("app.start")) i++;
		else await new Promise((resolve) => setImmediate(resolve));
	}
	assert.equal(await logger.close(), "flushed");
	assert.deepEqual((await readdir(directory)).sort(), ["desktop.1.log", "desktop.log"]);
	for (const name of await readdir(directory)) {
		const content = await readFile(join(directory, name), "utf8");
		assert.ok(Buffer.byteLength(content) <= LOG_LIMITS.fileBytes + LOG_LIMITS.recordBytes + 2);
		for (const line of content.trim().split("\n")) assert.equal(JSON.parse(line).event, "app.start");
	}
});
test("startup retention removes only owned stale files", async (t) => {
	const directory = await fixture(t);
	for (const name of ["desktop.log", "desktop.1.log", "keep.txt"]) {
		const path = join(directory, name);
		await writeFile(path, "old");
		await utimes(path, 1, 1);
	}
	const logger = createNodeLogger({ role: "main", directory });
	logger.record("app.start");
	assert.equal(await logger.close(), "flushed");
	assert.deepEqual((await readdir(directory)).sort(), ["desktop.log", "keep.txt"]);
});
test("stderr-only development logs exclude payloads and protocol stdout", () => {
	const stderr = child(
		`const l=createNodeLogger({role:'dev',console:true});l.record('dev.ready',{exitCode:0,secret:'SECRET_SENTINEL'});await l.close();`,
	);
	assert.match(stderr, /INFO \[dev\] dev.ready/);
	assert.doesNotMatch(stderr, /SECRET_SENTINEL/);
});
test("development failures and lifecycle guidance use fixed safe terminal descriptions", () => {
	const codes = [
		"dev.usage.invalid",
		"dev.models.missing",
		"dev.electron.missing",
		"dev.shutdown.failed",
		"dev.server.failed",
		"dev.desktop.failed",
		"dev.startup.failed",
		"dev.shutdown.waiting",
		"dev.desktop.ready",
	];
	const stderr = child(
		`const logger=createNodeLogger({role:'dev',console:true});for(const event of ${JSON.stringify(codes)})logger.record(event,{message:'SECRET_SENTINEL',error:new Error('SECRET_SENTINEL')});await logger.close();`,
	);
	assert.equal(stderr.trim().split("\n").length, codes.length);
	for (const code of codes) assert.equal(stderr.split(code).length - 1, 1);
	assert.match(stderr, /--provider=production or --provider=deterministic/);
	assert.match(stderr, /npm run hydrate:model-data, then npm run check:model-data/);
	assert.match(stderr, /Electron installation step/);
	assert.match(stderr, /Save or discard unsaved edits/);
	assert.match(stderr, /port 5173/);
	assert.doesNotMatch(stderr, /SECRET_SENTINEL|Error:|\n\s+at /);
});
test("bundled Node logger relocates without node_modules or Electron and retains only builtin external edges", async (t) => {
	const directory = await fixture(t);
	const result = await build({
		entryPoints: [fileURLToPath(new URL("../src/index.mjs", import.meta.url))],
		outfile: join(directory, "backend.mjs"),
		bundle: true,
		platform: "node",
		format: "esm",
		metafile: true,
		banner: { js: "import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);" },
	});
	for (const output of Object.values(result.metafile.outputs))
		for (const dependency of output.imports) {
			assert.ok(dependency.external && isBuiltin(dependency.path));
			assert.notEqual(dependency.path, "node:sqlite");
		}
	for (const input of Object.keys(result.metafile.inputs))
		assert.ok(!input.includes("electron-log") && !input.includes("winston"));
	const script = `import {createNodeLogger} from ${JSON.stringify(pathToFileURL(join(directory, "backend.mjs")).href)};const l=createNodeLogger({role:'main',directory:${JSON.stringify(join(directory, "logs"))}});l.record('app.start');await l.close();`;
	const child = spawnSync(process.execPath, ["--input-type=module", "-e", script], {
		cwd: directory,
		encoding: "utf8",
	});
	assert.equal(child.status, 0, child.stderr);
	assert.equal(child.stdout, "");
	assert.equal(child.stderr, "");
	assert.equal(JSON.parse((await readFile(join(directory, "logs/desktop.log"), "utf8")).trim()).event, "app.start");
});

test("bounded admission drops excess producer records and close flushes only accepted records", async (t) => {
	const directory = await fixture(t);
	const logger = createNodeLogger({ role: "main", directory });
	let accepted = 0;
	for (let i = 0; i < 20000; i++) if (logger.record("app.start")) accepted++;
	assert.ok(accepted > 0 && accepted < 20000);
	assert.equal(logger.droppedRecords, 9999);
	const closing = logger.close();
	assert.equal(logger.close(), closing);
	assert.equal(logger.record("app.start"), false);
	assert.equal(await closing, "flushed");
	assert.equal((await readFile(join(directory, "desktop.log"), "utf8")).trim().split("\n").length, accepted);
});

test("real initialization and rotation errors are fixed, nonfatal and report failed close", async (t) => {
	const directory = await fixture(t);
	const output = child(`import {mkdirSync,writeFileSync,readFileSync} from 'node:fs';import {join} from 'node:path';
 const directory=${JSON.stringify(directory)};const blocked=join(directory,'SECRET_SENTINEL');writeFileSync(blocked,'x');
 const a=createNodeLogger({role:'main',directory:blocked});a.record('app.start');if(await a.close()!=='failed')throw new Error('Expected initial failure');
 const line=JSON.stringify({event:'app.start'})+'\\n';const content=line.repeat(Math.ceil(LOG_LIMITS.fileBytes/line.length));writeFileSync(join(directory,'desktop.log'),content);
 const b=createNodeLogger({role:'main',directory});mkdirSync(join(directory,'desktop.1.log'));b.record('app.start');if(await b.close()!=='failed')throw new Error('Expected rotation failure');
 if(readFileSync(join(directory,'desktop.log'),'utf8')!==content)throw new Error('JSONL corrupted');`);
	assert.equal(output, "[Hipi logging] LOG_WRITE_FAILED\n[Hipi logging] LOG_WRITE_FAILED\n");
});

test("stalled stream close is bounded and reports timeout rather than claiming a flush", async (t) => {
	const directory = await fixture(t);
	t.mock.method(RotatingFileStream.prototype, "_write", () => {});
	const logger = createNodeLogger({ role: "main", directory });
	logger.record("app.start");
	const start = performance.now();
	assert.equal(await logger.close(), "timeout");
	assert.ok(performance.now() - start < LOG_LIMITS.closeWaitMs + 1000);
	await new Promise((resolve) => setTimeout(resolve, 20));
});

test("Node-only package cannot be bundled into a browser entry", async () => {
	await assert.rejects(
		build({
			stdin: {
				contents: 'import {createNodeLogger} from "@hipi/work-logging"; console.log(createNodeLogger);',
				resolveDir: process.cwd(),
			},
			bundle: true,
			platform: "browser",
			write: false,
			logLevel: "silent",
		}),
		/Could not resolve/,
	);
});

test("context accessors and nested serializers never execute", async (t) => {
	const directory = await fixture(t);
	const logger = createNodeLogger({ role: "main", directory });
	let invoked = 0;
	const payload = {
		toJSON() {
			invoked++;
			return "SECRET_SENTINEL";
		},
	};
	assert.equal(
		logger.record({
			toString() {
				invoked++;
				return "app.start";
			},
			toJSON: payload.toJSON,
		}),
		false,
	);
	const context = {
		get stage() {
			invoked++;
			return invoked === 1 ? "storage-open" : payload;
		},
		generation: payload,
		durationMs: payload,
	};
	assert.equal(logger.record("app.start", context), true);
	assert.equal(await logger.close(), "flushed");
	assert.equal(invoked, 0);
	const record = JSON.parse((await readFile(join(directory, "desktop.log"), "utf8")).trim());
	assert.deepEqual(record.context, {});
});

test("existing linked log targets fail without touching their destinations", async (t) => {
	const directory = await fixture(t);
	const target = join(directory, "target");
	await writeFile(target, "untouched");
	const hard = join(directory, "hard");
	await mkdir(hard);
	await link(target, join(hard, "desktop.log"));
	const a = createNodeLogger({ role: "main", directory: hard });
	assert.equal(await a.close(), "failed");
	if (process.platform !== "win32") {
		const linked = join(directory, "linked");
		await symlink(hard, linked);
		const b = createNodeLogger({ role: "main", directory: linked });
		assert.equal(await b.close(), "failed");
		const plain = join(directory, "plain");
		await mkdir(plain);
		await symlink(target, join(plain, "desktop.log"));
		const c = createNodeLogger({ role: "main", directory: plain });
		assert.equal(await c.close(), "failed");
	}
	assert.equal(await readFile(target, "utf8"), "untouched");
});
