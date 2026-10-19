import assert from "node:assert/strict";
import test from "node:test";
import { readFontLayout, renderedFonts } from "./gui-fonts.mjs";

const fixture = { workspace: "GUI 工作区", text: "真实桌面 中文流式验证", conversation: "GUI 会话" };
const bundled = { familyName: "Noto Sans SC", isCustomFont: true, glyphCount: 10 };
function renderer(fonts, visible = true) {
	const calls = [];
	return {
		calls,
		async request(method, params) {
			calls.push({ method, params });
			if (method === "Runtime.evaluate") {
				if (params.expression.includes("fontSetStatus"))
					return {
						result: {
							value: {
								present: true,
								fontFamily: 'Arial, "Hipi Noto Sans SC"',
								fontWeight: "400",
								fontSetStatus: "loaded",
								faces: [{ family: "Hipi Noto Sans SC", status: "unloaded", weight: "100 900" }],
							},
						},
					};
				return { result: { value: params.awaitPromise ? true : visible } };
			}
			if (method === "DOM.getDocument") return { root: { nodeId: 1 } };
			if (method === "DOM.querySelector")
				return {
					nodeId: params.selector === ".project-name" ? 2 : params.selector === ".toolbar-conversation" ? 4 : 3,
				};
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
		{ target: "conversation-title", fonts: [bundled], bundled: true },
	]);
	assert.deepEqual(
		cdp.calls.filter((call) => call.method === "CSS.getPlatformFontsForNode").map((call) => call.params),
		[{ nodeId: 2 }, { nodeId: 3 }, { nodeId: 4 }],
	);
});

test("a failed target retains observed font and fixed layout diagnostics before throwing", async () => {
	const observations = [];
	const system = { familyName: "Arial", isCustomFont: false, glyphCount: 4 };
	await assert.rejects(renderedFonts(renderer([system]), fixture, "linux", observations), /glyphs: workspace/);
	assert.equal(observations.length, 3);
	assert.equal(observations[0].target, "workspace");
	assert.equal(observations[0].layout.fontWeight, "400");
	assert.equal(observations[0].layout.faces[0].status, "unloaded");
	assert.deepEqual(observations[0].fonts, [system]);
	assert.equal(observations[0].bundled, false);
	assert.equal(observations[1].target, "user-message");
	assert.equal(observations[0].afterBounds.fontSetStatus, "loaded");
});

test("font diagnostics read fixed style controls and only the shipped resource without raw text or URLs", () => {
	const faces = [
		{ family: '"Hipi Noto Sans SC"', status: "loaded", weight: "100 900", unicodeRange: "U+0-10FFFF" },
		{ family: "private face", status: "loaded" },
	];
	faces.status = "loaded";
	const queried = [];
	const value = readFontLayout(
		{
			fonts: faces,
			querySelector: (selector) => {
				queried.push(selector);
				return { textContent: "secret text" };
			},
		},
		() => ({ fontFamily: "Arial", fontWeight: "400", fontSynthesis: "weight style", fontFeatureSettings: "normal" }),
		{
			getEntriesByType: () => [
				{ name: "https://secret.invalid/private", transferSize: 123 },
				{
					name: "hipi-work://app/assets/hipi-noto-sc-aef8c342.woff2",
					transferSize: 456,
					encodedBodySize: 456,
					decodedBodySize: 456,
					responseStatus: 200,
				},
			],
		},
		".project-name",
	);
	assert.deepEqual(queried, [".project-name", ".toolbar-conversation", ".conversation-link"]);
	assert.equal(value.faces.length, 1);
	assert.equal(value.resource.length, 1);
	assert.equal(value.resource[0].responseStatus, 200);
	assert.ok(!JSON.stringify(value).includes("secret"));
	assert.ok(!JSON.stringify(value).includes("hipi-work://"));
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
