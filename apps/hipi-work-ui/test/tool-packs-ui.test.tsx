import assert from "node:assert/strict";
import type { AppClient } from "@hipi/work-runtime/contracts";
import { renderToStaticMarkup } from "react-dom/server";
import { test } from "vitest";
import { AppClientProvider } from "../src/app/client-provider.tsx";
import { PreferencesProvider } from "../src/app/preferences.tsx";
import { ToolPackSource } from "../src/features/tool-packs/source-view.tsx";
import { ToolPacksDialog } from "../src/features/tool-packs/tool-packs-dialog.tsx";

test("complete source stays escaped plain text and its scroll area is keyboard accessible in both locales", () => {
	const source = '<script>alert("untrusted")</script>\n[run](javascript:alert(1))\n{"prompt":"do not execute"}';
	for (const locale of ["en", "zh-CN"]) {
		const html = renderToStaticMarkup(<ToolPackSource locale={locale} digest={"a".repeat(64)} packageText={source} />);
		assert.ok(html.includes("&lt;script&gt;"));
		assert.equal(html.includes("<script>"), false);
		assert.equal(html.includes("<a "), false);
		assert.ok(html.includes("[run](javascript:alert(1))"));
		assert.match(html, /<textarea[^>]*readOnly=""[^>]*aria-label=/);
		assert.ok(html.includes("do not execute"));
		assert.match(html, /bg-muted/);
		assert.match(html, locale === "en" ? /Unverified publisher/ : /发布者未经验证/);
	}
});
test("the workbench entry is a compact official dialog trigger, with no eager calls or conversation metadata", () => {
	let calls = 0;
	const client: AppClient = {
		call: async () => {
			calls++;
			throw new Error("not expected before opening");
		},
		observe: async () => ({ dispose: async () => {} }),
	};
	const html = renderToStaticMarkup(
		<PreferencesProvider>
			<AppClientProvider client={client}>
				<ToolPacksDialog
					connected
					workspaceId="workspace"
					conversation={{
						workspaceId: "workspace",
						conversationId: "conversation",
						title: "Secret conversation title",
						revision: 1,
						createdAt: 1,
						archivedAt: null,
					}}
				/>
			</AppClientProvider>
		</PreferencesProvider>,
	);
	assert.match(html, /aria-haspopup="dialog"/);
	assert.match(html, /data-state="closed"/);
	assert.equal(html.includes("Secret conversation title"), false);
	assert.equal(html.includes("Exact package source"), false);
	assert.equal(calls, 0);
});
