import assert from "node:assert/strict";
import { mkdtemp, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels, fauxProvider } from "@earendil-works/pi-ai";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { AppError, type Frame, PROTOCOL_VERSION, type ReceiptView, type Scope } from "../src/contracts.ts";
import type { WorkRuntime } from "../src/core.ts";
import { openRuntime as openNodeRuntime } from "../src/node.ts";
import { type Failpoint, PiWorkspace, WorkspaceShutdownFailed } from "../src/pi-workspace.ts";
import { deterministicModels, openTestRuntime as openRuntime } from "../src/testing.ts";

async function until<T>(check: () => Promise<T | undefined>): Promise<T> {
	const deadline = Date.now() + 15000;
	while (Date.now() < deadline) {
		const result = await check();
		if (result !== undefined) return result;
		await new Promise((resolve) => setTimeout(resolve, 10));
	}
	throw new Error("Condition timed out");
}
async function setup(runtime: WorkRuntime): Promise<Scope> {
	await runtime.call("createWorkspace", { workspaceId: "work", name: "Test workspace" });
	const created = await runtime.call("createConversation", {
		requestId: "create-1",
		workspaceId: "work",
		title: "Test conversation",
	});
	return { workspaceId: created.workspaceId, conversationId: created.conversationId };
}
async function done(runtime: WorkRuntime, requestId = "request_1"): Promise<ReceiptView> {
	return until(async () => {
		const receipt = await runtime.call("getReceipt", { workspaceId: "work", requestId });
		return receipt?.execution === "done" ? receipt : undefined;
	});
}

test("SQLite-backed loop, concurrent retries, target/content conflicts, stream and read-only reopen", async () => {
	const directory = await mkdtemp(join(tmpdir(), "hipi-core-"));
	let runtime = await openRuntime(directory, { tokensPerSecond: 60 });
	try {
		const scope = await setup(runtime);
		const exposed = await runtime.call("openWorkspace", { workspaceId: "work" });
		exposed.workspaceId = "mutated";
		assert.equal((await runtime.call("openWorkspace", { workspaceId: "work" })).workspaceId, "work");
		const frames: Frame[] = [];
		const watcher = await runtime.observe(scope, (frame) => {
			frames.push(frame);
		});
		const input = { ...scope, requestId: "request_1", text: "hello" };
		const receipts = await Promise.all(Array.from({ length: 5 }, () => runtime.call("submit", input)));
		assert.equal(new Set(receipts.map((r) => r.receiptId)).size, 1);
		await assert.rejects(runtime.call("submit", { ...input, text: "changed" }), { code: "IDEMPOTENCY_CONFLICT" });
		const other = await runtime.call("createConversation", {
			requestId: "create-2",
			workspaceId: "work",
			title: "Other",
		});
		await assert.rejects(runtime.call("submit", { ...input, conversationId: other.conversationId }), {
			code: "IDEMPOTENCY_CONFLICT",
		});
		const settled = await done(runtime);
		assert.match(settled.answer ?? "", /deterministic test answer/);
		await until(async () => (frames.some((frame) => frame.snapshot.partial.length > 0) ? true : undefined));
		await watcher.dispose();
		const before = await runtime.call("snapshot", scope);
		assert.equal(before.messages.filter((m) => m.role === "user").length, 1);
		assert.equal(before.messages.filter((m) => m.role === "assistant").length, 1);
		await runtime.close();
		runtime = await openRuntime(directory);
		assert.deepEqual(await runtime.call("snapshot", scope), before);
		assert.deepEqual(await runtime.call("getReceipt", { workspaceId: "work", requestId: "request_1" }), settled);
		const retry = await runtime.call("submit", input);
		assert.equal(retry.receiptId, settled.receiptId);
		assert.equal(retry.submissionId, settled.submissionId);
	} finally {
		await runtime.close();
		await rm(directory, { recursive: true, force: true });
	}
});

for (const failure of ["after_accept", "after_dispatch_mark", "after_submit"] satisfies Failpoint[]) {
	test(`recover persisted intent at ${failure} without creating a second input`, async () => {
		const directory = await mkdtemp(join(tmpdir(), "hipi-recover-"));
		let fired = false;
		let runtime = await openRuntime(directory, {
			tokensPerSecond: 200,
			failpoint: async (point) => {
				if (point === failure) {
					fired = true;
					throw new Error("Injected interruption");
				}
			},
		});
		try {
			const scope = await setup(runtime);
			const input = { ...scope, requestId: "request_1", text: "original" };
			if (failure === "after_accept") await assert.rejects(runtime.call("submit", input), /Injected/);
			else await runtime.call("submit", input);
			await until(async () => (fired ? true : undefined));
			const original = await runtime.call("getReceipt", { workspaceId: "work", requestId: "request_1" });
			assert.ok(original);
			await runtime.close();
			runtime = await openRuntime(directory, { resume: true, tokensPerSecond: 200 });
			await runtime.call("openWorkspace", { workspaceId: "work" });
			const final = await done(runtime);
			assert.equal(final.receiptId, original.receiptId);
			const view = await runtime.call("snapshot", scope);
			assert.equal(view.messages.filter((message) => message.role === "user").length, 1);
		} finally {
			await runtime.close();
			await rm(directory, { recursive: true, force: true });
		}
	});
}

test("cancelWait and observer disposal do not cancel execution; directory alias cannot acquire a second owner", async () => {
	const directory = await mkdtemp(join(tmpdir(), "hipi-owner-"));
	const runtime = await openRuntime(directory, { tokensPerSecond: 60 });
	const alias = `${directory}-alias`;

	try {
		const scope = await setup(runtime);
		await symlink(directory, alias, "dir");
		await assert.rejects(openRuntime(alias), { code: "WORKSPACE_BUSY" });
		const abort = new AbortController();
		const request = runtime.call("submit", { ...scope, requestId: "request_1", text: "continue" }, abort.signal);
		abort.abort(new Error("Only stop waiting"));
		await assert.rejects(request, /Only stop waiting/);
		let delivered = 0;
		const observer = await runtime.observe(scope, () => {
			delivered++;
		});
		await observer.dispose();
		const count = delivered;
		assert.equal((await done(runtime)).execution, "done");
		assert.equal(delivered, count);
		await assert.rejects(
			runtime.execute({ version: PROTOCOL_VERSION, method: "openWorkspace", params: { workspaceId: "../escape" } }),
			AppError,
		);
	} finally {
		await runtime.close();
		await rm(alias, { force: true });
		await rm(directory, { recursive: true, force: true });
	}
});

for (const asynchronous of [false, true]) {
	test(`diagnostic ${asynchronous ? "rejection" : "throw"} cannot break close or release a live writer`, async () => {
		const directory = await mkdtemp(join(tmpdir(), "hipi-diagnostic-"));
		let interrupted = false;
		let runtime = await openRuntime(directory, {
			failpoint: async (point) => {
				if (point === "after_submit") {
					interrupted = true;
					throw new Error("Injected failure");
				}
			},
			onError: () => {
				if (asynchronous) return Promise.reject(new Error("Diagnostic failure"));
				throw new Error("Diagnostic failure");
			},
		});
		try {
			const scope = await setup(runtime);
			await runtime.call("submit", { ...scope, requestId: "request_1", text: "original" });
			await until(async () => (interrupted ? true : undefined));
			await Promise.all([runtime.close(), runtime.close()]);
			runtime = await openRuntime(directory, { resume: true, tokensPerSecond: 200 });
			await runtime.call("openWorkspace", { workspaceId: "work" });
			await done(runtime);
			assert.equal(
				(await runtime.call("snapshot", scope)).messages.filter((message) => message.role === "user").length,
				1,
			);
		} finally {
			await runtime.close();
			await rm(directory, { recursive: true, force: true });
		}
	});
}

test("concurrent retries do not append duplicate dispatch closures", async () => {
	const directory = await mkdtemp(join(tmpdir(), "hipi-queue-"));
	const gate = Promise.withResolvers<void>();
	let calls = 0;
	const runtime = await openRuntime(directory, {
		tokensPerSecond: 200,
		failpoint: async (point) => {
			if (point === "after_dispatch_mark") {
				calls++;
				await gate.promise;
			}
		},
	});
	try {
		const scope = await setup(runtime);
		const input = { ...scope, requestId: "request_1", text: "one input" };
		await runtime.call("submit", input);
		await until(async () => (calls === 1 ? true : undefined));
		await Promise.all(Array.from({ length: 40 }, () => runtime.call("submit", input)));
		gate.resolve();
		await done(runtime);
		await runtime.close();
		assert.equal(calls, 1);
	} finally {
		gate.resolve();
		await runtime.close();
		await rm(directory, { recursive: true, force: true });
	}
});

test("aborting a hung first observer releases every reserved slot", async () => {
	const directory = await mkdtemp(join(tmpdir(), "hipi-observer-"));
	const runtime = await openRuntime(directory);
	try {
		const scope = await setup(runtime);
		const never = new Promise<void>(() => {});
		for (let index = 0; index < 20; index++) {
			const controller = new AbortController();
			const subscription = await runtime.observe(scope, () => never, controller.signal);
			controller.abort();
			await subscription.dispose();
		}
		const last = await runtime.observe(scope, () => {});
		await last.dispose();
	} finally {
		await runtime.close();
		await rm(directory, { recursive: true, force: true });
	}
});

test("a PI open failure with failed cleanup is conservatively marked unsafe to unlock", async () => {
	const directory = await mkdtemp(join(tmpdir(), "hipi-open-failure-"));
	const storage = await openNodeSqliteStorage(join(directory, "workspace.sqlite"));
	const close = storage.close.bind(storage);
	storage.scanTasks = async () => {
		throw new Error("Injected startup read failure");
	};
	storage.close = async () => {
		throw new Error("Injected cleanup failure");
	};
	try {
		await assert.rejects(
			PiWorkspace.open(storage, {
				workspaceId: "work",
				name: "Test",
				models: deterministicModels(),
				model: { provider: "faux", modelId: "faux-1" },
			}),
			WorkspaceShutdownFailed,
		);
	} finally {
		await close(BACKGROUND_CONTEXT);
		await rm(directory, { recursive: true, force: true });
	}
});

test("reopening and reading a pending submission never resumes model scheduling", async () => {
	const directory = await mkdtemp(join(tmpdir(), "hipi-read-only-"));
	let interrupted = false;
	let runtime = await openRuntime(directory, {
		tokensPerSecond: 1,
		failpoint: async (point) => {
			if (point === "after_submit") {
				interrupted = true;
				throw new Error("Stop before mapping");
			}
		},
	});
	try {
		const scope = await setup(runtime);
		await runtime.call("submit", { ...scope, requestId: "request_1", text: "remain paused" });
		await until(async () => (interrupted ? true : undefined));
		await runtime.close();
		const faux = fauxProvider();
		const models = createModels();
		models.setProvider(faux.provider);
		runtime = await openNodeRuntime(directory, {
			models,
			model: { provider: "faux", modelId: "faux-1" },
			resume: false,
		});
		const receipt = await runtime.call("getReceipt", { workspaceId: "work", requestId: "request_1" });
		assert.equal(receipt?.state, "dispatched");
		assert.notEqual(receipt?.execution, "done");
		await runtime.call("snapshot", scope);
		await new Promise((resolve) => setTimeout(resolve, 50));
		assert.equal(faux.state.callCount, 0);
	} finally {
		await runtime.close();
		await rm(directory, { recursive: true, force: true });
	}
});

test("input quota rejects atomically without publishing a receipt", async () => {
	const directory = await mkdtemp(join(tmpdir(), "hipi-capacity-"));
	const runtime = await openRuntime(directory, {
		failpoint: async (point) => {
			if (point === "after_accept") throw new Error("Lost receipt");
		},
	});
	try {
		const scope = await setup(runtime);
		for (let index = 0; index < 64; index++) {
			await assert.rejects(
				runtime.call("submit", { ...scope, requestId: `request_${index}`, text: "bounded" }),
				/Lost receipt/,
			);
		}
		await assert.rejects(runtime.call("submit", { ...scope, requestId: "overflow", text: "bounded" }), {
			code: "CAPACITY_EXCEEDED",
		});
		assert.equal(await runtime.call("getReceipt", { workspaceId: "work", requestId: "overflow" }), null);
	} finally {
		await runtime.close();
		await rm(directory, { recursive: true, force: true });
	}
});
