import assert from "node:assert/strict";
import { test } from "node:test";
import { externalLinkUrl, parseExternalLinkRequest, parseExternalLinkResult } from "../src/external-links.ts";

test("only bounded absolute credential-free HTTP(S) URLs are admitted without I/O", () => {
	for (const value of [
		"javascript:alert(1)",
		"data:text/html,x",
		"file:///tmp/a",
		"mailto:a@b.test",
		"//example.test",
		"/relative",
		"#hash",
		"https://name:secret@example.test",
		"https://name@example.test",
		"https://example.test/\n",
		"https://example.test\\@evil.test",
		"https://example.test/%0a",
		"https://example.test/%5C",
		"https://example.test/\ud800",
		`https://example.test/${"x".repeat(8192)}`,
		"https:///example.test",
		null,
		123,
	])
		assert.equal(externalLinkUrl(value), undefined, String(value));
	assert.equal(externalLinkUrl("HTTPS://EXAMPLE.TEST/a?q=1#x"), "https://example.test/a?q=1#x");
	assert.equal(externalLinkUrl("http://[::1]:8080/a"), "http://[::1]:8080/a");
	assert.ok(externalLinkUrl("https://例子.test/路径"));
});

test("request accepts no renderer policy or confirmation and response is closed", () => {
	assert.deepEqual(parseExternalLinkRequest({ version: 1, url: "https://example.test" }), {
		version: 1,
		url: "https://example.test/",
	});
	for (const raw of [
		{ version: 2, url: "https://example.test" },
		{ version: 1, url: "https://example.test", policy: "allow" },
		{ version: 1, url: "https://example.test", confirmed: true },
		[],
	])
		assert.throws(() => parseExternalLinkRequest(raw));
	assert.equal(parseExternalLinkResult("opened"), "opened");
	assert.throws(() => parseExternalLinkResult({ opened: true }));
});
