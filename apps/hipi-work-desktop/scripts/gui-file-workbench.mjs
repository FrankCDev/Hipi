import assert from "node:assert/strict";
import { chooseOwnedFileFolder } from "./gui-file-picker.mjs";
import { changeOwnedFixture, fileFixture, readOwnedFixture } from "./gui-file-workbench-fixture.mjs";
import { assertNoAlerts, capture, click, evaluate, pressKey, selectEnglish, until } from "./gui-flow.mjs";

export function fileWorkbenchState(document) {
	const roots = [...document.querySelectorAll(".file-workbench")];
	if (roots.length !== 1) return null;
	const root = roots[0];
	const text = (label) => {
		const contents = root.querySelectorAll(`.cm-content[aria-label="${label}"]`);
		if (contents.length !== 1) return null;
		return [...contents[0].querySelectorAll(".cm-line")].map((line) => line.textContent).join("\n");
	};
	const save = [...root.querySelectorAll(".file-buffer button")].filter(
		(button) => button.textContent.trim() === "Save",
	);
	return {
		editor: text("File text editor"),
		left: text("Comparison baseline"),
		right: text("Current file input"),
		path: root.querySelector(".file-buffer .file-path")?.textContent ?? null,
		dirty: [...root.querySelectorAll(".file-buffer p")].some((p) => p.textContent.startsWith("Unsaved changes")),
		clean: [...root.querySelectorAll(".file-buffer p")].some((p) =>
			p.textContent.startsWith("Matches confirmed version"),
		),
		initialBaseline: root.textContent.includes("Left: initial editor-read baseline."),
		diskBaseline: root.textContent.includes("Left: latest disk read."),
		saveDisabled: save.length === 1 ? save[0].disabled : null,
		alerts: [...root.querySelectorAll('[role="alert"]')].map((e) => e.textContent.trim()),
		image: (() => {
			const image = root.querySelector("img.file-preview-image");
			return image
				? { loaded: image.complete && image.naturalWidth > 0, sourceIsBlob: image.src.startsWith("blob:") }
				: null;
		})(),
		cells: [...root.querySelectorAll(".file-preview-grid td")].map((e) => e.textContent),
	};
}

async function state(cdp) {
	return evaluate(cdp, `(${fileWorkbenchState.toString()})(document)`);
}
async function expectEditor(cdp, expected, { dirty = false } = {}) {
	return until(async () => {
		const value = await state(cdp);
		return value?.editor === expected && value.dirty === dirty && value.clean === !dirty ? value : null;
	}, "single CodeMirror buffer with exact synthetic text and dirty state");
}
async function replaceEditor(cdp, text) {
	await click(cdp, '.file-code .cm-content[aria-label="File text editor"]');
	assert.ok(
		await evaluate(
			cdp,
			`document.activeElement === document.querySelector('.file-code .cm-content[aria-label="File text editor"]')`,
		),
		"File editor must own keyboard focus before input",
	);
	for (const type of ["keyDown", "keyUp"])
		await cdp.request("Input.dispatchKeyEvent", {
			type,
			key: "a",
			code: "KeyA",
			windowsVirtualKeyCode: 65,
			modifiers: 2,
		});
	await cdp.request("Input.insertText", { text });
	await expectEditor(cdp, text, { dirty: true });
}
async function selectFile(cdp, name, preview = false) {
	assert.ok([fileFixture.textName, fileFixture.csvName, fileFixture.imageName].includes(name));
	const selector = await until(
		() =>
			evaluate(
				cdp,
				`(() => {
		const entries=[...document.querySelectorAll('.file-directory > ul > li')];
		const indexes=entries.map((e,i)=>e.querySelector('.file-entry span:last-child')?.textContent === ${JSON.stringify(name)} ? i : -1).filter(i=>i>=0);
		return indexes.length===1 ? '.file-directory > ul > li:nth-child('+(indexes[0]+1)+') button${preview ? ":not(.file-entry)" : ".file-entry"}' : null;
	})()`,
			),
		"exact synthetic file entry",
	);
	await click(cdp, selector, preview ? "Preview" : undefined);
}
async function assertDiff(cdp, before, after, disk = false) {
	await until(async () => {
		const value = await state(cdp);
		return value?.left === before && value.right === after && (disk ? value.diskBaseline : value.initialBaseline);
	}, "explicit baseline and exact current-input diff panes");
	assert.ok(
		await evaluate(
			cdp,
			`[...document.querySelectorAll('.file-diff .cm-content')].length === 2 && [...document.querySelectorAll('.file-diff .cm-content')].every(e => e.getAttribute('contenteditable') === 'false')`,
		),
	);
}
async function showFiles(cdp) {
	if (!(await evaluate(cdp, "!!document.querySelector('.file-workbench')")))
		await click(cdp, 'button[aria-label="Show files"]');
	await until(() => state(cdp), "exactly one file workbench");
}
async function hideFiles(cdp) {
	await click(cdp, ".file-panel-controls button", "Hide files");
	await until(
		() =>
			evaluate(
				cdp,
				`!document.querySelector('.file-workbench') && document.activeElement === document.querySelector('button[aria-label="Show files"]')`,
			),
		"file dock hidden and toolbar focus restored",
	);
}
async function openRoot(cdp) {
	await click(cdp, ".file-root button", fileFixture.folder);
	await until(
		() =>
			evaluate(
				cdp,
				`JSON.stringify([...document.querySelectorAll('.file-entry span:last-child')].map(e=>e.textContent).sort()) === ${JSON.stringify(JSON.stringify([fileFixture.textName, fileFixture.csvName, fileFixture.imageName].sort()))}`,
			),
		"real owned-directory listing",
	);
}

export function validateFileWorkbenchEvidence({ first, reopened }) {
	for (const key of [
		"listedAndOpened",
		"savedBytesVerified",
		"initialBaselineSurvivesSave",
		"conflictDraftPreserved",
		"conflictDidNotOverwriteDisk",
		"explicitDiscardGuard",
		"dirtyPanelPreservation",
		"narrowModalPreservation",
		"csvPreview",
		"pngPreview",
		"previewNotRestored",
	])
		assert.equal(first?.[key], true, `Missing file-workbench evidence: ${key}`);
	for (const key of ["nativePicker", "ownedDisplay", "ownedPid", "syntheticFolderOnly"])
		assert.equal(first?.nativePicker?.[key], true, `Missing owned-picker evidence: ${key}`);
	for (const key of ["reopened", "freshlyAuthorized", "coldSavedContent", "rootRevoked"])
		assert.equal(reopened?.[key], true, `Missing restarted file-workbench evidence: ${key}`);
}

export async function exerciseFileWorkbench({ cdp, directory, reopened, nativeContext, record }) {
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
	const expanded = await until(
		() => evaluate(cdp, `document.querySelector('.project-toggle')?.getAttribute('aria-expanded')`),
		"fixture workspace visible",
	);
	if (expanded === "false") await click(cdp, ".project-toggle");
	await click(cdp, ".conversation-list button.conversation-link", fileFixture.conversationTitle);
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
				`document.querySelector('.file-workbench')?.textContent.includes('No folders authorized.') && !document.querySelector('.file-root')`,
			),
		"no implicit or restarted file grants",
	);
	await click(cdp, ".file-workbench button", "Authorize folder (read and write)");
	const picker = await chooseOwnedFileFolder(nativeContext);
	record({ picker, reopened, grantsRequireFreshNativeChoice: true });
	await openRoot(cdp);
	await selectFile(cdp, fileFixture.textName);
	await expectEditor(cdp, reopened ? fileFixture.external : fileFixture.initial);
	if (reopened) {
		assert.equal((await readOwnedFixture(nativeContext.ownedProfileRoot)).toString("utf8"), fileFixture.external);
		await capture(cdp, directory, "file-workbench-reopened");
		await click(cdp, ".file-root button", "Revoke folder");
		await until(
			() =>
				evaluate(
					cdp,
					`document.querySelector('.file-workbench')?.textContent.includes('No folders authorized.') && !document.querySelector('.file-code .cm-content')`,
				),
			"revocation removes file capability and editor presentation",
		);
		await assertNoAlerts(cdp);
		return { reopened: true, freshlyAuthorized: true, coldSavedContent: true, rootRevoked: true };
	}
	await replaceEditor(cdp, fileFixture.saved);
	await click(cdp, ".file-buffer button", "Compare changes");
	await assertDiff(cdp, fileFixture.initial, fileFixture.saved);
	await capture(cdp, directory, "file-initial-baseline-diff");
	await click(cdp, ".file-buffer button", "Editor");
	await click(cdp, ".file-buffer button", "Save");
	await expectEditor(cdp, fileFixture.saved);
	assert.equal((await readOwnedFixture(nativeContext.ownedProfileRoot)).toString("utf8"), fileFixture.saved);
	await click(cdp, ".file-buffer button", "Compare changes");
	await assertDiff(cdp, fileFixture.initial, fileFixture.saved);
	record({ listedAndOpened: true, savedBytesVerified: true, initialBaselineSurvivesSave: true });
	await click(cdp, ".file-buffer button", "Editor");
	await replaceEditor(cdp, fileFixture.draft);
	await hideFiles(cdp);
	await showFiles(cdp);
	await expectEditor(cdp, fileFixture.draft, { dirty: true });
	await cdp.request("Emulation.setDeviceMetricsOverride", {
		width: 720,
		height: 900,
		deviceScaleFactor: 1,
		mobile: false,
	});
	await until(
		() =>
			evaluate(
				cdp,
				`document.querySelectorAll('.file-panel-dialog[role="dialog"]').length === 1 && document.querySelectorAll('.file-workbench').length === 1 && !document.querySelector('.file-panel-dock')`,
			),
		"single narrow modal instead of dock",
	);
	await expectEditor(cdp, fileFixture.draft, { dirty: true });
	await capture(cdp, directory, "file-dirty-narrow-modal");
	await pressKey(cdp, "Escape");
	await until(
		() =>
			evaluate(
				cdp,
				`!document.querySelector('.file-workbench') && document.activeElement === document.querySelector('button[aria-label="Show files"]')`,
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
	await expectEditor(cdp, fileFixture.draft, { dirty: true });
	record({
		hideReopenPreservesDirtyInput: true,
		narrowModalPreservesDirtyInput: true,
		narrowEscapeFocus: true,
		cssViewportEmulation: true,
	});
	await changeOwnedFixture(nativeContext.ownedProfileRoot);
	await click(cdp, ".file-buffer button", "Save");
	const conflict = await until(async () => {
		const value = await state(cdp);
		return value?.alerts.length === 1 && value.alerts[0].startsWith("Disk revision changed.") ? value : null;
	}, "real version-conflict response");
	assert.equal(conflict.editor, fileFixture.draft);
	assert.equal(conflict.saveDisabled, true);
	assert.equal(conflict.dirty, true);
	assert.equal((await readOwnedFixture(nativeContext.ownedProfileRoot)).toString("utf8"), fileFixture.external);
	await click(cdp, ".file-buffer button", "Read disk / reconcile");
	await assertDiff(cdp, fileFixture.external, fileFixture.draft, true);
	await capture(cdp, directory, "file-conflict-preserved-diff");
	await click(cdp, ".file-buffer button", "Discard input and reload");
	await click(cdp, '[role="dialog"] button', "Keep editing");
	await assertDiff(cdp, fileFixture.external, fileFixture.draft, true);
	await click(cdp, ".file-buffer button", "Discard input and reload");
	await click(cdp, '[role="dialog"] button', "Discard and continue");
	await until(async () => (await state(cdp))?.clean, "explicit discard reload completes");
	await click(cdp, ".file-buffer button", "Editor");
	await expectEditor(cdp, fileFixture.external);
	await assertNoAlerts(cdp);
	record({ conflictDraftPreserved: true, conflictDidNotOverwriteDisk: true, explicitDiscardGuard: true });
	// Presentation remounts collapse the directory, but the grant remains alive in this process.
	await openRoot(cdp);
	await selectFile(cdp, fileFixture.csvName, true);
	await until(
		async () =>
			JSON.stringify((await state(cdp))?.cells) ===
			JSON.stringify(["label", "value", "中文", "42", "fixture", "read-only"]),
		"CSV parser output in actual renderer",
	);
	await capture(cdp, directory, "file-csv-preview");
	await click(cdp, ".file-buffer button", "Close preview");
	await selectFile(cdp, fileFixture.imageName, true);
	await until(async () => {
		const value = (await state(cdp))?.image;
		return value?.loaded && value.sourceIsBlob;
	}, "owned PNG decoded from local blob");
	await capture(cdp, directory, "file-image-preview");
	await hideFiles(cdp);
	await showFiles(cdp);
	assert.equal((await state(cdp)).image, null);
	assert.equal(
		await evaluate(cdp, `document.querySelectorAll('.file-buffer[aria-label="Preview"]').length`),
		0,
		"Preview must not reappear after panel remount",
	);
	await assertNoAlerts(cdp);
	return {
		reopened: false,
		listedAndOpened: true,
		savedBytesVerified: true,
		initialBaselineSurvivesSave: true,
		conflictDraftPreserved: true,
		conflictDidNotOverwriteDisk: true,
		explicitDiscardGuard: true,
		dirtyPanelPreservation: true,
		narrowModalPreservation: true,
		csvPreview: true,
		pngPreview: true,
		previewNotRestored: true,
		nativePicker: picker,
		notValidated: [
			"native window resizing",
			"physical IME",
			"native unsaved-close dialog",
			"preview worker/blob release instrumentation",
			"macOS and Windows file picker",
		],
	};
}
