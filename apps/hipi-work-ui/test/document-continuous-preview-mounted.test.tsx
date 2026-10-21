// @vitest-environment jsdom
import assert from "node:assert/strict";
import type { PreviewClient } from "@hipi/work-runtime/previews/protocol";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { test, vi } from "vitest";
import { PreferencesProvider } from "../src/app/preferences.tsx";
import { DocumentPreviewPane } from "../src/features/files/document-preview.tsx";
import { PreviewSession } from "../src/features/files/preview-session.ts";

vi.mock("../src/app/client-provider.tsx", () => ({ useFiles: () => ({ files: undefined }) }));

test("Word transport chunks render continuously without page controls or invented line breaks", async () => {
	vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
	const query = new QueryClient({ defaultOptions: { queries: { retry: false } } });
	const reads: number[] = [];
	const client: PreviewClient = {
		open: async () => ({
			id: "doc",
			revision: "a".repeat(64),
			kind: "docx",
			summary: { bytes: 10, pages: 2, truncated: false },
		}),
		readPage: async (id, page) => {
			reads.push(page);
			return {
				id,
				revision: "a".repeat(64),
				page,
				content: {
					kind: "document",
					format: "docx",
					text: page === 0 ? "An unfinished para" : "graph\nSecond line.",
					truncated: false,
					limitations: [],
				},
			};
		},
		readBytes: async () => {
			throw new Error("Unexpected binary read");
		},
		close: async () => {},
	};
	const session = new PreviewSession(client);
	const host = document.createElement("div");
	document.body.append(host);
	const root = createRoot(host);
	try {
		await session.open({ workspaceId: "w", rootId: "r", path: "example.docx" });
		await act(async () =>
			root.render(
				<QueryClientProvider client={query}>
					<PreferencesProvider>
						<DocumentPreviewPane session={session} />
					</PreferencesProvider>
				</QueryClientProvider>,
			),
		);
		assert.deepEqual(reads, [0, 1]);
		assert.equal(host.querySelector(".file-preview-text")?.textContent, "An unfinished paragraph\nSecond line.");
		assert.equal(host.querySelector(".file-actions"), null);
		assert.equal(host.querySelectorAll("button").length, 1, "only the genuine close action remains");
	} finally {
		await act(async () => root.unmount());
		session.dispose();
		query.clear();
		host.remove();
		vi.unstubAllGlobals();
	}
});
