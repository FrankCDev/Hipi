import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { runInNewContext } from "node:vm";
import { exerciseSidebar } from "./journey.mjs";
import { sidebarStartupDiagnostic } from "./startup-diagnostic.mjs";

const seed = {
	workspaceIds: ["sidebar-chats", "sidebar-project-a", "sidebar-project-b"],
	defaultWorkspaceId: "sidebar-chats",
	handshake: { protocolVersion: 9, storeId: "fixture-store" },
};
test("startup capture preserves the original failure even if capture or writing fails", async () => {
	const directory = await mkdtemp(join(tmpdir(), "hipi-startup-diagnostic-"));
	try {
		for (const mode of ["saved", "capture_failed", "write_failed"]) {
			const original = new Error("Original startup failure");
			let calls = 0;
			const cdp = {
				request: async (method, { expression }) => {
					assert.equal(method, "Runtime.evaluate", "Failure capture must not send native input");
					calls++;
					if (calls === 1) return { result: { value: true } };
					if (calls === 2) throw original;
					assert.match(expression, /sidebarStartupDiagnostic/);
					if (mode === "capture_failed") throw new Error("Capture failed");
					return { result: { value: { status: "verified_fixture_store" } } };
				},
			};
			await assert.rejects(
				exerciseSidebar({
					cdp,
					directory: mode === "write_failed" ? join(directory, "missing") : directory,
					reopened: true,
					seed,
				}),
				(error) => error === original,
			);
			assert.equal(calls, 3, "Exactly one diagnostic capture without repair or retry");
			if (mode !== "write_failed") {
				const diagnostic = JSON.parse(await readFile(join(directory, "sidebar-startup-diagnostic.json"), "utf8"));
				assert.equal(diagnostic.status, mode === "saved" ? "verified_fixture_store" : "capture_unavailable");
			}
		}
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
});
test("diagnostic remains self-contained when serialized into the renderer", async () => {
	const result = await runInNewContext(`(${sidebarStartupDiagnostic.toString()})(seed, bridge, storage)`, {
		seed,
		setTimeout,
		clearTimeout,
		bridge: { request: async ({ method }) => ({ ok: true, result: method === "handshake" ? seed.handshake : {} }) },
		storage: { getItem: () => null },
	});
	assert.equal(result.status, "verified_fixture_store");
});
test("startup diagnostics read only the verified store and two exact local entries", async () => {
	const calls = [],
		keys = [];
	const result = await sidebarStartupDiagnostic(
		seed,
		{
			request: async (request) => {
				calls.push(request);
				if (request.method === "handshake") return { ok: true, result: seed.handshake };
				if (request.method === "listSidebarPins") return { ok: false, error: "INDEX_RECOVERY_REQUIRED" };
				return { ok: true, result: { marker: request.method } };
			},
		},
		{
			getItem: (key) => {
				keys.push(key);
				return "fixture-only";
			},
		},
	);
	assert.equal(result.status, "verified_fixture_store");
	assert.deepEqual(
		calls.map((item) => item.method),
		["handshake", "getProjectCatalogState", "listProjects", "listSidebarPins"],
	);
	assert.ok(
		calls
			.slice(1)
			.every((item) => item.expectedStoreId === seed.handshake.storeId && JSON.stringify(item.params) === "{}"),
	);
	assert.deepEqual(
		keys,
		["default-chat-workspace", "command.catalog"].map((key) => `hipi.work.local.v1.fixture-store.value.${key}`),
	);
	assert.equal(result.reads.listSidebarPins.error, "INDEX_RECOVERY_REQUIRED");
});
test("wrong store or protocol forbids all further reads including localStorage", async () => {
	for (const handshake of [
		{ ...seed.handshake, storeId: "other" },
		{ ...seed.handshake, protocolVersion: 10 },
	]) {
		let calls = 0;
		const result = await sidebarStartupDiagnostic(
			seed,
			{
				request: async () => {
					calls++;
					return { ok: true, result: handshake };
				},
			},
			{
				getItem: () => {
					throw new Error("must not read");
				},
			},
		);
		assert.equal(result.status, "unverified_store");
		assert.equal(calls, 1);
		assert.equal("local" in result, false);
	}
});
test("invalid fixture issues no requests and failed diagnostics preserve other results", async () => {
	assert.deepEqual(await sidebarStartupDiagnostic({ ...seed, workspaceIds: ["private"] }, {}, {}), {
		status: "invalid_fixture",
	});
	const result = await sidebarStartupDiagnostic(
		seed,
		{
			request: async ({ method }) => {
				if (method === "handshake") return { ok: true, result: seed.handshake };
				if (method === "getProjectCatalogState") throw new Error("private failure detail");
				return { ok: true, result: {} };
			},
		},
		{ getItem: () => null },
	);
	assert.deepEqual(result.reads.getProjectCatalogState, { ok: false, error: "diagnostic_request_failed" });
	assert.equal(result.reads.listSidebarPins.ok, true);
	assert.equal(JSON.stringify(result).includes("private failure detail"), false);
});
