/** Serializable, read-only observation. Never scroll, focus, or repair the page. */
export function sidebarShellGeometry(document) {
	const view = document.defaultView;
	const identity = (node) => (node ? { tag: node.tagName, id: node.id, className: node.getAttribute("class") } : null);
	const measure = (node) => {
		if (!node) return null;
		const rect = node.getBoundingClientRect();
		const style = view.getComputedStyle(node);
		return {
			...identity(node),
			rect: {
				x: rect.x,
				y: rect.y,
				top: rect.top,
				right: rect.right,
				bottom: rect.bottom,
				left: rect.left,
				width: rect.width,
				height: rect.height,
			},
			clientWidth: node.clientWidth,
			clientHeight: node.clientHeight,
			scrollWidth: node.scrollWidth,
			scrollHeight: node.scrollHeight,
			scrollLeft: node.scrollLeft,
			scrollTop: node.scrollTop,
			offsetParent: identity(node.offsetParent),
			style: {
				display: style.display,
				position: style.position,
				overflowX: style.overflowX,
				overflowY: style.overflowY,
				top: style.top,
				left: style.left,
				height: style.height,
				minHeight: style.minHeight,
				transform: style.transform,
				clipPath: style.clipPath,
			},
		};
	};
	const selectors = [
		"#root",
		".work-shell",
		".sidebar",
		".sidebar-brand-row",
		".conversation-nav",
		".navigation-list",
		".sidebar-footer",
		".main-shell",
		".app-toolbar",
		".new-conversation-trigger",
		".sidebar-settings-trigger",
		".work-area",
	];
	return {
		viewport: {
			width: view.innerWidth,
			height: view.innerHeight,
			scrollX: view.scrollX,
			scrollY: view.scrollY,
		},
		scrollingElement: measure(document.scrollingElement),
		documentElement: measure(document.documentElement),
		body: measure(document.body),
		owners: Object.fromEntries(selectors.map((selector) => [selector, measure(document.querySelector(selector))])),
		announcements: [...document.querySelectorAll('.sr-only, [aria-live], [role="status"]')].map((node) => ({
			...measure(node),
			ariaLive: node.getAttribute("aria-live"),
			role: node.getAttribute("role"),
			parent: identity(node.parentElement),
		})),
	};
}

import assert from "node:assert/strict";

export function assertSidebarShellGeometry(value) {
	const shell = value.owners[".work-shell"];
	const root = value.scrollingElement;
	assert.ok(shell && root && value.owners[".navigation-list"], "Native sidebar scroll owners must exist");
	const minimum = Number.parseFloat(shell.style.minHeight);
	assert.ok(value.viewport.width > 720, "Native sidebar fixture requires desktop width");
	assert.ok(Number.isFinite(minimum) && value.viewport.height >= minimum, "Fixture is below shell minimum height");
	assert.ok(Math.abs(shell.rect.x) <= 1 && Math.abs(shell.rect.y) <= 1, "Shell must stay viewport-aligned");
	assert.ok(Math.abs(shell.rect.height - value.viewport.height) <= 1, "Shell must retain viewport height");
	assert.equal(root.scrollTop, 0, "Sidebar actions must not scroll the document vertically");
	assert.equal(root.scrollLeft, 0, "Sidebar actions must not scroll the document horizontally");
	assert.ok(root.scrollHeight <= root.clientHeight + 1, "Sidebar contents escaped into document height");
	assert.ok(root.scrollWidth <= root.clientWidth + 1, "Sidebar contents escaped into document width");
	for (const selector of [".app-toolbar", ".new-conversation-trigger", ".sidebar-settings-trigger"]) {
		const rect = value.owners[selector]?.rect;
		assert.ok(
			rect &&
				rect.width > 0 &&
				rect.height > 0 &&
				rect.x >= -1 &&
				rect.y >= -1 &&
				rect.right <= value.viewport.width + 1 &&
				rect.bottom <= value.viewport.height + 1,
			`${selector} must remain inside the viewport`,
		);
	}
}
