import assert from "node:assert/strict";
import { nativeEditorKey } from "./gui-work-experience.mjs";

export function projectSelector(document, name) {
	const branches = [...document.querySelectorAll(".workspace-tree > .workspace-branch")];
	const matches = branches
		.map((node, index) => ({ node, index }))
		.filter(({ node }) => node.querySelector(".project-name")?.textContent === name);
	if (matches.length !== 1) return null;
	return `.workspace-tree > .workspace-branch:nth-child(${matches[0].index + 1})`;
}

export function assertDisclosureContinuity(actual, expected) {
	assert.equal(actual.sameConversation, true, "Disclosure remounted the active conversation");
	assert.equal(actual.sameComposer, true, "Disclosure remounted the composer");
	assert.equal(actual.selected, expected.selected, "Disclosure selected another project");
	assert.equal(actual.draft, expected.draft, "Disclosure changed the draft");
	assert.deepEqual(actual.keys, expected.keys, "Disclosure changed execution message identities");
	assert.equal(actual.navigationOpen, expected.navigationOpen, "Disclosure closed the navigation drawer");
}

export async function exerciseProjectDisclosure(cdp, helpers, directory, fixture, reopened) {
	const { evaluate, click, until, capture, pressKey, waitForOverlayClosed, assertNoAlerts } = helpers;
	const second = "GUI disclosure empty project";
	const creator = '.nav-section-heading button[aria-label="New workspace"]';
	const locate = (name) =>
		until(
			() => evaluate(cdp, `(${projectSelector.toString()})(document, ${JSON.stringify(name)})`),
			"exact project branch",
		);
	const read = () =>
		evaluate(
			cdp,
			`({
		selected: document.querySelector('.workspace-branch[data-selected="true"] .project-name')?.textContent,
		draft: document.querySelector('.composer textarea')?.value,
		keys: [...document.querySelectorAll('[data-message-key^="message:"]')].map(e => e.dataset.messageKey),
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
		await until(() => evaluate(cdp, `innerWidth === ${width}`), "project disclosure viewport");
	}
	assert.equal((await read()).draft, "", "Project acceptance starts with an empty composer");
	const originalKeys = (await read()).keys;
	let failure;
	try {
		await resize(1440);
		if (!reopened) {
			assert.equal(await evaluate(cdp, `(${projectSelector.toString()})(document, ${JSON.stringify(second)})`), null);
			await click(cdp, creator);
			await click(cdp, '[role="dialog"] input');
			await cdp.request("Input.insertText", { text: second });
			await click(cdp, '[role="dialog"] button[type="submit"]');
			await locate(second);
			await waitForOverlayClosed(cdp, creator);
		}
		const a = await locate(fixture.workspace);
		const b = await locate(second);
		if (
			await evaluate(
				cdp,
				`document.querySelector(${JSON.stringify(`${a} .project-toggle`)}).getAttribute('aria-expanded') === 'false'`,
			)
		)
			await click(cdp, `${a} .project-toggle`);
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
		assert.equal(expected.selected, fixture.workspace);
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
					`document.querySelector(${JSON.stringify(b)}).dataset.selected === 'true' && !document.querySelector('.composer textarea') && !document.querySelector('.toolbar-conversation')`,
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
			const a = await locate(fixture.workspace);
			if (
				await evaluate(
					cdp,
					`document.querySelector(${JSON.stringify(`${a} .project-toggle`)}).getAttribute('aria-expanded') === 'false'`,
				)
			)
				await click(cdp, `${a} .project-toggle`);
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
			await evaluate(cdp, "delete window.__hipiDisclosureConversation; delete window.__hipiDisclosureComposer");
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
