import assert from "node:assert/strict";
import { test } from "node:test";
import { ExternalLinkService } from "../src/external-links/service.ts";

const page = "hipi-work://app/index.html";
const request = JSON.stringify({ version: 1, url: "https://example.test/a" });
test("owned main frame allow opens once through a mock and all other senders fail closed", async () => {
	const owner = { isDestroyed: () => false, mainFrame: { url: page } };
	const calls: string[] = [];
	const service = new ExternalLinkService(
		owner,
		page,
		() => "allow",
		async (url) => {
			calls.push(url);
		},
	);
	assert.equal(await service.request({ sender: owner, senderFrame: owner.mainFrame }, request), "opened");
	assert.deepEqual(calls, ["https://example.test/a"]);
	for (const event of [
		{ sender: {}, senderFrame: owner.mainFrame },
		{ sender: owner, senderFrame: { url: page } },
	])
		assert.equal(await service.request(event, request), "denied");
	owner.mainFrame.url = "https://example.test";
	assert.equal(await service.request({ sender: owner, senderFrame: owner.mainFrame }, request), "denied");
	assert.equal(calls.length, 1);
});
test("host restriction, malformed inputs and destroyed windows cannot invoke opener", async () => {
	let policy: "allow" | "restricted" = "restricted";
	let destroyed = false;
	const owner = { isDestroyed: () => destroyed, mainFrame: { url: page } };
	const event = { sender: owner, senderFrame: owner.mainFrame };
	const service = new ExternalLinkService(
		owner,
		page,
		() => policy,
		async () => {
			assert.fail("No external call permitted");
		},
	);
	assert.equal(await service.request(event, request), "denied");
	policy = "allow";
	for (const raw of [
		"{",
		"x".repeat(20000),
		JSON.stringify({ version: 1, url: "file:///tmp/a" }),
		JSON.stringify({ version: 1, url: "https://example.test", policy: "allow" }),
	])
		assert.equal(await service.request(event, raw), "denied");
	destroyed = true;
	assert.equal(await service.request(event, request), "denied");
});
test("pending OS operation stays single-flight and rejection never retries", async () => {
	const owner = { isDestroyed: () => false, mainFrame: { url: page } };
	const event = { sender: owner, senderFrame: owner.mainFrame };
	let reject: ((error: Error) => void) | undefined;
	let count = 0;
	const service = new ExternalLinkService(
		owner,
		page,
		() => "allow",
		() => {
			count++;
			return new Promise<void>((_resolve, fail) => {
				reject = fail;
			});
		},
	);
	const first = service.request(event, request);
	assert.equal(await service.request(event, request), "busy");
	assert.ok(reject);
	reject(new Error("OS rejected"));
	assert.equal(await first, "failed");
	assert.equal(count, 1);
});
