import assert from "node:assert/strict";
import { test } from "node:test";
import { boundedCatalogBytes } from "./release-download.mjs";

test("catalog download allows the exact bound and rejects a missing body", async () => {
	assert.equal((await boundedCatalogBytes(new Response("1234"), 4)).toString(), "1234");
	await assert.rejects(boundedCatalogBytes(new Response(null)), /body is missing/);
});

test("catalog download counts actual chunks regardless of declared length and cancels overflow", async () => {
	let cancelled = false;
	const response = new Response(
		new ReadableStream({
			start(controller) {
				controller.enqueue(new Uint8Array([1, 2]));
				controller.enqueue(new Uint8Array([3, 4, 5]));
			},
			cancel() {
				cancelled = true;
			},
		}),
		{ headers: { "Content-Length": "1" } },
	);
	await assert.rejects(boundedCatalogBytes(response, 4), /maximum download size/);
	assert.equal(cancelled, true);
});
