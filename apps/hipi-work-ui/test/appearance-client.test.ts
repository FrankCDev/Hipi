import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { type AppearanceClient, AppearanceError, type InstalledFontCatalog } from "@hipi/work-runtime/appearance";
import { afterEach, test, vi } from "vitest";
import {
	buildFontCatalog,
	createAppearanceClient,
	waitForAppearance,
	webAppearance,
} from "../src/app/appearance-client.ts";
import { themeVariables } from "../src/app/theme/application.ts";
import { nativeSidebarTints } from "../src/app/theme/backdrop-tint.ts";
import {
	contrastRatio,
	defaultConfig,
	exportAppearanceShare,
	parseAppearanceShare,
	validateConfig,
} from "../src/app/theme/config.ts";
import { applyLocalFontFaces } from "../src/app/theme/local-font-faces.ts";
import { nativeFontCatalog } from "../src/features/settings/font-catalog-query.ts";
import { settingsSearchEntries } from "../src/features/settings/settings-search.ts";

const face = {
	family: "Example Mono",
	fullName: "Example Mono Bold",
	postscriptName: "ExampleMono-Bold",
	style: "Bold",
};
afterEach(() => {
	vi.unstubAllGlobals();
	vi.useRealTimers();
});
test("font list is sanitized, deduplicated, grouped by family and bounded without exposing binary data", () => {
	const raw = [
		face,
		face,
		{ ...face, style: "Regular", postscriptName: "ExampleMono-Regular" },
		{ ...face, family: "Example Sans", postscriptName: "Sans", blob: "never retained" },
		{ ...face, family: 'unsafe";color:red' },
	];
	const catalog = buildFontCatalog(raw);
	assert.equal(catalog.families.length, 2);
	assert.equal(catalog.families[0]?.faces.length, 2);
	assert.equal(catalog.families[0]?.faces[0]?.style, "Regular");
	assert.equal(catalog.families[0]?.monospace, null);
	assert.equal(catalog.families[1]?.monospace, null);
	assert.doesNotMatch(JSON.stringify(catalog), /blob|never retained|unsafe/);
	const large = buildFontCatalog(
		Array.from({ length: 3000 }, (_, index) => ({
			...face,
			family: `Font ${index}`,
			postscriptName: `Font${index}`,
		})),
	);
	assert.equal(large.families.length, 512);
	assert.equal(large.truncated, true);
});
test("native construction/status never enumerate; native queries need no gesture while browser queries do", async () => {
	let queries = 0;
	let nativeQueries = 0;
	vi.stubGlobal("window", {
		queryLocalFonts: async () => {
			queries++;
			return [];
		},
	});
	vi.stubGlobal("navigator", { userActivation: { isActive: false } });
	const client = createAppearanceClient({
		request: async () => ({ ok: true, result: webAppearance }),
		fontsSupported: true,
		listFonts: async () => {
			nativeQueries++;
			return { ok: true, result: { families: [], truncated: false } };
		},
		cancelFonts: () => {},
		subscribe: () => () => {},
	});
	await client.status();
	assert.equal(queries, 0);
	assert.equal(nativeQueries, 0);
	await client.listFonts();
	assert.equal(nativeQueries, 1);
	await assert.rejects(
		createAppearanceClient().listFonts(),
		(error) => error instanceof AppearanceError && error.code === "DENIED",
	);
	assert.equal(queries, 0);
});

function queryClient(listFonts: AppearanceClient["listFonts"]): AppearanceClient {
	return {
		localFontsSupported: true,
		status: async () => webAppearance,
		setThemeMode: async () => webAppearance,
		setBackdrop: async () => webAppearance,
		subscribe: () => () => {},
		listFonts,
	};
}
async function flushCatalog() {
	for (let index = 0; index < 6; index++) await Promise.resolve();
}
test("native lazy queries share only exact client/platform identities and cache successful results across owners", async () => {
	let calls = 0;
	const catalog = buildFontCatalog([face]);
	const client = queryClient(async () => {
		calls++;
		return catalog;
	});
	assert.equal(nativeFontCatalog(client, "web"), undefined);
	assert.equal(nativeFontCatalog(client, undefined), undefined);
	assert.equal(nativeFontCatalog({ ...client, localFontsSupported: false }, "linux"), undefined);
	const query = nativeFontCatalog(client, "linux");
	assert.ok(query);
	assert.equal(nativeFontCatalog(client, "linux"), query);
	assert.notEqual(nativeFontCatalog(client, "macos"), query);
	assert.notEqual(nativeFontCatalog({ ...client }, "linux"), query);
	assert.equal(calls, 0);
	const stop = query.subscribe(() => {});
	assert.equal(query.snapshot().status, "pending");
	await flushCatalog();
	assert.deepEqual(query.snapshot(), { status: "ready", catalog });
	stop();
	await flushCatalog();
	const second = query.subscribe(() => {});
	await flushCatalog();
	assert.equal(calls, 1);
	second();
});
test("native theme requests retain original modes on hosts without backdrop support", async () => {
	const calls: unknown[] = [];
	const client = createAppearanceClient({
		request: async (input) => {
			calls.push(input);
			return { ok: true, result: { ...webAppearance, platform: "linux", themeMode: "system" } };
		},
		fontsSupported: false,
		listFonts: async () => {
			throw new Error("unrelated capability");
		},
		cancelFonts() {},
		subscribe: () => () => {},
	});
	for (const mode of ["light", "dark", "system"] as const) await client.setThemeMode(mode);
	assert.deepEqual(calls, [
		{ version: 1, method: "theme", mode: "light" },
		{ version: 1, method: "theme", mode: "dark" },
		{ version: 1, method: "theme", mode: "system" },
	]);
	const controller = new AbortController();
	controller.abort();
	await assert.rejects(
		client.setThemeMode("dark", controller.signal),
		(error) => error instanceof AppearanceError && error.code === "CLOSED",
	);
	await assert.rejects(
		Reflect.apply(client.setThemeMode, client, ["auto"]),
		(error) => error instanceof AppearanceError && error.code === "INVALID",
	);
	assert.equal(calls.length, 3);
});
test("web theme choice is a renderer preference, not a claimed native chrome capability", async () => {
	vi.stubGlobal("window", {});
	const client = createAppearanceClient();
	for (const mode of ["light", "dark", "system"] as const) {
		assert.equal((await client.setThemeMode(mode)).themeMode, null);
	}
});
test("StrictMode cleanup/setup retains one query; final release aborts and fences late results without automatic retry", async () => {
	let calls = 0;
	let signal: AbortSignal | undefined;
	let finish: (value: InstalledFontCatalog) => void = () => {};
	const client = queryClient((active) => {
		calls++;
		signal = active;
		return new Promise((resolve) => {
			finish = resolve;
		});
	});
	const query = nativeFontCatalog(client, "linux");
	assert.ok(query);
	const first = query.subscribe(() => {});
	first();
	const second = query.subscribe(() => {});
	await flushCatalog();
	assert.equal(calls, 1);
	assert.equal(signal?.aborted, false);
	second();
	await flushCatalog();
	assert.equal(signal?.aborted, true);
	assert.deepEqual(query.snapshot(), { status: "error", error: "CLOSED" });
	finish(buildFontCatalog([face]));
	await flushCatalog();
	assert.deepEqual(query.snapshot(), { status: "error", error: "CLOSED" });
	const third = query.subscribe(() => {});
	await flushCatalog();
	assert.equal(calls, 1);
	query.retry();
	await flushCatalog();
	assert.equal(calls, 2);
	finish(buildFontCatalog([]));
	await flushCatalog();
	assert.equal(query.snapshot().status, "ready");
	third();
});
test("native denied/failed queries remain explicit errors until a single manual retry, with no reopen loop", async () => {
	let calls = 0;
	const client = queryClient(async () => {
		calls++;
		if (calls === 1) throw new AppearanceError("DENIED");
		throw new Error("device unavailable");
	});
	const query = nativeFontCatalog(client, "windows");
	assert.ok(query);
	const stop = query.subscribe(() => {});
	await flushCatalog();
	assert.deepEqual(query.snapshot(), { status: "error", error: "DENIED" });
	stop();
	const next = query.subscribe(() => {});
	await flushCatalog();
	assert.equal(calls, 1);
	query.retry();
	query.retry();
	await flushCatalog();
	assert.equal(calls, 2);
	assert.deepEqual(query.snapshot(), { status: "error", error: "FAILED" });
	next();
});
test("font denial is explicit; native request admission stays bounded after caller cancellation", async () => {
	let finish: (value: unknown) => void = () => {};
	let queries = 0;
	let cancellations = 0;
	let browserQueries = 0;
	vi.stubGlobal("window", {
		queryLocalFonts: async () => {
			browserQueries++;
			return [];
		},
	});
	vi.stubGlobal("navigator", { userActivation: { isActive: true } });
	const client = createAppearanceClient({
		request: async () => ({ ok: true, result: webAppearance }),
		fontsSupported: true,
		listFonts: () => {
			queries++;
			return new Promise<unknown>((resolve) => {
				finish = resolve;
			});
		},
		cancelFonts: () => {
			cancellations++;
		},
		subscribe: () => () => {},
	});
	const controller = new AbortController();
	const pending = client.listFonts(controller.signal);
	controller.abort();
	await assert.rejects(pending, (error) => error instanceof AppearanceError && error.code === "CLOSED");
	assert.equal(cancellations, 1);
	await assert.rejects(client.listFonts(), (error) => error instanceof AppearanceError && error.code === "BUSY");
	assert.equal(queries, 1);
	finish({ ok: true, result: { families: [], truncated: false } });
	await Promise.resolve();
	const denied = client.listFonts();
	finish({ ok: false, error: "DENIED" });
	await assert.rejects(denied, (error) => error instanceof AppearanceError && error.code === "DENIED");
	assert.equal(browserQueries, 0);
});
test("browser local font permission is explicit and never inferred from native availability", async () => {
	vi.stubGlobal("navigator", { userActivation: { isActive: true } });
	vi.stubGlobal("window", { queryLocalFonts: async () => [face] });
	const client = createAppearanceClient();
	assert.equal((await client.listFonts()).families[0]?.monospace, null);
	vi.stubGlobal("window", {
		queryLocalFonts: async () => {
			throw new DOMException("blocked", "NotAllowedError");
		},
	});
	await assert.rejects(client.listFonts(), (error) => error instanceof AppearanceError && error.code === "DENIED");
});
test("search exposes native-only controls only when the active host reports their capabilities", () => {
	const entries = settingsSearchEntries(defaultConfig());
	assert.equal(
		entries.some((entry) => entry.id === "translucentSidebar"),
		false,
	);
	assert.equal(
		entries.some((entry) => entry.id === "fontSmoothing"),
		false,
	);
	assert.equal(
		entries.some((entry) => entry.id === "codeTheme"),
		true,
	);
	const native = settingsSearchEntries(defaultConfig(), undefined, {
		...webAppearance,
		platform: "macos",
		backdrop: "vibrancy",
		fontSmoothing: true,
	});
	assert.equal(
		native.some((entry) => entry.id === "translucentSidebar"),
		true,
	);
	assert.equal(
		native.some((entry) => entry.id === "fontSmoothing"),
		true,
	);
});
test("browser absence, failed metadata and synchronous API failures remain recoverable", async () => {
	vi.stubGlobal("window", {});
	const unsupported = createAppearanceClient();
	assert.equal(unsupported.localFontsSupported, false);
	assert.deepEqual(await unsupported.status(), webAppearance);
	await assert.rejects(unsupported.setBackdrop(true, "#ffffff"), AppearanceError);
	await assert.rejects(unsupported.listFonts(), AppearanceError);
	vi.stubGlobal("navigator", { userActivation: { isActive: true } });
	vi.stubGlobal("window", {
		queryLocalFonts: () => {
			throw new Error("API unavailable");
		},
	});
	const client = createAppearanceClient();
	for (let index = 0; index < 2; index++)
		await assert.rejects(client.listFonts(), (error) => error instanceof AppearanceError && error.code === "FAILED");
});
test("abort and timeout release waiting listeners and ignore late completion without retrying side effects", async () => {
	vi.useFakeTimers();
	let complete: (value: string) => void = () => {};
	const source = new Promise<string>((resolve) => {
		complete = resolve;
	});
	const pending = waitForAppearance(source, undefined, 10);
	const rejection = assert.rejects(pending, AppearanceError);
	await vi.advanceTimersByTimeAsync(11);
	await rejection;
	complete("late");
	await Promise.resolve();
	assert.equal(vi.getTimerCount(), 0);
});
test("selected native faces survive validated share strings and override only their intended regions", () => {
	const config = {
		...defaultConfig(),
		localFontFaces: { ui: face },
		translucentSidebar: true,
		codeTheme: "solarized" as const,
	};
	assert.deepEqual(parseAppearanceShare(exportAppearanceShare(config)), { ok: true, value: config });
	assert.match(themeVariables(config)["--font-ui"] ?? "", /Hipi local ExampleMono-Bold/);
	assert.doesNotMatch(themeVariables(config)["--font-code"] ?? "", /ExampleMono/);
	for (const patch of [
		{ localFontFaces: { ui: { ...face, postscriptName: 'evil");url(x)' } } },
		{ localFontFaces: { unknown: face } },
		{ translucentSidebar: "yes" },
		{ fontSmoothing: "execute" },
		{ codeTheme: "https://remote/theme" },
	])
		assert.equal(validateConfig({ ...defaultConfig(), ...patch }).ok, false);
});
test("local font registration is bounded, cleaned up, and late loads cannot outlive their owner", async () => {
	const added: unknown[] = [];
	const removed: unknown[] = [];
	const completions: (() => void)[] = [];
	class FakeFontFace {
		load() {
			return new Promise<FakeFontFace>((resolve) => completions.push(() => resolve(this)));
		}
	}
	vi.stubGlobal("FontFace", FakeFontFace);
	vi.stubGlobal("document", {
		fonts: { add: (value: unknown) => added.push(value), delete: (value: unknown) => removed.push(value) },
	});
	const cleanup = applyLocalFontFaces({ ui: face, code: face });
	completions[0]?.();
	await Promise.resolve();
	assert.equal(added.length, 1);
	cleanup();
	completions[1]?.();
	await Promise.resolve();
	assert.equal(added.length, 1);
	assert.equal(removed.length, 1);
});
test("native sidebar paint preserves app visibility beneath opaque settings and default/custom contrast", () => {
	const css = readFileSync(new URL("../src/app/theme/native-appearance.css", import.meta.url), "utf8");
	assert.match(css, /:root\[data-native-backdrop="on"\] body,[\s\S]*?#root\s*\{\s*background: transparent/);
	assert.doesNotMatch(css, /settings-route|settings-page-sidebar|data-settings-open|visibility:\s*hidden/);
	const settings = readFileSync(new URL("../src/features/settings/settings-page.css", import.meta.url), "utf8");
	assert.match(settings, /\.settings-modal\[data-slot="dialog-content"\]\s*\{[^}]*background: var\(--surface\)/);
	assert.match(settings, /\.settings-page-sidebar\s*\{[^}]*background: var\(--sidebar\)/);
	assert.doesNotMatch(css, /display:\s*none|opacity:\s*0/);
	assert.match(css, /var\(--native-sidebar-tint, 100%\)/);
	const theme = readFileSync(new URL("../src/theme.css", import.meta.url), "utf8");
	for (const [mode, selector] of [
		["light", ":root"],
		["dark", ':root[data-theme="dark"]'],
	] as const) {
		const tokens = Object.fromEntries(
			[...(theme.split(`${selector} {`)[1]?.split("}")[0] ?? "").matchAll(/--([\w-]+): (#[\da-f]{6});/g)].map(
				(match) => [match[1], match[2]],
			),
		);
		assert.deepEqual(nativeSidebarTints(defaultConfig(), mode), { settings: 95, sidebar: 95 });
		// Each backdrop channel is bounded by these extrema; sweep grays to guard luminance crossing.
		for (let level = 0; level <= 255; level++) {
			const composite = `#${[1, 3, 5]
				.map((offset) =>
					Math.round(Number.parseInt(tokens.sidebar.slice(offset, offset + 2), 16) * 0.95 + level * 0.05)
						.toString(16)
						.padStart(2, "0"),
				)
				.join("")}`;
			for (const foreground of ["text", "muted", "warning", "danger"])
				assert.ok(contrastRatio(tokens[foreground], composite) >= 4.5, `${mode}/${foreground}/${level}`);
		}
		const custom = {
			...defaultConfig(),
			appearance: { [mode]: { background: "#ffffff", foreground: "#767676", accent: "#000000" } },
		};
		assert.deepEqual(nativeSidebarTints(custom, mode), { settings: 100, sidebar: 100 });
		const region = { ...defaultConfig(), regions: { sidebar: { background: "#ffffff", foreground: "#767676" } } };
		assert.deepEqual(nativeSidebarTints(region, mode), { settings: 95, sidebar: 100 });
	}
});
