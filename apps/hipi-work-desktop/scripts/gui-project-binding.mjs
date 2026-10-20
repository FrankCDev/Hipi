import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { chooseOwnedFileFolder } from "./gui-file-picker.mjs";
import { fileFixture } from "./gui-file-workbench-fixture.mjs";
import { assertNoAlerts, capture, click, evaluate, hover, pressKey, until } from "./gui-flow.mjs";

export const bindingProjectTitle = "Native bound project 中文";

export function bindingReadOnlyBuffer(document, path, expected) {
	const hosts = document.querySelectorAll(".file-code.pierre-code .pierre-editor-viewport diffs-container");
	const tabs = document.querySelectorAll('.file-tabs [role="tab"][aria-selected="true"]');
	if (hosts.length !== 1 || tabs.length !== 1 || tabs[0].getAttribute("title") !== path) return false;
	const shadow = hosts[0].shadowRoot;
	if (!shadow || shadow.querySelector('[contenteditable="true"]')) return false;
	const lines = [...shadow.querySelectorAll("[data-content] > [data-line]")];
	return (
		lines.length > 0 &&
		lines.every((line, index) => line.getAttribute("data-line") === String(index + 1)) &&
		lines.map((line) => line.textContent).join("\n") === expected &&
		document.querySelector(".file-document-status")?.textContent.includes("Read only") === true
	);
}

/** Discover the newly created canonical identity, never infer it from the title alone. */
export function bindingProjectIdentity(branches, before) {
	if (branches.length !== 3 || new Set(branches.map((row) => row.id)).size !== 3) return null;
	if (before.length !== 2 || !before.every((id) => branches.some((row) => row.id === id))) return null;
	const added = branches.filter((row) => !before.includes(row.id));
	if (added.length !== 1 || added[0].title !== bindingProjectTitle || !added[0].current || added[0].conversations !== 0)
		return null;
	return added[0].id || null;
}

export function assertBindingEvidence(first, reopened) {
	assert.ok(first && reopened, "Both native binding launches are required");
	for (const evidence of [first, reopened])
		assert.equal(
			evidence.noModelGrant,
			"native_not_run; empty conversation UI is not authoritative grant evidence",
			"Native binding evidence must not claim unobserved model-grant absence",
		);
	assert.ok(first.workspaceId && ![fileFixture.workspaceId, fileFixture.otherWorkspaceId].includes(first.workspaceId));
	assert.equal(reopened.workspaceId, first.workspaceId, "Restart changed the canonical bound project");
	for (const key of ["cancelNoCreate", "nativeChosen", "readOnlyRoot", "noConversationCreated", "restoredOriginal"])
		assert.equal(first[key], true, `Missing native project binding observation: ${key}`);
	for (const key of ["persistedWithoutPicker", "readOnlyRoot", "noConversationCreated", "unbound", "tabsRevoked"])
		assert.equal(reopened[key], true, `Missing restarted project binding observation: ${key}`);
}

export async function exerciseProjectBinding({ cdp, directory, nativeContext, reopened, previous, record, helpers }) {
	const read = (expression) => evaluate(cdp, expression);
	const branches = () =>
		read(`Array.from(document.querySelectorAll('.workspace-branch'), e => ({
			id:e.dataset.workspaceId, title:e.querySelector('.project-name')?.textContent.trim(),
			current:e.dataset.current === 'true', conversations:e.querySelectorAll('.conversation-link').length
		}))`);
	const original = await read(
		"document.querySelector('.workspace-branch[data-contains-current=\"true\"]')?.dataset.workspaceId",
	);
	assert.equal(original, fileFixture.workspaceId, "Binding journey starts only after the unchanged A file gates");
	let workspaceId;
	if (!reopened) {
		const before = (await branches()).map((row) => row.id).sort();
		assert.deepEqual(before, [fileFixture.workspaceId, fileFixture.otherWorkspaceId].sort());
		await read(`void (window.__hipiBindingCreateOpener = document.querySelector('button[aria-label="New project"]'))`);
		await click(cdp, 'button[aria-label="New project"]');
		await until(
			() => read("document.activeElement === document.querySelector('.project-create-dialog .task-title-input')"),
			"project name initial focus",
		);
		await cdp.request("Input.insertText", { text: bindingProjectTitle });
		const picker = async (action) => {
			await click(cdp, ".project-create-folder button", "Choose a project folder (optional)");
			return chooseOwnedFileFolder(nativeContext, {
				purpose: "project",
				action,
				observe: async (stage, png) => {
					const file = `project-picker-${action}-${stage}.png`;
					await writeFile(join(directory, file), png, { flag: "wx", mode: 0o600 });
					record({ projectPickerCapture: file, nativeWindowOnly: true });
				},
			});
		};
		assert.equal((await picker("cancel")).cancelled, true);
		await until(
			() =>
				read(`document.querySelector('.task-title-input')?.value === ${JSON.stringify(bindingProjectTitle)} &&
			!document.querySelector('.task-create-confirm')?.disabled &&
			document.activeElement === document.querySelector('.project-create-folder button')`),
			"native picker cancellation retains project draft and exact opener focus",
		);
		assert.deepEqual(
			(await branches()).map((row) => row.id).sort(),
			before,
			"Picker cancellation must not create a project",
		);
		await capture(cdp, directory, "project-binding-cancelled");
		const chosen = await picker("choose");
		assert.equal(chosen.nativePicker, true);
		await until(
			() =>
				read(`document.querySelector('.project-create-folder button')?.textContent.trim() === ${JSON.stringify(fileFixture.folder)} &&
			!document.querySelector('.task-create-confirm')?.disabled`),
			"native prepared folder is visible before Create",
		);
		assert.deepEqual(
			(await branches()).map((row) => row.id).sort(),
			before,
			"Choosing a folder alone must not create a project",
		);
		await capture(cdp, directory, "project-binding-prepared");
		await click(cdp, ".task-create-confirm");
		workspaceId = await until(
			async () => bindingProjectIdentity(await branches(), before),
			"one explicit Create returns a new canonical bound project",
		);
		await until(
			() =>
				read(
					"!document.querySelector('.project-create-dialog') && document.activeElement === window.__hipiBindingCreateOpener",
				),
			"Create returns exact original project trigger focus",
		);
	} else {
		workspaceId = previous?.workspaceId;
		assert.ok(workspaceId && ![fileFixture.workspaceId, fileFixture.otherWorkspaceId].includes(workspaceId));
		assert.deepEqual(
			(await branches()).map((row) => row.id).sort(),
			[fileFixture.workspaceId, fileFixture.otherWorkspaceId, workspaceId].sort(),
		);
		await click(cdp, `.workspace-branch[data-workspace-id="${workspaceId}"] .project-open`);
	}
	const branch = `.workspace-branch[data-workspace-id="${workspaceId}"]`;
	if (
		await read(
			`document.querySelector(${JSON.stringify(`${branch} .project-toggle`)})?.getAttribute('aria-expanded') === 'false'`,
		)
	)
		await click(cdp, `${branch} .project-toggle`);
	await until(
		() =>
			read(`document.querySelector(${JSON.stringify(branch)})?.dataset.current === 'true' &&
		!!document.querySelector(${JSON.stringify(`${branch} .nav-empty-state`)}) &&
		document.querySelector('.project-folder-summary')?.textContent.includes('Connected for local browsing') &&
		!document.querySelector('.conversation-panel')`),
		"bound project overview with no backing chat created",
	);
	await helpers.showFiles(cdp);
	await helpers.expectListing(cdp);
	await click(cdp, '.file-workbench button[aria-label="Folder access"]');
	assert.equal(
		await read(`document.querySelectorAll('.file-access-row').length === 1 &&
		document.querySelector('.file-access-name')?.textContent === ${JSON.stringify(fileFixture.folder)} &&
		document.querySelector('.file-access-kind')?.textContent === 'Read only'`),
		true,
		"Only one read-only project root may exist",
	);
	await pressKey(cdp, "Escape");
	await helpers.selectFile(cdp, fileFixture.textName);
	await until(
		() =>
			read(
				`(${bindingReadOnlyBuffer.toString()})(document, ${JSON.stringify(fileFixture.textName)}, ${JSON.stringify(fileFixture.external)})`,
			),
		"project file opens without a writable editor",
	);
	await capture(cdp, directory, reopened ? "project-binding-reopened" : "project-binding-readonly");
	assert.equal((await branches()).find((row) => row.id === workspaceId)?.conversations, 0);
	if (reopened) {
		// Explicit project menu, not the separate writable-root revoke action.
		await click(cdp, `${branch} .project-open`);
		await hover(cdp, `${branch} .project-open`);
		await read(
			`void (window.__hipiBindingManagerOpener = document.querySelector(${JSON.stringify(`${branch} .project-actions-trigger`)}))`,
		);
		await click(cdp, `${branch} .project-actions-trigger`);
		await click(cdp, '.project-action-menu [role="menuitem"]', "Project folder");
		await until(
			() => read("!!document.querySelector('.project-folder-dialog')"),
			"project folder manager from actual menu",
		);
		await capture(cdp, directory, "project-binding-manager");
		await click(cdp, ".project-folder-actions button", "Disconnect folder");
		await until(
			() =>
				read("document.querySelector('.project-folder-identity')?.textContent.includes('Folder access was revoked')"),
			"explicit disconnect persists revoked binding",
		);
		await click(cdp, '.project-folder-dialog [data-slot="dialog-close"]');
		await until(
			() =>
				read(`!document.querySelector('.project-folder-dialog') &&
			window.__hipiBindingManagerOpener.isConnected &&
			document.activeElement === window.__hipiBindingManagerOpener &&
			window.__hipiBindingManagerOpener === document.querySelector(${JSON.stringify(`${branch} .project-actions-trigger`)})`),
			"project manager returns exact menu trigger focus",
		);
		await until(
			() => read("!document.querySelector('.pierre-file-tree, .file-tabs [role=\"tab\"], .file-code')"),
			"unbinding revokes project tree and all open tabs",
		);
		await capture(cdp, directory, "project-binding-revoked");
		await assertNoAlerts(cdp);
		await read("delete window.__hipiBindingManagerOpener");
		return {
			workspaceId,
			persistedWithoutPicker: true,
			readOnlyRoot: true,
			noConversationCreated: true,
			noModelGrant: "native_not_run; empty conversation UI is not authoritative grant evidence",
			unbound: true,
			tabsRevoked: true,
		};
	}
	await click(
		cdp,
		`.workspace-branch[data-workspace-id="${fileFixture.workspaceId}"] .conversation-link`,
		fileFixture.conversationTitle,
	);
	await helpers.expectEditor(cdp, fileFixture.external);
	await assertNoAlerts(cdp);
	await read("delete window.__hipiBindingCreateOpener");
	return {
		workspaceId,
		cancelNoCreate: true,
		nativeChosen: true,
		readOnlyRoot: true,
		noConversationCreated: true,
		noModelGrant: "native_not_run; empty conversation UI is not authoritative grant evidence",
		restoredOriginal: true,
	};
}
