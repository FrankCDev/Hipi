import assert from "node:assert/strict";
import { FileServiceError, type FileText } from "@hipi/work-runtime/files";
import type { FileClient } from "@hipi/work-runtime/files/protocol";
import type { PreviewClient } from "@hipi/work-runtime/previews/protocol";
import { afterEach, beforeEach, test, vi } from "vitest";
import {
	FILE_AUTOSAVE_DELAY,
	FILE_WORKSPACE_LIMIT,
	FileWorkspaceSession,
} from "../src/features/files/file-workspace-session.ts";

const target = { workspaceId: "workspace", rootId: "root", path: "first.txt" };
const text = (value: string, revision = "a"): FileText => ({
	text: value,
	revision: revision.repeat(64),
	bytes: value.length,
	encoding: "utf-8",
});
const owners: FileWorkspaceSession[] = [];
function fixture(overrides: Partial<FileClient> = {}) {
	const saved: { path: string; value: string; revision: string }[] = [];
	const files: FileClient = {
		listRoots: async () => [{ workspaceId: "workspace", rootId: "root", writable: true }],
		list: async () => ({ entries: [], nextCursor: null }),
		preview: async () => ({ kind: "unsupported", reason: "binary-or-encoding" }),
		readText: async () => text("original"),
		saveText: async (file, value, revision) => {
			saved.push({ path: file.path, value, revision });
			return text(value, "b");
		},
		...overrides,
	};
	const owner = new FileWorkspaceSession(files);
	owner.setWorkspace("workspace");
	owners.push(owner);
	return { owner, files, saved };
}
function active(owner: FileWorkspaceSession) {
	const tab = owner.snapshot().tabs.find((item) => item.id === owner.snapshot().activeId);
	assert.ok(tab && tab.kind === "editor");
	return tab;
}
beforeEach(() => vi.useFakeTimers());
afterEach(() => {
	for (const owner of owners.splice(0)) owner.dispose();
	vi.useRealTimers();
});

test("clean transient replacement, edit pinning, and exact owner reuse preserve drafts", async () => {
	const f = fixture();
	await f.owner.open(target, true);
	const transient = active(f.owner);
	await f.owner.open({ ...target, path: "second.txt" }, true);
	assert.equal(f.owner.snapshot().tabs.length, 1);
	assert.notEqual(active(f.owner).id, transient.id);
	assert.deepEqual(transient.editor.snapshot(), {});
	const edited = active(f.owner);
	edited.editor.edit("my draft");
	await f.owner.open(target, true);
	assert.equal(f.owner.snapshot().tabs.length, 2);
	assert.equal(f.owner.snapshot().tabs.find((tab) => tab.id === edited.id)?.pinned, true);
	await f.owner.open(edited.target, true);
	assert.equal(active(f.owner).editor, edited.editor);
	assert.equal(active(f.owner).editor.snapshot().document?.text, "my draft");
	assert.equal(f.saved.length, 0);
});

test("workspace selection retains all buffers, active choices and aggregate protection", async () => {
	const f = fixture();
	await f.owner.open(target, true, { pinned: true });
	const first = active(f.owner);
	first.editor.edit("unsaved first");
	f.owner.setWorkspace("other");
	await f.owner.open({ ...target, workspaceId: "other" }, true, { pinned: true });
	const second = active(f.owner);
	assert.notEqual(first.id, second.id);
	assert.equal(f.owner.protected, true);
	f.owner.setWorkspace("workspace");
	assert.equal(active(f.owner).id, first.id);
	assert.equal(first.editor.snapshot().document?.text, "unsaved first");
	f.owner.setWorkspace("other");
	assert.equal(active(f.owner).id, second.id);
});

test("debounce submits latest bytes once, retaining later typing during an in-flight save", async () => {
	const pending = Promise.withResolvers<FileText>();
	const sent: string[] = [];
	const f = fixture({
		saveText: async (_target, value) => {
			sent.push(value);
			return sent.length === 1 ? pending.promise : text(value, "c");
		},
	});
	await f.owner.open(target, true);
	const editor = active(f.owner).editor;
	editor.edit("first draft");
	await vi.advanceTimersByTimeAsync(2000);
	editor.edit("submitted draft");
	await vi.advanceTimersByTimeAsync(FILE_AUTOSAVE_DELAY - 1);
	assert.deepEqual(sent, []);
	await vi.advanceTimersByTimeAsync(1);
	assert.deepEqual(sent, ["submitted draft"]);
	editor.edit("later draft");
	await vi.advanceTimersByTimeAsync(10000);
	assert.equal(sent.length, 1);
	pending.resolve(text("submitted draft", "b"));
	await Promise.resolve();
	await Promise.resolve();
	assert.equal(editor.snapshot().document?.baseline.text, "submitted draft");
	assert.equal(editor.snapshot().document?.text, "later draft");
	await vi.advanceTimersByTimeAsync(FILE_AUTOSAVE_DELAY);
	assert.deepEqual(sent, ["submitted draft", "later draft"]);
	assert.equal(editor.protected, false);
});
for (const outcome of ["VERSION_CONFLICT", "WRITE_OUTCOME_UNKNOWN"] as const) {
	test(`${outcome} pauses autosave and stays protected when input equals old baseline`, async () => {
		let saves = 0;
		const f = fixture({
			saveText: async () => {
				saves++;
				throw new FileServiceError(outcome);
			},
		});
		await f.owner.open(target, true);
		const editor = active(f.owner).editor;
		editor.edit("mine");
		await vi.advanceTimersByTimeAsync(FILE_AUTOSAVE_DELAY);
		editor.edit("original");
		await vi.advanceTimersByTimeAsync(FILE_AUTOSAVE_DELAY * 10);
		assert.equal(saves, 1);
		assert.equal(f.owner.protected, true);
		assert.equal(editor.snapshot().error, outcome);
	});
}
test("cancelled save reconciles submitted bytes, not later edits", async () => {
	const pending = Promise.withResolvers<FileText>();
	const f = fixture({ saveText: () => pending.promise });
	await f.owner.open(target, true);
	const editor = active(f.owner).editor;
	editor.edit("submitted");
	const save = editor.save();
	editor.edit("typed later");
	editor.cancel();
	assert.equal(editor.snapshot().unknown, "submitted");
	assert.equal(editor.snapshot().document?.text, "typed later");
	pending.resolve(text("submitted", "b"));
	await save;
	f.files.readText = async () => text("submitted", "b");
	await editor.compare();
	assert.equal(editor.snapshot().unknown, undefined);
	assert.equal(editor.snapshot().document?.baseline.text, "submitted");
	assert.equal(editor.snapshot().document?.text, "typed later");
	assert.equal(editor.snapshot().autosavePaused, true);
	await vi.advanceTimersByTimeAsync(FILE_AUTOSAVE_DELAY * 3);
	assert.equal(editor.snapshot().document?.baseline.text, "submitted");
	assert.equal(editor.snapshot().document?.text, "typed later");
	assert.equal(editor.snapshot().operation, undefined);
});
for (const resume of ["edit", "save"] as const) {
	test(`reviewing a conflict never writes until subsequent ${resume}`, async () => {
		let calls = 0;
		const f = fixture({
			saveText: async (_target, value) => {
				calls++;
				if (calls === 1) throw new FileServiceError("VERSION_CONFLICT");
				return text(value, "c");
			},
		});
		await f.owner.open(target, true);
		const tab = active(f.owner);
		tab.editor.edit("my draft");
		await vi.advanceTimersByTimeAsync(FILE_AUTOSAVE_DELAY);
		f.files.readText = async () => text("other author", "b");
		await tab.editor.compare();
		assert.equal(tab.editor.adoptComparedRevision(), true);
		assert.equal(tab.editor.snapshot().autosavePaused, true);
		await vi.advanceTimersByTimeAsync(FILE_AUTOSAVE_DELAY * 3);
		assert.equal(calls, 1);
		assert.deepEqual(await f.owner.close([tab.id]), [tab.id]);
		assert.equal(calls, 1, "close cannot silently resume a paused recovery");
		if (resume === "edit") {
			tab.editor.edit("my draft");
			await vi.advanceTimersByTimeAsync(FILE_AUTOSAVE_DELAY);
			assert.equal(calls, 1, "unchanged renderer notification is not a user edit");
			tab.editor.edit("reviewed draft");
			await vi.advanceTimersByTimeAsync(FILE_AUTOSAVE_DELAY);
		} else await tab.editor.save();
		assert.equal(calls, 2);
		assert.equal(tab.editor.protected, false);
	});
}
test("unknown-write reconciliation pauses later input until a new deliberate edit", async () => {
	let calls = 0;
	const pending = Promise.withResolvers<FileText>();
	const f = fixture({
		saveText: async (_target, value) => {
			calls++;
			return calls === 1 ? pending.promise : text(value, "c");
		},
	});
	await f.owner.open(target, true);
	const editor = active(f.owner).editor;
	editor.edit("submitted");
	const save = editor.save();
	editor.edit("later input");
	editor.cancel();
	f.files.readText = async () => text("submitted", "b");
	await editor.compare();
	pending.resolve(text("submitted", "b"));
	await save;
	await vi.advanceTimersByTimeAsync(FILE_AUTOSAVE_DELAY * 2);
	assert.equal(calls, 1);
	assert.equal(editor.snapshot().autosavePaused, true);
	editor.edit("later input reviewed");
	await vi.advanceTimersByTimeAsync(FILE_AUTOSAVE_DELAY);
	assert.equal(calls, 2);
	assert.equal(editor.snapshot().document?.text, "later input reviewed");
});
test("a late close save cannot remove a reopened same-path tab", async () => {
	const pending = Promise.withResolvers<FileText>();
	const f = fixture({ saveText: () => pending.promise });
	await f.owner.open(target, true, { pinned: true });
	const old = active(f.owner);
	old.editor.edit("save me");
	const close = f.owner.close([old.id]);
	f.owner.discard([old.id]);
	await f.owner.open(target, true, { pinned: true });
	const replacement = active(f.owner);
	pending.resolve(text("save me", "b"));
	assert.deepEqual(await close, []);
	assert.notEqual(replacement.id, old.id);
	assert.equal(f.owner.snapshot().tabs[0]?.id, replacement.id);
});
test("failed close returns exact protected IDs and discard does not touch another tab", async () => {
	const f = fixture({
		saveText: async () => {
			throw new FileServiceError("WRITE_OUTCOME_UNKNOWN");
		},
	});
	await f.owner.open(target, true, { pinned: true });
	const first = active(f.owner);
	first.editor.edit("preserve");
	assert.deepEqual(await f.owner.close([first.id]), [first.id]);
	await f.owner.open({ ...target, path: "other.txt" }, true, { pinned: true });
	const second = active(f.owner);
	f.owner.discard([first.id]);
	assert.deepEqual(
		f.owner.snapshot().tabs.map((tab) => tab.id),
		[second.id],
	);
});
test("capacity never evicts protected tabs or reads the rejected target", async () => {
	let reads = 0;
	const f = fixture({
		readText: async () => {
			reads++;
			return text("original");
		},
	});
	for (let index = 0; index < FILE_WORKSPACE_LIMIT; index++) {
		await f.owner.open({ ...target, path: `${index}.txt` }, true, { pinned: true });
		active(f.owner).editor.edit(String(index));
	}
	await f.owner.open({ ...target, path: "over-limit.txt" }, true);
	assert.equal(f.owner.snapshot().tabs.length, FILE_WORKSPACE_LIMIT);
	assert.equal(f.owner.snapshot().limitReached, true);
	assert.equal(reads, FILE_WORKSPACE_LIMIT);
	assert.ok(f.owner.snapshot().tabs.every((tab) => tab.kind === "editor" && tab.editor.protected));
});
test("artifact reopen preserves dirty bytes and baseline while retaining new provenance", async () => {
	const f = fixture();
	await f.owner.open(target, true);
	const first = active(f.owner);
	first.editor.edit("my draft");
	await f.owner.openArtifact(target, { operationId: "op", expectedRevision: "c".repeat(64) });
	const reopened = active(f.owner);
	assert.equal(reopened.editor, first.editor);
	assert.equal(reopened.reference?.expectedRevision, "c".repeat(64));
	assert.equal(reopened.editor.snapshot().document?.baseline.revision, "a".repeat(64));
	assert.equal(reopened.editor.snapshot().document?.text, "my draft");
});
test("hide releases preview handles, keeps tab identity and reauthorizes on resume", async () => {
	const f = fixture();
	let opens = 0;
	const closed: string[] = [];
	const preview: PreviewClient = {
		open: async () => ({
			id: `handle${++opens}`,
			revision: "a".repeat(64),
			kind: "docx",
			summary: { bytes: 4, pages: 1, truncated: false },
		}),
		readPage: async (id, page) => ({
			id,
			revision: "a".repeat(64),
			page,
			content: { kind: "document", format: "docx", text: "page", truncated: false, limitations: [] },
		}),
		readBytes: async () => {
			throw Error("unexpected bytes");
		},
		close: async (id) => {
			closed.push(id);
		},
	};
	const owner = new FileWorkspaceSession(f.files, preview);
	owners.push(owner);
	await owner.openPreview({ ...target, path: "preview.docx" }, true);
	const tab = owner.snapshot().tabs[0];
	assert.ok(tab && tab.kind === "preview");
	owner.suspendPreviews();
	assert.deepEqual(closed, ["handle1"]);
	assert.equal(owner.snapshot().tabs[0]?.id, tab.id);
	assert.deepEqual(tab.preview.snapshot(), {});
	owner.resumePreview(tab.id);
	await Promise.resolve();
	await Promise.resolve();
	await Promise.resolve();
	assert.equal(opens, 2);
	assert.equal(tab.preview.snapshot().target?.path, "preview.docx");
});
test("disposal cancels every autosave timer", async () => {
	const f = fixture();
	await f.owner.open(target, true);
	active(f.owner).editor.edit("pending");
	f.owner.dispose();
	await vi.advanceTimersByTimeAsync(FILE_AUTOSAVE_DELAY * 2);
	assert.equal(f.saved.length, 0);
	assert.equal(f.owner.snapshot().tabs.length, 0);
});

test("close joins the exact running autosave then saves newer input against its confirmed revision", async () => {
	const first = Promise.withResolvers<FileText>();
	const second = Promise.withResolvers<FileText>();
	const writes: { value: string; revision: string }[] = [];
	const f = fixture({
		saveText: (_target, value, revision) => {
			writes.push({ value, revision });
			return writes.length === 1 ? first.promise : second.promise;
		},
	});
	await f.owner.open(target, true);
	const tab = active(f.owner);
	tab.editor.edit("first");
	await vi.advanceTimersByTimeAsync(FILE_AUTOSAVE_DELAY);
	let settled = false;
	const closing = f.owner.close([tab.id]).then((blocked) => {
		settled = true;
		return blocked;
	});
	await Promise.resolve();
	assert.equal(settled, false);
	assert.equal(writes.length, 1);
	tab.editor.edit("newer");
	first.resolve(text("first", "b"));
	await vi.advanceTimersByTimeAsync(0);
	assert.deepEqual(writes, [
		{ value: "first", revision: "a".repeat(64) },
		{ value: "newer", revision: "b".repeat(64) },
	]);
	assert.equal(settled, false);
	second.resolve(text("newer", "c"));
	assert.deepEqual(await closing, []);
	assert.equal(f.owner.snapshot().tabs.length, 0);
});

test("continued typing bounds close to two writes and keeps newer input without discard review", async () => {
	const first = Promise.withResolvers<FileText>();
	const second = Promise.withResolvers<FileText>();
	let calls = 0;
	const f = fixture({ saveText: () => (++calls === 1 ? first.promise : second.promise) });
	await f.owner.open(target, true);
	const tab = active(f.owner);
	tab.editor.edit("first");
	const closing = f.owner.close([tab.id]);
	tab.editor.edit("second");
	first.resolve(text("first", "b"));
	await vi.advanceTimersByTimeAsync(0);
	tab.editor.edit("third");
	second.resolve(text("second", "c"));
	assert.deepEqual(await closing, []);
	assert.equal(calls, 2);
	assert.equal(f.owner.snapshot().tabs[0]?.id, tab.id);
	assert.equal(tab.editor.snapshot().document?.text, "third");
	assert.equal(tab.editor.snapshot().document?.baseline.text, "second");
});

for (const failure of ["VERSION_CONFLICT", "WRITE_OUTCOME_UNKNOWN", "IO_ERROR"] as const) {
	test(`joined close stops on ${failure} without another write`, async () => {
		const pending = Promise.withResolvers<FileText>();
		let calls = 0;
		const f = fixture({
			saveText: () => {
				calls++;
				return pending.promise;
			},
		});
		await f.owner.open(target, true);
		const tab = active(f.owner);
		tab.editor.edit("submitted");
		const saving = tab.editor.save();
		assert.equal(tab.editor.save(), saving, "join preserves exact save promise");
		const closing = f.owner.close([tab.id]);
		tab.editor.edit("later");
		pending.reject(new FileServiceError(failure));
		assert.deepEqual(await closing, [tab.id]);
		assert.equal(await saving, false);
		await vi.advanceTimersByTimeAsync(FILE_AUTOSAVE_DELAY * 3);
		assert.equal(calls, 1);
		assert.equal(tab.editor.snapshot().document?.text, "later");
	});
}

test.each(["workspace", "authority", "target", "same-target", "dispose"] as const)(
	"retired %s close intent neither continues saving nor requests discard",
	async (retirement) => {
		const pending = Promise.withResolvers<FileText>();
		let calls = 0;
		let authority = true;
		const f = fixture({
			saveText: () => {
				calls++;
				return pending.promise;
			},
		});
		await f.owner.open(target, true);
		const tab = active(f.owner);
		tab.editor.edit("submitted");
		const closing = f.owner.close([tab.id], () => authority);
		tab.editor.edit("later");
		if (retirement === "workspace") f.owner.setWorkspace("other");
		if (retirement === "authority") authority = false;
		if (retirement === "target" || retirement === "same-target") {
			tab.editor.clear();
			await tab.editor.open(retirement === "same-target" ? target : { ...target, path: "replacement" }, true);
		}
		if (retirement === "dispose") f.owner.dispose();
		pending.resolve(text("submitted", "b"));
		assert.deepEqual(await closing, []);
		assert.equal(calls, 1);
		if (retirement !== "dispose") assert.equal(f.owner.snapshot().tabs[0]?.id, tab.id);
	},
);

test("close during comparison does not join the read or issue a save", async () => {
	const pending = Promise.withResolvers<FileText>();
	const f = fixture();
	await f.owner.open(target, true);
	const tab = active(f.owner);
	tab.editor.edit("protected");
	f.files.readText = () => pending.promise;
	const comparing = tab.editor.compare();
	assert.deepEqual(await f.owner.close([tab.id]), [tab.id]);
	assert.equal(f.saved.length, 0);
	pending.resolve(text("disk", "b"));
	await comparing;
	assert.equal(tab.editor.snapshot().document?.text, "protected");
});

test("active close fallback uses workspace-local positions despite interleaved global tabs", async () => {
	const f = fixture();
	await f.owner.open({ ...target, workspaceId: "hidden", path: "h1" }, true, { pinned: true });
	await f.owner.open({ ...target, workspaceId: "hidden", path: "h2" }, true, { pinned: true });
	await f.owner.open(target, true, { pinned: true });
	const first = active(f.owner);
	await f.owner.open({ ...target, path: "second" }, true, { pinned: true });
	const second = active(f.owner);
	await f.owner.open({ ...target, path: "third" }, true, { pinned: true });
	f.owner.select(first.id);
	await f.owner.close([first.id]);
	assert.equal(f.owner.snapshot().activeId, second.id);
	f.owner.setWorkspace("hidden");
	assert.equal(active(f.owner).target.path, "h2");
});

test("reorder supports both edges including final insertion and rejects stale or foreign targets", async () => {
	const f = fixture();
	const ids: string[] = [];
	for (const path of ["a", "b", "c"]) {
		await f.owner.open({ ...target, path }, true, { pinned: true });
		ids.push(active(f.owner).id);
	}
	const [a, b, c] = ids as [string, string, string];
	f.owner.move(a, c, "after");
	assert.deepEqual(
		f.owner.snapshot().tabs.map((tab) => tab.id),
		[b, c, a],
	);
	f.owner.move(a, b, "before");
	assert.deepEqual(
		f.owner.snapshot().tabs.map((tab) => tab.id),
		[a, b, c],
	);
	await f.owner.open({ ...target, workspaceId: "other" }, true, { pinned: true });
	const foreign = active(f.owner).id;
	f.owner.move(a, foreign, "after");
	f.owner.move(a, "retired", "after");
	f.owner.move("retired", a, "before");
	assert.deepEqual(
		f.owner.snapshot().tabs.map((tab) => tab.id),
		[a, b, c, foreign],
	);
});

test("a failed follow-on close save stops at its error and canceled join retains uncertain submitted bytes", async () => {
	const first = Promise.withResolvers<FileText>();
	let calls = 0;
	const f = fixture({
		saveText: () => {
			calls++;
			return calls === 1 ? first.promise : Promise.reject(new FileServiceError("VERSION_CONFLICT"));
		},
	});
	await f.owner.open(target, true);
	const tab = active(f.owner);
	tab.editor.edit("first");
	const closing = f.owner.close([tab.id]);
	tab.editor.edit("later");
	first.resolve(text("first", "b"));
	assert.deepEqual(await closing, [tab.id]);
	assert.equal(calls, 2);
	assert.equal(tab.editor.snapshot().error, "VERSION_CONFLICT");
	assert.equal(tab.editor.snapshot().document?.text, "later");
	const pending = Promise.withResolvers<FileText>();
	const other = fixture({ saveText: () => pending.promise });
	await other.owner.open(target, true);
	const canceled = active(other.owner);
	canceled.editor.edit("submitted");
	const save = canceled.editor.save();
	const close = other.owner.close([canceled.id]);
	canceled.editor.edit("newer");
	canceled.editor.cancel();
	pending.resolve(text("submitted", "b"));
	assert.equal(await save, false);
	assert.deepEqual(await close, [canceled.id]);
	assert.equal(canceled.editor.snapshot().unknown, "submitted");
	assert.equal(canceled.editor.snapshot().document?.text, "newer");
});

test("superseded close does not remove its original target after the joined save resolves", async () => {
	const pending = Promise.withResolvers<FileText>();
	const f = fixture({ saveText: () => pending.promise });
	await f.owner.open(target, true, { pinned: true });
	const first = active(f.owner);
	await f.owner.open({ ...target, path: "other" }, true, { pinned: true });
	const second = active(f.owner);
	first.editor.edit("first");
	const old = f.owner.close([first.id]);
	assert.deepEqual(await f.owner.close([second.id]), []);
	pending.resolve(text("first", "b"));
	assert.deepEqual(await old, []);
	assert.deepEqual(
		f.owner.snapshot().tabs.map((tab) => tab.id),
		[first.id],
	);
});

test("unavailable authority still permits clean close but never starts a write for a protected tab", async () => {
	const f = fixture();
	await f.owner.open(target, true, { pinned: true });
	const clean = active(f.owner);
	await f.owner.open({ ...target, path: "dirty" }, true, { pinned: true });
	const dirty = active(f.owner);
	dirty.editor.edit("keep");
	assert.deepEqual(
		await f.owner.close(
			[clean.id, dirty.id],
			() => true,
			() => false,
		),
		[dirty.id],
	);
	assert.equal(f.saved.length, 0);
	assert.deepEqual(
		f.owner.snapshot().tabs.map((tab) => tab.id),
		[dirty.id],
	);
});

test("batch close retains a later target reloaded while the first target is saving", async () => {
	const pending = Promise.withResolvers<FileText>();
	const f = fixture({ saveText: () => pending.promise });
	await f.owner.open(target, true, { pinned: true });
	const first = active(f.owner);
	await f.owner.open({ ...target, path: "second" }, true, { pinned: true });
	const second = active(f.owner);
	first.editor.edit("saving");
	const closing = f.owner.close([first.id, second.id]);
	second.editor.clear();
	await second.editor.open(second.target, true);
	pending.resolve(text("saving", "b"));
	assert.deepEqual(await closing, []);
	assert.deepEqual(
		f.owner.snapshot().tabs.map((tab) => tab.id),
		[second.id],
	);
});
