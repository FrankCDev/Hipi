import assert from "node:assert/strict";
import { test } from "node:test";
import { FileServiceError, type FileText } from "@hipi/work-runtime/files";
import type { FileClient } from "@hipi/work-runtime/files/protocol";
import { EditorSession } from "../src/features/files/editor-session.ts";

const target = { workspaceId: "workspace", rootId: "root", path: "file.txt" };
const content = (text: string, revision = "a"): FileText => ({
	text,
	revision: revision.repeat(64),
	bytes: new TextEncoder().encode(text).length,
	encoding: "utf-8",
});
function fixture() {
	let disk = content("original");
	let saves = 0;
	const client: FileClient = {
		listRoots: async () => [],
		list: async () => ({ entries: [], nextCursor: null }),
		preview: async () => ({ kind: "unsupported", reason: "binary-or-encoding" }),
		readText: async () => disk,
		saveText: async (_target, text, revision) => {
			saves++;
			if (revision !== disk.revision) throw new FileServiceError("VERSION_CONFLICT");
			disk = content(text, "b");
			return disk;
		},
	};
	return {
		client,
		session: new EditorSession(client),
		setDisk: (value: FileText) => {
			disk = value;
		},
		saves: () => saves,
	};
}
test("dirty buffer blocks direct file switching; saves use the read revision", async () => {
	const f = fixture();
	await f.session.open(target, true);
	f.session.edit("my input");
	await f.session.open({ ...target, path: "other.txt" }, true);
	assert.equal(f.session.snapshot().document?.target.path, "file.txt");
	assert.equal(f.session.protected, true);
	await f.session.save();
	assert.equal(f.saves(), 1);
	assert.equal(f.session.protected, false);
	assert.equal(f.session.snapshot().document?.baseline.text, "my input");
	assert.equal(f.session.snapshot().document?.diffBaseline.kind, "editor-read");
	assert.equal(f.session.snapshot().document?.diffBaseline.text, "original");
});
test("external conflict preserves input and original baseline; comparison never overwrites", async () => {
	const f = fixture();
	await f.session.open(target, true);
	f.session.edit("mine");
	f.setDisk(content("external", "c"));
	await f.session.save();
	assert.equal(f.session.snapshot().error, "VERSION_CONFLICT");
	await f.session.compare();
	assert.equal(f.session.snapshot().document?.text, "mine");
	assert.equal(f.session.snapshot().document?.baseline.text, "original");
	assert.equal(f.session.snapshot().disk?.text, "external");
	await f.session.save();
	assert.equal(f.saves(), 1);
	f.session.reload();
	await Promise.resolve();
	assert.equal(f.session.snapshot().document?.text, "external");
});
test("unknown write is never retried; matching disk reconciles even empty input", async () => {
	const f = fixture();
	await f.session.open(target, true);
	f.session.edit("");
	let saves = 0;
	f.client.saveText = async () => {
		saves++;
		throw new FileServiceError("WRITE_OUTCOME_UNKNOWN");
	};
	await f.session.save();
	assert.equal(f.session.protected, true);
	await f.session.save();
	assert.equal(saves, 1);
	await f.session.compare();
	assert.equal(f.session.snapshot().unknown, "");
	assert.equal(f.session.protected, true);
	f.setDisk(content("", "b"));
	await f.session.compare();
	assert.equal(f.session.snapshot().unknown, undefined);
	assert.equal(f.session.protected, false);
});
test("cancelled save remains unknown and ignores late success", async () => {
	const f = fixture();
	await f.session.open(target, true);
	f.session.edit("pending");
	let finish: (text: FileText) => void = () => {};
	f.client.saveText = async () =>
		new Promise((resolve) => {
			finish = resolve;
		});
	const pending = f.session.save();
	f.session.cancel();
	assert.equal(f.session.snapshot().unknown, "pending");
	finish(content("pending", "b"));
	await pending;
	assert.equal(f.session.snapshot().unknown, "pending");
	assert.equal(f.session.snapshot().document?.baseline.text, "original");
});
test("slow cancelled read cannot replace newer target", async () => {
	const f = fixture();
	let finish: (text: FileText) => void = () => {};
	f.client.readText = async () =>
		new Promise((resolve) => {
			finish = resolve;
		});
	const old = f.session.open(target, true);
	f.session.clear();
	f.client.readText = async () => content("new");
	await f.session.open({ ...target, path: "new.txt" }, true);
	finish(content("old"));
	await old;
	assert.equal(f.session.snapshot().document?.text, "new");
	let updates = 0;
	f.session.subscribe(() => updates++);
	f.session.dispose();
	assert.equal(updates, 0);
});
test("read-only and oversized text never call save", async () => {
	const f = fixture();
	await f.session.open(target, false);
	f.session.edit("input");
	await f.session.save();
	assert.equal(f.saves(), 0);
	f.session.clear();
	await f.session.open(target, true);
	f.session.edit("中".repeat(50000));
	await f.session.save();
	assert.equal(f.saves(), 0);
	assert.equal(f.session.snapshot().error, "LIMIT_EXCEEDED");
});
test("failed comparison preserves dirty buffer and unknown outcome", async () => {
	const f = fixture();
	await f.session.open(target, true);
	f.session.edit("input");
	f.client.saveText = async () => {
		throw new Error("transport lost");
	};
	await f.session.save();
	f.client.readText = async () => {
		throw new Error("offline");
	};
	await f.session.compare();
	assert.equal(f.session.snapshot().unknown, "input");
	assert.equal(f.session.snapshot().document?.text, "input");
	assert.equal(f.session.protected, true);
});

test("explicit comparison adoption preserves manually merged input and initial Diff baseline", async () => {
	const f = fixture();
	await f.session.open(target, true);
	f.session.edit("mine");
	f.setDisk(content("external", "c"));
	await f.session.save();
	assert.equal(f.session.adoptComparedRevision(), false);
	await f.session.compare();
	f.session.edit("manually merged");
	assert.equal(f.session.adoptComparedRevision(), true);
	assert.equal(f.saves(), 1);
	assert.equal(f.session.snapshot().document?.text, "manually merged");
	assert.equal(f.session.snapshot().document?.baseline.revision, "c".repeat(64));
	assert.equal(f.session.snapshot().document?.diffBaseline.text, "original");
	assert.equal(f.session.snapshot().error, undefined);
	await f.session.save();
	assert.equal(f.saves(), 2);
	assert.equal(f.session.protected, false);
});
test("unknown mismatch requires explicit adoption and later disk races still conflict", async () => {
	const f = fixture();
	await f.session.open(target, true);
	f.session.edit("mine");
	const save = f.client.saveText;
	f.client.saveText = async () => {
		throw new FileServiceError("WRITE_OUTCOME_UNKNOWN");
	};
	await f.session.save();
	f.setDisk(content("external", "c"));
	await f.session.compare();
	assert.equal(f.session.snapshot().unknown, "mine");
	f.client.saveText = save;
	await f.session.save();
	assert.equal(f.saves(), 0);
	assert.equal(f.session.adoptComparedRevision(), true);
	assert.equal(f.session.snapshot().unknown, undefined);
	assert.equal(f.session.snapshot().document?.text, "mine");
	f.setDisk(content("another writer", "d"));
	await f.session.save();
	assert.equal(f.session.snapshot().error, "VERSION_CONFLICT");
	assert.equal(f.session.snapshot().document?.text, "mine");
});
test("adoption is blocked during reads and cannot carry a comparison to another target", async () => {
	const f = fixture();
	await f.session.open(target, true);
	await f.session.compare();
	let finish: (value: FileText) => void = () => {};
	f.client.readText = async () =>
		new Promise((resolve) => {
			finish = resolve;
		});
	const pending = f.session.compare();
	assert.equal(f.session.adoptComparedRevision(), false);
	f.session.clear();
	f.client.readText = async () => content("new file", "d");
	await f.session.open({ ...target, path: "other.txt" }, true);
	finish(content("late old disk", "c"));
	await pending;
	assert.equal(f.session.adoptComparedRevision(), false);
	assert.equal(f.session.snapshot().document?.target.path, "other.txt");
});

test("a pre-save comparison cannot be adopted after an unconfirmed save without rereading", async () => {
	const f = fixture();
	await f.session.open(target, true);
	await f.session.compare();
	f.session.edit("mine");
	f.client.saveText = async () => {
		throw new FileServiceError("WRITE_OUTCOME_UNKNOWN");
	};
	await f.session.save();
	assert.equal(f.session.snapshot().disk, undefined);
	assert.equal(f.session.adoptComparedRevision(), false);
	await f.session.compare();
	assert.equal(f.session.adoptComparedRevision(), true);
	assert.equal(f.session.snapshot().document?.text, "mine");
});
