import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { WorkRuntime } from "@hipi/work-runtime";
import { AppError } from "@hipi/work-runtime/contracts";
import { FileServiceError } from "@hipi/work-runtime/files";
import { parseFileRoots } from "@hipi/work-runtime/files/protocol";
import { createPreviewClient, parsePreviewRequest } from "@hipi/work-runtime/previews/protocol";
import { createFileRuntime } from "../src/file-runtime.ts";
import { HostConnection } from "../src/host-connection.ts";
import { PreviewConnection } from "../src/preview-connection.ts";
import { previewInvocation } from "../src/preview-protocol.ts";
import { createPreviewRuntime } from "../src/preview-runtime.ts";
import { decode, encode } from "../src/protocol.ts";

const request = parsePreviewRequest({
	version: 1,
	expectedStoreId: "store",
	method: "open",
	params: { workspaceId: "work", rootId: "root", path: "test.csv" },
});

test("preview input rejects absolute paths, raw URLs and principal overrides", () => {
	assert.deepEqual(previewInvocation({ id: "one", request }), { id: "one", request });
	for (const params of [
		{ ...request.params, path: "/etc/passwd" },
		{ ...request.params, url: "file:///private" },
		{ ...request.params, principalId: "another" },
	])
		assert.throws(() => previewInvocation({ id: "one", request: { ...request, params } }));
	assert.throws(() => previewInvocation({ id: "one", request, channel: "raw-ipc" }));
});

test("preview wait rejects stale generation and sends cancellation without replay", async () => {
	const sent: string[] = [];
	const connection = new PreviewConnection("new", (raw) => sent.push(raw));
	const pending = connection.call(request);
	connection.receive(
		encode({ generation: "old", kind: "previewResult", id: decode(sent[0]).id, ok: false, error: "UNAUTHORIZED" }),
	);
	const rejected = assert.rejects(pending.result, { code: "CLOSED" });
	pending.cancel();
	await rejected;
	assert.deepEqual(
		sent.map((raw) => decode(raw).kind),
		["previewCall", "previewCancel"],
	);
	connection.close();
	assert.throws(() => connection.call(request), { code: "CLOSED" });
});

test("preview cancellation reaches utility handler and shutdown drains it", async () => {
	let signal: AbortSignal | undefined;
	let began = () => {};
	const started = new Promise<void>((resolve) => {
		began = resolve;
	});
	const output: string[] = [];
	const runtime = createPreviewRuntime(
		{
			async execute(_raw, inputSignal) {
				signal = inputSignal;
				began();
				await new Promise<void>((resolve) => inputSignal?.addEventListener("abort", () => resolve(), { once: true }));
				throw new FileServiceError("CLOSED");
			},
		},
		"generation",
		(raw) => output.push(raw),
	);
	const pending = runtime.receive(encode({ generation: "generation", kind: "previewCall", id: "one", input: request }));
	await started;
	await assert.rejects(runtime.receive(encode({ generation: "old", kind: "previewCancel", id: "one" })), {
		code: "UNAUTHORIZED",
	});
	assert.equal(signal?.aborted, false);
	await runtime.close();
	await pending;
	assert.equal(signal?.aborted, true);
	assert.deepEqual(output, []);
});

test("preview transport admission is bounded and close cancels every pending parse", async () => {
	const connection = new PreviewConnection("new", () => {});
	const pending = Array.from({ length: 16 }, () => connection.call(request));
	assert.throws(() => connection.call(request), { code: "BUSY" });
	const rejected = pending.map((entry) => assert.rejects(entry.result, { code: "CLOSED" }));
	connection.close();
	await Promise.all(rejected);
});

test("desktop files and previews share grants; revoke blocks cached handles and store mismatch", async () => {
	const directory = await mkdtemp(join(tmpdir(), "hipi-desktop-previews-"));
	const rejectFeatureRead = async () => {
		throw new Error("Previews must not read tool packs or activities");
	};
	const runtime = new WorkRuntime({
		storeId: "store",
		previewToolPack: rejectFeatureRead,
		listToolPacks: rejectFeatureRead,
		getToolPackSource: rejectFeatureRead,
		listToolPackBindings: rejectFeatureRead,
		listActiveToolPackBindings: rejectFeatureRead,
		getToolPackCommandResult: rejectFeatureRead,
		getToolActivities: rejectFeatureRead,
		getToolActivityText: rejectFeatureRead,
		listWorkspaces: async () => ({ items: [{ workspaceId: "work", name: "Preview fixtures" }], nextCursor: null }),
		getWorkspace: async ({ workspaceId }) => {
			if (workspaceId !== "work") throw new AppError("NOT_FOUND");
			return { workspaceId, name: "Preview fixtures" };
		},
		listModels: async () => {
			throw new Error("No model access");
		},
		listConversations: async () => {
			throw new Error("No conversation access");
		},
		getConversation: async () => {
			throw new Error("No conversation read access");
		},
		getConversationCommandResult: async () => {
			throw new Error("No conversation command access");
		},
		getAgentCommandResult: async () => {
			throw new Error("No agent command access");
		},
		openWorkspace: async () => {
			throw new Error("No workspace open");
		},
		close: async () => {},
	});
	const tasks = new Set<Promise<boolean>>();
	const connection = new HostConnection("generation", (raw) => {
		const task = files.receive(raw);
		tasks.add(task);
		void task.finally(() => tasks.delete(task)).catch(() => connection.close());
	});
	const files = await createFileRuntime(runtime, "generation", (raw) => connection.receive(raw));
	const previews = createPreviewClient({
		storeId: "store",
		request: (input) => connection.previews.call(input).result,
	});
	try {
		await writeFile(join(directory, "table.csv"), 'name,value\n"<script>",=1+1');
		const root = parseFileRoots(
			[
				await connection.files.call({
					operation: "grant",
					expectedStoreId: "store",
					workspaceId: "work",
					absolutePath: directory,
					writable: false,
				}),
			],
			"work",
		)[0];
		const target = { workspaceId: "work", rootId: root.rootId, path: "table.csv" };
		const handle = await previews.open(target);
		assert.equal(handle.kind, "csv");
		const page = await previews.readPage(handle.id, 0);
		assert.equal(page.content.kind, "spreadsheet");
		assert.equal(JSON.stringify(page).includes(directory), false);
		await assert.rejects(connection.previews.call({ ...request, expectedStoreId: "wrong", params: target }).result, {
			code: "UNAUTHORIZED",
		});
		await connection.files.call({
			operation: "revoke",
			expectedStoreId: "store",
			workspaceId: "work",
			rootId: root.rootId,
		});
		await assert.rejects(previews.readPage(handle.id, 0), { code: "UNAUTHORIZED" });
		await assert.rejects(previews.open(target), { code: "UNAUTHORIZED" });
		await files.close();
		await assert.rejects(connection.previews.call(request).result, { code: "CLOSED" });
	} finally {
		connection.close();
		await Promise.all(tasks);
		await files.close();
		await runtime.close();
		await rm(directory, { recursive: true, force: true });
	}
});

test("cancel crossing a successful open reply reclaims its handle", async () => {
	const sent: string[] = [];
	const connection = new PreviewConnection("new", (raw) => sent.push(raw));
	const pending = connection.call(request);
	const rejected = assert.rejects(pending.result, { code: "CLOSED" });
	pending.cancel();
	await rejected;
	connection.receive(
		encode({
			generation: "new",
			kind: "previewResult",
			id: decode(sent[0]).id,
			ok: true,
			result: {
				version: 1,
				storeId: "store",
				request,
				ok: true,
				result: {
					id: "orphan",
					revision: "a".repeat(64),
					kind: "csv",
					summary: { bytes: 8, pages: 1, truncated: false },
				},
			},
		}),
	);
	const cleanup = decode(sent[2]);
	assert.equal(cleanup.kind, "previewCall");
	assert.deepEqual(cleanup.input, { version: 1, expectedStoreId: "store", method: "close", params: { id: "orphan" } });
	connection.close();
});
