import assert from "node:assert/strict";
import {
	type AppClient,
	AppError,
	type Method,
	type Params,
	PROTOCOL_VERSION,
	parseResult,
} from "@hipi/work-runtime/contracts";
import { test } from "vitest";
import { LocalState } from "../../../src/features/workbench/local-state.ts";
import { PresentationSession } from "../../../src/features/workbench/sidebar/presentation-session.ts";

const input: Params<"reorderSidebarPin"> = {
	requestId: "mixed-request",
	moved: { kind: "project", projectId: "project" },
	before: { kind: "conversation", workspaceId: "execution", conversationId: "chat" },
	expectedOrderRevision: 7,
};
const current = { items: [], previousCursor: null, nextCursor: null, nextPinKey: null, orderRevision: 12 };
function fixture(local = new LocalState()) {
	const calls: { method: Method; params: unknown }[] = [];
	let handler: (method: Method, params: unknown) => Promise<unknown> = async (method) => {
		if (method === "getSidebarPinCommandResult") return null;
		throw new Error("Lost reply");
	};
	const client: AppClient = {
		call: async (method, params) => {
			calls.push({ method, params });
			return parseResult(method, await handler(method, params));
		},
		observe: async () => {
			throw new Error("No execution");
		},
	};
	const session = new PresentationSession(client, local);
	return {
		session,
		local,
		calls,
		client,
		handle: (next: typeof handler) => {
			handler = next;
		},
	};
}
for (const lost of [false, true])
	test(`mixed reorder reads current authoritative order after historical result (lost=${lost})`, async () => {
		const f = fixture();
		f.handle(async (method) => {
			if (method === "reorderSidebarPin") {
				if (lost) throw new Error("Lost response");
				return { orderRevision: 8 };
			}
			if (method === "getSidebarPinCommandResult")
				return { method: "reorderSidebarPin", params: input, result: { orderRevision: 8 } };
			assert.equal(method, "listSidebarPins");
			return current;
		});
		await f.session.reorderMixed(input);
		assert.equal(f.session.getSnapshot().pending, null);
		assert.deepEqual(f.session.getSnapshot().mixedOrderResult, current);
		assert.equal(f.session.getSnapshot().orderResult, null);
		assert.equal(f.session.getSnapshot().result, null);
		f.session.dispose();
	});
test("mixed unknown journal reloads without dispatch and retries only original tagged targets/revision", async () => {
	const f = fixture();
	const mutable = structuredClone(input);
	await f.session.reorderMixed(mutable);
	mutable.moved = { kind: "project", projectId: "changed" };
	mutable.before = null;
	mutable.expectedOrderRevision = 99;
	const raw = f.local.read("command.presentation");
	assert.ok(raw);
	assert.equal(JSON.parse(raw).version, 3);
	const local = new LocalState();
	local.write("command.presentation", raw);
	const restored = fixture(local);
	assert.equal(restored.calls.length, 0);
	assert.equal(restored.session.getSnapshot().order, true);
	await restored.session.check();
	assert.equal(local.read("command.presentation"), raw);
	await restored.session.retry();
	assert.deepEqual(
		restored.calls.filter((call) => call.method === "reorderSidebarPin").map((call) => call.params),
		[input],
	);
	assert.equal(local.read("command.presentation"), raw);
	f.session.dispose();
	restored.session.dispose();
});
for (const mismatch of ["anchor", "kind", "revision", "current"] as const)
	test(`mixed ${mismatch} mismatch retains recovery`, async () => {
		const f = fixture();
		f.handle(async (method) => {
			if (method === "reorderSidebarPin") throw new Error("Lost");
			if (method === "getSidebarPinCommandResult")
				return {
					method: "reorderSidebarPin",
					params: {
						...input,
						...(mismatch === "anchor"
							? { before: null }
							: mismatch === "kind"
								? { moved: { kind: "conversation", workspaceId: "project", conversationId: "chat" } }
								: {}),
					},
					result: { orderRevision: mismatch === "revision" ? 90 : 8 },
				};
			return { ...current, orderRevision: mismatch === "current" ? 6 : 12 };
		});
		await f.session.reorderMixed(input);
		assert.ok(f.session.getSnapshot().pending);
		assert.equal(f.session.getSnapshot().failed, true);
		assert.equal(f.session.getSnapshot().mixedOrderResult, null);
		f.session.dispose();
	});
test("mixed CAS rejection retires only after absent exact receipt", async () => {
	const f = fixture();
	f.handle(async (method) => {
		if (method === "reorderSidebarPin") throw new AppError("IDEMPOTENCY_CONFLICT");
		assert.equal(method, "getSidebarPinCommandResult");
		return null;
	});
	await f.session.reorderMixed(input);
	assert.equal(f.session.getSnapshot().pending, null);
	assert.equal(f.session.getSnapshot().rejected, true);
	await f.session.retry();
	assert.equal(f.calls.length, 2);
	f.session.dispose();
});
for (const version of [8, 9])
	test(`new mixed command cannot enter legacy version2 decoder (protocol ${version})`, async () => {
		const local = new LocalState();
		const raw = JSON.stringify({ version: 2, request: { version, method: "reorderSidebarPin", params: input } });
		local.write("command.presentation", raw);
		const f = fixture(local);
		await f.session.check();
		await f.session.retry();
		assert.equal(f.session.getSnapshot().incompatible, true);
		assert.equal(local.read("command.presentation"), raw);
		assert.equal(f.calls.length, 0);
		f.session.dispose();
	});
test("mixed journal refuses protocol8 and unknown envelope metadata unchanged", async () => {
	for (const request of [
		{ version: 8, method: "reorderSidebarPin", params: input },
		{ version: PROTOCOL_VERSION, method: "reorderSidebarPin", params: input, expectedStoreId: "other" },
	]) {
		const local = new LocalState();
		const raw = JSON.stringify({ version: 3, kind: "mixed-pin-order", request });
		local.write("command.presentation", raw);
		const f = fixture(local);
		await f.session.retry();
		assert.equal(f.session.getSnapshot().incompatible, true);
		assert.equal(local.read("command.presentation"), raw);
		assert.equal(f.calls.length, 0);
		f.session.dispose();
	}
});
