import assert from "node:assert/strict";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { assertFreshReopenedTab, dispatchReopenShortcut } from "./gui-file-reopen.mjs";
import {
	changeClosedSecondFixture,
	fileFixture,
	ownedFileDirectory,
	readOwnedFixture,
} from "./gui-file-workbench-fixture.mjs";
import { createGuiProfile } from "./smoke-packaged-gui.mjs";

test("fresh reopen rejects old session identity, stale bytes and dirty buffers", () => {
	const valid = {
		path: fileFixture.secondName,
		activeId: "file-tab-file-3",
		tabs: [{ id: "file-tab-file-1" }, { id: "file-tab-file-3" }],
		editor: fileFixture.secondReopened,
		dirty: false,
		clean: true,
	};
	assertFreshReopenedTab(valid, "file-tab-file-2", fileFixture.secondReopened);
	for (const delta of [
		{ path: fileFixture.textName },
		{ activeId: "file-tab-file-2" },
		{ tabs: [...valid.tabs, { id: "file-tab-file-2" }] },
		{ editor: fileFixture.secondClosed },
		{ dirty: true },
		{ clean: false },
	])
		assert.throws(() => assertFreshReopenedTab({ ...valid, ...delta }, "file-tab-file-2", fileFixture.secondReopened));
});

test("reopen shortcut sends real paired platform-specific modifier events", async () => {
	for (const platform of ["darwin", "win32", "linux"]) {
		const events = [];
		await dispatchReopenShortcut({ request: async (method, args) => events.push({ method, ...args }) }, platform);
		assert.deepEqual(
			events.map((e) => e.type),
			["keyDown", "keyUp"],
		);
		assert.ok(
			events.every(
				(e) =>
					e.method === "Input.dispatchKeyEvent" &&
					e.code === "KeyT" &&
					e.windowsVirtualKeyCode === 84 &&
					e.modifiers === (platform === "darwin" ? 12 : 10),
			),
		);
	}
	await assert.rejects(dispatchReopenShortcut({}, "unknown"));
});

test("external reread fixture only changes the exact owned second file at its confirmed prior bytes", async () => {
	const root = await createGuiProfile();
	try {
		await mkdir(join(root, "profile"), { mode: 0o700 });
		const directory = await ownedFileDirectory(root, { create: true });
		await writeFile(join(directory, fileFixture.secondName), "unexpected");
		await assert.rejects(changeClosedSecondFixture(root));
		assert.equal((await readOwnedFixture(root, fileFixture.secondName)).toString(), "unexpected");
		await writeFile(join(directory, fileFixture.secondName), fileFixture.secondClosed);
		await writeFile(join(directory, fileFixture.textName), fileFixture.external);
		await changeClosedSecondFixture(root);
		assert.equal((await readOwnedFixture(root, fileFixture.secondName)).toString(), fileFixture.secondReopened);
		assert.equal((await readOwnedFixture(root)).toString(), fileFixture.external);
		await assert.rejects(changeClosedSecondFixture(root), "No replay of the external edit");
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});
