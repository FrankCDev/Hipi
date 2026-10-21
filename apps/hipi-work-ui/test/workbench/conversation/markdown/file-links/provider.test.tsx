// @vitest-environment jsdom
import assert from "node:assert/strict";
import type { ProjectFolder } from "@hipi/work-runtime/files";
import type { FileClient } from "@hipi/work-runtime/files/protocol";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, test, vi } from "vitest";
import type { FileAuthority } from "../../../../../src/app/file-client.ts";
import { FileWorkspaceSession } from "../../../../../src/features/files/file-workspace-session.ts";
import {
	type ProjectFileLinks,
	ProjectFileLinksProvider,
	useProjectFileLinks,
} from "../../../../../src/features/workbench/conversation/markdown/file-links/provider.tsx";
import { FilePanelController } from "../../../../../src/features/workbench/files/panel-controller.ts";
import { createNavigation } from "../../../../../src/features/workbench/navigation/state.ts";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
const state = vi.hoisted(() => ({
	folder: undefined as ProjectFolder | undefined,
	files: undefined as FileClient | undefined,
	fileAuthority: undefined as FileAuthority | undefined,
}));
vi.mock("../../../../../src/app/client-provider.tsx", () => ({ useFiles: () => state }));
vi.mock("../../../../../src/features/workbench/projects/use-folder.ts", () => ({
	useProjectFolder: () => ({ data: state.folder }),
}));
afterEach(() => {
	state.folder = undefined;
	state.files = undefined;
	state.fileAuthority = undefined;
});

test("provider owns a navigation generation, exact binding and connection; harmless renders do not cancel clicks", async () => {
	const folder: Extract<ProjectFolder, { status: "available" }> = {
		workspaceId: "w",
		status: "available",
		bindingId: "binding",
		revision: 1,
		displayName: "Project",
		root: { workspaceId: "w", rootId: "r", writable: false },
	};
	state.folder = folder;
	state.files = {
		listRoots: vi.fn(async () => [folder.root]),
		list: vi.fn(async () => ({ entries: [{ name: "a.md", path: "a.md", kind: "file" }], nextCursor: null })),
		readText: vi.fn(async () => ({ text: "safe", bytes: 4, revision: "a".repeat(64), encoding: "utf-8" })),
		saveText: vi.fn(async () => {
			throw new Error("No writes");
		}),
		preview: vi.fn(async () => ({ kind: "unsupported", reason: "binary-or-encoding" })),
	};
	state.fileAuthority = { getProject: vi.fn(async () => folder), chooseRoot: vi.fn(), revokeRoot: vi.fn() };
	const session = new FileWorkspaceSession(state.files);
	session.setWorkspace("w");
	const local = { read: () => null, write: () => true };
	const panel = new FilePanelController(local);
	const navigation = createNavigation(local);
	navigation.selectConversation({ workspaceId: "w", conversationId: "a" }, null);
	let captured: ProjectFileLinks | undefined;
	let connected = true;
	function Probe() {
		captured = useProjectFileLinks();
		return null;
	}
	const root = createRoot(document.createElement("div"));
	const render = () =>
		act(() =>
			root.render(
				<ProjectFileLinksProvider
					workspaceId="w"
					session={session}
					panel={panel}
					navigation={navigation}
					connected={() => connected}
				>
					<Probe />
				</ProjectFileLinksProvider>,
			),
		);
	const open = (capability: ProjectFileLinks) => capability.open("a.md", new AbortController().signal);
	try {
		await render();
		assert.ok(captured);
		const initial = captured;
		await render();
		assert.equal(captured, initial);
		navigation.selectConversation({ workspaceId: "w", conversationId: "b" }, null);
		navigation.selectConversation({ workspaceId: "w", conversationId: "a" }, null);
		await assert.rejects(open(initial), { code: "CLOSED" });
		assert.equal(vi.mocked(state.fileAuthority.getProject).mock.calls.length, 0);
		await render();
		assert.ok(captured);
		const next = captured;
		state.folder = { ...folder, revision: 2 };
		await render();
		await assert.rejects(open(next), { code: "CLOSED" });
		state.folder = folder;
		await render();
		assert.ok(captured);
		connected = false;
		await assert.rejects(open(captured), { code: "CLOSED" });
		connected = true;
		await open(captured);
		assert.equal(session.snapshot().tabs.length, 1);
		assert.equal(vi.mocked(state.fileAuthority.chooseRoot).mock.calls.length, 0);
		assert.equal(vi.mocked(state.fileAuthority.revokeRoot).mock.calls.length, 0);
		const final = captured;
		await act(() => root.unmount());
		await assert.rejects(open(final), { code: "CLOSED" });
	} finally {
		await act(() => root.unmount());
		session.dispose();
	}
});
