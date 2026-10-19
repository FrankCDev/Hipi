import assert from "node:assert/strict";
import { test } from "node:test";
import { FileServiceError } from "@hipi/work-runtime/files";
import { type PreviewRequest, parsePreviewRequest } from "@hipi/work-runtime/previews/protocol";
import { desktopPreviews } from "../src/app/preview-client.ts";

test("desktop preview requests bind store and cancellation to a unique operation", async () => {
	const cancellations: string[] = [];
	const requests: { id: string; raw: PreviewRequest }[] = [];
	let complete: (value: unknown) => void = () => {};
	const client = desktopPreviews(
		{
			request: async (id, raw) => {
				requests.push({ id, raw: parsePreviewRequest(raw) });
				if (raw.method === "close") return { version: 1, storeId: "store", request: raw, ok: true, result: null };
				return new Promise((resolve) => {
					complete = resolve;
				});
			},
			cancel: (id) => {
				cancellations.push(id);
			},
		},
		"store",
	);
	const controller = new AbortController();
	const pending = client.open({ workspaceId: "workspace", rootId: "root", path: "file.pdf" }, controller.signal);
	await Promise.resolve();
	controller.abort();
	await assert.rejects(pending, FileServiceError);
	const first = requests[0];
	assert.ok(first);
	assert.equal(first.raw.expectedStoreId, "store");
	assert.deepEqual(cancellations, [first.id]);
	complete({
		version: 1,
		storeId: "store",
		request: first.raw,
		ok: true,
		result: { id: "late", revision: "a".repeat(64), kind: "pdf", summary: { bytes: 10, pages: 0, truncated: false } },
	});
	await new Promise((resolve) => setTimeout(resolve, 10));
	assert.equal(requests[1]?.raw.method, "close");
	assert.notEqual(requests[1]?.id, first.id);
});
