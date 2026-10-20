import assert from "node:assert/strict";
import { nativeEditorKey } from "./gui-work-experience.mjs";

export const projectCreationTrigger = '.nav-section-heading button[aria-label="New project"]';

export function projectCreationRecovered(document, before) {
	return (
		document.activeElement === before.trigger &&
		before.trigger.isConnected &&
		before.conversation === document.querySelector(".conversation-panel") &&
		before.composer === document.querySelector(".composer textarea") &&
		document.querySelector(".composer textarea")?.value === "" &&
		document.querySelectorAll(".workspace-branch").length === before.count
	);
}

export function projectViewportReady(document, width) {
	const shell = document.querySelector(".work-shell");
	const sidebar = document.querySelector(".sidebar");
	const toggle = document.querySelector(".navigation-toggle");
	const narrow = width <= 720;
	return (
		document.defaultView.innerWidth === width &&
		shell?.dataset.navigationMode === (narrow ? "narrow" : "desktop") &&
		shell.dataset.navigationOpen === "false" &&
		shell.dataset.navigationCollapsed === "false" &&
		sidebar?.inert === narrow &&
		toggle?.getAttribute("aria-expanded") === String(!narrow)
	);
}

export function projectSelector(document, name) {
	const branches = [...document.querySelectorAll(".workspace-tree > .workspace-branch")];
	const matches = branches
		.map((node, index) => ({ node, index }))
		.filter(({ node }) => node.querySelector(".project-name")?.textContent === name);
	if (matches.length !== 1) return null;
	return `.workspace-tree > .workspace-branch:nth-child(${matches[0].index + 1})`;
}

export function currentProject(document) {
	const branches = [
		...document.querySelectorAll('.workspace-branch:is([data-current="true"],[data-contains-current="true"])'),
	];
	if (branches.length !== 1) return null;
	const branch = branches[0];
	if (branch.dataset.current === "true" && branch.dataset.containsCurrent === "true") return null;
	return branch.dataset.workspaceId ?? null;
}

export function assertDisclosureContinuity(actual, expected) {
	assert.equal(actual.sameConversation, true, "Disclosure remounted the active conversation");
	assert.equal(actual.sameComposer, true, "Disclosure remounted the composer");
	assert.equal(actual.selected, expected.selected, "Disclosure selected another project");
	assert.equal(actual.draft, expected.draft, "Disclosure changed the draft");
	assert.deepEqual(actual.keys, expected.keys, "Disclosure changed execution message identities");
	assert.equal(actual.navigationOpen, expected.navigationOpen, "Disclosure closed the navigation drawer");
}

export async function exerciseProjectDisclosure(cdp, helpers, directory, fixture, reopened, expectedScope) {
	assert.match(
		expectedScope?.workspaceId ?? "",
		/^[A-Za-z0-9_-]{1,128}$/,
		"Actual receipt workspace identity required",
	);
	const { evaluate, click, until, capture, pressKey, waitForOverlayClosed, assertNoAlerts, inspectModal } = helpers;
	const second = "GUI disclosure empty project";
	const creator = projectCreationTrigger;
	const locate = (name) =>
		until(
			() => evaluate(cdp, `(${projectSelector.toString()})(document, ${JSON.stringify(name)})`),
			"exact project branch",
		);
	const read = () =>
		evaluate(
			cdp,
			`({
		selected: (${currentProject.toString()})(document),
		draft: document.querySelector('.composer textarea')?.value,
		keys: [...document.querySelectorAll('[data-message-id]')].map(e => 'message:' + e.dataset.messageId),
		navigationOpen: document.querySelector('.work-shell').dataset.navigationOpen,
		sameConversation: window.__hipiDisclosureConversation === document.querySelector('.conversation-panel'),
		sameComposer: window.__hipiDisclosureComposer === document.querySelector('.composer textarea')
	})`,
		);
	async function resize(width) {
		await cdp.request("Emulation.setDeviceMetricsOverride", {
			width,
			height: 900,
			deviceScaleFactor: 1,
			mobile: false,
		});
		// Chromium can update innerWidth before React commits its matchMedia state.
		// Wait for the actual closed-drawer/expanded-desktop contract before input.
		const ready = () => evaluate(cdp, `(${projectViewportReady.toString()})(document, ${width})`);
		await until(ready, "project disclosure committed viewport");
		await evaluate(cdp, "new Promise(r => requestAnimationFrame(() => requestAnimationFrame(() => r(true))))");
		assert.equal(await ready(), true, "Project navigation changed while settling the viewport");
	}
	assert.equal((await read()).draft, "", "Project acceptance starts with an empty composer");
	const originalKeys = (await read()).keys;
	let failure;
	try {
		await resize(1440);
		if (!reopened) {
			assert.equal(await evaluate(cdp, `(${projectSelector.toString()})(document, ${JSON.stringify(second)})`), null);
			await evaluate(
				cdp,
				`window.__hipiProjectCreate = {
				trigger: document.querySelector(${JSON.stringify(creator)}),
				conversation: document.querySelector('.conversation-panel'),
				composer: document.querySelector('.composer textarea'),
				count: document.querySelectorAll('.workspace-branch').length
			}`,
			);
			await click(cdp, creator);
			await until(
				() =>
					evaluate(
						cdp,
						`document.activeElement === document.querySelector('[role="dialog"] .task-title-input') &&
				document.querySelector('[role="dialog"] .task-title-input')?.value === '' &&
				document.querySelector('[role="dialog"] .task-create-confirm')?.disabled === true`,
					),
				"new project starts focused and cannot create an empty name",
			);
			await inspectModal(cdp, '[role="dialog"]', "center");
			await capture(cdp, directory, "project-create-empty");
			await click(cdp, '[role="dialog"] input');
			await cdp.request("Input.insertText", { text: second });
			await pressKey(cdp, "Escape");
			await waitForOverlayClosed(cdp, creator);
			assert.equal(
				await evaluate(cdp, `(${projectCreationRecovered.toString()})(document,window.__hipiProjectCreate)`),
				true,
				"Cancelled project must preserve exact opener, app owners, empty draft and workspace count",
			);
			assert.deepEqual((await read()).keys, originalKeys, "Cancelled project must not replay the conversation");
			await click(cdp, creator);
			await until(
				() =>
					evaluate(
						cdp,
						`document.querySelector('[role="dialog"] .task-title-input')?.value === ${JSON.stringify(second)} && document.querySelector('[role="dialog"] .task-create-confirm')?.disabled === false`,
					),
				"reopened project preserves its unsubmitted name",
			);
			await capture(cdp, directory, "project-create-ready");
			await click(cdp, '[role="dialog"] .task-create-confirm');
			await locate(second);
			await waitForOverlayClosed(cdp, creator);
			await evaluate(cdp, "delete window.__hipiProjectCreate");
		}
		const a = `.workspace-branch[data-workspace-id="${expectedScope.workspaceId}"]`;
		const b = await locate(second);
		const secondId = await evaluate(cdp, `document.querySelector(${JSON.stringify(b)}).dataset.workspaceId`);
		assert.match(secondId, /^[A-Za-z0-9_-]{1,128}$/);
		assert.notEqual(secondId, expectedScope.workspaceId);
		assert.equal(
			await evaluate(
				cdp,
				`document.querySelectorAll(${JSON.stringify(a)}).length === 1 && document.querySelector(${JSON.stringify(a)}).classList.contains('recent-conversations')`,
			),
			true,
			"Original receipt must identify the unique default Recent branch",
		);
		await click(cdp, `${a} .conversation-link`, fixture.conversation);
		await until(
			() => evaluate(cdp, `!!document.querySelector('.composer textarea')`),
			"original conversation restored after fixture setup",
		);
		await until(
			async () => JSON.stringify((await read()).keys) === JSON.stringify(originalKeys),
			"original history loaded after fixture setup",
		);
		await click(cdp, ".composer textarea");
		await cdp.request("Input.insertText", { text: "A draft stays while B unfolds" });
		assert.equal(
			await evaluate(
				cdp,
				`(() => { window.__hipiDisclosureConversation = document.querySelector('.conversation-panel'); window.__hipiDisclosureComposer = document.querySelector('.composer textarea'); return !!window.__hipiDisclosureConversation && !!window.__hipiDisclosureComposer; })()`,
			),
			true,
		);
		const expected = await read();
		assert.equal(expected.selected, expectedScope.workspaceId);
		assert.equal(expected.draft, "A draft stays while B unfolds");
		assert.ok(expected.keys.length >= 2);
		for (const width of [1440, 640]) {
			await resize(width);
			if (width === 640) {
				await click(cdp, ".navigation-toggle");
				await until(
					() => evaluate(cdp, `document.querySelector('.work-shell').dataset.navigationOpen === 'true'`),
					"open narrow project drawer",
				);
			}
			const scope = { ...expected, navigationOpen: width === 640 ? "true" : "false" };
			for (let index = 0; index < 2; index++) {
				const before = await evaluate(
					cdp,
					`document.querySelector(${JSON.stringify(`${b} .project-toggle`)}).getAttribute('aria-expanded')`,
				);
				if (index === 0) await click(cdp, `${b} .project-toggle`);
				else await nativeEditorKey(cdp, "Enter");
				await until(
					() =>
						evaluate(
							cdp,
							`document.querySelector(${JSON.stringify(`${b} .project-toggle`)}).getAttribute('aria-expanded') === ${JSON.stringify(before === "true" ? "false" : "true")}`,
						),
					"other project disclosure toggled",
				);
				assertDisclosureContinuity(await read(), scope);
				assert.equal(
					await evaluate(
						cdp,
						`document.activeElement === document.querySelector(${JSON.stringify(`${b} .project-toggle`)})`,
					),
					true,
				);
			}
			await capture(cdp, directory, `project-disclosure-${reopened ? "reopened-" : ""}${width}`);
			if (width === 640) {
				await pressKey(cdp, "Escape");
				await until(
					() =>
						evaluate(
							cdp,
							`document.querySelector('.work-shell').dataset.navigationOpen === 'false' && document.activeElement === document.querySelector('.navigation-toggle')`,
						),
					"project drawer Escape focus",
				);
			}
		}
		await resize(1440);
		assertDisclosureContinuity(await read(), expected);
		// Intentional navigation is tested separately from disclosure, with no unsaved draft left behind.
		await click(cdp, ".composer textarea");
		await nativeEditorKey(cdp, "a", { modifiers: process.platform === "darwin" ? 4 : 2 });
		await nativeEditorKey(cdp, "Backspace");
		assert.equal((await read()).draft, "");
		await click(cdp, `${b} .project-open`);
		await until(
			() =>
				evaluate(
					cdp,
					`document.querySelector(${JSON.stringify(b)}).dataset.current === 'true' && document.querySelector(${JSON.stringify(b)}).dataset.containsCurrent === 'false' && (${currentProject.toString()})(document) === ${JSON.stringify(secondId)} && document.querySelector('.prepared-task-input')?.value === '' && !document.querySelector('.toolbar-conversation') && !document.querySelector('[data-message-id]')`,
				),
			"empty project explicitly opened",
		);
		await assertNoAlerts(cdp);
	} catch (error) {
		failure = error;
		await capture(cdp, directory, "project-disclosure-failure").catch(() => {});
	} finally {
		try {
			await resize(1440);
			if (await evaluate(cdp, `document.querySelector('.work-shell').dataset.navigationOpen === 'true'`))
				await pressKey(cdp, "Escape");
			const a = `.workspace-branch[data-workspace-id="${expectedScope.workspaceId}"]`;
			await click(cdp, `${a} .conversation-link`, fixture.conversation);
			await until(
				() => evaluate(cdp, `!!document.querySelector('.composer textarea')`),
				"restore original conversation",
			);
			await until(
				async () => JSON.stringify((await read()).keys) === JSON.stringify(originalKeys),
				"restore original execution history",
			);
			await click(cdp, ".composer textarea");
			await nativeEditorKey(cdp, "a", { modifiers: process.platform === "darwin" ? 4 : 2 });
			await nativeEditorKey(cdp, "Backspace");
			assert.equal((await read()).draft, "");
			assert.deepEqual(
				(await read()).keys,
				originalKeys,
				"Project navigation must not replay or mutate the completed task",
			);
			await cdp.request("Emulation.clearDeviceMetricsOverride");
			await evaluate(
				cdp,
				"delete window.__hipiDisclosureConversation; delete window.__hipiDisclosureComposer; delete window.__hipiProjectCreate",
			);
		} catch (error) {
			failure = failure ? new AggregateError([failure, error], "Project disclosure and restoration failed") : error;
		}
	}
	if (failure) throw failure;
	return {
		otherProjectDisclosureRetainsDraftAndNodes: true,
		narrowDisclosureKeepsDrawer: true,
		emptyProjectExplicitOpen: true,
		notValidated: ["disclosure during active streaming", "dirty file navigation (separate file fixture)"],
	};
}
