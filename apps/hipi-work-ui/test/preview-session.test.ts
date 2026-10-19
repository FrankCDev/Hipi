import assert from "node:assert/strict";
import { test } from "node:test";
import { FileServiceError } from "@hipi/work-runtime/files";
import {
	PREVIEW_LIMITS,
	type PreviewClient,
	type PreviewHandle,
	type PreviewPage,
} from "@hipi/work-runtime/previews/protocol";
import { PREVIEW_BYTE_LIMIT, PreviewSession } from "../src/features/files/preview-session.ts";

const target = { workspaceId: "workspace", rootId: "root", path: "example.docx" };
const handle = (id = "first", kind: PreviewHandle["kind"] = "docx", bytes = 100): PreviewHandle => ({
	id,
	revision: "a".repeat(64),
	kind,
	summary: { bytes, pages: kind === "docx" ? 3 : 0, truncated: false },
});
const page = (id: string, index: number): PreviewPage => ({
	id,
	revision: "a".repeat(64),
	page: index,
	content: { kind: "document", format: "docx", text: `Page ${index}`, truncated: false, limitations: [] },
});
function fixture() {
	const closed: string[] = [];
	const client: PreviewClient = {
		open: async () => handle(),
		readPage: async (id, index) => page(id, index),
		readBytes: async () => {
			throw new Error("Unexpected byte read");
		},
		close: async (id) => {
			closed.push(id);
		},
	};
	return { client, closed, session: new PreviewSession(client) };
}
test("preview retains exactly one page and closes on clear", async () => {
	const f = fixture();
	await f.session.open(target);
	assert.equal(f.session.snapshot().page?.page, 0);
	await f.session.readPage(2);
	assert.equal(f.session.snapshot().page?.page, 2);
	f.session.clear();
	assert.deepEqual(f.session.snapshot(), {});
	assert.deepEqual(f.closed, ["first"]);
});
test("switching before open returns closes the late handle without publishing", async () => {
	const f = fixture();
	let resolve: (value: PreviewHandle) => void = () => {};
	f.client.open = async () =>
		new Promise((done) => {
			resolve = done;
		});
	const old = f.session.open(target);
	f.client.open = async () => handle("second");
	await f.session.open({ ...target, path: "new.docx" });
	resolve(handle());
	await old;
	assert.equal(f.session.snapshot().handle?.id, "second");
	assert.deepEqual(f.closed, ["first"]);
	f.session.dispose();
});
test("late page after disposal cannot resurrect private content", async () => {
	const f = fixture();
	await f.session.open(target);
	let resolve: (value: PreviewPage) => void = () => {};
	f.client.readPage = async () =>
		new Promise((done) => {
			resolve = done;
		});
	const pending = f.session.readPage(1);
	f.session.dispose();
	resolve(page("first", 1));
	await pending;
	assert.deepEqual(f.session.snapshot(), {});
	assert.deepEqual(f.closed, ["first"]);
});
test("permission errors release the handle and retained content", async () => {
	const f = fixture();
	await f.session.open(target);
	f.client.readPage = async () => {
		throw new FileServiceError("UNAUTHORIZED");
	};
	await f.session.readPage(1);
	assert.equal(f.session.snapshot().error, "UNAUTHORIZED");
	assert.equal(f.session.snapshot().page, undefined);
	assert.equal(f.session.snapshot().handle, undefined);
	assert.deepEqual(f.closed, ["first"]);
});
test("bytes are read sequentially in fixed bounded chunks and cleared on release", async () => {
	const f = fixture();
	const total = PREVIEW_LIMITS.chunkBytes + 12;
	const offsets: number[] = [];
	f.client.open = async () => handle("image", "png", total);
	f.client.readBytes = async (id, offset) => {
		offsets.push(offset);
		return {
			id,
			offset,
			revision: "a".repeat(64),
			total,
			base64: Buffer.alloc(Math.min(PREVIEW_LIMITS.chunkBytes, total - offset), 7).toString("base64"),
		};
	};
	await f.session.open(target);
	assert.deepEqual(offsets, [0, PREVIEW_LIMITS.chunkBytes]);
	assert.equal(f.session.snapshot().bytes?.length, total);
	assert.equal(f.session.snapshot().bytes?.at(-1), 7);
	f.session.clear();
	assert.equal(f.session.snapshot().bytes, undefined);
});
test("size and revision violations close without exposing bytes", async () => {
	const f = fixture();
	f.client.open = async () => handle("large", "pdf", PREVIEW_BYTE_LIMIT + 1);
	await f.session.open(target);
	assert.equal(f.session.snapshot().error, "LIMIT_EXCEEDED");
	f.client.open = async () => handle("changed", "pdf", 4);
	f.client.readBytes = async (id, offset) => ({ id, offset, revision: "b".repeat(64), total: 4, base64: "YWJjZA==" });
	await f.session.open(target);
	assert.equal(f.session.snapshot().error, "BLOCKED_RESOURCE");
	assert.equal(f.session.snapshot().bytes, undefined);
	assert.deepEqual(f.closed, ["large", "changed"]);
});
test("failed close cannot retain resources or create an unhandled rejection", async () => {
	const f = fixture();
	await f.session.open(target);
	f.client.close = async () => {
		throw new Error("Disconnected");
	};
	f.session.dispose();
	await Promise.resolve();
	assert.deepEqual(f.session.snapshot(), {});
});
test("mismatched document format and oversized images cannot enter a viewer", async () => {
	const f = fixture();
	f.client.readPage = async (id, index) => ({
		...page(id, index),
		content: { kind: "spreadsheet", format: "xlsx", sheets: [], truncated: false, limitations: [] },
	});
	await f.session.open(target);
	assert.equal(f.session.snapshot().error, "BLOCKED_RESOURCE");
	f.client.open = async () => handle("image", "png", 10 * 1024 * 1024 + 1);
	await f.session.open(target);
	assert.equal(f.session.snapshot().error, "LIMIT_EXCEEDED");
	assert.deepEqual(f.closed, ["first", "image"]);
});
