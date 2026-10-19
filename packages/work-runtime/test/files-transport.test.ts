import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { request as httpRequest } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { FILE_LIMITS, FileServiceError } from "../src/files/contracts.ts";
import { createRuntimeFileHost, parseHostFileMapping } from "../src/files/host.ts";
import { createHttpFileClient } from "../src/files/http-client.ts";
import type { FileRequest } from "../src/files/protocol.ts";
import {
	createFileClient,
	createFileRequestHandler,
	FILE_FRAME_BYTES,
	fileRequestTarget,
	parseFileRequest,
	parseFileResponse,
} from "../src/files/protocol.ts";
import { createFileAuthority } from "../src/files/service.ts";
import { openTestRuntime } from "../src/testing.ts";
import { serveLoopback } from "../src/transport-http.ts";

const target = { workspaceId: "workspace", rootId: "root", path: "hello.txt" };
const request: FileRequest = { version: 1, expectedStoreId: "store", method: "readText", params: target };
const content = { text: "hello", revision: "a".repeat(64), encoding: "utf-8", bytes: 5 };
const envelope = { version: 1, storeId: "store", method: "readText", target, ok: true, result: content };

test("file text preserves supplementary Unicode and rejects lone UTF-16 surrogates before transport", () => {
	for (const text of ["中文 😀", "\ud800", "\udc00", "x\ud800y"]) {
		const input: FileRequest = {
			...request,
			method: "saveText",
			params: { ...target, text, ifMatch: content.revision },
		};
		if (text === "中文 😀") assert.deepEqual(parseFileRequest(input), input);
		else assert.throws(() => parseFileRequest(input), { code: "INVALID_PATH" });
	}
});

test("file protocol rejects unknown keys, principal injection, paths, codes and response identity changes", () => {
	for (const bad of [
		{ ...request, principalId: "mallory" },
		{ ...request, version: 2 },
		{ ...request, params: { ...target, absolutePath: "/tmp/private" } },
		{ ...request, params: { ...target, path: "../secret" } },
		{ ...request, params: { ...target, path: "/tmp/secret" } },
		{ ...request, method: "grantRoot" },
	])
		assert.throws(() => parseFileRequest(bad), FileServiceError);
	for (const bad of [
		{ ...envelope, storeId: "other" },
		{ ...envelope, method: "saveText" },
		{ ...envelope, target: { ...target, rootId: "other" } },
		{ ...envelope, target: { ...target, path: "other.txt" } },
		{ ...envelope, extra: true },
		{ ...envelope, result: { ...content, bytes: 2 } },
		{ ...envelope, result: { ...content, encoding: "latin1" } },
		{ ...envelope, ok: false, error: "BOGUS" },
	])
		assert.throws(() => parseFileResponse(bad, request), FileServiceError);
	assert.deepEqual(parseFileResponse(envelope, request), envelope);
});

test("file result validators enforce root scope and direct-child paths", () => {
	const roots: FileRequest = { ...request, method: "listRoots", params: { workspaceId: "workspace" } };
	assert.throws(() =>
		parseFileResponse(
			{
				...envelope,
				method: "listRoots",
				target: { workspaceId: "workspace" },
				result: [{ workspaceId: "other", rootId: "root", writable: true }],
			},
			roots,
		),
	);
	const list: FileRequest = { ...request, method: "list", params: { ...target, path: "dir" } };
	for (const entry of [
		{ name: "file", path: "elsewhere/file", kind: "file" },
		{ name: "../secret", path: "dir/../secret", kind: "blocked" },
		{ name: "file", path: "dir/file", kind: "executable" },
	])
		assert.throws(() =>
			parseFileResponse(
				{ ...envelope, method: "list", target: list.params, result: { entries: [entry], nextCursor: null } },
				list,
			),
		);
});

test("client cancellation releases waiting without claiming save rollback or retrying", async () => {
	let calls = 0;
	const gate = Promise.withResolvers<unknown>();
	const client = createFileClient({
		storeId: "store",
		request: async () => {
			calls++;
			return gate.promise;
		},
	});
	const readAbort = new AbortController();
	const reading = client.readText(target, readAbort.signal);
	readAbort.abort();
	await assert.rejects(reading, { code: "CLOSED" });
	const saveAbort = new AbortController();
	const saving = client.saveText(target, "new", content.revision, saveAbort.signal);
	saveAbort.abort();
	await assert.rejects(saving, { code: "WRITE_OUTCOME_UNKNOWN" });
	assert.equal(calls, 2);
	gate.resolve(envelope);
	const preabort = AbortSignal.abort();
	await assert.rejects(client.readText(target, preabort), { code: "CLOSED" });
	assert.equal(calls, 2);
});

test("untrusted response and transport loss cannot falsely confirm a save", async () => {
	for (const response of [envelope, { ...envelope, error: "BOGUS" }, null]) {
		const client = createFileClient({ storeId: "store", request: async () => response });
		await assert.rejects(client.saveText(target, "new", content.revision), { code: "WRITE_OUTCOME_UNKNOWN" });
	}
	const client = createFileClient({
		storeId: "store",
		request: async () => {
			throw new Error("private host path");
		},
	});
	await assert.rejects(
		client.saveText(target, "new", content.revision),
		(error) =>
			error instanceof FileServiceError &&
			error.code === "WRITE_OUTCOME_UNKNOWN" &&
			!error.message.includes("private"),
	);
});

test("maximum text remains inside the transport frame after JSON escaping", () => {
	const text = "\t".repeat(FILE_LIMITS.bytes);
	const save = parseFileRequest({
		...request,
		method: "saveText",
		params: { ...target, text, ifMatch: content.revision },
	});
	const response = { ...envelope, method: "saveText", result: { ...content, text, bytes: FILE_LIMITS.bytes } };
	assert.ok(Buffer.byteLength(JSON.stringify(save)) < FILE_FRAME_BYTES);
	assert.ok(Buffer.byteLength(JSON.stringify(response)) < FILE_FRAME_BYTES);
	assert.throws(() => parseFileRequest({ ...save, params: { ...save.params, text: `${text}x` } }), {
		code: "LIMIT_EXCEEDED",
	});
});

test("trusted CLI mapping requires explicit absolute root and write choice, with sanitized errors", () => {
	assert.deepEqual(parseHostFileMapping('{"workspaceId":"workspace","absolutePath":"/tmp/root","writable":false}'), {
		workspaceId: "workspace",
		absolutePath: "/tmp/root",
		writable: false,
	});
	for (const raw of [
		"secret-invalid-json",
		'{"workspaceId":"workspace","absolutePath":"relative","writable":true}',
		'{"workspaceId":"workspace","absolutePath":"/tmp/secret"}',
		'{"workspaceId":"workspace","absolutePath":"/tmp/secret","writable":true,"principalId":"mallory"}',
	]) {
		assert.throws(
			() => parseHostFileMapping(raw),
			(error) => error instanceof FileServiceError && error.message === "INVALID_PATH",
		);
	}
});

test("HTTP fixture completes explicit grant/list/read/save/CAS, authentication and generation isolation", async () => {
	const directory = await mkdtemp(join(tmpdir(), "hipi-file-http-"));
	const runtime = await openTestRuntime(join(directory, "runtime"), { resume: false });
	const workspace = await runtime.call("createWorkspace", { workspaceId: "workspace", name: "Fixture" });
	const host = await createRuntimeFileHost(runtime, "session");
	const origin = "http://127.0.0.1:5173";
	const server = await serveLoopback(runtime, { origin, files: host.handler });
	const client = createHttpFileClient({ url: server.url, token: server.token, storeId: host.storeId, origin });
	try {
		assert.deepEqual(await client.listRoots(workspace.workspaceId), []);
		await assert.rejects(
			host.authority.grantRoot({
				principalId: "session",
				workspaceId: "unknown",
				absolutePath: directory,
				writable: true,
			}),
			{ code: "UNAUTHORIZED" },
		);
		const root = await host.authority.grantRoot({
			principalId: "session",
			workspaceId: workspace.workspaceId,
			absolutePath: directory,
			writable: true,
		});
		await writeFile(join(directory, "hello.txt"), "original");
		const actual = { workspaceId: workspace.workspaceId, rootId: root.rootId, path: "hello.txt" };
		assert.deepEqual(await client.listRoots(workspace.workspaceId), [root]);
		assert.ok((await client.list({ ...actual, path: "" })).entries.some((entry) => entry.name === "hello.txt"));
		const before = await client.readText(actual);
		const saved = await client.saveText(actual, "changed", before.revision);
		assert.equal(saved.text, "changed");
		assert.equal(await readFile(join(directory, "hello.txt"), "utf8"), "changed");
		await assert.rejects(client.saveText(actual, "dirty buffer", before.revision), { code: "VERSION_CONFLICT" });
		assert.equal((await client.preview(actual)).kind, "text");
		const raw: FileRequest = { version: 1, expectedStoreId: host.storeId, method: "readText", params: actual };
		const headers = { Origin: origin, Authorization: `Bearer ${server.token}`, "Content-Type": "application/json" };
		const response = await fetch(`${server.url}/files`, { method: "POST", headers, body: JSON.stringify(raw) });
		assert.equal(response.headers.get("cache-control"), "no-store");
		assert.equal(response.status, 200);
		await response.text();
		for (const changed of [{ Origin: "https://evil.invalid" }, { Authorization: "Bearer incorrect" }]) {
			const rejected = await fetch(`${server.url}/files`, {
				method: "POST",
				headers: { ...headers, ...changed },
				body: JSON.stringify(raw),
			});
			assert.ok([401, 403].includes(rejected.status));
			await rejected.text();
		}
		const hostStatus = await new Promise<number | undefined>((resolve, reject) => {
			const req = httpRequest(
				`${server.url}/files`,
				{ method: "POST", headers: { ...headers, Host: "localhost" } },
				(res) => {
					res.resume();
					res.once("end", () => resolve(res.statusCode));
				},
			);
			req.once("error", reject);
			req.end(JSON.stringify(raw));
		});
		assert.equal(hostStatus, 403);
		const oversized = await fetch(`${server.url}/files`, {
			method: "POST",
			headers,
			body: "x".repeat(FILE_FRAME_BYTES + 1),
		});
		assert.equal(oversized.status, 413);
		await oversized.text();
		for (const bad of [
			{ ...raw, principalId: "session" },
			{ ...raw, expectedStoreId: "other" },
			{ ...raw, params: { ...actual, absolutePath: directory } },
		]) {
			const rejected = await fetch(`${server.url}/files`, { method: "POST", headers, body: JSON.stringify(bad) });
			assert.ok([400, 401].includes(rejected.status));
			assert.equal((await rejected.text()).includes(directory), false);
		}
		const second = await createRuntimeFileHost(runtime, "session");
		try {
			const fresh = createFileClient({
				storeId: second.storeId,
				request: (request) => second.handler.execute(request),
			});
			await assert.rejects(fresh.readText(actual), { code: "UNAUTHORIZED" });
		} finally {
			await second.authority.close();
		}
		host.authority.revokeRoot(root.rootId);
		await assert.rejects(client.readText(actual), { code: "UNAUTHORIZED" });
	} finally {
		await server.close();
		await host.authority.close();
		await runtime.close();
		await rm(directory, { recursive: true, force: true });
	}
});

test("handler binds trusted principal and never echoes save text into target", async () => {
	const authority = createFileAuthority({
		securityMode: "cooperative-local-files",
		assertWorkspaceAccess: async () => {
			throw new FileServiceError("UNAUTHORIZED");
		},
	});
	try {
		const handler = createFileRequestHandler(authority.forPrincipal("session"), "store");
		const save = parseFileRequest({
			...request,
			method: "saveText",
			params: { ...target, text: "private-buffer", ifMatch: content.revision },
		});
		const result = await handler.execute(save);
		assert.deepEqual(result.target, fileRequestTarget(save));
		assert.equal(JSON.stringify(result).includes("private-buffer"), false);
		assert.equal(result.ok, false);
	} finally {
		await authority.close();
	}
});

test("save success must echo the exact submitted text; malformed and oversized responses stay unknown", async () => {
	for (const result of [
		content,
		{ ...content, text: "x".repeat(FILE_FRAME_BYTES + 1), bytes: FILE_FRAME_BYTES + 1 },
	]) {
		const client = createFileClient({
			storeId: "store",
			request: async () => ({ ...envelope, method: "saveText", result }),
		});
		await assert.rejects(client.saveText(target, "new", content.revision), { code: "WRITE_OUTCOME_UNKNOWN" });
	}
});
