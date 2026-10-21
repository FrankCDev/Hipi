import assert from "node:assert/strict";
import { FileServiceError, type ProjectFolder } from "@hipi/work-runtime/files";
import type { FileClient } from "@hipi/work-runtime/files/protocol";
import { test, vi } from "vitest";
import { FileWorkspaceSession } from "../../../../../src/features/files/file-workspace-session.ts";
import {
	openProjectFile,
	type ProjectFileNavigation,
} from "../../../../../src/features/workbench/conversation/markdown/file-links/navigation.ts";
import { projectFilePath } from "../../../../../src/features/workbench/conversation/markdown/file-links/path.ts";

function fixture() {
	const folder: Extract<ProjectFolder, { status: "available" }> = {
		workspaceId: "w",
		status: "available",
		bindingId: "binding",
		revision: 1,
		displayName: "Project",
		root: { workspaceId: "w", rootId: "r", writable: false },
	};
	const files: FileClient = {
		listRoots: vi.fn(async () => [folder.root]),
		list: vi.fn(async () => ({
			entries: [{ name: "note.md", path: "docs/note.md", kind: "file" as const }],
			nextCursor: null,
		})),
		readText: vi.fn(async () => ({
			text: "# authorized",
			revision: "a".repeat(64),
			bytes: 12,
			encoding: "utf-8" as const,
		})),
		saveText: vi.fn(async () => {
			throw new Error("No write expected");
		}),
		preview: vi.fn(async () => ({ kind: "unsupported", reason: "binary-or-encoding" })),
	};
	const session = new FileWorkspaceSession(files);
	session.setWorkspace("w");
	const owner: ProjectFileNavigation = {
		folder,
		files,
		session,
		getProject: vi.fn(async () => folder),
		panel: { setOpen: vi.fn() },
		previews: true,
		isCurrent: () => true,
	};
	return { owner, files, session };
}
const click = (owner: ProjectFileNavigation, path = "docs/note.md") =>
	openProjectFile(owner, path, new AbortController().signal);

test("project paths reject URL schemes, absolute paths, escapes and unimplemented line destinations", () => {
	for (const value of [
		undefined,
		"",
		"/tmp/a",
		"file:///tmp/a",
		"https://example.test/a",
		"C:/a",
		"//server/a",
		"../a",
		"./../a",
		"a/../b",
		"a\\b",
		"a//b",
		"a/",
		"a%2fb",
		"%2e%2e/a",
		"a#L2",
		"a:2",
		"a?x",
		"a\0b",
		"CON",
	])
		assert.equal(projectFilePath(value), undefined, value);
	assert.equal(projectFilePath("./src/main.ts"), "src/main.ts");
	assert.equal(projectFilePath("文档/说明.md"), "文档/说明.md");
});

test("fresh bound-root validation opens the real read-only editor, retaining existing dirty tab state", async () => {
	const { owner, files, session } = fixture();
	try {
		await click(owner);
		const tab = session.snapshot().tabs[0];
		assert.ok(tab?.kind === "editor");
		assert.equal(tab.editor.snapshot().document?.text, "# authorized");
		assert.equal(tab.editor.snapshot().document?.writable, false);
		assert.deepEqual(tab.target, { workspaceId: "w", rootId: "r", path: "docs/note.md" });
		await click(owner);
		assert.equal(session.snapshot().tabs.length, 1);
		assert.equal(session.snapshot().tabs[0], tab);
		assert.equal(vi.mocked(files.readText).mock.calls.length, 1);
		assert.equal(vi.mocked(owner.getProject).mock.calls.length, 4);
		assert.equal(vi.mocked(files.saveText).mock.calls.length, 0);
	} finally {
		session.dispose();
	}
});

test.each(["root", "binding", "revision", "workspace", "unbound", "revoked"])(
	"a changed %s cannot redirect the old reference",
	async (change) => {
		const { owner, files, session } = fixture();
		const folder = { ...owner.folder, root: { ...owner.folder.root } };
		if (change === "root") folder.root.rootId = "other";
		if (change === "binding") folder.bindingId = "other";
		if (change === "revision") folder.revision++;
		if (change === "workspace") folder.workspaceId = "other";
		owner.getProject = async () =>
			change === "unbound" || change === "revoked"
				? { workspaceId: "w", status: "revoked", bindingId: "binding", revision: 2, displayName: "Project", root: null }
				: folder;
		try {
			await assert.rejects(click(owner), { code: "UNAUTHORIZED" });
			assert.equal(vi.mocked(files.list).mock.calls.length, 0);
			assert.equal(session.snapshot().tabs.length, 0);
			assert.equal(vi.mocked(owner.panel.setOpen).mock.calls.length, 0);
		} finally {
			session.dispose();
		}
	},
);

test.each(["blocked", "directory", "missing", "revoked"])(
	"%s host entry fails without revealing an existing cached tab",
	async (kind) => {
		const { owner, files, session } = fixture();
		try {
			await click(owner);
			vi.mocked(owner.panel.setOpen).mockClear();
			if (kind === "revoked") files.listRoots = async () => [];
			else
				files.list = async () => ({
					entries:
						kind === "missing"
							? []
							: [{ name: "note.md", path: "docs/note.md", kind: kind === "blocked" ? "blocked" : "directory" }],
					nextCursor: null,
				});
			await assert.rejects(click(owner), FileServiceError);
			assert.equal(vi.mocked(owner.panel.setOpen).mock.calls.length, 0);
			assert.equal(vi.mocked(files.readText).mock.calls.length, 1);
		} finally {
			session.dispose();
		}
	},
);

test("scope A→B→A, connection retirement, abort and rebind during a read discard late navigation", async () => {
	for (const transition of ["scope", "abort", "rebind"]) {
		const { owner, files, session } = fixture();
		let resolve: (() => void) | undefined;
		let current = true;
		owner.isCurrent = () => current;
		files.list = async () => {
			await new Promise<void>((done) => {
				resolve = done;
			});
			return { entries: [{ name: "note.md", path: "docs/note.md", kind: "file" }], nextCursor: null };
		};
		const controller = new AbortController();
		try {
			const opening = openProjectFile(owner, "docs/note.md", controller.signal);
			await vi.waitFor(() => assert.ok(resolve));
			if (transition === "scope") current = false;
			if (transition === "abort") controller.abort();
			if (transition === "rebind") owner.getProject = async () => ({ ...owner.folder, revision: 2 });
			resolve?.();
			await assert.rejects(opening, FileServiceError);
			assert.equal(session.snapshot().tabs.length, 0);
			assert.equal(vi.mocked(owner.panel.setOpen).mock.calls.length, 0);
		} finally {
			session.dispose();
		}
	}
});

test("preview routing uses the same validated target and leaves content-kind validation to host", async () => {
	const { owner, files, session } = fixture();
	const openPreview = vi.fn(async () => {});
	owner.session = { open: vi.fn(async () => {}), openPreview };
	files.list = async () => ({ entries: [{ name: "report.pdf", path: "report.pdf", kind: "file" }], nextCursor: null });
	try {
		await click(owner, "report.pdf");
		assert.deepEqual(openPreview.mock.calls[0], [{ workspaceId: "w", rootId: "r", path: "report.pdf" }]);
		assert.equal(vi.mocked(files.readText).mock.calls.length, 0);
	} finally {
		session.dispose();
	}
});

test("bounded directory pagination distinguishes an exhausted listing from a capacity limit", async () => {
	const { owner, files, session } = fixture();
	files.list = vi.fn(async () => ({ entries: [], nextCursor: "next" }));
	try {
		await assert.rejects(click(owner), { code: "LIMIT_EXCEEDED" });
		assert.equal(vi.mocked(files.list).mock.calls.length, 82);
		assert.equal(vi.mocked(owner.panel.setOpen).mock.calls.length, 0);
	} finally {
		session.dispose();
	}
});
