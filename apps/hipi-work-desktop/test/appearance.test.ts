import assert from "node:assert/strict";
import { test } from "node:test";
import {
	AppearanceError,
	parseAppearanceReply,
	parseAppearanceRequest,
	parseAppearanceStatus,
	parseInstalledFontFace,
} from "@hipi/work-runtime/appearance";
import { decodeAppearanceRequest } from "../src/appearance-protocol.ts";
import { backdropSupport, WindowAppearanceService } from "../src/appearance-service.ts";
import { trustedSender } from "../src/sender.ts";

test("appearance IPC rejects extra capabilities, oversized payloads and malformed font/CSS metadata", () => {
	for (const input of [
		{ version: 1, method: "status", path: "/etc" },
		{ version: 2, method: "status" },
		{ version: 1, method: "backdrop", enabled: true, background: "url(https://invalid)" },
		{ version: 1, method: "backdrop", enabled: "true", background: "#ffffff" },
		{ version: 1, method: "fonts" },
	])
		assert.throws(() => parseAppearanceRequest(input), AppearanceError);
	assert.throws(() => decodeAppearanceRequest(" ".repeat(513)), AppearanceError);
	assert.throws(() => decodeAppearanceRequest("{"), AppearanceError);
	assert.deepEqual(decodeAppearanceRequest('{"version":1,"method":"status"}'), { version: 1, method: "status" });
	const face = {
		family: "思源黑体",
		fullName: "思源黑体 Regular",
		postscriptName: "SourceHanSans-Regular",
		style: "Regular",
	};
	assert.deepEqual(parseInstalledFontFace(face), face);
	for (const name of ["x".repeat(129), "Arial\nbad", 'Arial"),url(https://bad)', "\\23"]) {
		assert.throws(() => parseInstalledFontFace({ ...face, postscriptName: name }), AppearanceError);
	}
	assert.throws(() => parseAppearanceReply({ ok: false, error: "secret native path" }), AppearanceError);
	assert.throws(() => parseAppearanceStatus({ version: 1, platform: "macos" }), AppearanceError);
});
test("native support is limited to actual OS APIs, not a fake Linux opacity switch", () => {
	assert.equal(backdropSupport("darwin", "24.1.0"), "vibrancy");
	assert.equal(backdropSupport("linux", "6.8.0"), "unsupported");
	assert.equal(backdropSupport("win32", "10.0.19045"), "unsupported");
	assert.equal(backdropSupport("win32", "10.0.22000"), "unsupported");
	assert.equal(backdropSupport("win32", "10.0.22621"), "mica");
	assert.equal(backdropSupport("win32", "invalid"), "unsupported");
});
test("window material respects reduced transparency, refreshes on OS changes and resets on renderer loss", () => {
	const calls: unknown[] = [];
	let reduced = false;
	let destroyed = false;
	const service = new WindowAppearanceService(
		{
			isDestroyed: () => destroyed,
			setVibrancy: (value) => calls.push(["vibrancy", value]),
			setBackgroundMaterial: (value) => calls.push(["material", value]),
			setBackgroundColor: (value) => calls.push(["background", value]),
		},
		"darwin",
		"24.1.0",
		() => reduced,
	);
	assert.equal(
		service.request({ version: 1, method: "backdrop", enabled: true, background: "#181818" }).backdropEnabled,
		true,
	);
	assert.deepEqual(calls, [
		["vibrancy", "sidebar"],
		["background", "#00000000"],
	]);
	reduced = true;
	assert.equal(service.refresh().backdropEnabled, false);
	assert.deepEqual(calls.slice(-2), [
		["vibrancy", null],
		["background", "#181818"],
	]);
	reduced = false;
	assert.equal(service.refresh().backdropEnabled, true);
	service.reset();
	assert.equal(service.status().backdropEnabled, false);
	destroyed = true;
	assert.throws(
		() => service.status(),
		(error) => error instanceof AppearanceError && error.code === "CLOSED",
	);
});
test("unsupported native toggle refuses before changing any OS state", () => {
	let calls = 0;
	const service = new WindowAppearanceService(
		{
			isDestroyed: () => false,
			setVibrancy: () => {
				calls++;
			},
			setBackgroundMaterial: () => {
				calls++;
			},
			setBackgroundColor: () => {
				calls++;
			},
		},
		"linux",
		"6.8.0",
		() => false,
	);
	assert.throws(
		() => service.request({ version: 1, method: "backdrop", enabled: true, background: "#ffffff" }),
		(error) => error instanceof AppearanceError && error.code === "UNSUPPORTED",
	);
	assert.equal(calls, 0);
});
test("font IPC trust requires the exact owned main frame and application origin", () => {
	const owner = { mainFrame: { url: "hipi-work://app/index.html" } };
	assert.equal(trustedSender({ sender: {}, senderFrame: owner.mainFrame }, owner, owner.mainFrame.url), false);
	assert.equal(trustedSender({ sender: owner, senderFrame: {} }, owner, owner.mainFrame.url), false);
	assert.equal(trustedSender({ sender: owner, senderFrame: owner.mainFrame }, owner, "https://foreign.example"), false);
});
