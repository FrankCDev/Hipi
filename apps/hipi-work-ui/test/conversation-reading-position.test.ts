import assert from "node:assert/strict";
import { test } from "node:test";
import type { AppClient } from "@hipi/work-runtime/contracts";
import {
	ConversationReadingPositions,
	readingPositionsFor,
} from "../src/features/workbench/conversation-reading-position.ts";

const scope = { workspaceId: "workspace", conversationId: "conversation" };
const item = (index: number) => ({
	key: `message:${index}`,
	index,
	size: 100,
	start: index * 100,
	end: (index + 1) * 100,
	lane: 0,
});
test("reading restoration retains a stable key and fractional pixel, never message contents", () => {
	const positions = new ConversationReadingPositions();
	positions.save(
		scope,
		{ key: "message:20", pixel: -25.375, following: false },
		Array.from({ length: 50 }, (_, index) => item(index)),
	);
	const saved = positions.read(scope);
	assert.equal(saved?.key, "message:20");
	assert.equal(saved?.pixel, -25.375);
	assert.equal(saved?.following, false);
	assert.equal(saved?.heights.get("message:20"), 100);
	assert.deepEqual(Object.keys(saved ?? {}).sort(), ["following", "heights", "key", "pixel"]);
});
test("height metadata stays bounded near the reading key and LRU scopes cannot collide", () => {
	const positions = new ConversationReadingPositions();
	positions.save(
		scope,
		{ key: "message:1000", pixel: -12, following: false },
		Array.from({ length: 2000 }, (_, index) => item(index)),
	);
	assert.equal(positions.read(scope)?.heights.size, 256);
	assert.equal(positions.read(scope)?.heights.has("message:1000"), true);
	assert.equal(positions.read(scope)?.heights.has("message:0"), false);
	const a = { workspaceId: "a:b", conversationId: "c" };
	const b = { workspaceId: "a", conversationId: "b:c" };
	positions.save(a, { key: "a", pixel: 0, following: true }, []);
	positions.save(b, { key: "b", pixel: 0, following: true }, []);
	assert.equal(positions.read(a)?.key, "a");
	assert.equal(positions.read(b)?.key, "b");
	for (let index = 0; index < 24; index++)
		positions.save({ ...scope, conversationId: String(index) }, { key: "x", pixel: 0, following: true }, []);
	assert.equal(positions.read(scope), undefined);
	positions.clear({ ...scope, conversationId: "23" });
	assert.equal(positions.read({ ...scope, conversationId: "23" }), undefined);
});

test("the same scope IDs in two injected stores have distinct view owners and reading metadata", () => {
	// Identity-only doubles: the reading-position cache never calls the clients.
	const first = {} as AppClient;
	const second = {} as AppClient;
	const a = readingPositionsFor(first);
	const b = readingPositionsFor(second);
	assert.equal(readingPositionsFor(first), a);
	assert.notEqual(a.ownerKey, b.ownerKey);
	a.save(scope, { key: "private-first-store-key", pixel: -30, following: false }, []);
	assert.equal(b.read(scope), undefined);
	assert.equal(a.read(scope)?.key, "private-first-store-key");
});
