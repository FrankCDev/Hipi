import assert from "node:assert/strict";
import { test } from "vitest";
import { createPresentationPreferences, presentationStorageKey } from "../src/app/presentation/store.ts";

test("global code wrapping defaults off, persists exact v1 schema and reloads", () => {
	const data = new Map<string, string>();
	const storage = {
		getItem: (key: string) => data.get(key) ?? null,
		setItem: (key: string, value: string) => {
			data.set(key, value);
		},
	};
	const owner = createPresentationPreferences(storage);
	assert.equal(owner.store.getState().codeBlockWordWrap, false);
	let changes = 0;
	const unsubscribe = owner.store.subscribe(() => changes++);
	owner.toggleCodeBlockWordWrap();
	assert.deepEqual(JSON.parse(data.get(presentationStorageKey) ?? ""), { version: 1, codeBlockWordWrap: true });
	assert.equal(createPresentationPreferences(storage).store.getState().codeBlockWordWrap, true);
	assert.equal(changes, 1);
	unsubscribe();
});

test("invalid/future records stay untouched; unavailable storage stays functional without claiming persistence", () => {
	for (const raw of [
		"{",
		"null",
		'{"version":2,"codeBlockWordWrap":true}',
		'{"version":1,"codeBlockWordWrap":"yes"}',
		'{"version":1,"codeBlockWordWrap":true,"extra":0}',
	]) {
		let writes = 0;
		const owner = createPresentationPreferences({
			getItem: () => raw,
			setItem: () => {
				writes++;
			},
		});
		assert.equal(owner.store.getState().codeBlockWordWrap, false);
		owner.toggleCodeBlockWordWrap();
		assert.equal(owner.store.getState().codeBlockWordWrap, true);
		assert.equal(owner.store.getState().storageStatus, "invalid");
		assert.equal(writes, 0);
	}
	for (const storage of [
		undefined,
		{
			getItem: () => {
				throw new Error("denied");
			},
			setItem: () => {
				throw new Error("denied");
			},
		},
		{
			getItem: () => null,
			setItem: () => {
				throw new Error("quota");
			},
		},
	]) {
		const owner = createPresentationPreferences(storage);
		owner.toggleCodeBlockWordWrap();
		assert.equal(owner.store.getState().codeBlockWordWrap, true);
		assert.equal(owner.store.getState().storageStatus, "memory");
	}
});
