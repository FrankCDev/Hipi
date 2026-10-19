/**
 * Serial, disposable SQLite directory benchmark; no submissions, credentials or user files.
 * Run from any directory: node --conditions=source packages/work-runtime/scripts/benchmark-capacity.ts
 * Optional: --scales=10,100,1000 --samples=30 --restarts=3 --idle-ms=30000 --output=/absolute/result.json
 * Each scale runs in a fresh process. Cold reads use fresh processes, but do not flush the OS page cache.
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, readdir, readFile, rm, stat, statfs, writeFile } from "node:fs/promises";
import { availableParallelism, cpus, freemem, platform, release, tmpdir, totalmem } from "node:os";
import { dirname, join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { PROTOCOL_VERSION } from "../src/contracts.ts";
import { openTestRuntime } from "../src/testing.ts";

const script = fileURLToPath(import.meta.url);
const root = resolve(dirname(script), "../../..");
const flags = new Map(
	process.argv.slice(2).map((arg) => {
		assert.match(arg, /^--[a-z-]+=.+$/);
		const index = arg.indexOf("=");
		return [arg.slice(2, index), arg.slice(index + 1)];
	}),
);
function integer(name: string, fallback: number): number {
	const value = Number(flags.get(name) ?? fallback);
	assert.ok(Number.isSafeInteger(value) && value >= (name === "idle-ms" ? 0 : 1), `Invalid ${name}`);
	return value;
}
const samples = integer("samples", 30);
const restarts = integer("restarts", 3);
const idleMs = integer("idle-ms", 30000);
const minFreeBytes = integer("min-free-bytes", 1024 ** 3);
const maxRssBytes = integer("max-rss-bytes", 2 * 1024 ** 3);
function summary(values: number[]) {
	const sorted = [...values].sort((a, b) => a - b);
	return {
		count: sorted.length,
		p50: sorted[Math.ceil(sorted.length * 0.5) - 1],
		p95: sorted[Math.ceil(sorted.length * 0.95) - 1],
		max: sorted.at(-1),
	};
}
async function timed<T>(operation: () => Promise<T>): Promise<{ value: T; ms: number }> {
	const start = performance.now();
	const value = await operation();
	return { value, ms: performance.now() - start };
}
async function files(directory: string): Promise<string[]> {
	const result: string[] = [];
	for (const entry of await readdir(directory, { withFileTypes: true })) {
		const path = join(directory, entry.name);
		if (entry.isDirectory()) result.push(...(await files(path)));
		else if (entry.isFile()) result.push(path);
	}
	return result.sort();
}
async function footprint(directory: string) {
	const entries = await Promise.all(
		(await files(directory)).map(async (path) => ({
			name: path.slice(directory.length + 1),
			bytes: (await stat(path)).size,
		})),
	);
	return { totalBytes: entries.reduce((sum, entry) => sum + entry.bytes, 0), files: entries };
}
async function resources(directory: string) {
	const disk = await statfs(directory);
	const memory = process.memoryUsage();
	assert.ok(disk.bavail * disk.bsize >= minFreeBytes, "Disk guard: less than configured free reserve");
	assert.ok(memory.rss <= maxRssBytes, "RSS guard exceeded");
	return {
		...memory,
		systemFreeBytes: freemem(),
		diskFreeBytes: disk.bavail * disk.bsize,
		filesystemType: disk.type,
		filesystemBytes: disk.blocks * disk.bsize,
	};
}
async function sourceHashes() {
	const paths = [
		script,
		join(root, "package-lock.json"),
		...(await files(join(root, "packages/work-runtime/src"))),
		...(await files(join(root, "packages/durable/src"))),
		...(await files(join(root, "packages/ai/src"))),
	];
	const hashes: Record<string, string> = {};
	for (const path of paths)
		hashes[path.slice(root.length + 1)] = createHash("sha256")
			.update(await readFile(path))
			.digest("hex");
	return hashes;
}
function gitHead(): string | null {
	try {
		return execFileSync("git", ["rev-parse", "HEAD"], {
			cwd: root,
			encoding: "utf8",
			stdio: ["ignore", "pipe", "ignore"],
		}).trim();
	} catch {
		return null;
	}
}
function child(args: string[]): unknown {
	return JSON.parse(
		execFileSync(process.execPath, ["--conditions=source", script, ...args], {
			cwd: root,
			encoding: "utf8",
			maxBuffer: 16 * 1024 ** 2,
			timeout: 60 * 60 * 1000,
		}),
	);
}

if (flags.has("cold-directory")) {
	const directory = flags.get("cold-directory");
	assert.ok(directory);
	const opening = await timed(() => openTestRuntime(directory));
	try {
		const first = await timed(() => opening.value.call("listConversations", { workspaceId: "work", filter: "all" }));
		console.log(
			JSON.stringify({
				openMs: opening.ms,
				firstPageMs: first.ms,
				openToFirstPageMs: opening.ms + first.ms,
				firstPageItems: first.value.items.length,
				memory: process.memoryUsage(),
			}),
		);
	} finally {
		await opening.value.close();
	}
} else if (flags.has("scale")) {
	const scale = integer("scale", 10);
	const directory = await mkdtemp(join(tmpdir(), "hipi-capacity-bench-"));
	const before = await resources(directory);
	let peakRss = before.rss;
	let peakHeap = before.heapUsed;
	const sampleMemory = () => {
		const memory = process.memoryUsage();
		peakRss = Math.max(peakRss, memory.rss);
		peakHeap = Math.max(peakHeap, memory.heapUsed);
	};
	const interval = setInterval(sampleMemory, 20);
	const openingStarted = performance.now();
	let runtime = await openTestRuntime(directory);
	const rootOpenMs = performance.now() - openingStarted;
	try {
		const workspace = await timed(() =>
			runtime.call("createWorkspace", { workspaceId: "work", name: "Disposable capacity benchmark" }),
		);
		const seedStart = performance.now();
		for (let i = 0; i < scale; i++) {
			const conversation = await runtime.call("createConversation", {
				workspaceId: "work",
				requestId: `seed-create-${i}`,
				title: `Archived ${i}`,
			});
			await runtime.call("archiveConversation", {
				workspaceId: "work",
				conversationId: conversation.conversationId,
				expectedRevision: conversation.revision,
				requestId: `seed-archive-${i}`,
			});
			sampleMemory();
			if (i % 50 === 0) await resources(directory);
		}
		const seedMs = performance.now() - seedStart;
		const projection = await timed(() => runtime.call("listConversations", { workspaceId: "work", filter: "all" }));
		let page = projection.value;
		let tailCursor: string | undefined;
		let pageCount = 1;
		let itemCount = page.items.length;
		const seen = new Set(page.items.map((item) => item.conversationId));
		while (page.nextCursor) {
			tailCursor = page.nextCursor;
			page = await runtime.call("listConversations", { workspaceId: "work", filter: "all", cursor: tailCursor });
			itemCount += page.items.length;
			for (const item of page.items) {
				assert.ok(!seen.has(item.conversationId));
				seen.add(item.conversationId);
			}
			pageCount++;
		}
		assert.equal(itemCount, scale);
		seen.clear();
		assert.equal((await runtime.call("listConversations", { workspaceId: "work" })).items.length, 0);
		const firstPageMs: number[] = [];
		const tailPageMs: number[] = [];
		for (let i = 0; i < samples; i++) {
			firstPageMs.push(
				(await timed(() => runtime.call("listConversations", { workspaceId: "work", filter: "all" }))).ms,
			);
			tailPageMs.push(
				(
					await timed(() =>
						runtime.call("listConversations", {
							workspaceId: "work",
							filter: "all",
							...(tailCursor ? { cursor: tailCursor } : {}),
						}),
					)
				).ms,
			);
		}
		const seededDisk = await footprint(directory);
		await runtime.close();
		const coldReads = [];
		for (let i = 0; i < restarts; i++) coldReads.push(child([`--cold-directory=${directory}`]));
		runtime = await openTestRuntime(directory);
		const firstMutationAfterReopen = await timed(() =>
			runtime.call("createConversation", { workspaceId: "work", requestId: "warmup-create", title: "Warmup" }),
		);
		await runtime.call("archiveConversation", {
			workspaceId: "work",
			conversationId: firstMutationAfterReopen.value.conversationId,
			requestId: "warmup-archive",
			expectedRevision: 1,
		});
		const measurements: Record<string, number[]> = {
			create: [],
			rename: [],
			archive: [],
			restore: [],
			rearchive: [],
		};
		for (let i = 0; i < samples; i++) {
			const created = await timed(() =>
				runtime.call("createConversation", {
					workspaceId: "work",
					requestId: `measure-create-${i}`,
					title: `Measurement ${i}`,
				}),
			);
			measurements.create.push(created.ms);
			let conversation = created.value;
			for (const method of [
				"renameConversation",
				"archiveConversation",
				"restoreConversation",
				"archiveConversation",
			] as const) {
				const key =
					method === "renameConversation"
						? "rename"
						: method === "restoreConversation"
							? "restore"
							: conversation.revision === 4
								? "rearchive"
								: "archive";
				const measured = await timed(() =>
					runtime.call(method, {
						workspaceId: "work",
						conversationId: conversation.conversationId,
						expectedRevision: conversation.revision,
						requestId: `measure-${key}-${i}`,
						...(method === "renameConversation" ? { title: `Renamed ${i}` } : {}),
					}),
				);
				conversation = measured.value;
				measurements[key].push(measured.ms);
			}
			assert.ok(conversation.archivedAt);
			sampleMemory();
			await resources(directory);
		}
		const finalProjection = await timed(() =>
			runtime.call("listConversations", { workspaceId: "work", filter: "all" }),
		);
		const afterWork = await resources(directory);
		await delay(idleMs);
		const idle = await resources(directory);
		const openDisk = await footprint(directory);
		await runtime.close();
		const closedDisk = await footprint(directory);
		console.log(
			JSON.stringify({
				scale,
				finalHistoricalConversations: scale + samples + 1,
				maxActiveConversations: 1,
				samples,
				restarts,
				idleMs,
				initialization: {
					rootOpenMs,
					workspaceSchemaAndHarnessMs: workspace.ms,
					seedMs,
					initialProjectionCatchupMs: projection.ms,
					initialExpectedDirectoryChanges: scale * 2,
					firstMutationAfterReopenMs: firstMutationAfterReopen.ms,
					finalProjectionCatchupMs: finalProjection.ms,
					finalExpectedDirectoryChanges: 2 + samples * 5,
				},
				pageCount,
				verifiedUniqueItems: itemCount,
				latencyMs: {
					firstPage: summary(firstPageMs),
					tailPage: summary(tailPageMs),
					...Object.fromEntries(Object.entries(measurements).map(([name, values]) => [name, summary(values)])),
				},
				rawLatencyMs: { firstPage: firstPageMs, tailPage: tailPageMs, ...measurements },
				coldReads,
				memory: {
					before,
					afterWork,
					idle,
					sampledPeakRssBytes: peakRss,
					sampledPeakHeapBytes: peakHeap,
					sampleIntervalMs: 20,
					processMaxRssKiB: process.resourceUsage().maxRSS,
				},
				disk: { seeded: seededDisk, open: openDisk, closed: closedDisk },
			}),
		);
	} finally {
		clearInterval(interval);
		await runtime.close();
		await rm(directory, { recursive: true, force: true });
	}
} else {
	const scales = (flags.get("scales") ?? "10,100,1000").split(",").map(Number);
	assert.ok(scales.every((scale) => Number.isSafeInteger(scale) && scale > 0));
	const startedAt = new Date().toISOString();
	const initialFreeMemoryBytes = freemem();
	const sourcesBefore = await sourceHashes();
	const sqlite = new DatabaseSync(":memory:");
	const sqliteVersion = sqlite.prepare("SELECT sqlite_version() AS version").get()?.version;
	sqlite.close();
	const results = [];
	for (const scale of scales) {
		console.error(`Benchmarking ${scale} historical conversations, serially`);
		results.push(
			child([
				`--scale=${scale}`,
				`--samples=${samples}`,
				`--restarts=${restarts}`,
				`--idle-ms=${idleMs}`,
				`--min-free-bytes=${minFreeBytes}`,
				`--max-rss-bytes=${maxRssBytes}`,
			]),
		);
	}
	const sourcesAfter = await sourceHashes();
	const changedSources = [...new Set([...Object.keys(sourcesBefore), ...Object.keys(sourcesAfter)])].filter(
		(path) => sourcesBefore[path] !== sourcesAfter[path],
	);
	const result = {
		schemaVersion: 1,
		startedAt,
		finishedAt: new Date().toISOString(),
		command: [process.execPath, ...process.execArgv, ...process.argv.slice(1)],
		environment: {
			temporaryRoot: tmpdir(),
			node: process.version,
			sqlite: sqliteVersion,
			platform: platform(),
			release: release(),
			arch: process.arch,
			cpu: cpus()[0]?.model,
			logicalCpus: cpus().length,
			availableParallelism: availableParallelism(),
			totalMemoryBytes: totalmem(),
			initialFreeMemoryBytes,
			gitHead: gitHead(),
			protocolVersion: PROTOCOL_VERSION,
		},
		limits: { minFreeBytes, maxRssBytes },
		scope: "One workspace, empty archived conversations, no model calls; local in-process public API; fresh-process restart with warm OS cache; no legacy migration, audit, submission, UI, transport, crash or multi-workspace benchmark. Metadata timings exclude deferred root projection, measured separately. No explicit GC; 20ms sampled memory peak can miss short spikes. Cold-read imports/process startup excluded from latency.",
		sourcesBefore,
		sourcesAfter,
		changedSources,
		results,
	};
	const json = `${JSON.stringify(result, null, 2)}\n`;
	if (flags.has("output")) await writeFile(resolve(flags.get("output") ?? ""), json, { flag: "wx" });
	else console.log(json);
}
