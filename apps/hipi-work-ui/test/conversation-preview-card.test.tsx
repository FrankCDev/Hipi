import assert from "node:assert/strict";
import type { Conversation } from "@hipi/work-runtime/contracts";
import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { test, vi } from "vitest";
import { PreferencesProvider } from "../src/app/preferences.tsx";
import { ConversationPreview } from "../src/features/workbench/conversation-preview.tsx";

// Inspect card content without replacing the independently tested hover/focus lifecycle.
vi.mock("../src/features/workbench/sidebar-preview-row.tsx", () => ({
	SidebarPreviewRow: ({
		children,
		preview,
	}: {
		children: ReactNode | ((state: { hovered: boolean }) => ReactNode);
		preview: () => ReactNode;
	}) => (
		<section>
			{typeof children === "function" ? children({ hovered: false }) : children}
			<aside>{preview()}</aside>
		</section>
	),
}));

const conversation: Conversation = {
	workspaceId: "project-one",
	conversationId: "conversation-one",
	title: "A recognizable conversation title",
	revision: 1,
	createdAt: Date.parse("2026-10-19T09:30:00.000Z"),
	archivedAt: null,
};

function renderPreview(overrides: Partial<Conversation> = {}) {
	return renderToStaticMarkup(
		<PreferencesProvider>
			<ConversationPreview
				conversation={{ ...conversation, ...overrides }}
				workspaceName="Example project"
				selected
				onSelect={() => {}}
			/>
		</PreferencesProvider>,
	);
}

test("conversation navigation stays text-only while its preview retains the full title and project", () => {
	const html = renderPreview();
	const row = html.match(/<button[^>]*class="conversation-link"[^>]*>([\s\S]*?)<\/button>/)?.[1];
	assert.ok(row);
	assert.match(row, /class="conversation-title sidebar-title"/);
	assert.match(row, /class="sidebar-title-content">A recognizable conversation title<\/span>/);
	assert.doesNotMatch(row, /<svg|<time|创建于/);
	assert.match(html, /class="preview-workspace"[^>]*>[\s\S]*?<span>Example project<\/span>/);
	assert.match(html, /data-slot="popover-title"[^>]*>A recognizable conversation title<\/h2>/);
});

test("preview creation metadata uses the recorded timestamp without claiming last activity", () => {
	const html = renderPreview();
	assert.match(html, /class="preview-created" dateTime="2026-10-19T09:30:00.000Z"/);
	assert.match(html, /class="sr-only">创建于 /);
	assert.doesNotMatch(html, /preview-status|当前列表/);
	assert.doesNotMatch(html, /今天|刚刚|最后活跃|执行中|当前无执行/);
});

test("unknown or invalid legacy creation dates are omitted rather than fabricated", () => {
	for (const createdAt of [null, Number.NaN, Number.MAX_SAFE_INTEGER]) {
		const html = renderPreview({ createdAt });
		assert.doesNotMatch(html, /<time|创建于|Invalid Date|1970/);
		assert.match(html, /Example project/);
	}
});

test("the informational preview has no duplicate actions, identifiers or decorative status", () => {
	const html = renderPreview({ archivedAt: Date.parse("2026-10-20T00:00:00.000Z") });
	assert.doesNotMatch(html, /preview-status|preview-identifiers|conversation-preview-actions|<details/);
	const preview = html.match(/<aside>([\s\S]*?)<\/aside>/)?.[1];
	assert.ok(preview);
	assert.doesNotMatch(preview, /project-one|conversation-one/);
	assert.doesNotMatch(html.replace(/<[^>]*>/g, ""), /project-one|conversation-one/);
	assert.equal((html.match(/<button /g) ?? []).length, 1, "Only the conversation navigation itself is actionable");
});
