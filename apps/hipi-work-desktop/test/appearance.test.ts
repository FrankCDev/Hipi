import assert from "node:assert/strict";
import { test } from "node:test";
import {
	AppearanceError,
	type AppearanceThemeMode,
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
		{ version: 1, method: "theme", mode: "auto" },
		{ version: 1, method: "theme", mode: null },
		{ version: 1, method: "theme", mode: "dark", global: true },
		{ version: 1, method: "theme", mode: "system", background: "#ffffff" },
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
		{ themeSource: "system" },
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
		{ themeSource: "system" },
	);
	assert.throws(
		() => service.request({ version: 1, method: "backdrop", enabled: true, background: "#ffffff" }),
		(error) => error instanceof AppearanceError && error.code === "UNSUPPORTED",
	);
	assert.equal(calls, 0);
});
test("light/dark/system apply to native chrome independently of backdrop, without duplicate writes or OS changes", () => {
	for (const [platform, release] of [
		["darwin", "24.1.0"],
		["win32", "10.0.19045"],
		["linux", "6.8.0"],
	]) {
		let mode: AppearanceThemeMode = "system";
		let writes = 0;
		let paints = 0;
		let events = 0;
		const theme = {
			get themeSource() {
				return mode;
			},
			set themeSource(value: AppearanceThemeMode) {
				mode = value;
				writes++;
				// Like Electron, the setter emits an update synchronously. Refresh
				// may repaint material but must not assign themeSource recursively.
				events++;
				service.refresh();
			},
		};
		const service = new WindowAppearanceService(
			{
				isDestroyed: () => false,
				setVibrancy() {},
				setBackgroundMaterial() {},
				setBackgroundColor() {
					paints++;
				},
			},
			platform,
			release,
			() => true,
			theme,
		);
		for (const selected of ["light", "dark", "system"] as const) {
			const request = decodeAppearanceRequest(JSON.stringify({ version: 1, method: "theme", mode: selected }));
			const status = service.request(request);
			assert.equal(status.themeMode, selected);
			assert.equal(status.reducedTransparency, true);
			assert.equal(status.backdropEnabled, false);
			assert.equal(parseAppearanceStatus(status).themeMode, selected);
			service.request(request);
		}
		assert.equal(writes, 3);
		assert.equal(events, 3);
		assert.equal(paints, 3, "Only native notifications repaint; theme requests do not mutate window material");
		assert.equal(mode, "system", "Returning to system removes the app override rather than resolving an OS color");
		service.refresh();
		assert.equal(writes, 3, "OS updates cannot turn system into an explicit color");
	}
});
test("renderer material reset retains the selected app theme, and closed windows cannot change it", () => {
	let destroyed = false;
	const theme = { themeSource: "system" as AppearanceThemeMode };
	const service = new WindowAppearanceService(
		{
			isDestroyed: () => destroyed,
			setVibrancy() {},
			setBackgroundMaterial() {},
			setBackgroundColor() {},
		},
		"darwin",
		"24.1.0",
		() => false,
		theme,
	);
	service.request({ version: 1, method: "theme", mode: "light" });
	service.reset();
	assert.equal(theme.themeSource, "light");
	destroyed = true;
	assert.throws(
		() => service.request({ version: 1, method: "theme", mode: "dark" }),
		(error) => error instanceof AppearanceError && error.code === "CLOSED",
	);
	assert.equal(theme.themeSource, "light");
});
test("failed native theme assignment reports failure without pretending to apply the preference", () => {
	const service = new WindowAppearanceService(
		{
			isDestroyed: () => false,
			setVibrancy() {},
			setBackgroundMaterial() {},
			setBackgroundColor() {},
		},
		"linux",
		"6.8.0",
		() => false,
		{
			get themeSource(): AppearanceThemeMode {
				return "system";
			},
			set themeSource(_value: AppearanceThemeMode) {
				throw new Error("native failure details must not cross IPC");
			},
		},
	);
	assert.throws(
		() => service.request({ version: 1, method: "theme", mode: "dark" }),
		(error) => error instanceof AppearanceError && error.code === "FAILED",
	);
	assert.equal(service.status().themeMode, "system");
});
test("font IPC trust requires the exact owned main frame and application origin", () => {
	const owner = { mainFrame: { url: "hipi-work://app/index.html" } };
	assert.equal(trustedSender({ sender: {}, senderFrame: owner.mainFrame }, owner, owner.mainFrame.url), false);
	assert.equal(trustedSender({ sender: owner, senderFrame: {} }, owner, owner.mainFrame.url), false);
	assert.equal(trustedSender({ sender: owner, senderFrame: owner.mainFrame }, owner, "https://foreign.example"), false);
});
