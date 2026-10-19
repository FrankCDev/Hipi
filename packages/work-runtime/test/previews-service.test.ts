import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { FileServiceError } from "../src/files/contracts.ts";
import { createFileAuthority } from "../src/files/service.ts";
import { type DocumentPreview, DocumentPreviewError } from "../src/previews/contracts.ts";
import {
	createPreviewClient,
	createPreviewRequestHandler,
	PREVIEW_LIMITS,
	parsePreviewRequest,
	parsePreviewResponse,
} from "../src/previews/protocol.ts";
import { createPreviewService } from "../src/previews/service.ts";

const document: DocumentPreview = { kind: "document", format: "docx", text: "test", truncated: false, limitations: [] };
const parser = {
	async parse() {
		return document;
	},
	async close() {},
};
const pdf = Buffer.from("%PDF-1.7\n1 0 obj\n<< /Type /Catalog >>\nendobj\n%%EOF\n");
async function fixture() {
	const directory = await mkdtemp(join(tmpdir(), "hipi-preview-"));
	let allowed = true;
	const authority = createFileAuthority({
		securityMode: "cooperative-local-files",
		async assertWorkspaceAccess() {
			if (!allowed) throw new FileServiceError("UNAUTHORIZED");
		},
	});
	const root = await authority.grantRoot({
		principalId: "owner",
		workspaceId: "workspace",
		absolutePath: directory,
		writable: false,
	});
	const target = { workspaceId: "workspace", rootId: root.rootId, path: "test.pdf" };
	await writeFile(join(directory, target.path), pdf);
	let clock = 0;
	const service = createPreviewService({
		source: authority.forPrincipalSnapshot("owner"),
		parser,
		storeId: "store",
		principalId: "owner",
		now: () => clock,
	});
	return {
		directory,
		authority,
		target,
		service,
		revoke() {
			allowed = false;
		},
		expire() {
			clock = PREVIEW_LIMITS.ttlMs + 1;
		},
		async close() {
			await service.close();
			await authority.close();
			await rm(directory, { recursive: true, force: true });
		},
	};
}
test("preview snapshots preserve bytes and revision, reject revoked grants, expire and close idempotently", async () => {
	const f = await fixture();
	try {
		const handle = await f.service.client.open(f.target);
		await writeFile(join(f.directory, f.target.path), "changed");
		const chunk = await f.service.client.readBytes(handle.id, 0);
		assert.equal(chunk.revision, handle.revision);
		assert.deepEqual(Buffer.from(chunk.base64, "base64"), pdf);
		await f.service.client.close(handle.id);
		await f.service.client.close(handle.id);
		await assert.rejects(f.service.client.readBytes(handle.id, 0), { code: "NOT_FOUND" });
		await writeFile(join(f.directory, f.target.path), pdf);
		const expired = await f.service.client.open(f.target);
		f.expire();
		await assert.rejects(f.service.client.readBytes(expired.id, 0), { code: "NOT_FOUND" });
		const revoked = await f.service.client.open(f.target);
		f.revoke();
		await assert.rejects(f.service.client.readBytes(revoked.id, 0), { code: "UNAUTHORIZED" });
	} finally {
		await f.close();
	}
});
test("zero grants and another principal cannot open; handles do not cross service instances", async () => {
	const f = await fixture();
	const other = createPreviewService({
		source: f.authority.forPrincipalSnapshot("other"),
		parser,
		storeId: "store",
		principalId: "other",
	});
	try {
		await assert.rejects(other.client.open(f.target), { code: "UNAUTHORIZED" });
		const h = await f.service.client.open(f.target);
		await assert.rejects(other.client.readBytes(h.id, 0), { code: "NOT_FOUND" });
	} finally {
		await other.close();
		await f.close();
	}
});
test("extension and signature both required; input and handle bounds enforced", async () => {
	const f = await fixture();
	try {
		for (const name of ["test.svg", "test.html", "test.doc", "test.xls", "test.docm"]) {
			await writeFile(join(f.directory, name), pdf);
			await assert.rejects(f.service.client.open({ ...f.target, path: name }), { code: "BLOCKED_RESOURCE" });
		}
		await writeFile(join(f.directory, "fake.pdf"), "<html>%%EOF");
		await assert.rejects(f.service.client.open({ ...f.target, path: "fake.pdf" }), { code: "BLOCKED_RESOURCE" });
		for (let i = 0; i < PREVIEW_LIMITS.handles; i++) await f.service.client.open(f.target);
		await assert.rejects(f.service.client.open(f.target), { code: "BUSY" });
	} finally {
		await f.close();
	}
});
test("queue is bounded, cancellation removes queued work and aborts active parsing", async () => {
	const controllers: AbortSignal[] = [];
	let reads = 0;
	const service = createPreviewService({
		storeId: "store",
		principalId: "owner",
		source: {
			async read() {
				reads++;
				return { bytes: new Uint8Array([1]), revision: "a".repeat(64) };
			},
			async assertAuthorized() {},
		},
		parser: {
			parse(_format, _bytes, signal) {
				assert.ok(signal);
				controllers.push(signal);
				return new Promise((_resolve, reject) =>
					signal.addEventListener("abort", () => reject(new DocumentPreviewError("ABORTED")), { once: true }),
				);
			},
			async close() {},
		},
	});
	const target = { workspaceId: "workspace", rootId: "root", path: "test.docx" };
	const aborters = Array.from({ length: 10 }, () => new AbortController());
	const operations = aborters.map((c) => service.client.open(target, c.signal).catch((e) => e));
	await new Promise((resolve) => setImmediate(resolve));
	assert.equal(reads, 2);
	assert.equal(controllers.length, 2);
	await assert.rejects(service.client.open(target), { code: "BUSY" });
	aborters[9].abort();
	aborters[0].abort();
	await new Promise((resolve) => setImmediate(resolve));
	assert.equal(reads, 3);
	for (const c of aborters) c.abort();
	const results = await Promise.all(operations);
	assert.ok(results.every((r) => r instanceof FileServiceError && r.code === "CLOSED"));
	await service.close();
});
test("protocol rejects extra fields, store and request confusion, and changed revisions", async () => {
	const f = await fixture();
	try {
		const request = parsePreviewRequest({ version: 1, expectedStoreId: "store", method: "open", params: f.target });
		assert.throws(() => parsePreviewRequest({ ...request, principalId: "owner" }));
		assert.throws(() => parsePreviewRequest({ ...request, params: { ...f.target, absolutePath: f.directory } }));
		const handler = createPreviewRequestHandler(f.service.client, "store");
		const response = await handler.execute(request);
		assert.throws(() => parsePreviewResponse({ ...response, storeId: "other" }, request));
		await assert.rejects(handler.execute({ ...request, expectedStoreId: "other" }), { code: "UNAUTHORIZED" });
		const client = createPreviewClient({
			storeId: "store",
			async request(req, signal) {
				const r = await handler.execute(req, signal);
				if (req.method === "readBytes" && r.ok && r.result)
					return { ...r, result: { ...r.result, revision: "b".repeat(64) } };
				return r;
			},
		});
		const h = await client.open(f.target);
		await assert.rejects(client.readBytes(h.id, 0));
	} finally {
		await f.close();
	}
});
test("client cancellation cleans up late open responses even for an ignoring bridge", async () => {
	const f = await fixture();
	try {
		const handler = createPreviewRequestHandler(f.service.client, "store");
		const gate = Promise.withResolvers<void>();
		let lateId = "",
			closedId = "";
		const client = createPreviewClient({
			storeId: "store",
			async request(req) {
				if (req.method === "open") {
					const r = await handler.execute(req);
					if (r.ok && r.result) lateId = r.result.id;
					await gate.promise;
					return r;
				}
				closedId = req.params.id;
				return handler.execute(req);
			},
		});
		const c = new AbortController();
		const opening = client.open(f.target, c.signal);
		await new Promise((resolve) => setTimeout(resolve, 20));
		c.abort();
		await assert.rejects(opening, { code: "CLOSED" });
		gate.resolve();
		await new Promise((resolve) => setTimeout(resolve, 20));
		assert.ok(lateId);
		assert.equal(closedId, lateId);
		await assert.rejects(f.service.client.readBytes(lateId, 0), { code: "NOT_FOUND" });
	} finally {
		await f.close();
	}
});

test("fixed binary chunks, global retained-byte budget, and close draining", async () => {
	const bytes = Buffer.alloc(20 * 1024 * 1024, 32);
	bytes.write("%PDF-1.7\n");
	bytes.write("%%EOF\n", bytes.length - 6);
	const gate = Promise.withResolvers<void>();
	let delayed = false;
	const service = createPreviewService({
		storeId: "store",
		principalId: "owner",
		source: {
			async read() {
				if (delayed) await gate.promise;
				return { bytes: Uint8Array.from(bytes), revision: "a".repeat(64) };
			},
			async assertAuthorized() {},
		},
		parser,
	});
	const target = { workspaceId: "workspace", rootId: "root", path: "test.pdf" };
	try {
		const handles = [];
		for (let i = 0; i < 3; i++) handles.push(await service.client.open(target));
		await assert.rejects(service.client.open(target), { code: "BUSY" });
		const chunk = await service.client.readBytes(handles[0].id, 0);
		assert.equal(Buffer.from(chunk.base64, "base64").length, PREVIEW_LIMITS.chunkBytes);
		await assert.rejects(service.client.readBytes(handles[0].id, 1), { code: "INVALID_PATH" });
		for (const handle of handles) await service.client.close(handle.id);
		delayed = true;
		const opening = service.client.open(target).catch((error) => error);
		await new Promise((resolve) => setImmediate(resolve));
		let settled = false;
		const closing = service.close().then(() => {
			settled = true;
		});
		await new Promise((resolve) => setImmediate(resolve));
		assert.equal(settled, false);
		gate.resolve();
		await closing;
		assert.equal((await opening).code, "CLOSED");
	} finally {
		gate.resolve();
		await service.close();
	}
});
function png(width: number, height: number) {
	const chunk = (type: string, data: Buffer) => {
		const b = Buffer.alloc(data.length + 12);
		b.writeUInt32BE(data.length);
		b.write(type, 4);
		data.copy(b, 8);
		let crc = 0xffffffff;
		for (const byte of b.subarray(4, -4)) {
			crc ^= byte;
			for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
		}
		b.writeUInt32BE((crc ^ 0xffffffff) >>> 0, b.length - 4);
		return b;
	};
	const header = Buffer.alloc(13);
	header.writeUInt32BE(width);
	header.writeUInt32BE(height, 4);
	header[8] = 8;
	header[9] = 6;
	return Buffer.concat([
		Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
		chunk("IHDR", header),
		chunk("IDAT", Buffer.from([120, 156, 99, 96, 0, 0, 0, 2, 0, 1])),
		chunk("IEND", Buffer.alloc(0)),
	]);
}
test("image structural gate rejects malformed PNG and oversized dimensions before decoding", async () => {
	const f = await fixture();
	try {
		const target = { ...f.target, path: "test.png" };
		await writeFile(join(f.directory, target.path), png(1, 1));
		const h = await f.service.client.open(target);
		assert.equal(h.kind, "png");
		await f.service.client.close(h.id);
		await writeFile(join(f.directory, target.path), png(4001, 4000));
		await assert.rejects(f.service.client.open(target), { code: "LIMIT_EXCEEDED" });
		const corrupt = png(1, 1);
		corrupt[20] ^= 1;
		await writeFile(join(f.directory, target.path), corrupt);
		await assert.rejects(f.service.client.open(target), { code: "BLOCKED_RESOURCE" });
		const renamed = { ...target, path: "test.jpeg" };
		await writeFile(join(f.directory, renamed.path), png(1, 1));
		await assert.rejects(f.service.client.open(renamed), { code: "BLOCKED_RESOURCE" });
	} finally {
		await f.close();
	}
});
test("document paging preserves supplementary characters and checked page copies", async () => {
	const text = `${"x".repeat(15999)}😀end`;
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
			async parse() {
				return { ...document, text };
			},
			async close() {},
		},
	});
	try {
		const h = await service.client.open({ workspaceId: "workspace", rootId: "root", path: "test.docx" });
		let result = "";
		for (let p = 0; p < h.summary.pages; p++) {
			const page = await service.client.readPage(h.id, p);
			assert.equal(page.content.kind, "document");
			if (page.content.kind === "document") {
				assert.ok(!/[\ud800-\udfff]/u.test(page.content.text));
				result += page.content.text;
				page.content.text = "mutated";
			}
		}
		assert.equal(result, text);
		const page = await service.client.readPage(h.id, 0);
		assert.ok(page.content.kind === "document" && page.content.text !== "mutated");
	} finally {
		await service.close();
	}
});
