import assert from "node:assert/strict";
import { changeClosedSecondFixture, fileFixture, readOwnedFixture } from "./gui-file-workbench-fixture.mjs";
import { capture, click, evaluate, until } from "./gui-flow.mjs";

export function assertFreshReopenedTab(state, closedId, text) {
	assert.equal(state?.path, fileFixture.secondName);
	assert.match(state.activeId, /^file-tab-file-\d+$/);
	assert.notEqual(state.activeId, closedId, "Closed editor must reopen as a fresh tab/session");
	assert.equal(
		state.tabs.some((tab) => tab.id === closedId),
		false,
		"Closed tab cannot reappear",
	);
	assert.equal(state.editor, text, "Reopen must render the current owned disk bytes");
	assert.equal(state.dirty, false);
	assert.equal(state.clean, true);
}

export async function dispatchReopenShortcut(cdp, platform = process.platform) {
	assert.ok(["darwin", "linux", "win32"].includes(platform));
	for (const type of ["keyDown", "keyUp"])
		await cdp.request("Input.dispatchKeyEvent", {
			type,
			key: "T",
			code: "KeyT",
			windowsVirtualKeyCode: 84,
			modifiers: (platform === "darwin" ? 4 : 2) | 8,
		});
}

export async function exerciseFileReopen({ cdp, directory, nativeContext, primaryId, closedId, helpers }) {
	const { state, expectEditor, replaceEditor, selectTab, savedBytes, hideFiles, fileAction, fileShadowTarget } =
		helpers;
	const original = await expectEditor(cdp, fileFixture.draft, { dirty: true, id: primaryId });
	const originalIds = original.tabs.map((tab) => tab.id);
	assert.equal(
		original.tabs.some((tab) => tab.path === fileFixture.secondName),
		false,
	);
	const protectedDraft = async () => {
		await selectTab(cdp, primaryId);
		await expectEditor(cdp, fileFixture.draft, { dirty: true, id: primaryId });
		assert.equal((await readOwnedFixture(nativeContext.ownedProfileRoot)).toString("utf8"), fileFixture.external);
	};
	const focusedReopen = async (oldId, text) => {
		const current = await expectEditor(cdp, text, { path: fileFixture.secondName });
		assertFreshReopenedTab(current, oldId, text);
		await until(
			() =>
				evaluate(
					cdp,
					`(${fileShadowTarget.toString()})(document, "editor", ${JSON.stringify(fileFixture.secondName)})?.focused === true`,
				),
			"fresh reopened file receives actual shadow editor focus after menu dismissal",
		);
		assert.equal(await evaluate(cdp, "!!document.querySelector('[role=\"menu\"]')"), false);
		return current.activeId;
	};
	const closeSecond = async (id) => {
		await click(cdp, `.file-tab-close[aria-label="Close file: ${fileFixture.secondName}"]`);
		await until(async () => !(await state(cdp))?.tabs.some((tab) => tab.id === id), "reopened clean file closes");
		await protectedDraft();
	};

	await click(cdp, '.file-tabs-header button[aria-label="File tab actions"]');
	await capture(cdp, directory, "file-reopen-menu");
	await click(cdp, '[role="menuitem"]:not([aria-disabled="true"])', "Reopen closed file");
	const menuId = await focusedReopen(closedId, fileFixture.secondClosed);
	await capture(cdp, directory, "file-reopened-menu");
	await protectedDraft();
	await selectTab(cdp, menuId);
	await closeSecond(menuId);

	// The tab is visibly absent before the sole known external fixture edit.
	assert.equal(
		(await state(cdp)).tabs.some((tab) => tab.path === fileFixture.secondName),
		false,
	);
	await changeClosedSecondFixture(nativeContext.ownedProfileRoot);
	await hideFiles(cdp);
	await dispatchReopenShortcut(cdp);
	await until(
		() => evaluate(cdp, "document.querySelector('.file-workbench')?.getClientRects().length > 0"),
		"successful global reopen reveals the hidden IDE",
	);
	const shortcutId = await focusedReopen(menuId, fileFixture.secondReopened);
	await capture(cdp, directory, "file-reopened-shortcut-fresh-disk");
	await protectedDraft();
	await selectTab(cdp, shortcutId);
	await replaceEditor(cdp, fileFixture.secondClosed);
	await fileAction(cdp, "Save");
	await savedBytes(cdp, nativeContext, fileFixture.secondName, fileFixture.secondClosed, shortcutId);
	await expectEditor(cdp, fileFixture.secondClosed, { path: fileFixture.secondName, id: shortcutId });
	await closeSecond(shortcutId);
	assert.deepEqual(
		(await state(cdp)).tabs.map((tab) => tab.id),
		originalIds,
		"Reopen journey must restore original tab set",
	);
	return {
		menuReopen: true,
		hiddenShortcutReopen: true,
		freshDiskRead: true,
		editorFocus: true,
		protectedDraft: true,
		restoredFixtureBytes: true,
	};
}
