import assert from "node:assert/strict";

const familySelector = '[data-setting="uiFont"] .settings-font-control > [role="combobox"]:first-of-type';
const styleSelector = '[data-setting="uiFont"] .settings-font-control > [role="combobox"]:nth-of-type(2)';
const switchSelector = '[data-setting="translucentSidebar"] [role="switch"]';
const storageKey = "hipi-work.preferences.v1";

/** Observe the production controls and renderer surfaces, never synthesize host results. */
export function nativeAppearanceSnapshot(document, getComputedStyle) {
	const catalog = document.querySelector("[data-font-catalog-state]");
	const toggle = document.querySelector('[data-setting="translucentSidebar"] [role="switch"]');
	const surfaces = Object.fromEntries(
		[
			["root", "html"],
			["body", "body"],
			["app", "#root"],
			["route", ".settings-modal"],
			["settingsSidebar", ".settings-page-sidebar"],
			["settingsMain", ".settings-page-main"],
			["sidebar", ".sidebar"],
			["main", ".main-shell"],
		].map(([name, selector]) => {
			const node = document.querySelector(selector);
			if (!node) return [name, null];
			const style = getComputedStyle(node);
			return [
				name,
				{
					background: style.backgroundColor,
					fontFamily: style.fontFamily?.slice(0, 512),
					visibility: style.visibility,
					opacity: style.opacity,
					visible: !!node.getClientRects().length,
				},
			];
		}),
	);
	const root = getComputedStyle(document.documentElement);
	return {
		hostMarker: document.documentElement.dataset.nativeBackdrop,
		catalog: {
			state: catalog?.dataset.fontCatalogState,
			count: Number(catalog?.dataset.fontFamilyCount ?? 0),
			error: catalog?.dataset.fontError,
		},
		toggle: toggle
			? {
					checked: toggle.checked,
					disabled: toggle.disabled,
					description: toggle.closest("[data-setting]")?.querySelector("p")?.textContent.trim() ?? "",
				}
			: null,
		uiFont: root.getPropertyValue("--font-ui").trim(),
		sidebarTint: root.getPropertyValue("--native-sidebar-tint").trim(),
		settingsTint: root.getPropertyValue("--native-settings-sidebar-tint").trim(),
		localFaces: [...document.fonts]
			.filter((face) => face.family.replaceAll('"', "").startsWith("Hipi local "))
			.slice(0, 3)
			.map((face) => ({ family: face.family.replaceAll('"', ""), status: face.status })),
		surfaces,
	};
}

export function backgroundAlpha(value) {
	if (value === "transparent") return 0;
	if (/^#[\da-f]{6}$/i.test(value)) return 1;
	if (!/^(?:rgba?|color)\(/.test(value)) return Number.NaN;
	const alpha =
		(value.includes("/") ? value.split("/").at(-1) : /^rgba\(/.test(value) ? value.split(",")[3] : "1") ?? "";
	return Number.parseFloat(alpha) / (alpha.includes("%") ? 100 : 1);
}

export function assertNativeBackdrop(snapshot, status, requested) {
	assert.ok(["macos", "windows", "linux"].includes(status.platform), "Appearance requires the native host");
	assert.ok(["vibrancy", "mica", "unsupported"].includes(status.backdrop), "Unknown native backdrop capability");
	const enabled = status.backdrop !== "unsupported" && !status.reducedTransparency && requested;
	assert.equal(status.backdropEnabled, enabled, "Host must confirm the requested supported backdrop state");
	assert.equal(snapshot.hostMarker, enabled ? "on" : "off", "Renderer marker must follow native confirmation");
	if (status.backdrop === "unsupported") {
		assert.equal(snapshot.toggle, null, "Unsupported native backdrop must not expose an actionable switch");
	} else {
		assert.ok(snapshot.toggle, "Supported native backdrop requires its Settings switch");
		assert.equal(snapshot.toggle.checked, requested, "Backdrop switch must reflect the saved preference");
		assert.equal(snapshot.toggle.disabled, status.reducedTransparency, "Respect OS reduced transparency");
		if (status.reducedTransparency) assert.ok(snapshot.toggle.description, "Explain the disabled OS preference");
	}
	if (enabled) {
		for (const name of ["root", "body", "app"])
			assert.equal(backgroundAlpha(snapshot.surfaces[name]?.background ?? ""), 0, `${name} blocks native material`);
	}
	// The floating dialog is deliberately opaque even while the underlying window uses native material.
	for (const name of ["route", "settingsSidebar", "settingsMain"])
		assert.equal(
			backgroundAlpha(snapshot.surfaces[name]?.background ?? ""),
			1,
			`${name} modal surface must stay opaque`,
		);
	for (const name of ["sidebar", "main"]) {
		assert.equal(snapshot.surfaces[name]?.visibility, "visible", "Retained app must remain visible behind Settings");
		assert.ok(Number(snapshot.surfaces[name]?.opacity) > 0, "Retained app must not be transparent behind Settings");
	}
}

/** Runs only within the owned synthetic smoke profile, with a preset-font starting preference. */
export async function inspectNativeAppearance(cdp, helpers, route, directory, prefix = "native-appearance") {
	const { evaluate, click, until, capture, pressKey } = helpers;
	const read = (expression) => evaluate(cdp, expression);
	const saved = () => read(`JSON.parse(localStorage.getItem(${JSON.stringify(storageKey)}))`);
	const snapshot = () => read(`(${nativeAppearanceSnapshot.toString()})(document,getComputedStyle)`);
	const settled = () =>
		read(
			"document.fonts.ready.then(() => new Promise(r => requestAnimationFrame(() => requestAnimationFrame(() => r(true)))))",
		);
	const hostStatus = async () => {
		const reply = await read("window.hipiWorkAppearance.request({version:1,method:'status'})");
		assert.equal(reply?.ok, true, "Native read-only appearance status must succeed");
		return reply.result;
	};
	const waitBackdrop = (requested) =>
		until(async () => {
			const status = await hostStatus();
			const expected = status.backdrop !== "unsupported" && !status.reducedTransparency && requested;
			return (await saved()).translucentSidebar === requested &&
				status.backdropEnabled === expected &&
				(await snapshot()).hostMarker === (expected ? "on" : "off")
				? status
				: null;
		}, "backdrop preference persists and native status settles");
	const options = () =>
		read("Array.from(document.querySelectorAll('[role=\"option\"]')).slice(0,520).map(e => e.textContent.trim())");
	const choose = async (selector, label) => {
		await click(cdp, selector);
		await click(cdp, '[role="option"]', label);
		await until(
			() =>
				read(
					`!document.querySelector('[role="option"]') && document.activeElement === document.querySelector(${JSON.stringify(selector)})`,
				),
			"font choice restores its exact combobox",
		);
	};
	assert.equal(
		await read(
			"location.href === 'hipi-work://app/index.html' && window.hipiWorkAppearance?.fontsSupported === true && typeof window.hipiWorkAppearance.listFonts === 'function'",
		),
		true,
		"Native appearance requires the production isolated font bridge",
	);
	const original = await saved();
	assert.ok(
		original &&
			["system", "serif", "mono"].includes(original.uiFont) &&
			!original.customUiFont &&
			!original.localFontFaces?.ui,
		"This synthetic journey requires a restorable preset UI font, not a user's custom font",
	);
	const originalLabel = await read(`document.querySelector(${JSON.stringify(familySelector)}).textContent.trim()`);
	const opener = await read("window.__hipiGuiSettingsOpener.selector");
	assert.equal(
		await read(`(() => {
			const owner = document.querySelector('.conversation-panel');
			if (!owner || !document.querySelector('.settings-modal')) return false;
			window.__hipiGuiAppearanceOwner = { node: owner, draft: owner.querySelector('.composer textarea')?.value,
				keys: [...owner.querySelectorAll('[data-message-id]')].map(e => e.dataset.messageId) };
			return true;
		})()`),
		true,
		"Appearance acceptance requires the owned, retained conversation",
	);
	const continuity = async () => {
		assert.equal(
			await read(`(() => {
				const before = window.__hipiGuiAppearanceOwner, owner = document.querySelector('.conversation-panel');
				return before.node === owner && owner.isConnected && before.draft === owner.querySelector('.composer textarea')?.value &&
					JSON.stringify(before.keys) === JSON.stringify([...owner.querySelectorAll('[data-message-id]')].map(e => e.dataset.messageId));
			})()`),
			true,
			"Appearance Settings must retain exact conversation owner, draft and history",
		);
	};
	const screenshots = [];
	const captureState = async (name) => {
		await settled();
		const state = await snapshot();
		await capture(cdp, directory, `${prefix}-${name}`);
		screenshots.push(`${prefix}-${name}.png`);
		return state;
	};
	let failure;
	let result;
	try {
		await click(cdp, familySelector);
		const catalog = await until(async () => {
			const state = (await snapshot()).catalog;
			assert.notEqual(state.state, "error", `Native font enumeration failed: ${state.error}`);
			return state.state === "ready" && state.count > 0 ? state : null;
		}, "native picker automatically returns OS font families without an extra Load action");
		assert.ok(catalog.count <= 512, "Native catalog exceeds its bounded family count");
		const families = await options();
		assert.equal(families.length, catalog.count + 4, "Picker must expose each returned family after its four presets");
		const returned = families
			.slice(4)
			.filter((name) => families.filter((candidate) => candidate === name).length === 1);
		const family =
			["Arial", "Segoe UI", "DejaVu Sans", "Liberation Sans", "Noto Sans"].find((name) => returned.includes(name)) ??
			returned[0];
		assert.ok(family, "Native enumeration must provide an unambiguous selectable family");
		await captureState("font-families");
		await click(cdp, '[role="option"]', family);
		await until(
			async () => (await saved()).localFontFaces?.ui?.family === family,
			"returned font family persists immediately",
		);
		await click(cdp, styleSelector);
		const styles = await options();
		assert.ok(styles.length > 0 && styles.length <= 2048, "Returned family needs a bounded style list");
		const firstFace = (await saved()).localFontFaces.ui;
		const style =
			styles.find(
				(name) => name !== firstFace.style && styles.filter((candidate) => candidate === name).length === 1,
			) ?? firstFace.style;
		assert.equal(styles.filter((name) => name === style).length, 1, "Font style must be unambiguous");
		await captureState("font-styles");
		await click(cdp, '[role="option"]', style);
		const selected = await until(async () => {
			const face = (await saved()).localFontFaces?.ui;
			return face?.family === family && face.style === style ? face : null;
		}, "returned font style persists immediately");
		assert.ok(selected.fullName && selected.postscriptName, "Persist the actual returned face metadata");
		const alias = `Hipi local ${selected.postscriptName}`;
		await until(async () => {
			const state = await snapshot();
			return (
				state.uiFont.includes(`"${alias}"`) &&
				state.surfaces.route?.fontFamily.includes(alias) &&
				state.localFaces.some((face) => face.family === alias && face.status === "loaded")
			);
		}, "selected local face registers and applies, rather than silently falling back");
		const applied = await captureState("font-applied");
		await route.close(opener);
		await continuity();
		await captureState("font-workbench");
		await route.open(opener, "appearance");
		assert.deepEqual((await saved()).localFontFaces.ui, selected, "Returned face must persist across Settings reopen");
		assert.equal(await read(`document.querySelector(${JSON.stringify(styleSelector)}).textContent.trim()`), style);
		await click(cdp, familySelector);
		await until(
			async () => (await snapshot()).catalog.state === "ready",
			"native catalog remains available after modal reopen",
		);
		assert.ok((await options()).includes(family), "Reopened picker must retain its returned family");
		await pressKey(cdp, "Escape");
		let status = await hostStatus();
		const backdrop = { capability: status.backdrop, reducedTransparency: status.reducedTransparency, states: [] };
		const requests =
			status.backdrop === "unsupported" || status.reducedTransparency
				? [original.translucentSidebar]
				: [!original.translucentSidebar, original.translucentSidebar];
		for (const requested of requests) {
			if ((await saved()).translucentSidebar !== requested) await click(cdp, switchSelector);
			status = await waitBackdrop(requested);
			const state = await captureState(`backdrop-${status.backdropEnabled ? "on" : "off"}`);
			assertNativeBackdrop(state, status, requested);
			await route.close(opener);
			await continuity();
			const workbench = await captureState(`backdrop-${status.backdropEnabled ? "on" : "off"}-workbench`);
			for (const name of ["sidebar", "main"])
				assert.equal(
					workbench.surfaces[name]?.visibility,
					"visible",
					"Close must restore the retained workbench painting",
				);
			const tint = status.backdropEnabled ? Number.parseFloat(workbench.sidebarTint) / 100 : 1;
			assert.ok(
				Math.abs(backgroundAlpha(workbench.surfaces.sidebar?.background ?? "") - tint) <= 0.01,
				"Workbench sidebar must paint its confirmed tint or opaque fallback",
			);
			await route.open(opener, "appearance");
			assert.equal((await saved()).translucentSidebar, requested, "Backdrop preference survives modal reopen");
			backdrop.states.push({ requested, status, settings: state, workbench });
		}
		result = {
			font: {
				source: "production native picker → preload IPC → OS catalog",
				familyCount: catalog.count,
				selected,
				styleCount: styles.length,
				changedStyle: style !== firstFace.style,
				applied,
				modalReopenPersisted: true,
			},
			backdrop,
			screenshots,
			exactCloseFocusAndConversationContinuity: true,
			limits: [
				"Host confirmation and computed renderer transparency are not proof of OS compositor painting.",
				"Settled screenshots require visual review; native backdrop quality is not asserted.",
				"Catalog reuse is observed, not an IPC call-count assertion; cache ownership has separate unit coverage.",
				"Only this host's supported, unsupported or reduced-transparency branch runs; OS settings are never changed.",
			],
		};
	} catch (error) {
		failure = error;
	} finally {
		try {
			if (await read("!!document.querySelector('[role=\"option\"]')")) await pressKey(cdp, "Escape");
			if (!(await read("!!document.querySelector('.settings-modal')"))) await route.open(opener, "appearance");
			if ((await saved()).localFontFaces?.ui) await choose(familySelector, originalLabel);
			if ((await saved()).translucentSidebar !== original.translucentSidebar) await click(cdp, switchSelector);
			await until(
				async () => JSON.stringify(await saved()) === JSON.stringify(original),
				"complete original appearance restored through UI",
			);
			const restoredStatus = await waitBackdrop(original.translucentSidebar);
			await settled();
			assertNativeBackdrop(await snapshot(), restoredStatus, original.translucentSidebar);
			await route.close(opener);
			await continuity();
			await route.open(opener, "appearance");
			assert.deepEqual(await saved(), original, "Restored appearance must survive modal reopen");
			await read("delete window.__hipiGuiAppearanceOwner");
		} catch (restoreError) {
			failure = failure
				? new AggregateError([failure, restoreError], "Native appearance acceptance and restoration failed")
				: restoreError;
		}
	}
	if (failure) throw failure;
	return { ...result, originalPreferencesRestored: true };
}
