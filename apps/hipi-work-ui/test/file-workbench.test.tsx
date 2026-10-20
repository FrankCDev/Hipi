import assert from "node:assert/strict";
import { createFileClient, type FileClient, parseFileRequest } from "@hipi/work-runtime/files/protocol";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderToStaticMarkup } from "react-dom/server";
import { test, vi } from "vitest";
import { PreferencesProvider } from "../src/app/preferences.tsx";
import { FileWorkbench, fileTarget } from "../src/features/files/file-workbench.tsx";
import { FileWorkspaceSession } from "../src/features/files/file-workspace-session.ts";

function editor(session: FileWorkspaceSession) {
	const tab = session.snapshot().tabs.find((item) => item.id === session.snapshot().activeId);
	assert.ok(tab && tab.kind === "editor");
	return tab.editor;
}

const port = vi.hoisted(() => ({ files: undefined as FileClient | undefined }));
vi.mock("../src/app/client-provider.tsx", () => ({ useFiles: () => port }));
function render(session?: FileWorkspaceSession) {
	const cache = new QueryClient();
	cache.setQueryData(["fileRoots", "workspace"], []);
	const html = renderToStaticMarkup(
		<QueryClientProvider client={cache}>
			<PreferencesProvider>
				<FileWorkbench workspaceId="workspace" session={session} guard={(action) => action()} />
			</PreferencesProvider>
		</QueryClientProvider>,
	);
	cache.clear();
	return html;
}
test("missing capability is explicit and never shows a simulated tree", () => {
	port.files = undefined;
	const html = render();
	assert.match(html, /此连接未提供文件访问能力/);
	assert.doesNotMatch(html, /授权目录（读写）/);
});
test("authorized connection with no roots gives real setup guidance", () => {
	port.files = {
		listRoots: async () => [],
		list: async () => ({ entries: [], nextCursor: null }),
		readText: async () => ({ text: "original", revision: "a".repeat(64), encoding: "utf-8", bytes: 8 }),
		saveText: async () => {
			throw Error("unexpected save");
		},
		preview: async () => ({ kind: "unsupported", reason: "binary-or-encoding" }),
	};
	const html = render();
	assert.match(html, /尚未授权目录/);
	assert.match(html, /HTTP/);
	assert.doesNotMatch(html, /My conversation/);
});
test("loaded file exposes named editor and dirty buffer recovery controls", async () => {
	const files = port.files;
	assert.ok(files);
	const session = new FileWorkspaceSession(files);
	await session.open({ workspaceId: "workspace", rootId: "root", path: "file.ts" }, true);
	editor(session).edit("mine");
	const html = render(session);
	assert.match(html, /有未保存修改/);
	assert.match(html, /file.ts/);
	assert.match(html, /aria-label="文件操作"/);
	assert.match(html, /role="tab"/);
	assert.match(html, /比较修改/);
	assert.match(html, /页面内存/);
	session.dispose();
});
test("directory and open targets cross the real strict client without leaking root metadata", async () => {
	const root = { workspaceId: "workspace", rootId: "root", writable: true, displayName: "Documents" };
	const seen: unknown[] = [];
	const client = createFileClient({
		storeId: "store",
		request: async (raw) => {
			const request = parseFileRequest(raw);
			seen.push(request.params);
			return {
				version: 1,
				storeId: "store",
				method: request.method,
				target: request.params,
				ok: true,
				result:
					request.method === "list"
						? { entries: [], nextCursor: null }
						: { text: "hello", bytes: 5, encoding: "utf-8", revision: "a".repeat(64) },
			};
		},
	});
	await client.list(fileTarget(root, ""));
	await client.readText(fileTarget(root, "file.txt"));
	assert.deepEqual(seen, [
		{ workspaceId: "workspace", rootId: "root", path: "" },
		{ workspaceId: "workspace", rootId: "root", path: "file.txt" },
	]);
});
