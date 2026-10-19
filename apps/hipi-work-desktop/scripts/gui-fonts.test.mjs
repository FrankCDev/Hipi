import assert from "node:assert/strict";
import test from "node:test";
import { renderedFonts } from "./gui-fonts.mjs";

const fixture = { workspace: "GUI 工作区", text: "真实桌面 中文流式验证" };
const bundled = { familyName: "Noto Sans SC", isCustomFont: true, glyphCount: 10 };
function renderer(fonts, visible = true) {
	const calls = [];
	return {
		calls,
		async request(method, params) {
			calls.push({ method, params });
			if (method === "Runtime.evaluate") {
				return { result: { value: params.awaitPromise ? true : visible } };
			}
			if (method === "DOM.getDocument") return { root: { nodeId: 1 } };
			if (method === "DOM.querySelector") return { nodeId: params.selector === ".project-name" ? 2 : 3 };
			if (method === "CSS.getPlatformFontsForNode") return { fonts };
			assert.ok(["DOM.enable", "CSS.enable"].includes(method), "No rendering or input overrides allowed");
			return {};
		},
	};
}

test("Chinese fixture evidence records actual node fonts and strips unrelated protocol fields", async () => {
	const cdp = renderer([{ ...bundled, postScriptName: "not exported", arbitrary: "not exported" }]);
	const result = await renderedFonts(cdp, fixture, "linux");
	assert.deepEqual(result, [
		{ target: "workspace", fonts: [bundled], bundled: true },
		{ target: "user-message", fonts: [bundled], bundled: true },
	]);
	assert.deepEqual(
		cdp.calls.filter((call) => call.method === "CSS.getPlatformFontsForNode").map((call) => call.params),
		[{ nodeId: 2 }, { nodeId: 3 }],
	);
});

test("Linux rejects missing or unused custom CJK fonts while other hosts keep system priority", async () => {
	const system = { familyName: "PingFang SC", isCustomFont: false, glyphCount: 10 };
	for (const font of [system, { ...bundled, isCustomFont: false }, { ...bundled, glyphCount: 0 }]) {
		await assert.rejects(renderedFonts(renderer([font]), fixture, "linux"), /glyph/);
	}
	for (const platform of ["darwin", "win32"]) {
		const result = await renderedFonts(renderer([system]), fixture, platform);
		assert.equal(result[1].bundled, false);
		assert.deepEqual(result[1].fonts, [system]);
	}
	await assert.rejects(renderedFonts(renderer([bundled], false), fixture, "linux"), /exact visible fixture/);
	await assert.rejects(renderedFonts(renderer([]), fixture, "darwin"), /Missing rendered font/);
});

test("only the reviewed CSS alias and exact variable-font name-table families are accepted", async () => {
	for (const familyName of ["Hipi Noto Sans SC", "Noto Sans SC", "Noto Sans SC Thin"]) {
		const result = await renderedFonts(renderer([{ ...bundled, familyName }]), fixture, "linux");
		assert.equal(result[1].bundled, true);
	}
	for (const familyName of ["Noto Sans", "Noto Sans SC Unknown", "Other Noto Sans SC", "NotoSansSC-Thin"]) {
		await assert.rejects(renderedFonts(renderer([{ ...bundled, familyName }]), fixture, "linux"), /bundled CJK/);
	}
});
