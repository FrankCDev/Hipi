import assert from "node:assert/strict";
import { useDndContext } from "@dnd-kit/core";
import { renderToStaticMarkup } from "react-dom/server";
import { test } from "vitest";
import { PreferencesProvider } from "../src/app/preferences.tsx";
import {
	SidebarDragProvider,
	SidebarOrderSection,
	useSidebarDragging,
	useSidebarSortable,
} from "../src/features/workbench/sidebar-drag-provider.tsx";

// Real React 19 and installed dnd-kit composition, without module mocks.
// Server rendering does not establish native geometry, focus, or pointer behavior.
test("actual dnd-kit context and draggable hooks compose with React 19 without replacing navigation semantics", () => {
	let calls = 0;
	function Row() {
		const dnd = useDndContext();
		const sortable = useSidebarSortable({
			item: {
				id: "private-canonical-scope",
				group: "pinned",
				label: "Visible conversation",
				revision: "7",
				disabled: false,
				after: null,
				move: () => calls++,
			},
			up: undefined,
			down: undefined,
		});
		assert.equal(dnd.active, null);
		assert.equal(useSidebarDragging(), false);
		assert.match(sortable.describedBy ?? "", /^DndDescribedBy-/);
		return (
			<button type="button" aria-describedby={sortable.describedBy}>
				Visible conversation
			</button>
		);
	}
	const html = renderToStaticMarkup(
		<PreferencesProvider>
			<SidebarDragProvider scrollRef={{ current: null }}>
				<SidebarOrderSection
					action={{
						item: {
							id: "pinned",
							group: "sections",
							label: "Pinned",
							revision: "1",
							disabled: false,
							after: "projects",
							move: () => calls++,
						},
						up: undefined,
						down: "recent",
					}}
				>
					<Row />
				</SidebarOrderSection>
			</SidebarDragProvider>
		</PreferencesProvider>,
	);
	assert.equal(calls, 0);
	assert.match(html, /data-sidebar-dragging="false"/);
	assert.match(html, /aria-label="调整Pinned的顺序"/);
	assert.match(html, /aria-describedby="DndDescribedBy-/);
	assert.doesNotMatch(html, /private-canonical-scope|aria-pressed=|Move up|Move down|Space/);
	assert.equal((html.match(/<button/g) ?? []).length, 2);
});
