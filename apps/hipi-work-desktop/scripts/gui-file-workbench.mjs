import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { exerciseNarrowEditorEscape } from "./gui-file-editor-escape.mjs";
import { chooseOwnedFileFolder } from "./gui-file-picker.mjs";
import { previewFixture } from "./gui-file-preview-fixtures.mjs";
import { documentPreviewState, exerciseDocumentPreviews } from "./gui-file-previews.mjs";
import { exerciseFileReopen } from "./gui-file-reopen.mjs";
import { changeOwnedFixture, fileFixture, fileFixtureNames, readOwnedFixture } from "./gui-file-workbench-fixture.mjs";
import { assertNoAlerts, capture, click, evaluate, pressKey, selectEnglish, until } from "./gui-flow.mjs";
import { assertBindingEvidence, exerciseProjectBinding } from "./gui-project-binding.mjs";

export function fileCodePresentation(panel, path) {
	const text = (container) => {
		const lines = [...container.querySelectorAll("[data-content] > [data-line]")];
		// These bounded fixtures contain two nonempty lines, entirely visible. Never
		// reconstruct missing virtual rows or infer text from an editor/model API.
		if (!lines.length || lines.some((line, index) => line.getAttribute("data-line") !== String(index + 1))) return null;
		return lines.map((line) => line.textContent).join("\n");
	};
	const editors = panel?.querySelectorAll(".file-code.pierre-code .pierre-editor-viewport diffs-container") ?? [];
	const diffs = panel?.querySelectorAll(".file-diff.pierre-diff .pierre-diff-viewport diffs-container") ?? [];
	let editor = null;
	let left = null;
	let right = null;
	let readOnlyDiff = false;
	if (editors.length === 1 && diffs.length === 0) {
		const shadow = editors[0].shadowRoot;
		const inputs = shadow?.querySelectorAll('[role="textbox"][contenteditable="true"]') ?? [];
		if (inputs.length === 1 && inputs[0].getAttribute("aria-label") === path) editor = text(shadow);
	}
	if (diffs.length === 1 && editors.length === 0) {
		const shadow = diffs[0].shadowRoot;
		const deletions = shadow?.querySelectorAll("[data-code][data-deletions]") ?? [];
		const additions = shadow?.querySelectorAll("[data-code][data-additions]") ?? [];
		if (
			deletions.length === 1 &&
			additions.length === 1 &&
			shadow.querySelectorAll('[contenteditable="true"],[role="textbox"]').length === 0
		) {
			left = text(deletions[0]);
			right = text(additions[0]);
			readOnlyDiff = left !== null && right !== null;
		}
	}
	return { editor, left, right, readOnlyDiff };
}

export function fileTreeListing(document) {
	const roots = document.querySelectorAll(".file-workbench");
	if (roots.length !== 1) return null;
	const hosts = roots[0].querySelectorAll('.pierre-file-tree[data-file-tree-engine="pierre"] > file-tree-container');
	if (hosts.length !== 1 || !hosts[0].shadowRoot) return null;
	const shadow = hosts[0].shadowRoot;
	const trees = shadow.querySelectorAll('[role="tree"]');
	const rows = [...shadow.querySelectorAll('[role="treeitem"]')];
	if (
		trees.length !== 1 ||
		rows.some(
			(row) =>
				row.dataset.hipiKind !== "file" ||
				row.getAttribute("aria-disabled") !== "false" ||
				row.dataset.path !== row.dataset.itemPath,
		)
	)
		return null;
	const paths = rows.map((row) => row.dataset.path).sort();
	if (new Set(paths).size !== paths.length) return null;
	return { label: trees[0].getAttribute("aria-label"), paths };
}

/** Locate only a real, unobstructed library DOM target. This never calls renderer APIs. */
export function fileShadowTarget(document, kind, path) {
	const roots = document.querySelectorAll(".file-workbench");
	if (roots.length !== 1 || !["tree", "editor"].includes(kind)) return null;
	const root = roots[0];
	let scope = root;
	if (kind === "editor") {
		const tabs = root.querySelectorAll('.file-tabs [role="tab"][aria-selected="true"]');
		const panels = root.querySelectorAll('.file-tab-panel[role="tabpanel"]');
		if (
			tabs.length !== 1 ||
			panels.length !== 1 ||
			tabs[0].getAttribute("title") !== path ||
			tabs[0].getAttribute("aria-controls") !== panels[0].id ||
			panels[0].getAttribute("aria-labelledby") !== tabs[0].id
		)
			return null;
		scope = panels[0];
	}
	const hosts = scope.querySelectorAll(
		kind === "tree"
			? '.pierre-file-tree[data-file-tree-engine="pierre"] > file-tree-container'
			: ".file-code.pierre-code .pierre-editor-viewport diffs-container",
	);
	if (hosts.length !== 1 || !hosts[0].shadowRoot) return null;
	const host = hosts[0];
	const shadow = host.shadowRoot;
	const candidates = [...shadow.querySelectorAll(kind === "tree" ? '[role="treeitem"]' : '[role="textbox"]')].filter(
		(element) =>
			kind === "tree"
				? element.dataset.path === path && element.dataset.itemPath === path && element.dataset.hipiKind === "file"
				: element.getAttribute("aria-label") === path,
	);
	if (candidates.length !== 1) return null;
	const target = candidates[0];
	if (
		(kind === "tree" && target.getAttribute("aria-disabled") !== "false") ||
		(kind === "editor" && target.getAttribute("contenteditable") !== "true")
	)
		return null;
	target.scrollIntoView({ block: "nearest", inline: "nearest" });
	const rectangle = target.getBoundingClientRect();
	if (!(rectangle.width > 0 && rectangle.height > 0)) return null;
	const x = rectangle.x + rectangle.width / 2;
	const y = rectangle.y + rectangle.height / 2;
	if (
		!Number.isFinite(x) ||
		!Number.isFinite(y) ||
		document.elementFromPoint(x, y) !== host ||
		!target.contains(shadow.elementFromPoint(x, y))
	)
		return null;
	return { x, y, focused: document.activeElement === host && shadow.activeElement === target };
}

export function fileWorkbenchState(document, readCode = fileCodePresentation) {
	const roots = [...document.querySelectorAll(".file-workbench")];
	if (roots.length !== 1) return null;
	const root = roots[0];
	const tabs = [...root.querySelectorAll('.file-tabs [role="tab"]')].map((tab) => ({
		id: tab.id,
		path: tab.getAttribute("title"),
		panel: tab.getAttribute("aria-controls"),
		selected: tab.getAttribute("aria-selected") === "true",
		dirty: !!tab.querySelector(".file-tab-dirty"),
		error: !!tab.querySelector(".file-tab-error"),
	}));
	const active = tabs.filter((tab) => tab.selected);
	const panels = root.querySelectorAll('.file-tab-panel[role="tabpanel"]');
	if (
		new Set(tabs.map((tab) => tab.id)).size !== tabs.length ||
		(tabs.length > 0 &&
			(active.length !== 1 ||
				panels.length !== 1 ||
				active[0].panel !== panels[0].id ||
				panels[0].getAttribute("aria-labelledby") !== active[0].id)) ||
		(tabs.length === 0 && panels.length !== 0)
	)
		return null;
	const status = root.querySelector(".file-document-status > span")?.textContent.trim();
	return {
		tabs,
		activeId: active[0]?.id ?? null,
		...readCode(panels[0], active[0]?.path),
		path: active[0]?.path ?? null,
		dirty: root.querySelector(".file-document-status > span")?.getAttribute("data-dirty") === "true",
		clean: status === "Matches confirmed version",
		saving: status === "Saving file…",
		autosavePending: root.querySelector(".file-editor-status > span")?.textContent === "Changes save automatically",
		initialBaseline: root.textContent.includes("Left: initial editor-read baseline."),
		diskBaseline: root.textContent.includes("Left: latest disk read."),
		alerts: [...root.querySelectorAll('[role="alert"]')].map((e) => e.textContent.trim()),
		image: (() => {
			const image = root.querySelector("img.file-preview-image");
			return image
				? {
						loaded: image.complete && image.naturalWidth > 0,
						sourceIsBlob: image.src.startsWith("blob:"),
						source: image.src,
					}
				: null;
		})(),
		cells: [...root.querySelectorAll(".file-preview-grid td")].map((e) => e.textContent),
	};
}

async function state(cdp) {
	return evaluate(cdp, `(${fileWorkbenchState.toString()})(document, ${fileCodePresentation.toString()})`);
}
async function expectEditor(cdp, expected, { dirty = false, id, path = fileFixture.textName } = {}) {
	return until(async () => {
		const value = await state(cdp);
		return value?.path === path &&
			(!id || value.activeId === id) &&
			value.editor === expected &&
			value.dirty === dirty &&
			value.clean === !dirty &&
			!value.saving
			? value
			: null;
	}, "selected Pierre buffer with exact synthetic text and dirty state");
}
async function replaceEditor(cdp, text) {
	const before = await state(cdp);
	assert.ok([fileFixture.textName, fileFixture.secondName].includes(before?.path));
	const targetExpression = `(${fileShadowTarget.toString()})(document, "editor", ${JSON.stringify(before.path)})`;
	const point = await until(
		() => evaluate(cdp, targetExpression),
		"single unobstructed shadow editor for the selected fixture tab",
	);
	for (const type of ["mousePressed", "mouseReleased"])
		await cdp.request("Input.dispatchMouseEvent", { type, x: point.x, y: point.y, button: "left", clickCount: 1 });
	assert.equal((await evaluate(cdp, targetExpression))?.focused, true, "Exact shadow editor must own keyboard focus");
	for (const type of ["keyDown", "keyUp"])
		await cdp.request("Input.dispatchKeyEvent", {
			type,
			key: "a",
			code: "KeyA",
			windowsVirtualKeyCode: 65,
			modifiers: 2,
		});
	assert.equal((await evaluate(cdp, targetExpression))?.focused, true, "Focus must remain on the exact fixture editor");
	await cdp.request("Input.insertText", { text });
	return until(async () => {
		const value = await state(cdp);
		return value?.editor === text && value.dirty ? value : null;
	}, "exact inserted text observed as pending, not assumed saved");
}
async function selectFile(cdp, name, preview = false) {
	assert.ok(fileFixtureNames.includes(name));
	const point = await until(
		() => evaluate(cdp, `(${fileShadowTarget.toString()})(document, "tree", ${JSON.stringify(name)})`),
		"single unobstructed authorized Pierre tree row",
	);
	for (const type of ["mousePressed", "mouseReleased"])
		await cdp.request("Input.dispatchMouseEvent", {
			type,
			x: point.x,
			y: point.y,
			button: preview ? "right" : "left",
			clickCount: 1,
		});
	if (preview) await click(cdp, ".pierre-file-tree-menu[slot=context-menu] button", "Preview");
}
async function selectTab(cdp, id) {
	assert.match(id, /^file-tab-file-\d+$/);
	await click(cdp, `.file-tabs [role="tab"][id="${id}"]`);
	await until(async () => (await state(cdp))?.activeId === id, "exact retained file tab selected");
	assert.equal(await evaluate(cdp, "document.querySelectorAll('[role=\"dialog\"]').length"), 0);
}
async function fileAction(cdp, label) {
	assert.ok(["Save", "Discard input and reload", "Read disk / reconcile"].includes(label));
	await click(cdp, '.file-editor-toolbar button[aria-label="File actions"]');
	await click(cdp, '[role="menuitem"]:not([aria-disabled="true"])', label);
	await until(() => evaluate(cdp, "!document.querySelector('[role=\"menu\"]')"), "file action menu closed");
}
async function savedBytes(cdp, nativeContext, name, expected, id) {
	await until(async () => {
		const value = await state(cdp);
		const tab = value?.tabs.find((item) => item.id === id && item.path === name);
		return (
			tab &&
			!tab.dirty &&
			!tab.error &&
			(await readOwnedFixture(nativeContext.ownedProfileRoot, name)).toString("utf8") === expected
		);
	}, "confirmed per-tab save and exact owned disk bytes");
}
async function selectWorkspace(cdp, workspaceId) {
	assert.ok([fileFixture.workspaceId, fileFixture.otherWorkspaceId].includes(workspaceId));
	await click(cdp, `.workspace-branch[data-workspace-id="${workspaceId}"] .project-open`);
	await until(
		() =>
			evaluate(
				cdp,
				`document.querySelector('.workspace-branch[data-workspace-id="${workspaceId}"]')?.dataset.current === 'true' && !document.querySelector('[role="dialog"]')`,
			),
		"workspace switch completed without discarding file input",
	);
}
async function assertDiff(cdp, before, after, disk = false) {
	await until(async () => {
		const value = await state(cdp);
		return (
			value?.left === before &&
			value.right === after &&
			value.readOnlyDiff &&
			(disk ? value.diskBaseline : value.initialBaseline)
		);
	}, "explicit baseline and exact current-input diff panes");
}
async function showFiles(cdp) {
	if (
		!(await evaluate(cdp, "[...document.querySelectorAll('.file-workbench')].some(e => e.getClientRects().length > 0)"))
	)
		await click(cdp, 'button[aria-label="Show files"]');
	await until(
		async () =>
			(await state(cdp)) &&
			(await evaluate(cdp, "document.querySelector('.file-workbench')?.getClientRects().length > 0")),
		"exactly one visible file workbench",
	);
}
async function hideFiles(cdp) {
	await click(cdp, '.file-panel-close[aria-label="Hide files"]');
	await until(
		() =>
			evaluate(
				cdp,
				`(() => {
			const dock = document.querySelector('.file-panel-dock');
			return dock?.hidden && dock.inert && dock.getAttribute('aria-hidden') === 'true' &&
				dock.getClientRects().length === 0 && document.activeElement === document.querySelector('button[aria-label="Show files"]');
		})()`,
			),
		"file dock hidden and toolbar focus restored",
	);
}
async function expectListing(cdp) {
	await until(async () => {
		const value = await evaluate(cdp, `(${fileTreeListing.toString()})(document)`);
		return (
			value?.label === fileFixture.folder &&
			JSON.stringify(value.paths) === JSON.stringify([...fileFixtureNames].sort())
		);
	}, "real owned-directory listing");
}

export function fileSplitterGeometry(document, kind) {
	if (!["dock", "tree"].includes(kind)) return null;
	const areas = document.querySelectorAll(".work-area");
	const docks = document.querySelectorAll(".file-panel-dock");
	const selectors =
		kind === "dock"
			? '.file-panel-dock > .file-panel-resizer[aria-label="File panel width"]'
			: '.file-panel-dock .file-tree-resizer[aria-label="File tree width"]';
	const handles = document.querySelectorAll(selectors);
	if (areas.length !== 1 || docks.length !== 1 || handles.length !== 1 || docks[0].hidden || docks[0].inert)
		return null;
	const handle = handles[0];
	if (handle.getAttribute("aria-orientation") !== "vertical") return null;
	const area = areas[0].getBoundingClientRect();
	const box = handle.getBoundingClientRect();
	const x = box.x + box.width / 2;
	const y = box.y + box.height / 2;
	if (!(box.width > 0 && box.height > 0) || !handle.contains(document.elementFromPoint(x, y))) return null;
	return {
		x,
		y,
		width: Number(handle.getAttribute("aria-valuenow")),
		min: Number(handle.getAttribute("aria-valuemin")),
		max: Number(handle.getAttribute("aria-valuemax")),
		areaLeft: area.left,
		areaRight: area.right,
		areaWidth: area.width,
		viewportWidth: document.documentElement.clientWidth,
		viewportHeight: document.documentElement.clientHeight,
	};
}

/** Four bounded native moves, wholly inside the measured owned renderer viewport. */
export function fileDragPlan(geometry, requestedWidth) {
	assert.ok(geometry && Object.values(geometry).every(Number.isFinite), "Measured splitter geometry required");
	assert.ok(
		geometry.min > 0 &&
			geometry.width >= geometry.min &&
			geometry.max >= geometry.width &&
			geometry.areaWidth > geometry.width &&
			Math.abs(geometry.areaRight - geometry.areaLeft - geometry.areaWidth) < 1,
		"Invalid splitter range or work-area geometry",
	);
	assert.ok(Number.isFinite(requestedWidth) && requestedWidth > 0 && requestedWidth < geometry.areaWidth);
	const endX = geometry.x + geometry.width - requestedWidth;
	assert.ok(
		geometry.x > geometry.areaLeft &&
			geometry.x < geometry.areaRight &&
			endX > geometry.areaLeft &&
			endX < geometry.areaRight &&
			Math.min(geometry.x, endX) >= 0 &&
			Math.max(geometry.x, endX) < geometry.viewportWidth &&
			geometry.y >= 0 &&
			geometry.y < geometry.viewportHeight,
		"Splitter drag must stay inside the measured work area and viewport",
	);
	return {
		start: { x: geometry.x, y: geometry.y },
		moves: Array.from({ length: 4 }, (_, index) => ({
			x: geometry.x + ((endX - geometry.x) * (index + 1)) / 4,
			y: geometry.y,
		})),
	};
}

export async function dispatchFileDrag(cdp, plan) {
	await cdp.request("Input.dispatchMouseEvent", { type: "mouseMoved", ...plan.start, button: "none", buttons: 0 });
	await cdp.request("Input.dispatchMouseEvent", {
		type: "mousePressed",
		...plan.start,
		button: "left",
		buttons: 1,
		clickCount: 1,
	});
	let last = plan.start;
	try {
		for (const point of plan.moves) {
			await cdp.request("Input.dispatchMouseEvent", { type: "mouseMoved", ...point, button: "left", buttons: 1 });
			last = point;
		}
	} finally {
		await cdp.request("Input.dispatchMouseEvent", {
			type: "mouseReleased",
			...last,
			button: "left",
			buttons: 0,
			clickCount: 1,
		});
	}
}

export function fileSplitNodes(document, includeVirtualInput = true) {
	const selectors = [
		".work-conversation-frame",
		".work-conversation-frame .conversation-panel",
		".work-conversation-frame .message-scroll",
		".work-conversation-frame .composer-input",
		".file-panel-dock",
		".file-panel-dock .file-workbench",
		'.file-panel-dock .file-tabs [role="tab"][aria-selected="true"]',
		'.file-panel-dock .file-tab-panel[role="tabpanel"]',
		".file-panel-dock .file-code.pierre-code diffs-container",
	];
	const nodes = [];
	for (const selector of selectors) {
		const matches = document.querySelectorAll(selector);
		if (matches.length !== 1 || !matches[0].isConnected) return null;
		nodes.push(matches[0]);
	}
	if (!includeVirtualInput) return nodes;
	const inputs = nodes.at(-1).shadowRoot?.querySelectorAll('[role="textbox"][contenteditable="true"]');
	if (inputs?.length !== 1 || !inputs[0].isConnected) return null;
	return [...nodes, inputs[0]];
}

async function exerciseFileSplitters(cdp, directory, nativeContext, primaryId, record) {
	const original = await until(
		() => evaluate(cdp, `(${fileSplitterGeometry.toString()})(document, "dock")`),
		"actual visible dock splitter",
	);
	assert.ok(original.areaWidth - 80 > original.max, "Full gesture must cross the actual normal maximum");
	assert.equal(
		await evaluate(
			cdp,
			`(() => {
		const nodes = (${fileSplitNodes.toString()})(document);
		if (!nodes || document.querySelectorAll('[data-message-id]').length !== 0 ||
			nodes[1].getAttribute('aria-label') !== ${JSON.stringify(fileFixture.conversationTitle)}) return false;
		window.__hipiFileSplitNodes = nodes;
		return true;
	})()`,
		),
		true,
		"Capture exact empty fixture conversation, composer and selected editor DOM, not app owners",
	);
	const retained = async (label, includeVirtualInput = true, visible = true) => {
		assert.equal(
			await evaluate(
				cdp,
				`(() => {
			const before = window.__hipiFileSplitNodes;
			const current = (${fileSplitNodes.toString()})(document, ${includeVirtualInput});
			return !!before && !!current && current.length === ${includeVirtualInput ? 10 : 9} &&
				current.every((node, index) => node === before[index]) &&
				document.querySelectorAll('[data-message-id]').length === 0;
		})()`,
			),
			true,
			`${label}: canonical conversation shell and exact editor DOM must stay mounted`,
		);
		if (visible) await expectEditor(cdp, fileFixture.draft, { dirty: true, id: primaryId });
		assert.equal((await readOwnedFixture(nativeContext.ownedProfileRoot)).toString("utf8"), fileFixture.external);
	};
	const drag = async (kind, width) => {
		const measured = await until(
			() => evaluate(cdp, `(${fileSplitterGeometry.toString()})(document, ${JSON.stringify(kind)})`),
			`unobstructed ${kind} splitter`,
		);
		await dispatchFileDrag(cdp, fileDragPlan(measured, width));
	};
	try {
		await drag("dock", original.areaWidth - 80);
		await until(
			() =>
				evaluate(
					cdp,
					`(() => {
				const area = document.querySelector('.work-area[data-file-panel-full-width="true"]');
				const dock = area?.querySelector('.file-panel-dock[data-full-width="true"]');
				const chat = area?.querySelector('.work-conversation-frame');
				return !!dock && !!chat && chat.inert && chat.getAttribute('aria-hidden') === 'true' &&
					getComputedStyle(chat).visibility === 'hidden' &&
					Math.abs(dock.getBoundingClientRect().width - area.getBoundingClientRect().width) < 2;
			})()`,
				),
			"real full-width dock fills the work area and hides only the retained conversation frame",
		);
		await retained("full-width drag");
		await capture(cdp, directory, "file-conflict-full-width");
		record({ dockDragFull: true, conversationShellRetained: true, splitterDraftPreserved: true });
		await drag("dock", original.width);
		await until(
			() =>
				evaluate(
					cdp,
					`(() => {
				const dock = document.querySelector('.file-panel-dock[data-full-width="false"]');
				const chat = document.querySelector('.work-conversation-frame');
				const width = Number(dock?.querySelector('.file-panel-resizer')?.getAttribute('aria-valuenow'));
				return !!chat && !chat.inert && chat.getAttribute('aria-hidden') !== 'true' &&
					getComputedStyle(chat).visibility !== 'hidden' && Math.abs(width - ${original.width}) <= 1;
			})()`,
				),
			"native drag restores the previous normal dock split",
		);
		await retained("restored dock split");
		record({ dockDragRestore: true });
		const tree = await until(
			() => evaluate(cdp, `(${fileSplitterGeometry.toString()})(document, "tree")`),
			"independent visible tree splitter",
		);
		await drag("tree", 50);
		await until(
			() =>
				evaluate(
					cdp,
					`(() => {
				const toggle = document.querySelector('.file-workbench button[aria-label="Toggle file tree"]');
				return toggle?.getAttribute('aria-pressed') === 'false' && document.activeElement === toggle &&
					!document.querySelector('.file-tree-pane, .file-tree-resizer');
			})()`,
				),
			"native tree drag below 100 collapses only the tree and returns focus",
		);
		await retained("collapsed tree");
		await click(cdp, '.file-workbench button[aria-label="Toggle file tree"]');
		await expectListing(cdp);
		await retained("restored tree");
		const restoredTree = await evaluate(cdp, `(${fileSplitterGeometry.toString()})(document, "tree")`);
		assert.ok(Math.abs(restoredTree.width - tree.width) <= 1, "Tree collapse must preserve its previous width");
		await capture(cdp, directory, "file-conflict-split-restored");
		record({ treeDragCollapseRestore: true });
		await drag("dock", 80);
		await until(
			() =>
				evaluate(
					cdp,
					`(() => {
				const dock = document.querySelector('.file-panel-dock');
				return dock?.hidden && dock.inert && dock.getClientRects().length === 0 &&
					document.activeElement === document.querySelector('button[aria-label="Show files"]');
			})()`,
				),
			"native drag below 160 hides the retained dock and restores trigger focus",
		);
		// A zero-size vendor viewport may recycle virtual input rows. The tab and
		// editor host must remain; exact protected text is checked after reopening.
		await retained("collapsed dock", false, false);
		await showFiles(cdp);
		await retained("reopened dock", false);
		const restored = await evaluate(cdp, `(${fileSplitterGeometry.toString()})(document, "dock")`);
		assert.ok(Math.abs(restored.width - original.width) <= 1, "Collapse must retain the prior split preference");
		record({ dockDragCollapseRestore: true });
	} finally {
		await evaluate(cdp, "delete window.__hipiFileSplitNodes");
	}
}

export function assertFileWorkbenchLayout(value) {
	assert.ok(value && Object.values(value).every(Number.isFinite), "Measured IDE geometry is required");
	assert.ok(value.editorWidth > 0 && value.treeWidth >= 200);
	assert.ok(
		value.editorRight <= value.treeLeft && Math.abs(value.editorTop - value.treeTop) < 2,
		"File editor must be beside, and to the left of, its tree",
	);
}

export function validateFileWorkbenchEvidence({ first, reopened }) {
	assertBindingEvidence(first?.projectBinding, reopened?.projectBinding);
	for (const key of [
		"listedAndOpened",
		"editorTreeSplit",
		"dockDragFull",
		"dockDragRestore",
		"dockDragCollapseRestore",
		"treeDragCollapseRestore",
		"conversationShellRetained",
		"splitterDraftPreserved",
		"savedBytesVerified",
		"autosaveObserved",
		"backgroundAutosave",
		"retainedTabIdentity",
		"workspaceTabRetention",
		"conditionalCloseSaved",
		"initialBaselineSurvivesSave",
		"conflictDraftPreserved",
		"conflictDidNotOverwriteDisk",
		"conflictRetryBlocked",
		"explicitDiscardGuard",
		"dirtyPanelPreservation",
		"narrowModalPreservation",
		"csvPreview",
		"docxPreview",
		"xlsxPreview",
		"xlsxSavedValues",
		"xlsxPagination",
		"pdfPreview",
		"pdfZoom",
		"pdfReopenResetsZoom",
		"dirtyPreviewRetained",
		"unsupportedPreviewRejected",
		"pngPreview",
		"previewHandleRenewed",
	])
		assert.equal(first?.[key], true, `Missing file-workbench evidence: ${key}`);
	for (const key of ["nativePicker", "ownedDisplay", "ownedPid", "syntheticFolderOnly"])
		assert.equal(first?.nativePicker?.[key], true, `Missing owned-picker evidence: ${key}`);
	for (const key of ["reopened", "freshlyAuthorized", "coldSavedContent", "coldTabsEmpty", "rootRevoked"])
		assert.equal(reopened?.[key], true, `Missing restarted file-workbench evidence: ${key}`);
}

export async function exerciseFileWorkbench({ cdp, directory, reopened, previous, nativeContext, record }) {
	assert.equal(process.platform, "linux", "File-workbench native candidate is Linux-only");
	assert.ok(nativeContext?.ownedProfileRoot && nativeContext?.xvfbPid);
	await cdp.request("Runtime.enable");
	await cdp.request("Log.enable");
	await cdp.request("Page.enable");
	await cdp.request("Emulation.setDeviceMetricsOverride", {
		width: 1400,
		height: 900,
		deviceScaleFactor: 1,
		mobile: false,
	});
	await until(
		() => evaluate(cdp, "location.href === 'hipi-work://app/index.html' && !!document.querySelector('.work-shell')"),
		"packaged file workbench shell",
	);
	await selectEnglish(cdp);
	const branch = `.workspace-branch[data-workspace-id="${fileFixture.workspaceId}"]`;
	const expanded = await until(
		() => evaluate(cdp, `document.querySelector('${branch} .project-toggle')?.getAttribute('aria-expanded')`),
		"fixture workspace visible",
	);
	if (expanded === "false") await click(cdp, `${branch} .project-toggle`);
	await click(cdp, `${branch} .conversation-list button.conversation-link`, fileFixture.conversationTitle);
	await until(
		() =>
			evaluate(
				cdp,
				`document.querySelector('.toolbar-conversation')?.textContent === ${JSON.stringify(fileFixture.conversationTitle)}`,
			),
		"fixture conversation selected",
	);
	if (!reopened)
		assert.equal(
			await evaluate(cdp, "document.querySelectorAll('.file-workbench').length"),
			0,
			"Fresh profile must not have an empty file column",
		);
	await showFiles(cdp);
	await until(
		() =>
			evaluate(
				cdp,
				`document.querySelector('.file-workbench')?.textContent.includes('No folders authorized.') && !document.querySelector('.pierre-file-tree')`,
			),
		"no implicit or restarted file grants",
	);
	assert.deepEqual((await state(cdp)).tabs, [], "In-memory file tabs must not silently restore after process restart");
	await click(cdp, ".file-workbench button", "Authorize folder (read and write)");
	const picker = await chooseOwnedFileFolder(nativeContext, {
		observe: async (stage, png) => {
			assert.ok(["before-input", "after-type", "bounded-failure"].includes(stage));
			const name = `native-picker-${reopened ? "reopened" : "first"}-${stage}.png`;
			await writeFile(join(directory, name), png, { flag: "wx", mode: 0o600 });
			record({ nativePickerCapture: stage, image: name, nativeWindowOnly: true, syntheticSessionOnly: true });
		},
	});
	record({ picker, reopened, grantsRequireFreshNativeChoice: true });
	await expectListing(cdp);
	record({ authorizedListing: true, reopened });
	await selectFile(cdp, fileFixture.textName);
	const opened = await expectEditor(cdp, reopened ? fileFixture.external : fileFixture.initial);
	const primaryId = opened.activeId;
	assert.match(primaryId, /^file-tab-file-\d+$/);
	record({ listedAndOpened: true, reopened });
	if (reopened) {
		await selectFile(cdp, fileFixture.secondName);
		await expectEditor(cdp, fileFixture.secondClosed, { path: fileFixture.secondName });
		assert.equal((await readOwnedFixture(nativeContext.ownedProfileRoot)).toString("utf8"), fileFixture.external);
		assert.equal(
			(await readOwnedFixture(nativeContext.ownedProfileRoot, fileFixture.secondName)).toString("utf8"),
			fileFixture.secondClosed,
		);
		await capture(cdp, directory, "file-workbench-reopened");
		await click(cdp, '.file-workbench button[aria-label="Folder access"]');
		await click(cdp, ".file-access-row button", "Revoke folder");
		await until(
			() =>
				evaluate(
					cdp,
					`!document.querySelector('.file-access-row, .pierre-file-tree, .file-tabs [role="tab"], .file-code')`,
				),
			"revocation removes file capability and all its editor tabs",
		);
		await click(cdp, '[role="dialog"] button[aria-label="Close"]');
		await assertNoAlerts(cdp);
		const projectBinding = await exerciseProjectBinding({
			cdp,
			directory,
			reopened,
			nativeContext,
			record,
			previous: previous?.projectBinding,
			helpers: { showFiles, expectListing, selectFile, expectEditor },
		});
		return {
			reopened: true,
			freshlyAuthorized: true,
			coldSavedContent: true,
			coldTabsEmpty: true,
			rootRevoked: true,
			projectBinding,
		};
	}
	const geometry = await until(
		() =>
			evaluate(
				cdp,
				`(() => {
			const host=document.querySelector('.file-split-view[data-tree-overlay="false"]');
			const editor=host?.querySelector('.file-content-view')?.getBoundingClientRect();
			const tree=host?.querySelector('.file-tree-pane')?.getBoundingClientRect();
			return editor && tree ? {editorWidth:editor.width,treeWidth:tree.width,editorRight:editor.right,
				treeLeft:tree.left,editorTop:editor.top,treeTop:tree.top} : null;
		})()`,
			),
		"measured side-by-side IDE, not a stacked file list",
	);
	assertFileWorkbenchLayout(geometry);
	record({ editorTreeSplit: true, geometry });
	const pending = await replaceEditor(cdp, fileFixture.saved);
	assert.equal(pending.activeId, primaryId);
	assert.equal(pending.autosavePending, true);
	// Do not click Save, accelerate timers or disable autosave. Observe the real debounced writer.
	await savedBytes(cdp, nativeContext, fileFixture.textName, fileFixture.saved, primaryId);
	await expectEditor(cdp, fileFixture.saved, { id: primaryId });
	await click(cdp, ".file-view-switch button", "Compare changes");
	await assertDiff(cdp, fileFixture.initial, fileFixture.saved);
	await capture(cdp, directory, "file-autosaved-baseline-diff");
	record({ savedBytesVerified: true, autosaveObserved: true, initialBaselineSurvivesSave: true });
	await click(cdp, ".file-view-switch button", "Editor");

	// Mutate the owned disk BEFORE typing. No race against the 3-second debounce is needed:
	// this tab still owns its previously confirmed revision, so its next real CAS must conflict.
	await changeOwnedFixture(nativeContext.ownedProfileRoot);
	await replaceEditor(cdp, fileFixture.draft);
	await until(async () => {
		const value = await state(cdp);
		return (
			value?.activeId === primaryId &&
			value.alerts.length === 1 &&
			value.alerts[0].includes("Disk revision changed.") &&
			value.dirty &&
			!value.saving
		);
	}, "natural autosave receives the real stale-revision conflict");
	await expectEditor(cdp, fileFixture.draft, { dirty: true, id: primaryId });
	assert.equal((await readOwnedFixture(nativeContext.ownedProfileRoot)).toString("utf8"), fileFixture.external);
	record({ conflictDraftPreserved: true, conflictDidNotOverwriteDisk: true });
	await click(cdp, '.file-editor-toolbar button[aria-label="File actions"]');
	assert.equal(
		await evaluate(
			cdp,
			`(() => {
		const items=[...document.querySelectorAll('[role="menuitem"]')].filter(e=>e.textContent.trim()==='Save');
		return items.length===1 && items[0].getAttribute('aria-disabled')==='true';
	})()`,
		),
		true,
		"Conflict must block explicit save, not just hide the warning",
	);
	await pressKey(cdp, "Escape");
	await until(() => evaluate(cdp, "!document.querySelector('[role=\"menu\"]')"), "file menu dismissed");
	await exerciseFileSplitters(cdp, directory, nativeContext, primaryId, record);

	await selectFile(cdp, fileFixture.secondName);
	const second = await expectEditor(cdp, fileFixture.secondInitial, { path: fileFixture.secondName });
	const secondId = second.activeId;
	assert.notEqual(secondId, primaryId);
	const secondPending = await replaceEditor(cdp, fileFixture.secondSaved);
	assert.equal(secondPending.activeId, secondId);
	assert.equal(secondPending.autosavePending, true);
	await selectTab(cdp, primaryId);
	await expectEditor(cdp, fileFixture.draft, { dirty: true, id: primaryId });
	await savedBytes(cdp, nativeContext, fileFixture.secondName, fileFixture.secondSaved, secondId);
	const retained = await state(cdp);
	assert.equal(retained.activeId, primaryId, "Background autosave must not select its tab");
	assert.equal(retained.tabs.find((tab) => tab.id === primaryId)?.error, true);
	assert.equal((await readOwnedFixture(nativeContext.ownedProfileRoot)).toString("utf8"), fileFixture.external);
	// More than one normal autosave cycle has passed while the conflicting tab stayed protected.
	record({ backgroundAutosave: true, retainedTabIdentity: true, conflictRetryBlocked: true });
	await selectWorkspace(cdp, fileFixture.otherWorkspaceId);
	await until(
		async () =>
			(await state(cdp))?.tabs.length === 0 &&
			(await evaluate(
				cdp,
				"document.querySelector('.file-workbench')?.textContent.includes('No folders authorized.')",
			)),
		"other workspace confirms no grants or tabs from the first workspace",
	);
	assert.equal(
		await evaluate(cdp, "!!document.querySelector('.pierre-file-tree')"),
		false,
		"No cross-workspace file grant",
	);
	await selectWorkspace(cdp, fileFixture.workspaceId);
	await expectEditor(cdp, fileFixture.draft, { dirty: true, id: primaryId });
	assert.deepEqual(
		(await state(cdp)).tabs.map((tab) => tab.id),
		retained.tabs.map((tab) => tab.id),
	);
	await selectTab(cdp, secondId);
	await expectEditor(cdp, fileFixture.secondSaved, { path: fileFixture.secondName, id: secondId });
	await replaceEditor(cdp, fileFixture.secondClosed);
	await click(cdp, `.file-tab-close[aria-label="Close file: ${fileFixture.secondName}"]`);
	await until(async () => {
		const value = await state(cdp);
		return value && !value.tabs.some((tab) => tab.id === secondId);
	}, "conditional save completes before tab close");
	assert.equal(
		(await readOwnedFixture(nativeContext.ownedProfileRoot, fileFixture.secondName)).toString("utf8"),
		fileFixture.secondClosed,
	);
	await selectTab(cdp, primaryId);
	await expectEditor(cdp, fileFixture.draft, { dirty: true, id: primaryId });
	record({ workspaceTabRetention: true, conditionalCloseSaved: true });
	const reopenJourney = await exerciseFileReopen({
		cdp,
		directory,
		nativeContext,
		primaryId,
		closedId: secondId,
		helpers: { state, expectEditor, replaceEditor, selectTab, savedBytes, hideFiles, fileAction, fileShadowTarget },
	});
	record({ reopenJourney });

	await hideFiles(cdp);
	await showFiles(cdp);
	await expectEditor(cdp, fileFixture.draft, { dirty: true, id: primaryId });
	await cdp.request("Emulation.setDeviceMetricsOverride", {
		width: 600,
		height: 900,
		deviceScaleFactor: 1,
		mobile: false,
	});
	await until(
		() =>
			evaluate(
				cdp,
				`document.querySelectorAll('.file-panel-dialog[role="dialog"]').length === 1 &&
			document.querySelectorAll('.file-workbench').length === 1 && !document.querySelector('.file-panel-dock')`,
			),
		"single narrow modal instead of dock",
	);
	await expectEditor(cdp, fileFixture.draft, { dirty: true, id: primaryId });
	await capture(cdp, directory, "file-conflict-narrow-modal");
	await exerciseNarrowEditorEscape(cdp, directory);
	await expectEditor(cdp, fileFixture.draft, { dirty: true, id: primaryId });
	assert.equal((await readOwnedFixture(nativeContext.ownedProfileRoot)).toString("utf8"), fileFixture.external);
	record({ narrowFindEscape: true, narrowLineEscape: true, nativeIme: "not_run" });
	await pressKey(cdp, "Escape");
	await until(
		() =>
			evaluate(
				cdp,
				`!document.querySelector('.file-workbench') &&
			document.activeElement === document.querySelector('button[aria-label="Show files"]')`,
			),
		"narrow Escape closes and restores focus",
	);
	await cdp.request("Emulation.setDeviceMetricsOverride", {
		width: 1400,
		height: 900,
		deviceScaleFactor: 1,
		mobile: false,
	});
	await showFiles(cdp);
	await expectEditor(cdp, fileFixture.draft, { dirty: true, id: primaryId });
	record({ dirtyPanelPreservation: true, narrowModalPreservation: true, cssViewportEmulation: true });

	await expectListing(cdp);
	await selectFile(cdp, previewFixture.unsupportedName, true);
	await until(async () => {
		const page = await evaluate(cdp, `(${documentPreviewState.toString()})(document)`);
		return (
			page?.path === previewFixture.unsupportedName &&
			page.alerts.length === 1 &&
			page.alerts[0].startsWith("Preview unavailable.") &&
			page.retryAvailable &&
			!page.loading &&
			page.text === undefined &&
			page.cells.length === 0
		);
	}, "unsupported preview reports a recoverable error in its own tab");
	assert.equal(
		await evaluate(cdp, "document.querySelectorAll('[role=\"dialog\"]').length"),
		0,
		"Opening a harmless preview must not ask to discard another tab",
	);
	await capture(cdp, directory, "file-unsupported-preview");
	await click(cdp, ".file-buffer button", "Close preview");
	await selectTab(cdp, primaryId);
	await expectEditor(cdp, fileFixture.draft, { dirty: true, id: primaryId });
	assert.equal((await readOwnedFixture(nativeContext.ownedProfileRoot)).toString("utf8"), fileFixture.external);
	record({ dirtyPreviewRetained: true, unsupportedPreviewRejected: true });

	await click(cdp, ".file-state-alert button", "Read disk / reconcile");
	await assertDiff(cdp, fileFixture.external, fileFixture.draft, true);
	await capture(cdp, directory, "file-conflict-preserved-diff");
	await click(cdp, `.file-tab-close[aria-label="Close file: ${fileFixture.textName}"]`);
	await until(
		() =>
			evaluate(
				cdp,
				`JSON.stringify([...document.querySelectorAll('.file-discard-paths li')].map(e=>e.textContent)) === ${JSON.stringify(JSON.stringify([fileFixture.textName]))}`,
			),
		"explicit close of a conflicted tab asks about its exact protected path",
	);
	await click(cdp, '[role="dialog"] button', "Keep editing");
	await assertDiff(cdp, fileFixture.external, fileFixture.draft, true);
	assert.equal((await state(cdp)).activeId, primaryId);
	await fileAction(cdp, "Discard input and reload");
	await click(cdp, '[role="dialog"] button', "Discard and continue");
	await until(async () => (await state(cdp))?.clean, "explicit discard reload completes");
	await click(cdp, ".file-view-switch button", "Editor");
	await expectEditor(cdp, fileFixture.external, { id: primaryId });
	await assertNoAlerts(cdp);
	record({ explicitDiscardGuard: true });

	await selectFile(cdp, fileFixture.csvName, true);
	await until(
		async () =>
			JSON.stringify((await state(cdp))?.cells) ===
			JSON.stringify(["label", "value", "中文", "42", "fixture", "read-only"]),
		"CSV parser output in actual renderer",
	);
	await capture(cdp, directory, "file-csv-preview");
	await click(cdp, ".file-buffer button", "Close preview");
	record({ csvPreview: true });
	const documents = await exerciseDocumentPreviews({ cdp, directory, selectFile, record });
	await selectFile(cdp, fileFixture.imageName, true);
	const image = await until(async () => {
		const value = await state(cdp);
		return value?.image?.loaded && value.image.sourceIsBlob ? value : null;
	}, "owned PNG decoded from local blob");
	await capture(cdp, directory, "file-image-preview");
	await hideFiles(cdp);
	await until(async () => {
		const value = await state(cdp);
		return value?.activeId === image.activeId && value.image === null;
	}, "hidden retained preview tab releases its rendered image instead of keeping the stale URL");
	await showFiles(cdp);
	await until(async () => {
		const value = await state(cdp);
		return (
			value?.activeId === image.activeId &&
			value.image?.loaded &&
			value.image.sourceIsBlob &&
			value.image.source !== image.image.source
		);
	}, "retained preview tab reopens with a new local blob instead of a stale handle");
	await click(cdp, ".file-buffer button", "Close preview");
	await selectTab(cdp, primaryId);
	await expectEditor(cdp, fileFixture.external, { id: primaryId });
	await assertNoAlerts(cdp);
	const projectBinding = await exerciseProjectBinding({
		cdp,
		directory,
		reopened,
		nativeContext,
		record,
		helpers: { showFiles, expectListing, selectFile, expectEditor },
	});
	return {
		projectBinding,
		reopened: false,
		reopenJourney,
		listedAndOpened: true,
		editorTreeSplit: true,
		dockDragFull: true,
		dockDragRestore: true,
		dockDragCollapseRestore: true,
		treeDragCollapseRestore: true,
		conversationShellRetained: true,
		splitterDraftPreserved: true,
		savedBytesVerified: true,
		autosaveObserved: true,
		initialBaselineSurvivesSave: true,
		backgroundAutosave: true,
		retainedTabIdentity: true,
		workspaceTabRetention: true,
		conditionalCloseSaved: true,
		conflictDraftPreserved: true,
		conflictDidNotOverwriteDisk: true,
		conflictRetryBlocked: true,
		explicitDiscardGuard: true,
		dirtyPanelPreservation: true,
		narrowModalPreservation: true,
		csvPreview: true,
		...documents,
		dirtyPreviewRetained: true,
		unsupportedPreviewRejected: true,
		pngPreview: true,
		previewHandleRenewed: true,
		nativePicker: picker,
		notValidated: [
			"native window resizing",
			"physical IME",
			"native unsaved-close dialog",
			"native unknown-write fault injection (covered only by source tests)",
			"preview worker/blob release instrumentation",
			"macOS and Windows file picker",
		],
	};
}
