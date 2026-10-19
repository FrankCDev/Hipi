import assert from "node:assert/strict";

/** Inspect actual rendered fixture text, without overriding fonts or reading user preferences. */
export async function renderedFonts(cdp, fixture, platform = process.platform) {
	await cdp.request("DOM.enable");
	await cdp.request("CSS.enable");
	const ready = await cdp.request("Runtime.evaluate", {
		expression: "document.fonts.ready.then(() => true)",
		awaitPromise: true,
		returnByValue: true,
	});
	assert.equal(ready.result?.value, true, "Renderer fonts did not settle");
	const { root } = await cdp.request("DOM.getDocument", { depth: 0 });
	const result = [];
	for (const [target, selector, text] of [
		["workspace", ".project-name", fixture.workspace],
		["user-message", ".message-user .message-text", fixture.text],
	]) {
		const checked = await cdp.request("Runtime.evaluate", {
			expression: `(() => { const e=document.querySelector(${JSON.stringify(selector)}); if(!e || e.textContent!==${JSON.stringify(text)})return false; const r=e.getBoundingClientRect(); return r.width>0 && r.height>0 && r.bottom>0 && r.right>0 && r.top<innerHeight && r.left<innerWidth; })()`,
			returnByValue: true,
		});
		assert.equal(checked.result?.value, true, "Chinese font target must display the exact visible fixture");
		const { nodeId } = await cdp.request("DOM.querySelector", { nodeId: root.nodeId, selector });
		assert.ok(nodeId > 0, "Chinese font target missing from renderer DOM");
		const { fonts } = await cdp.request("CSS.getPlatformFontsForNode", { nodeId });
		assert.ok(Array.isArray(fonts) && fonts.length > 0 && fonts.length <= 16, "Missing rendered font evidence");
		const used = fonts.map(({ familyName, isCustomFont, glyphCount }) => {
			assert.ok(typeof familyName === "string" && familyName.length <= 128, "Invalid rendered font family");
			assert.equal(typeof isCustomFont, "boolean", "Invalid rendered font origin");
			assert.ok(Number.isSafeInteger(glyphCount) && glyphCount >= 0, "Invalid rendered glyph count");
			return { familyName, isCustomFont, glyphCount };
		});
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
		if (platform === "linux") assert.ok(bundled, "Linux Chinese fixture must render bundled CJK glyphs");
		result.push({ target, fonts: used, bundled });
	}
	return result;
}
