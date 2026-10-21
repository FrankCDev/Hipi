import assert from "node:assert/strict";
import {
	type AppClient,
	type Method,
	type Params,
	PROTOCOL_VERSION,
	type ProjectCommandResult,
	parseRequest,
	parseResult,
	type Request,
} from "@hipi/work-runtime/contracts";
import { test, vi } from "vitest";
import { CatalogSession, type ProjectPinLifecycle } from "../../../src/features/workbench/catalog/session.ts";
import type { ProjectCatalogCommand } from "../../../src/features/workbench/command-recovery.ts";
import { LocalState } from "../../../src/features/workbench/local-state.ts";

const rename: Extract<ProjectCatalogCommand, { method: "renameProject" }> = {
	version: PROTOCOL_VERSION,
	method: "renameProject",
	params: { requestId: "rename", projectId: "logical", expectedRevision: 7, name: "Renamed" },
};
const pin: Extract<ProjectCatalogCommand, { method: "setProjectPinned" }> = {
	version: PROTOCOL_VERSION,
	method: "setProjectPinned",
	params: { requestId: "pin", projectId: "logical", expectedPresentationRevision: 4, pinned: true },
};
const project = { projectId: "logical", homeWorkspaceId: "physical", name: "Renamed", revision: 8 };
const presentation = { projectId: "logical", pinned: false, revision: 4 };
const emptyRecovery = JSON.stringify({ version: 2, request: null });

function fixture(local = new LocalState()) {
	const calls: { request: Request; signal?: AbortSignal; recovery: string | null }[] = [];
	const receipts = new Map<string, ProjectCommandResult>();
	let currentPresentation = { ...presentation };
	const respond = (request: Request): unknown => {
		switch (request.method) {
			case "renameProject": {
				const result = { ...project, name: request.params.name, revision: request.params.expectedRevision + 1 };
				receipts.set(request.params.requestId, {
					status: "completed",
					method: request.method,
					params: request.params,
					result,
				});
				return result;
			}
			case "setProjectPinned":
				currentPresentation = {
					projectId: request.params.projectId,
					pinned: request.params.pinned,
					revision: request.params.expectedPresentationRevision + 1,
				};
				receipts.set(request.params.requestId, {
					status: "completed",
					method: request.method,
					params: request.params,
					result: currentPresentation,
				});
				return currentPresentation;
			case "getProjectCommandResult":
				return receipts.get(request.params.requestId) ?? null;
			case "getProjectCatalogState":
				return { state: "ready", generation: 1, defaultWorkspaceId: null };
			case "getProject":
				return project;
			case "getProjectPresentation":
				return currentPresentation;
			default:
				throw new Error(`Unexpected ${request.method}`);
		}
	};
	let handler = async (request: Request): Promise<unknown> => respond(request);
	const client: AppClient = {
		call: async <M extends Method>(method: M, params: Params<M>, signal?: AbortSignal) => {
			const request = parseRequest({ version: PROTOCOL_VERSION, method, params });
			calls.push({ request, signal, recovery: local.read("command.catalog") });
			return parseResult(method, await handler(request));
		},
		observe: async () => ({ dispose: async () => {} }),
	};
	const session = new CatalogSession(client, local);
	const events: ProjectPinLifecycle[] = [];
	session.subscribeProjectPinLifecycle((event) => events.push(event));
	return {
		local,
		calls,
		client,
		session,
		events,
		respond,
		handle(next: typeof handler) {
			handler = next;
		},
	};
}

test("a captured pin waits for exact rename completion, refreshes authority and preserves its own revision", async () => {
	const f = fixture();
	const started = Promise.withResolvers<void>();
	const release = Promise.withResolvers<void>();
	f.handle(async (request) => {
		if (request.method === "renameProject") {
			started.resolve();
			await release.promise;
		}
		// Later project metadata does not replace the separately captured presentation revision.
		if (request.method === "getProject") return { ...project, name: "Later name", revision: 20 };
		return f.respond(request);
	});
	const renameInput = structuredClone(rename);
	const pinInput = structuredClone(pin);
	const renamed = f.session.execute(renameInput);
	const continuation = f.session.continueProjectPin(renameInput, pinInput, renamed);
	renameInput.params.name = "Unrelated edit";
	pinInput.params.expectedPresentationRevision = 20;
	pinInput.params.pinned = false;
	await started.promise;
	assert.deepEqual(
		f.calls.map(({ request }) => request.method),
		["renameProject"],
	);
	assert.deepEqual(f.session.getSnapshot().pending, rename);
	release.resolve();
	assert.equal(await continuation, "admitted");
	assert.deepEqual(
		f.calls.map(({ request }) => request.method),
		[
			"renameProject",
			"getProjectCommandResult",
			"getProjectCatalogState",
			"getProject",
			"getProjectPresentation",
			"setProjectPinned",
			"getProjectCommandResult",
			"getProjectPresentation",
		],
	);
	const mutation = f.calls.find(({ request }) => request.method === "setProjectPinned");
	assert.deepEqual(mutation?.request, pin);
	assert.equal(mutation?.recovery, JSON.stringify({ version: 6, kind: "project-command", request: pin }));
	assert.equal(f.calls.find(({ request }) => request.method === "getProject")?.recovery, emptyRecovery);
	assert.deepEqual(
		f.events.map((event) => event.phase),
		["initiated", "admitted", "confirmed"],
	);
	assert.equal(f.session.getSnapshot().pending, null);
	assert.equal(f.session.getSnapshot().projectResult?.method, "setProjectPinned");
	f.session.dispose();
});

test("changed project identity, home, presentation identity or revision never admits the pin", async () => {
	for (const mismatch of ["project", "home", "presentation", "older", "newer", "catalog"] as const) {
		const f = fixture();
		f.handle(async (request) => {
			if (request.method === "getProject")
				return {
					...project,
					projectId: mismatch === "project" ? "foreign" : project.projectId,
					homeWorkspaceId: mismatch === "home" ? "foreign" : project.homeWorkspaceId,
				};
			if (request.method === "getProjectPresentation")
				return {
					...presentation,
					projectId: mismatch === "presentation" ? "foreign" : presentation.projectId,
					revision: mismatch === "older" ? 3 : mismatch === "newer" ? 5 : presentation.revision,
				};
			if (request.method === "getProjectCatalogState" && mismatch === "catalog")
				return { state: "adopting", generation: 1, defaultWorkspaceId: null };
			return f.respond(request);
		});
		const renamed = f.session.execute(rename);
		assert.equal(await f.session.continueProjectPin(rename, pin, renamed), "pin_not_applied", mismatch);
		assert.equal(
			f.calls.some(({ request }) => request.method === "setProjectPinned"),
			false,
			mismatch,
		);
		assert.deepEqual(f.events, [], mismatch);
		assert.equal(f.local.read("command.catalog"), emptyRecovery, mismatch);
		assert.equal(f.session.getSnapshot().pending, null, mismatch);
		f.session.dispose();
	}
});

test("failed fresh reads leave only the completed rename, never a replayable pin", async () => {
	for (const failedRead of ["getProjectCatalogState", "getProject", "getProjectPresentation"] as const) {
		const f = fixture();
		f.handle(async (request) => {
			if (request.method === failedRead) throw new Error("offline");
			return f.respond(request);
		});
		const renamed = f.session.execute(rename);
		assert.equal(await f.session.continueProjectPin(rename, pin, renamed), "pin_not_applied", failedRead);
		assert.equal(
			f.calls.some(({ request }) => request.method === "setProjectPinned"),
			false,
		);
		assert.equal(f.local.read("command.catalog"), emptyRecovery);
		f.session.dispose();
		const restored = new CatalogSession(f.client, f.local);
		const before = f.calls.length;
		await restored.check();
		await restored.retry();
		assert.equal(f.calls.length, before);
		restored.dispose();
	}
});

test("unknown and mismatched rename receipts retain rename recovery without pin admission or later replay", async () => {
	for (const outcome of ["unknown", "mismatch", "lookup-failed"] as const) {
		const f = fixture();
		f.handle(async (request) => {
			if (request.method === "renameProject") throw new Error("lost reply");
			if (request.method === "getProjectCommandResult") {
				if (outcome === "lookup-failed") throw new Error("offline");
				if (outcome === "mismatch")
					return {
						status: "completed",
						method: "renameProject",
						params: { ...rename.params, requestId: "foreign" },
						result: project,
					};
				return null;
			}
			return f.respond(request);
		});
		const renamed = f.session.execute(rename);
		assert.equal(await f.session.continueProjectPin(rename, pin, renamed), "rename_unconfirmed", outcome);
		assert.deepEqual(f.session.getSnapshot().pending, rename);
		assert.equal(
			f.calls.some(({ request }) => request.method === "getProject"),
			false,
		);
		assert.equal(
			f.calls.some(({ request }) => request.method === "setProjectPinned"),
			false,
		);
		f.session.dispose();
		f.handle(async (request) => {
			if (request.method === "getProjectCommandResult")
				return { status: "completed", method: "renameProject", params: rename.params, result: project };
			return f.respond(request);
		});
		const restored = new CatalogSession(f.client, f.local);
		await restored.check();
		await restored.retry();
		assert.equal(restored.getSnapshot().pending, null);
		assert.equal(f.calls.filter(({ request }) => request.method === "renameProject").length, 1);
		assert.equal(
			f.calls.some(({ request }) => request.method === "setProjectPinned"),
			false,
		);
		restored.dispose();
	}
});

test("a different completed rename or pin target cannot authorize the continuation", async () => {
	for (const mismatch of ["rename", "pin"] as const) {
		const f = fixture();
		const renamed = f.session.execute(rename);
		const otherRename = { ...rename, params: { ...rename.params, requestId: "other" } };
		const otherPin = { ...pin, params: { ...pin.params, projectId: "other" } };
		assert.equal(
			await f.session.continueProjectPin(
				mismatch === "rename" ? otherRename : rename,
				mismatch === "pin" ? otherPin : pin,
				renamed,
			),
			"rename_unconfirmed",
		);
		assert.equal(
			f.calls.some(({ request }) => request.method === "getProject"),
			false,
		);
		assert.equal(
			f.calls.some(({ request }) => request.method === "setProjectPinned"),
			false,
		);
		f.session.dispose();
	}
});

test("the reserved preflight run rejects concurrent commands and duplicate continuation attempts", async () => {
	const f = fixture();
	const reading = Promise.withResolvers<void>();
	const release = Promise.withResolvers<void>();
	f.handle(async (request) => {
		if (request.method === "getProject") {
			reading.resolve();
			await release.promise;
		}
		return f.respond(request);
	});
	const renamed = f.session.execute(rename);
	const continuation = f.session.continueProjectPin(rename, pin, renamed);
	await reading.promise;
	assert.equal(f.session.getSnapshot().busy, true);
	assert.equal(f.session.getSnapshot().pending, null);
	await f.session.execute({ ...pin, params: { ...pin.params, requestId: "other-pin" } });
	await f.session.execute({ ...rename, params: { ...rename.params, requestId: "other-rename" } });
	await f.session.check();
	assert.equal(await f.session.continueProjectPin(rename, pin, renamed), "rename_unconfirmed");
	assert.equal(
		f.calls.some(({ request }) => request.method === "setProjectPinned"),
		false,
	);
	release.resolve();
	assert.equal(await continuation, "admitted");
	assert.equal(f.calls.filter(({ request }) => request.method === "setProjectPinned").length, 1);
	assert.equal(f.calls.filter(({ request }) => request.method === "renameProject").length, 1);
	f.session.dispose();
});

test("a displaced durable recovery record prevents admission even after fresh reads succeed", async () => {
	const f = fixture();
	const other = { ...pin, params: { ...pin.params, requestId: "other-pin" } };
	const recovery = JSON.stringify({ version: 6, kind: "project-command", request: other });
	f.handle(async (request) => {
		if (request.method === "getProjectPresentation") f.local.write("command.catalog", recovery);
		return f.respond(request);
	});
	const renamed = f.session.execute(rename);
	assert.equal(await f.session.continueProjectPin(rename, pin, renamed), "pin_not_applied");
	assert.equal(
		f.calls.some(({ request }) => request.method === "setProjectPinned"),
		false,
	);
	assert.equal(f.local.read("command.catalog"), recovery);
	assert.deepEqual(f.session.getSnapshot().pending, other);
	assert.deepEqual(
		f.events.map((event) => event.phase),
		["initiated", "retired"],
	);
	f.session.dispose();
});

test("another pending pin cannot be mistaken for this continuation's own admission", async () => {
	const f = fixture();
	await f.session.execute(rename);
	const release = Promise.withResolvers<void>();
	const continuation = f.session.continueProjectPin(rename, pin, release.promise);
	const other = { ...pin, params: { ...pin.params, requestId: "other-pin" } };
	f.handle(async (request) => {
		if (request.method === "setProjectPinned") throw new Error("lost reply");
		return f.respond(request);
	});
	await f.session.execute(other);
	release.resolve();
	assert.equal(await continuation, "rename_unconfirmed");
	assert.deepEqual(f.session.getSnapshot().pending, other);
	assert.deepEqual(
		f.calls.filter(({ request }) => request.method === "setProjectPinned").map(({ request }) => request),
		[other],
	);
	assert.equal(
		f.calls.some(({ request }) => request.method === "getProject"),
		false,
	);
	f.session.dispose();
});

test("dispose and reactivate invalidate a continuation waiting on rename or fresh authority", async () => {
	for (const stoppedMethod of ["renameProject", "getProject", "getProjectPresentation"] as const) {
		const f = fixture();
		const started = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		f.handle(async (request) => {
			if (request.method === stoppedMethod) {
				started.resolve();
				await release.promise;
			}
			return f.respond(request);
		});
		const renamed = f.session.execute(rename);
		const continuation = f.session.continueProjectPin(rename, pin, renamed);
		await started.promise;
		f.session.dispose();
		f.session.activate();
		assert.equal(await continuation, "disposed", stoppedMethod);
		release.resolve();
		await Promise.resolve();
		await Promise.resolve();
		assert.equal(f.calls.find(({ request }) => request.method === stoppedMethod)?.signal?.aborted, true);
		assert.equal(
			f.calls.some(({ request }) => request.method === "setProjectPinned"),
			false,
		);
		assert.equal(f.session.getSnapshot().projectResult, null);
		f.session.dispose();
		const restored = new CatalogSession(f.client, f.local);
		await restored.check();
		assert.equal(f.calls.filter(({ request }) => request.method === "renameProject").length, 1);
		assert.equal(
			f.calls.some(({ request }) => request.method === "setProjectPinned"),
			false,
		);
		restored.dispose();
	}
});

test("a continuation invoked while disposed cannot regain authority through activate", async () => {
	const f = fixture();
	await f.session.execute(rename);
	f.session.dispose();
	const renamed = Promise.withResolvers<void>();
	const continuation = f.session.continueProjectPin(rename, pin, renamed.promise);
	f.session.activate();
	renamed.resolve();
	assert.equal(await continuation, "disposed");
	assert.equal(
		f.calls.some(({ request }) => request.method === "setProjectPinned"),
		false,
	);
	f.session.dispose();
});

test("fresh-read timeout never admits a pin when an ignored-abort reply arrives later", async () => {
	vi.useFakeTimers();
	try {
		const f = fixture();
		const started = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		f.handle(async (request) => {
			if (request.method === "getProjectPresentation") {
				started.resolve();
				await release.promise;
			}
			return f.respond(request);
		});
		const renamed = f.session.execute(rename);
		const continuation = f.session.continueProjectPin(rename, pin, renamed);
		await started.promise;
		await vi.advanceTimersByTimeAsync(15000);
		assert.equal(await continuation, "pin_not_applied");
		release.resolve();
		await Promise.resolve();
		await Promise.resolve();
		assert.equal(
			f.calls.some(({ request }) => request.method === "setProjectPinned"),
			false,
		);
		assert.equal(f.local.read("command.catalog"), emptyRecovery);
		f.session.dispose();
	} finally {
		vi.useRealTimers();
	}
});

test("an admitted pin with an unknown outcome remains pin recovery, never a not-applied notice or automatic replay", async () => {
	const f = fixture();
	f.handle(async (request) => {
		if (request.method === "setProjectPinned") throw new Error("lost reply");
		return f.respond(request);
	});
	const renamed = f.session.execute(rename);
	assert.equal(await f.session.continueProjectPin(rename, pin, renamed), "admitted");
	assert.deepEqual(f.session.getSnapshot().pending, pin);
	assert.equal(f.session.getSnapshot().notFound, true);
	assert.deepEqual(
		f.events.map((event) => event.phase),
		["initiated", "admitted"],
	);
	f.session.dispose();
	const restored = new CatalogSession(f.client, f.local);
	await restored.check();
	assert.equal(f.calls.filter(({ request }) => request.method === "setProjectPinned").length, 1);
	assert.deepEqual(restored.getSnapshot().pending, pin);
	restored.dispose();
});

test("rejecting the supplied rename promise cannot dispatch or discard recovery", async () => {
	const f = fixture();
	const recovery = JSON.stringify({ version: 6, kind: "project-command", request: rename });
	f.local.write("command.catalog", recovery);
	assert.equal(
		await f.session.continueProjectPin(rename, pin, Promise.reject(new Error("rename interrupted"))),
		"rename_unconfirmed",
	);
	assert.equal(f.local.read("command.catalog"), recovery);
	assert.deepEqual(f.calls, []);
	f.session.dispose();
});
