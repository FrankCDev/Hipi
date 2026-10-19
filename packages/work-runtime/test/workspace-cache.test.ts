import assert from "node:assert/strict";
import test from "node:test";
import type { ObservationStatus, Scope } from "../src/contracts.ts";
import { type RuntimePorts, WorkRuntime, type WorkspacePort } from "../src/core.ts";
import { deniedFeatureReads } from "./feature-port-fixture.ts";

/** Controlled ownership ports: no PI or real providers; SQLite idle proofs live in capacity-archival.test. */
function fixture() {
	const states = new Map<
		string,
		{
			idle: boolean;
			unknown: boolean;
			closes: number;
			openCount: number;
			closeFailure: boolean;
			closeWait?: Promise<void>;
			onClose?: () => void;
			read?: Promise<void>;
			dispose?: Promise<void>;
			status?: (status: ObservationStatus) => void;
		}
	>();
	let live = 0;
	let maximum = 0;
	let rootClosed = false;
	let opening: Promise<void> | undefined;
	const resumePolicies: (false | undefined)[] = [];
	const ports: RuntimePorts = {
		...deniedFeatureReads,
		storeId: "store",
		getConversation: async () => {
			throw new Error("unused");
		},
		getConversationCommandResult: async () => null,
		getAgentCommandResult: async () => null,
		getWorkspace: async ({ workspaceId }) => ({ workspaceId, name: workspaceId }),
		listModels: async () => {
			throw new Error("unused");
		},
		listWorkspaces: async () => {
			throw new Error("unused");
		},
		listConversations: async () => {
			throw new Error("unused");
		},
		openWorkspace: async (id, _name, options) => {
			resumePolicies.push(options?.resume);
			await opening;
			const state = states.get(id) ?? { idle: true, unknown: false, closes: 0, openCount: 0, closeFailure: false };
			states.set(id, state);
			state.openCount++;
			maximum = Math.max(maximum, ++live);
			let closed = false;
			const partial: Partial<WorkspacePort> = {
				workspace: { workspaceId: id, name: id },
				canEvict: async () => {
					if (state.unknown) throw new Error("unknown");
					return state.idle;
				},
				getReceipt: async () => {
					await state.read;
					assert.equal(closed, false);
					return null;
				},
				observe: async (_scope, _listener, _signal, status) => {
					state.status = status;
					return {
						dispose: async () => {
							await state.dispose;
						},
					};
				},
				close: async () => {
					state.closes++;
					state.onClose?.();
					await state.closeWait;
					if (state.closeFailure) throw new Error("close failed");
					if (!closed) live--;
					closed = true;
				},
			};
			return new Proxy(partial, {
				get(target, key) {
					if (key === "then") return undefined;
					if (key in target) return Reflect.get(target, key);
					throw new Error(`Unexpected workspace method: ${String(key)}`);
				},
			}) as WorkspacePort;
		},
		close: async () => {
			assert.equal(live, 0);
			rootClosed = true;
		},
	};
	const runtime = new WorkRuntime(ports);
	const open = (id: string) => runtime.call("openWorkspace", { workspaceId: id });
	const fill = async () => {
		for (let i = 0; i < 16; i++) await open(`w${i}`);
	};
	return {
		runtime,
		open,
		fill,
		states,
		setOpening: (gate: Promise<void>) => {
			opening = gate;
		},
		resumePolicies,
		maximum: () => maximum,
		rootClosed: () => rootClosed,
	};
}
const scope: Scope = { workspaceId: "w0", conversationId: "conversation" };

test("17th workspace evicts idle LRU, reopening is bounded and concurrent same-id opens once", async () => {
	const f = fixture();
	await f.fill();
	await f.open("w0");
	await Promise.all([f.open("next"), f.open("next"), f.open("next")]);
	assert.equal(f.states.get("w0")?.closes, 0);
	assert.equal(f.states.get("w1")?.closes, 1);
	assert.equal(f.states.get("next")?.openCount, 1);
	await f.open("w1");
	assert.equal(f.states.get("w1")?.openCount, 2);
	assert.equal(f.maximum(), 16);
	assert.deepEqual(f.resumePolicies.slice(16), [false, false]);
	await f.runtime.close();
});

test("all task/approval/grant/unknown pins reject capacity without closing any owner", async () => {
	const f = fixture();
	await f.fill();
	for (const state of f.states.values()) state.idle = false;
	f.states.get("w0")!.unknown = true;
	await assert.rejects(f.open("next"), { code: "CAPACITY_EXCEEDED" });
	assert.ok([...f.states.values()].every((state) => state.closes === 0));
	await f.runtime.close();
});

test("cancelWait retains the actual call lease until the operation settles", async () => {
	const f = fixture();
	await f.fill();
	for (const [id, state] of f.states) state.idle = id === "w0";
	const gate = Promise.withResolvers<void>();
	f.states.get("w0")!.read = gate.promise;
	const abort = new AbortController();
	const read = f.runtime.call("getReceipt", { workspaceId: "w0", requestId: "read" }, abort.signal);
	// This request is queued behind read admission, proving the lease was acquired.
	await f.open("w1");
	abort.abort(new Error("stop waiting"));
	await assert.rejects(read, /stop waiting/);
	await assert.rejects(f.open("next"), { code: "CAPACITY_EXCEEDED" });
	gate.resolve();
	await f.runtime.call("getReceipt", { workspaceId: "w0", requestId: "settled" });
	await f.open("next");
	assert.equal(f.states.get("w0")?.closes, 1);
	await f.runtime.close();
});

test("observer pins its workspace through asynchronous disposal", async () => {
	const f = fixture();
	await f.fill();
	for (const [id, state] of f.states) state.idle = id === "w0";
	const gate = Promise.withResolvers<void>();
	f.states.get("w0")!.dispose = gate.promise;
	const sub = await f.runtime.observe(scope, () => {});
	await assert.rejects(f.open("next"), { code: "CAPACITY_EXCEEDED" });
	const disposing = sub.dispose();
	await assert.rejects(f.open("next"), { code: "CAPACITY_EXCEEDED" });
	gate.resolve();
	await disposing;
	await f.open("next");
	await f.runtime.close();
});

test("terminal observer status releases its lease and close failure retains ownership for retry", async () => {
	const f = fixture();
	await f.fill();
	for (const [id, state] of f.states) state.idle = id === "w0";
	await f.runtime.observe(scope, () => {});
	f.states.get("w0")!.status?.({ state: "closed", reason: "disconnected" });
	f.states.get("w0")!.closeFailure = true;
	await assert.rejects(f.open("next"), { code: "WORKSPACE_BUSY" });
	await assert.rejects(f.open("w0"), { code: "WORKSPACE_BUSY" });
	await assert.rejects(f.open("next"), { code: "CAPACITY_EXCEEDED" });
	assert.equal(f.states.get("w0")?.openCount, 1);
	await assert.rejects(f.runtime.close(), /close failed/);
	assert.equal(f.rootClosed(), false);
	f.states.get("w0")!.closeFailure = false;
	await f.runtime.close();
	assert.equal(f.rootClosed(), true);
});

test("shutdown waits for an opening owner and rejects new admission", async () => {
	const f = fixture();
	const gate = Promise.withResolvers<void>();
	f.setOpening(gate.promise);
	const opening = f.open("w0");
	await Promise.resolve();
	const closing = f.runtime.close();
	await assert.rejects(f.open("other"), { code: "CLOSED" });
	assert.equal(f.rootClosed(), false);
	gate.resolve();
	await opening;
	await closing;
	assert.equal(f.states.get("w0")?.closes, 1);
	assert.equal(f.rootClosed(), true);
});

test("shutdown during eviction waits for close and never opens a replacement", async () => {
	const f = fixture();
	await f.fill();
	const entered = Promise.withResolvers<void>();
	const gate = Promise.withResolvers<void>();
	f.states.get("w0")!.onClose = entered.resolve;
	f.states.get("w0")!.closeWait = gate.promise;
	const opening = f.open("next");
	await entered.promise;
	const closedError = assert.rejects(opening, { code: "CLOSED" });
	const closing = f.runtime.close();
	assert.equal(f.states.has("next"), false);
	gate.resolve();
	await closedError;
	await closing;
	assert.equal(f.states.has("next"), false);
	assert.equal(f.states.get("w0")!.closes, 1);
	assert.equal(f.rootClosed(), true);
});

test("failed observer disposal stays pinned and shutdown retries its cleanup", async () => {
	const f = fixture();
	await f.fill();
	for (const [id, state] of f.states) state.idle = id === "w0";
	const gate = Promise.withResolvers<void>();
	f.states.get("w0")!.dispose = gate.promise;
	const observer = await f.runtime.observe(scope, () => {});
	const rejected = assert.rejects(observer.dispose(), /dispose failed/);
	gate.reject(new Error("dispose failed"));
	await rejected;
	await assert.rejects(f.open("next"), { code: "CAPACITY_EXCEEDED" });
	f.states.get("w0")!.dispose = undefined;
	await f.runtime.close();
	assert.equal(f.rootClosed(), true);
});
