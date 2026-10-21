import assert from "node:assert/strict";
import test from "node:test";
import { runInNewContext } from "node:vm";
import { assertSidebarShellGeometry, sidebarShellGeometry } from "./gui-sidebar-geometry.mjs";

test("shell probe serializes scroll owners and escaped announcement geometry without mutating DOM", () => {
	const rect = { x: 0, y: -50, top: -50, right: 1400, bottom: 822, left: 0, width: 1400, height: 872 };
	const style = {
		display: "block",
		position: "static",
		overflowX: "visible",
		overflowY: "visible",
		top: "auto",
		left: "auto",
		height: "872px",
		minHeight: "0px",
		transform: "none",
		clipPath: "none",
	};
	const node = Object.freeze({
		tagName: "HTML",
		id: "",
		clientWidth: 1400,
		clientHeight: 872,
		scrollWidth: 1400,
		scrollHeight: 1426,
		scrollLeft: 0,
		scrollTop: 50,
		offsetParent: null,
		getAttribute: () => null,
		getBoundingClientRect: () => rect,
	});
	const announcement = Object.freeze({
		...node,
		tagName: "OUTPUT",
		offsetParent: node,
		parentElement: node,
		getAttribute: (name) => ({ class: "sr-only", "aria-live": "polite" })[name] ?? null,
		getBoundingClientRect: () => ({ ...rect, top: 1375, bottom: 1376, height: 1 }),
	});
	const document = Object.freeze({
		defaultView: Object.freeze({
			innerWidth: 1400,
			innerHeight: 872,
			scrollX: 0,
			scrollY: 50,
			getComputedStyle: (target) => (target === announcement ? { ...style, position: "absolute" } : style),
		}),
		scrollingElement: node,
		documentElement: node,
		body: node,
		querySelector: (selector) => (selector === ".sidebar-footer" ? null : node),
		querySelectorAll: () => [announcement],
	});
	const value = JSON.parse(
		JSON.stringify(runInNewContext(`(${sidebarShellGeometry.toString()})(document)`, { document })),
	);
	assert.equal(value.viewport.scrollY, 50);
	assert.equal(value.scrollingElement.scrollHeight, 1426);
	assert.equal(value.owners[".work-shell"].rect.top, -50);
	assert.equal(value.owners[".sidebar-footer"], null);
	assert.equal(value.announcements[0].style.position, "absolute");
	assert.equal(value.announcements[0].offsetParent.tag, "HTML");
	assert.equal(value.announcements[0].rect.bottom, 1376);
	assert.equal(value.announcements[0].ariaLive, "polite");
	assert.equal("textContent" in value.announcements[0], false);
});

test("shell guard permits independent navigation scrolling but rejects displaced chrome and root overflow", () => {
	const normal = () => ({
		viewport: { width: 1400, height: 872 },
		scrollingElement: {
			scrollTop: 0,
			scrollLeft: 0,
			scrollHeight: 872,
			clientHeight: 872,
			scrollWidth: 1400,
			clientWidth: 1400,
		},
		owners: {
			".work-shell": { rect: { x: 0, y: 0, height: 872 }, style: { minHeight: "480px" } },
			".navigation-list": { scrollTop: 600, scrollHeight: 2000, clientHeight: 724 },
			...Object.fromEntries(
				[".app-toolbar", ".new-conversation-trigger", ".sidebar-settings-trigger"].map((selector) => [
					selector,
					{
						rect: { x: 10, y: 10, width: 30, height: 30, right: 40, bottom: 40 },
					},
				]),
			),
		},
	});
	assertSidebarShellGeometry(normal());
	for (const mutate of [
		(value) => {
			value.scrollingElement.scrollTop = 50;
		},
		(value) => {
			value.scrollingElement.scrollLeft = 5;
		},
		(value) => {
			value.scrollingElement.scrollHeight = 1426;
		},
		(value) => {
			value.scrollingElement.scrollWidth = 1450;
		},
		(value) => {
			value.owners[".work-shell"].rect.y = -50;
		},
		(value) => {
			value.owners[".work-shell"].rect.height = 820;
		},
		(value) => {
			value.owners[".app-toolbar"].rect.y = -40;
		},
		(value) => {
			value.owners[".sidebar-settings-trigger"].rect.bottom = 1000;
		},
		(value) => {
			value.viewport.height = 400;
		},
		(value) => {
			value.viewport.width = 700;
		},
	]) {
		const value = normal();
		mutate(value);
		assert.throws(() => assertSidebarShellGeometry(value));
	}
});
