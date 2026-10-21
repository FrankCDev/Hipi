import assert from "node:assert/strict";
import { test } from "node:test";
import { hostMessages } from "../src/shell/messages.ts";

test("native host messages retain failure and unknown-outcome semantics across locales", () => {
	assert.match(hostMessages("en-US")["host.shutdown.unknown"], /unknown/);
	assert.match(hostMessages("zh-CN")["host.shutdown.unknown"], /未知/);
	assert.match(hostMessages("zh_CN")["host.unsaved.detail"], /不会因此取消/);
	assert.equal(hostMessages("ZH-tw"), hostMessages("zh"));
	assert.equal(hostMessages("de-DE"), hostMessages("en-US"));
	assert.equal(hostMessages("zhfake"), hostMessages("en-US"));
	assert.notEqual(hostMessages("zh")["host.unsaved.discard"], hostMessages("zh")["host.unsaved.keep"]);
});
