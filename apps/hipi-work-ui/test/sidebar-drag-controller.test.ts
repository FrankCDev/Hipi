import assert from "node:assert/strict";
import { test, vi } from "vitest";
import { insideSidebar, type SidebarDragItem, sidebarDrop } from "../src/features/workbench/sidebar-drag-controller.ts";

function item(id: string, after: string | null, overrides: Partial<SidebarDragItem> = {}): SidebarDragItem {
	return { id, after, group: "projects", label: id, revision: "order-1", disabled: false, move: vi.fn(), ...overrides };
}

const targetRect = { left: 10, right: 210, top: 100, bottom: 140 };

test("before and after use the target's canonical successor, not its visible neighbor", () => {
	const source = item("source", "source-successor");
	const target = item("target", "hidden-canonical-successor");
	const candidates = [{ item: target, rect: targetRect }];
	assert.deepEqual(sidebarDrop(source, { x: 20, y: 119 }, candidates), {
		id: "target",
		edge: "before",
		before: "target",
	});
	assert.deepEqual(sidebarDrop(source, { x: 20, y: 120 }, candidates), {
		id: "target",
		edge: "after",
		before: "hidden-canonical-successor",
	});
	assert.deepEqual(sidebarDrop(source, { x: 20, y: 140 }, [{ item: { ...target, after: null }, rect: targetRect }]), {
		id: "target",
		edge: "after",
		before: null,
	});
});

test("drop targets exclude other groups, disabled rows, and every outside edge", () => {
	const source = item("source", "next");
	for (const group of ["sections", "pinned"] as const) {
		assert.equal(
			sidebarDrop(source, { x: 20, y: 110 }, [{ item: item("target", null, { group }), rect: targetRect }]),
			null,
		);
	}
	assert.equal(
		sidebarDrop(source, { x: 20, y: 110 }, [{ item: item("target", null, { disabled: true }), rect: targetRect }]),
		null,
	);
	for (const point of [
		{ x: 9, y: 110 },
		{ x: 211, y: 110 },
		{ x: 20, y: 99 },
		{ x: 20, y: 141 },
	]) {
		assert.equal(sidebarDrop(source, point, [{ item: item("target", null), rect: targetRect }]), null);
	}
	assert.equal(sidebarDrop(source, { x: 20, y: 110 }, []), null);
});

test("self drops and either equivalent adjacent anchor cannot issue a move", () => {
	const source = item("source", "next");
	for (const target of [source, item("previous", "source"), item("next", "later")]) {
		const y = target.id === "previous" ? 130 : 110;
		assert.equal(sidebarDrop(source, { x: 20, y }, [{ item: target, rect: targetRect }]), null);
	}
	assert.equal(sidebarDrop(source, { x: 20, y: 130 }, [{ item: source, rect: targetRect }]), null);
	assert.equal(
		sidebarDrop(item("source", null), { x: 20, y: 130 }, [{ item: item("last", null), rect: targetRect }]),
		null,
		"appending an already final source is also an equivalent anchor",
	);
});

test("membership-changing drops are never inferred from overlapping targets", () => {
	const source = item("source", "next");
	const candidates = [
		{ item: item("pinned-target", null, { group: "pinned" }), rect: targetRect },
		{ item: item("section-target", null, { group: "sections" }), rect: targetRect },
		{ item: item("disabled-target", null, { disabled: true }), rect: targetRect },
		{ item: item("project-target", "canonical-next"), rect: targetRect },
	];
	assert.deepEqual(sidebarDrop(source, { x: 20, y: 130 }, candidates), {
		id: "project-target",
		edge: "after",
		before: "canonical-next",
	});
	assert.equal(vi.mocked(source.move).mock.calls.length, 0, "placement remains pure; persistence belongs to its owner");
});

test("viewport bounds reject overflowed targets on all edges, including partially clipped rows", () => {
	const source = item("source", "next");
	const bounds = { left: 0, right: 240, top: 0, bottom: 200 };
	const oversized = { left: -20, right: 260, top: -20, bottom: 220 };
	const candidates = [{ item: item("target", "canonical-next"), rect: oversized }];
	for (const point of [
		{ x: -1, y: 100 },
		{ x: 241, y: 100 },
		{ x: 20, y: -1 },
		{ x: 20, y: 201 },
	]) {
		assert.equal(sidebarDrop(source, point, candidates, bounds), null);
	}
	assert.deepEqual(sidebarDrop(source, { x: 20, y: 199 }, candidates, bounds), {
		id: "target",
		edge: "after",
		before: "canonical-next",
	});
});

test("placement does not require a visible source and uses the latest candidate anchor and geometry", () => {
	const source = item("source", "next");
	const target = item("target", "old-successor");
	const candidates = [{ item: target, rect: targetRect }];
	assert.equal(sidebarDrop(source, { x: 20, y: 130 }, candidates)?.before, "old-successor");
	target.after = "new-successor";
	assert.equal(sidebarDrop(source, { x: 20, y: 130 }, candidates)?.before, "new-successor");
	assert.deepEqual(
		sidebarDrop(source, { x: 20, y: 130 }, [{ item: target, rect: { ...targetRect, top: 120, bottom: 160 } }]),
		{ id: "target", edge: "before", before: "target" },
	);
});

test("sidebar hit testing includes boundary pixels and excludes each outside edge", () => {
	for (const point of [
		{ x: 10, y: 100 },
		{ x: 210, y: 100 },
		{ x: 10, y: 140 },
		{ x: 210, y: 140 },
	]) {
		assert.equal(insideSidebar(point, targetRect), true);
	}
	for (const point of [
		{ x: 9, y: 120 },
		{ x: 211, y: 120 },
		{ x: 20, y: 99 },
		{ x: 20, y: 141 },
	]) {
		assert.equal(insideSidebar(point, targetRect), false);
	}
});
