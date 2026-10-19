import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createRuntimeFileHost } from "../src/files/host.ts";
import { createRuntimePreviewHost } from "../src/previews/host.ts";
import { createHttpPreviewClient } from "../src/previews/http-client.ts";
import { createPreviewRequestHandler } from "../src/previews/protocol.ts";
import { createPreviewService } from "../src/previews/service.ts";
import { openTestRuntime } from "../src/testing.ts";
import { serveLoopback } from "../src/transport-http.ts";

test("authenticated HTTP CSV fixture opens bounded pages and blocks revoked roots, bad stores and origins", async () => {
	const directory = await mkdtemp(join(tmpdir(), "hipi-preview-http-"));
	const runtime = await openTestRuntime(join(directory, "runtime"), { resume: false });
	await runtime.call("createWorkspace", { workspaceId: "workspace", name: "Fixture" });
	const files = await createRuntimeFileHost(runtime, "owner");
	const previews = createRuntimePreviewHost({
		authority: files.authority,
		storeId: files.storeId,
		principalId: "owner",
	});
	const origin = "http://127.0.0.1:5173";
	const server = await serveLoopback(runtime, { origin, files: files.handler, previews: previews.handler });
	const client = createHttpPreviewClient({ url: server.url, token: server.token, storeId: files.storeId, origin });
	try {
		await writeFile(join(directory, "sheet.csv"), 'name,value\nalpha,42\n=HYPERLINK("https://invalid"),cached');
		await assert.rejects(client.open({ workspaceId: "workspace", rootId: "unknown", path: "sheet.csv" }), {
			code: "UNAUTHORIZED",
		});
		const root = await files.authority.grantRoot({
			workspaceId: "workspace",
			principalId: "owner",
			absolutePath: directory,
			writable: false,
		});
		const target = { workspaceId: "workspace", rootId: root.rootId, path: "sheet.csv" };
		const handle = await client.open(target);
		assert.equal(handle.kind, "csv");
		const page = await client.readPage(handle.id, 0);
		assert.equal(page.content.kind, "spreadsheet");
		if (page.content.kind === "spreadsheet") assert.equal(page.content.sheets[0].rows[1][1].display, "42");
		const request = { version: 1, expectedStoreId: files.storeId, method: "open", params: target };
		for (const headers of [
			{ Origin: "http://evil.invalid", Authorization: `Bearer ${server.token}` },
			{ Origin: origin, Authorization: "Bearer wrong" },
		]) {
			const response = await fetch(`${server.url}/previews`, {
				method: "POST",
				headers: { ...headers, "Content-Type": "application/json" },
				body: JSON.stringify(request),
			});
			assert.ok(response.status === 401 || response.status === 403);
		}
		const stale = createHttpPreviewClient({ url: server.url, token: server.token, storeId: "wrong", origin });
		await assert.rejects(stale.open(target));
		const invalid = await fetch(`${server.url}/previews`, {
			method: "POST",
			headers: { Origin: origin, Authorization: `Bearer ${server.token}`, "Content-Type": "application/json" },
			body: JSON.stringify({ ...request, absolutePath: directory }),
		});
		assert.equal(invalid.status, 400);
		assert.equal(invalid.headers.get("cache-control"), "no-store");
		assert.ok(!(await invalid.text()).includes(directory));
		files.authority.revokeRoot(root.rootId);
		await assert.rejects(client.readPage(handle.id, 0), { code: "UNAUTHORIZED" });
		await client.close(handle.id);
		await client.close(handle.id);
	} finally {
		await server.close();
		await previews.close();
		await files.authority.close();
		await runtime.close();
		await rm(directory, { recursive: true, force: true });
	}
});

test("HTTP connection cancellation reaches admitted preview work", async () => {
	const directory = await mkdtemp(join(tmpdir(), "hipi-preview-abort-"));
	const runtime = await openTestRuntime(join(directory, "runtime"), { resume: false });
	const entered = Promise.withResolvers<void>(),
		cancelled = Promise.withResolvers<void>();
	const service = createPreviewService({
		storeId: "store",
		principalId: "owner",
		source: {
			async read() {
				return { bytes: new Uint8Array([1]), revision: "a".repeat(64) };
			},
			async assertAuthorized() {},
		},
		parser: {
			parse(_format, _bytes, signal) {
				entered.resolve();
				return new Promise((_resolve, reject) =>
					signal?.addEventListener(
						"abort",
						() => {
							cancelled.resolve();
							reject(new Error("aborted"));
						},
						{ once: true },
					),
				);
			},
			async close() {},
		},
	});
	const origin = "http://127.0.0.1:5173";
	const server = await serveLoopback(runtime, {
		origin,
		previews: createPreviewRequestHandler(service.client, "store"),
	});
	try {
		const client = createHttpPreviewClient({ url: server.url, token: server.token, storeId: "store", origin });
		const abort = new AbortController();
		const operation = client.open({ workspaceId: "workspace", rootId: "root", path: "test.docx" }, abort.signal);
		await entered.promise;
		abort.abort();
		await assert.rejects(operation, { code: "CLOSED" });
		await Promise.race([
			cancelled.promise,
			new Promise((_resolve, reject) => setTimeout(() => reject(new Error("cancel not propagated")), 1000).unref()),
		]);
	} finally {
		await server.close();
		await service.close();
		await runtime.close();
		await rm(directory, { recursive: true, force: true });
	}
});
