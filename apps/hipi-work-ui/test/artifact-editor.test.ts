import assert from "node:assert/strict";
import { test } from "node:test";
import type { FileRoot, FileTarget, FileText } from "@hipi/work-runtime/files";
import type { FileClient } from "@hipi/work-runtime/files/protocol";
import { EditorSession } from "../src/features/files/editor-session.ts";

const target: FileTarget = { workspaceId: "workspace", rootId: "root", path: "result.txt" };
const root: FileRoot = { workspaceId: "workspace", rootId: "root", writable: false };
const text: FileText = { text: "current content", revision: "b".repeat(64), bytes: 15, encoding: "utf-8" };
const reference = { operationId: "operation", expectedRevision: "a".repeat(64) };
function fixture() {
	let reads = 0,
		roots = 0,
		saves = 0;
	const client: FileClient = {
		listRoots: async () => {
			roots++;
			return [root];
		},
		list: async () => ({ entries: [], nextCursor: null }),
		preview: async () => ({ kind: "unsupported", reason: "binary-or-encoding" }),
		readText: async () => {
			reads++;
			return text;
		},
		saveText: async () => {
			saves++;
			return text;
		},
	};
	return { client, session: new EditorSession(client), calls: () => ({ reads, roots, saves }) };
}
test("activity opens current content with current root permission and distinct historical provenance", async () => {
	const f = fixture();
	await f.session.openArtifact(target, reference);
	const document = f.session.snapshot().document;
	assert.ok(document);
	assert.equal(document.writable, false);
	assert.equal(document.baseline.revision, text.revision);
	assert.deepEqual(document.artifactReference, reference);
	assert.notEqual(document.baseline.revision, document.artifactReference.expectedRevision);
	assert.equal(document.diffBaseline.kind, "editor-read");
	f.session.edit("a local edit");
	await f.session.save();
	assert.deepEqual(f.calls(), { roots: 1, reads: 1, saves: 0 });
	f.session.dispose();
});
test("revoked or foreign roots reject before reading and never grant access", async () => {
	for (const roots of [[], [{ ...root, workspaceId: "other" }], [{ ...root, rootId: "other" }]]) {
		const f = fixture();
		f.client.listRoots = async () => roots;
		await f.session.openArtifact(target, reference);
		assert.equal(f.session.snapshot().error, "UNAUTHORIZED");
		assert.equal(f.session.snapshot().document, undefined);
		assert.equal(f.calls().reads, 0);
		f.session.dispose();
	}
});
test("cancelled root lookup cannot read or overwrite a newer selection", async () => {
	const f = fixture();
	const lookup = Promise.withResolvers<FileRoot[]>();
	f.client.listRoots = async () => lookup.promise;
	const old = f.session.openArtifact(target, reference);
	f.session.clear();
	await f.session.open({ ...target, path: "new.txt" }, true);
	lookup.resolve([root]);
	await old;
	assert.equal(f.calls().reads, 1);
	assert.equal(f.session.snapshot().document?.target.path, "new.txt");
	assert.equal(f.session.snapshot().document?.artifactReference, undefined);
	assert.equal(f.session.snapshot().artifactRequest, undefined);
	f.session.dispose();
});
test("target and reference are copied before asynchronous authorization", async () => {
	const f = fixture();
	const lookup = Promise.withResolvers<FileRoot[]>();
	f.client.listRoots = async () => lookup.promise;
	const ownedTarget = { ...target },
		ownedReference = { ...reference };
	const pending = f.session.openArtifact(ownedTarget, ownedReference);
	ownedTarget.path = "changed.txt";
	ownedReference.operationId = "changed-operation";
	lookup.resolve([root]);
	await pending;
	assert.deepEqual(f.session.snapshot().document?.target, target);
	assert.deepEqual(f.session.snapshot().document?.artifactReference, reference);
	f.session.dispose();
});
test("dirty input and disposed sessions cannot trigger artifact reads", async () => {
	const f = fixture();
	await f.session.open(target, true);
	f.session.edit("keep this input");
	await f.session.openArtifact({ ...target, path: "other.txt" }, reference);
	assert.deepEqual(f.calls(), { roots: 0, reads: 1, saves: 0 });
	assert.equal(f.session.snapshot().document?.text, "keep this input");
	f.session.dispose();
	await f.session.openArtifact(target, reference);
	await f.session.open(target, true);
	await f.session.save();
	await f.session.compare();
	assert.deepEqual(f.calls(), { roots: 0, reads: 1, saves: 0 });
	assert.deepEqual(f.session.snapshot(), {});
});

test("effect reactivation permits new reads but never revives an old authorization lookup", async () => {
	const f = fixture();
	const oldRoots = Promise.withResolvers<FileRoot[]>();
	f.client.listRoots = async () => oldRoots.promise;
	const old = f.session.openArtifact(target, reference);
	f.session.dispose();
	f.session.activate();
	f.client.listRoots = async () => [root];
	await f.session.openArtifact({ ...target, path: "new.txt" }, { ...reference, operationId: "new-operation" });
	oldRoots.resolve([root]);
	await old;
	assert.equal(f.calls().reads, 1);
	assert.equal(f.session.snapshot().document?.target.path, "new.txt");
	assert.equal(f.session.snapshot().document?.artifactReference?.operationId, "new-operation");
	f.session.dispose();
});
