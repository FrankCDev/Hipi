import assert from "node:assert/strict";

export function readFontLayout(document, getComputedStyle, performance, selector) {
	const style = (query) => {
		const element = document.querySelector(query);
		if (!element) return { present: false };
		const value = getComputedStyle(element);
		return {
			present: true,
			fontFamily: value.fontFamily.slice(0, 256),
			fontWeight: value.fontWeight.slice(0, 32),
			fontSynthesis: value.fontSynthesis.slice(0, 64),
			fontFeatureSettings: value.fontFeatureSettings.slice(0, 128),
		};
	};
	return {
		...style(selector),
		fontSetStatus: document.fonts.status,
		faces: [...document.fonts]
			.filter((face) => face.family.replaceAll('"', "").replaceAll("'", "") === "Hipi Noto Sans SC")
			.slice(0, 4)
			.map((face) => ({
				family: "Hipi Noto Sans SC",
				status: face.status,
				weight: face.weight.slice(0, 32),
				unicodeRange: face.unicodeRange.slice(0, 128),
			})),
		comparison: { toolbar: style(".toolbar-conversation"), sidebar: style(".conversation-link") },
		resource: performance
			.getEntriesByType("resource")
			.filter((entry) => entry.name === "hipi-work://app/assets/hipi-noto-sc-aef8c342.woff2")
			.slice(-4)
			.map((entry) => ({
				transferSize: entry.transferSize,
				encodedBodySize: entry.encodedBodySize,
				decodedBodySize: entry.decodedBodySize,
				responseStatus: entry.responseStatus ?? null,
			})),
	};
}

/** Inspect actual rendered fixture text, without overriding fonts or reading user preferences. */
export async function renderedFonts(cdp, fixture, platform = process.platform, observations = []) {
	await cdp.request("DOM.enable");
	await cdp.request("CSS.enable");
	const initialLayout = (
		await cdp.request("Runtime.evaluate", {
			expression: `(${readFontLayout.toString()})(document,getComputedStyle,performance,'.project-name')`,
			returnByValue: true,
		})
	).result?.value;
	const ready = await cdp.request("Runtime.evaluate", {
		expression: "document.fonts.ready.then(() => true)",
		awaitPromise: true,
		returnByValue: true,
	});
	assert.equal(ready.result?.value, true, "Renderer fonts did not settle");
	const { root } = await cdp.request("DOM.getDocument", { depth: 0 });
	const result = [];
	const missingBundled = [];
	for (const [target, selector, text] of [
		["workspace", ".project-name", fixture.workspace],
		["user-message", ".message-user .message-text", fixture.text],
		["conversation-title", ".toolbar-conversation", fixture.conversation],
	]) {
		const observation = { target, initialLayout };
		observations.push(observation);
		const metadata = await cdp.request("Runtime.evaluate", {
			expression: `(${readFontLayout.toString()})(document,getComputedStyle,performance,${JSON.stringify(selector)})`,
			returnByValue: true,
		});
		observation.layout = metadata.result?.value;
		const checked = await cdp.request("Runtime.evaluate", {
			expression: `(() => { const e=document.querySelector(${JSON.stringify(selector)}); if(!e || e.textContent!==${JSON.stringify(text)})return false; const r=e.getBoundingClientRect(); return r.width>0 && r.height>0 && r.bottom>0 && r.right>0 && r.top<innerHeight && r.left<innerWidth; })()`,
			returnByValue: true,
		});
		assert.equal(checked.result?.value, true, "Chinese font target must display the exact visible fixture");
		observation.afterBounds = (
			await cdp.request("Runtime.evaluate", {
				expression: `(${readFontLayout.toString()})(document,getComputedStyle,performance,${JSON.stringify(selector)})`,
				returnByValue: true,
			})
		).result?.value;
		const { nodeId } = await cdp.request("DOM.querySelector", { nodeId: root.nodeId, selector });
		assert.ok(nodeId > 0, "Chinese font target missing from renderer DOM");
		const { fonts } = await cdp.request("CSS.getPlatformFontsForNode", { nodeId });
		assert.ok(Array.isArray(fonts) && fonts.length <= 16, "Missing rendered font evidence");
		const used = fonts.map(({ familyName, isCustomFont, glyphCount }) => {
			assert.ok(typeof familyName === "string" && familyName.length <= 128, "Invalid rendered font family");
			assert.equal(typeof isCustomFont, "boolean", "Invalid rendered font origin");
			assert.ok(Number.isSafeInteger(glyphCount) && glyphCount >= 0, "Invalid rendered glyph count");
			return { familyName, isCustomFont, glyphCount };
		});
		observation.fonts = used;
		assert.ok(used.length > 0, "Missing rendered font evidence");
		assert.ok(
			used.some((font) => font.glyphCount > 0),
			"Chinese fixture has no rendered glyphs",
		);
		// Exact CSS alias and reviewed font name-table families (IDs 1 and 16).
		const bundled = used.some(
			(font) =>
				font.isCustomFont &&
				["Hipi Noto Sans SC", "Noto Sans SC", "Noto Sans SC Thin"].includes(font.familyName) &&
				font.glyphCount > 0,
		);
		observation.bundled = bundled;
		if (platform === "linux" && target !== "conversation-title" && !bundled) missingBundled.push(target);
		result.push({ target, fonts: used, bundled });
	}
	assert.equal(
		missingBundled.length,
		0,
		`Linux Chinese fixture must render bundled CJK glyphs: ${missingBundled.join(", ")}`,
	);
	return result;
}
