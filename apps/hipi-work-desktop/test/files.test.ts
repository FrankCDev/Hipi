import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { WorkRuntime } from "@hipi/work-runtime";
import { AppError } from "@hipi/work-runtime/contracts";
import { createFileClient, parseFileRoots } from "@hipi/work-runtime/files/protocol";
import { FileConnection } from "../src/file-connection.ts";
import { manageFileRoots } from "../src/file-picker.ts";
import { rootRequest } from "../src/file-protocol.ts";
import { createFileRuntime } from "../src/file-runtime.ts";
import { decode, encode } from "../src/protocol.ts";

function catalog() {
	const rejectFeatureRead = async () => {
		throw new Error("Files must not access presentation metadata, tool packs, activities, or provider settings");
	};
	return new WorkRuntime({
		storeId: "store",
		refreshConversationSearch: rejectFeatureRead,
		searchConversations: rejectFeatureRead,
		getHistoryAroundMatch: rejectFeatureRead,
		getConversationPresentation: rejectFeatureRead,
		listPinnedConversations: rejectFeatureRead,
		setConversationPinned: rejectFeatureRead,
		reorderPinnedConversation: rejectFeatureRead,
		getPresentationCommandResult: rejectFeatureRead,
		listCustomProviders: rejectFeatureRead,
		saveCustomProvider: rejectFeatureRead,
		removeCustomProvider: rejectFeatureRead,
		listBuiltInProviders: rejectFeatureRead,
		getBuiltInProviderModels: rejectFeatureRead,
		previewToolPack: rejectFeatureRead,
		listToolPacks: rejectFeatureRead,
		getToolPackSource: rejectFeatureRead,
		listToolPackBindings: rejectFeatureRead,
		listActiveToolPackBindings: rejectFeatureRead,
		getToolPackCommandResult: rejectFeatureRead,
		getToolActivities: rejectFeatureRead,
		getToolActivityText: rejectFeatureRead,
		listWorkspaces: async () => ({ items: [{ workspaceId: "work", name: "Files" }], nextCursor: null }),
		getWorkspace: async ({ workspaceId }) => {
			if (workspaceId !== "work") throw new AppError("NOT_FOUND");
			return { workspaceId, name: "Files" };
		},
		listModels: async () => {
			throw new Error("Files must not touch models");
		},
		listConversations: async () => {
			throw new Error("Files must not touch conversations");
		},
		getConversation: async () => {
			throw new Error("Files must not read conversations");
		},
		getConversationCommandResult: async () => {
			throw new Error("Files must not read conversation commands");
		},
		getAgentCommandResult: async () => {
			throw new Error("Files must not read agent commands");
		},
		openWorkspace: async () => {
			throw new Error("Files must not open/resume workspaces");
		},
		close: async () => {},
	});
}
async function fixture(generation = "first") {
	const runtime = catalog();
	const tasks = new Set<Promise<boolean>>();
	const host = new FileConnection(generation, (raw) => {
		const task = files.receive(raw);
		tasks.add(task);
		void task.finally(() => tasks.delete(task)).catch(() => host.close());
	});
	const files = await createFileRuntime(runtime, generation, (raw) => host.receive(raw));
	const client = createFileClient({
		storeId: "store",
		request: (request) => host.call({ operation: "request", request }),
	});
	return {
		host,
		files,
		client,
		async close() {
			host.close();
			await Promise.all(tasks);
			await files.close();
			await runtime.close();
		},
	};
}
const pick = { version: 1, operation: "pick", expectedStoreId: "store", workspaceId: "work", writable: true };

test("public picker rejects paths, principals and arbitrary operations", () => {
	for (const extra of [{ absolutePath: "/tmp" }, { principalId: "other" }, { operation: "grant" }, { version: 2 }])
		assert.throws(() => rootRequest({ ...pick, ...extra }));
});

test("trusted picker grants only catalog workspaces; file save, conflict and revoke use one authority", async () => {
	const directory = await mkdtemp(join(tmpdir(), "hipi-desktop-files-"));
	const app = await fixture();
	try {
		await writeFile(join(directory, "note.txt"), "before");
		let selections = 0;
		const picker = async () => {
			selections++;
			return directory;
		};
		await assert.rejects(
			manageFileRoots(
				pick,
				() => app.host,
				() => false,
				picker,
			),
			{ code: "UNAUTHORIZED" },
		);
		await assert.rejects(
			manageFileRoots(
				{ ...pick, workspaceId: "missing" },
				() => app.host,
				() => true,
				picker,
			),
			{ code: "UNAUTHORIZED" },
		);
		await assert.rejects(
			manageFileRoots(
				{ ...pick, expectedStoreId: "other" },
				() => app.host,
				() => true,
				picker,
			),
			{ code: "UNAUTHORIZED" },
		);
		assert.equal(selections, 0);
		const root = parseFileRoots(
			[
				await manageFileRoots(
					pick,
					() => app.host,
					() => true,
					picker,
				),
			],
			"work",
		)[0];
		assert.equal(JSON.stringify(root).includes(directory), false);
		const target = { workspaceId: "work", rootId: root.rootId, path: "note.txt" };
		const before = await app.client.readText(target);
		await app.client.saveText(target, "after", before.revision);
		assert.equal(await readFile(join(directory, "note.txt"), "utf8"), "after");
		await assert.rejects(app.client.saveText(target, "stale", before.revision), { code: "VERSION_CONFLICT" });
		await manageFileRoots(
			{ version: 1, operation: "revoke", workspaceId: "work", expectedStoreId: "store", rootId: root.rootId },
			() => app.host,
			() => true,
			picker,
		);
		assert.deepEqual(await app.client.listRoots("work"), []);
		await assert.rejects(app.client.readText(target), { code: "UNAUTHORIZED" });
	} finally {
		await app.close();
		await rm(directory, { recursive: true, force: true });
	}
});

test("cancelled, stale renderer, and replaced utility picker results cannot create grants", async () => {
	const app = await fixture();
	const replacement = await fixture("second");
	try {
		assert.equal(
			await manageFileRoots(
				pick,
				() => app.host,
				() => true,
				async () => null,
			),
			null,
		);
		let owned = true;
		await assert.rejects(
			manageFileRoots(
				pick,
				() => app.host,
				() => owned,
				async () => {
					owned = false;
					return "/unused";
				},
			),
			{ code: "CLOSED" },
		);
		let current = app.host;
		await assert.rejects(
			manageFileRoots(
				pick,
				() => current,
				() => true,
				async () => {
					current = replacement.host;
					return "/unused";
				},
			),
			{ code: "CLOSED" },
		);
		assert.deepEqual(await app.client.listRoots("work"), []);
		assert.deepEqual(await replacement.client.listRoots("work"), []);
	} finally {
		await app.close();
		await replacement.close();
	}
});

test("utility restart revokes grants and cannot resolve old generation replies", async () => {
	const directory = await mkdtemp(join(tmpdir(), "hipi-desktop-grants-"));
	const first = await fixture();
	const second = await fixture("second");
	try {
		await manageFileRoots(
			pick,
			() => first.host,
			() => true,
			async () => directory,
		);
		assert.equal((await first.client.listRoots("work")).length, 1);
		await first.close();
		assert.deepEqual(await second.client.listRoots("work"), []);
		await assert.rejects(
			second.files.receive(
				encode({
					generation: "first",
					kind: "fileCall",
					id: "1",
					input: { operation: "check", expectedStoreId: "store", workspaceId: "work" },
				}),
			),
			{ code: "UNAUTHORIZED" },
		);
	} finally {
		await first.close();
		await second.close();
		await rm(directory, { recursive: true, force: true });
	}
});

test("lost save replies report unknown and never replay; stale generation cannot settle a wait", async () => {
	const output: string[] = [];
	const host = new FileConnection("new", (raw) => output.push(raw));
	const request = {
		version: 1 as const,
		expectedStoreId: "store",
		method: "saveText" as const,
		params: { workspaceId: "work", rootId: "root", path: "note.txt", text: "new", ifMatch: "a".repeat(64) },
	};
	const pending = host.call({ operation: "request", request });
	host.receive(
		encode({ generation: "old", kind: "fileResult", id: decode(output[0]).id, ok: false, error: "UNAUTHORIZED" }),
	);
	host.close();
	await assert.rejects(pending, { code: "WRITE_OUTCOME_UNKNOWN" });
	assert.equal(output.length, 1);
});

test("read-only picker grants deny writes and closed utility denies new grants", async () => {
	const directory = await mkdtemp(join(tmpdir(), "hipi-desktop-readonly-"));
	const app = await fixture();
	try {
		await writeFile(join(directory, "note.txt"), "original");
		const root = parseFileRoots(
			[
				await manageFileRoots(
					{ ...pick, writable: false },
					() => app.host,
					() => true,
					async (writable) => {
						assert.equal(writable, false);
						return directory;
					},
				),
			],
			"work",
		)[0];
		const target = { workspaceId: "work", rootId: root.rootId, path: "note.txt" };
		const content = await app.client.readText(target);
		await assert.rejects(app.client.saveText(target, "forbidden", content.revision), { code: "UNAUTHORIZED" });
		assert.equal(await readFile(join(directory, "note.txt"), "utf8"), "original");
		await app.files.close();
		await assert.rejects(
			app.host.call({
				operation: "grant",
				expectedStoreId: "store",
				workspaceId: "work",
				absolutePath: directory,
				writable: true,
			}),
			{ code: "CLOSED" },
		);
	} finally {
		await app.close();
		await rm(directory, { recursive: true, force: true });
	}
});

test("file wait admission is bounded and host close rejects every pending operation", async () => {
	const host = new FileConnection("first", () => {});
	const input = { operation: "check" as const, expectedStoreId: "store", workspaceId: "work" };
	const pending = Array.from({ length: 16 }, () => host.call(input));
	await assert.rejects(host.call(input), { code: "BUSY" });
	const rejected = pending.map((operation) => assert.rejects(operation, { code: "CLOSED" }));
	host.close();
	await Promise.all(rejected);
});
