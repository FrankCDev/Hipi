import assert from "node:assert/strict";
import type { AppearanceClient, AppearanceStatus } from "@hipi/work-runtime/appearance";
import type * as React from "react";
import { afterEach, beforeEach, test, vi } from "vitest";
import { AppearanceProvider, type useAppearance } from "../src/app/appearance-provider.tsx";
import { defaultConfig, type ThemeConfig } from "../src/app/theme/config.ts";
import { ThemeStore, themeStorageKey } from "../src/app/theme/store.ts";

type Cell = { value: unknown; deps?: React.DependencyList; cleanup?: () => void };
const hooks = vi.hoisted(() => ({
	cells: [] as Cell[],
	cursor: 0,
	commits: [] as (() => void)[],
	changed: false,
}));
// Run the production provider's effects and cleanup with the production persisted
// theme store. This bounded hook adapter does not verify Electron or OS window paint.
vi.mock("react", async () => {
	const actual = await vi.importActual<typeof React>("react");
	return {
		...actual,
		useState: <T,>(initial: T | (() => T)) => {
			const index = hooks.cursor++;
			const cell = hooks.cells[index] ?? {
				value: typeof initial === "function" ? (initial as () => T)() : initial,
			};
			hooks.cells[index] = cell;
			return [
				cell.value,
				(next: T | ((previous: T) => T)) => {
					const value = typeof next === "function" ? (next as (previous: T) => T)(cell.value as T) : next;
					hooks.changed ||= !Object.is(cell.value, value);
					cell.value = value;
				},
			];
		},
		useEffect: (effect: React.EffectCallback, deps: React.DependencyList) => {
			const index = hooks.cursor++;
			const previous = hooks.cells[index];
			if (
				!previous?.deps ||
				deps.length !== previous.deps.length ||
				deps.some((value, index) => !Object.is(value, previous.deps?.[index]))
			) {
				hooks.commits.push(() => {
					previous?.cleanup?.();
					const cleanup = effect();
					hooks.cells[index] = { value: undefined, deps, cleanup: typeof cleanup === "function" ? cleanup : undefined };
				});
			}
		},
	};
});
vi.mock("../src/app/theme/provider.tsx", () => ({
	useThemeSettings: () => ({ config: store.current }),
}));

let store: ThemeStore;
const saved = new Map<string, string>();
const dataset: Record<string, string> = {};
const properties = new Map<string, string>();
const mediaListeners = new Set<() => void>();
const media = {
	matches: false,
	addEventListener: (_event: string, listener: () => void) => mediaListeners.add(listener),
	removeEventListener: (_event: string, listener: () => void) => mediaListeners.delete(listener),
};
function persist(config: ThemeConfig) {
	saved.set(themeStorageKey, JSON.stringify(config));
	store = new ThemeStore({
		getItem: (key) => saved.get(key) ?? null,
		setItem: (key, value) => saved.set(key, value),
	});
	assert.equal(store.status, "available");
}
function unmount() {
	for (const cell of hooks.cells) cell.cleanup?.();
	hooks.cells = [];
	hooks.commits = [];
}
beforeEach(() => {
	saved.clear();
	properties.clear();
	mediaListeners.clear();
	for (const key of Object.keys(dataset)) delete dataset[key];
	media.matches = false;
	persist(defaultConfig());
	vi.stubGlobal("window", { matchMedia: () => media });
	vi.stubGlobal("document", {
		documentElement: {
			dataset,
			style: {
				setProperty: (key: string, value: string) => properties.set(key, value),
				removeProperty: (key: string) => properties.delete(key),
			},
		},
	});
});
afterEach(() => {
	unmount();
	vi.unstubAllGlobals();
});
function drive(client: AppearanceClient): ReturnType<typeof useAppearance> {
	for (let iteration = 0; iteration < 10; iteration++) {
		hooks.cursor = 0;
		hooks.changed = false;
		const tree = AppearanceProvider({ client, children: null });
		for (const commit of hooks.commits.splice(0)) commit();
		if (!hooks.changed) return tree.props.value;
	}
	throw new Error("Appearance provider did not settle within 10 renders");
}
async function flush(client: AppearanceClient) {
	// Bound promise draining so a status-triggered write loop fails deterministically.
	for (let iteration = 0; iteration < 12; iteration++) {
		await Promise.resolve();
		drive(client);
	}
	return drive(client);
}
function nativeClient(initial: Partial<AppearanceStatus> = {}, publishWrites = false) {
	let current: AppearanceStatus = {
		version: 1,
		platform: "macos",
		backdrop: "vibrancy",
		reducedTransparency: false,
		backdropEnabled: false,
		fontSmoothing: true,
		themeMode: "system",
		...initial,
	};
	const listeners = new Set<(status: AppearanceStatus) => void>();
	const emit = (status: AppearanceStatus) => {
		current = status;
		for (const listener of listeners) listener(status);
	};
	const client = {
		localFontsSupported: false,
		status: vi.fn(async () => current),
		setThemeMode: vi.fn<AppearanceClient["setThemeMode"]>(async (mode) => {
			current = { ...current, themeMode: mode };
			if (publishWrites) emit(current);
			return current;
		}),
		setBackdrop: vi.fn<AppearanceClient["setBackdrop"]>(async (enabled) => {
			current = { ...current, backdropEnabled: enabled };
			if (publishWrites) emit(current);
			return current;
		}),
		listFonts: vi.fn(async () => ({ families: [], truncated: false })),
		subscribe: vi.fn((listener: (status: AppearanceStatus) => void) => {
			listeners.add(listener);
			return () => listeners.delete(listener);
		}),
	} satisfies AppearanceClient;
	return { client, listeners, emit };
}
function deferredStatus() {
	let finish: ((status: AppearanceStatus) => void) | undefined;
	const promise = new Promise<AppearanceStatus>((resolve) => {
		finish = resolve;
	});
	return {
		promise,
		resolve(status: AppearanceStatus) {
			assert.ok(finish);
			finish(status);
		},
	};
}

test.each(["light", "dark"] as const)(
	"persisted explicit %s applies native mode before backdrop despite the opposite system preference",
	async (mode) => {
		media.matches = mode === "light";
		persist({ ...defaultConfig(), mode, translucentSidebar: true });
		const { client } = nativeClient();
		drive(client);
		assert.deepEqual(
			client.setThemeMode.mock.calls.map(([value]) => value),
			[mode],
		);
		assert.equal(client.setBackdrop.mock.calls.length, 0);
		const view = await flush(client);
		assert.equal(client.setBackdrop.mock.calls.length, 1);
		assert.deepEqual(client.setBackdrop.mock.calls[0], [
			true,
			mode === "dark" ? "#181818" : "#ffffff",
			client.setThemeMode.mock.calls[0]?.[1],
		]);
		assert.equal(view.status?.themeMode, mode);
		assert.equal(dataset.nativeBackdrop, "on");
	},
);

test("switching dark to system reapplies the raw preference even when the resolved background is unchanged", async () => {
	media.matches = true;
	persist({ ...defaultConfig(), mode: "dark" });
	const { client } = nativeClient();
	await flush(client);
	assert.equal(store.update({ ...store.current, mode: "system" }).ok, true);
	await flush(client);
	assert.deepEqual(
		client.setThemeMode.mock.calls.map(([mode]) => mode),
		["dark", "system"],
	);
	assert.deepEqual(
		client.setBackdrop.mock.calls.map(([, background]) => background),
		["#181818", "#181818"],
	);
	media.matches = false;
	for (const listener of mediaListeners) listener();
	const view = await flush(client);
	assert.deepEqual(
		client.setThemeMode.mock.calls.map(([mode]) => mode),
		["dark", "system", "system"],
	);
	assert.equal(client.setBackdrop.mock.lastCall?.[1], "#ffffff");
	assert.equal(view.status?.themeMode, "system");
});

test("native hosts without backdrop support still receive the persisted theme mode", async () => {
	persist({ ...defaultConfig(), mode: "dark", translucentSidebar: true });
	const { client } = nativeClient({ platform: "linux", backdrop: "unsupported" });
	const view = await flush(client);
	assert.deepEqual(
		client.setThemeMode.mock.calls.map(([mode]) => mode),
		["dark"],
	);
	assert.equal(client.setBackdrop.mock.calls.length, 0);
	assert.equal(view.status?.themeMode, "dark");
	assert.equal(dataset.nativeBackdrop, "off");
});

test("native write notifications and later same-client status events do not create a theme write loop", async () => {
	persist({ ...defaultConfig(), mode: "light", translucentSidebar: true });
	const { client, emit } = nativeClient({}, true);
	const view = await flush(client);
	assert.ok(view.status);
	emit({ ...view.status, reducedTransparency: true, backdropEnabled: false });
	const updated = await flush(client);
	assert.equal(updated.status?.reducedTransparency, true);
	assert.equal(dataset.nativeBackdrop, "off");
	assert.equal(client.setThemeMode.mock.calls.length, 1);
	assert.equal(client.setBackdrop.mock.calls.length, 1);
	assert.equal(client.subscribe.mock.calls.length, 1);
});

test("client replacement and reconnect reapply the current mode and retire previous subscriptions", async () => {
	persist({ ...defaultConfig(), mode: "dark", translucentSidebar: true });
	const first = nativeClient();
	await flush(first.client);
	const lateEvent = first.client.subscribe.mock.calls[0]?.[0];
	const second = nativeClient();
	const view = await flush(second.client);
	assert.ok(view.status);
	assert.equal(first.listeners.size, 0);
	assert.equal(second.listeners.size, 1);
	assert.deepEqual(
		second.client.setThemeMode.mock.calls.map(([mode]) => mode),
		["dark"],
	);
	lateEvent?.({ ...view.status, themeMode: "light", backdropEnabled: false });
	assert.equal(drive(second.client).status?.themeMode, "dark");
	assert.equal(dataset.nativeBackdrop, "on");
	unmount();
	assert.equal(second.listeners.size, 0);
	assert.equal(mediaListeners.size, 0);
	assert.equal(properties.size, 0);
	assert.equal(dataset.nativeBackdrop, undefined);
	await flush(second.client);
	assert.deepEqual(
		second.client.setThemeMode.mock.calls.map(([mode]) => mode),
		["dark", "dark"],
	);
	assert.equal(second.listeners.size, 1);
});

test("an aborted previous theme reply cannot start backdrop work or overwrite the current status", async () => {
	persist({ ...defaultConfig(), mode: "light", translucentSidebar: true });
	const { client } = nativeClient();
	const old = deferredStatus();
	client.setThemeMode.mockImplementationOnce(() => old.promise);
	drive(client);
	const oldSignal = client.setThemeMode.mock.calls[0]?.[1];
	assert.equal(oldSignal?.aborted, false);
	assert.equal(store.update({ ...store.current, mode: "dark", translucentSidebar: false }).ok, true);
	const current = await flush(client);
	assert.ok(current.status);
	assert.equal(oldSignal?.aborted, true);
	assert.equal(client.setBackdrop.mock.calls.length, 1);
	old.resolve({ ...current.status, themeMode: "light", backdropEnabled: true });
	const settled = await flush(client);
	assert.equal(client.setBackdrop.mock.calls.length, 1);
	assert.equal(settled.status?.themeMode, "dark");
	assert.equal(dataset.nativeBackdrop, "off");
});

test("an aborted previous backdrop reply cannot repaint after a replacement client has applied its theme", async () => {
	persist({ ...defaultConfig(), mode: "light", translucentSidebar: true });
	const first = nativeClient();
	const old = deferredStatus();
	first.client.setBackdrop.mockImplementationOnce(() => old.promise);
	await flush(first.client);
	const oldSignal = first.client.setBackdrop.mock.calls[0]?.[2];
	assert.equal(oldSignal?.aborted, false);
	assert.equal(store.update({ ...store.current, mode: "dark", translucentSidebar: false }).ok, true);
	const second = nativeClient();
	const current = await flush(second.client);
	assert.ok(current.status);
	assert.equal(oldSignal?.aborted, true);
	old.resolve({ ...current.status, themeMode: "light", backdropEnabled: true });
	const settled = await flush(second.client);
	assert.equal(settled.client, second.client);
	assert.equal(settled.status?.themeMode, "dark");
	assert.equal(dataset.nativeBackdrop, "off");
	assert.equal(first.client.setBackdrop.mock.calls.length, 1);
	assert.equal(second.client.setBackdrop.mock.calls.length, 1);
});

test("a white custom canvas under dark mode changes backdrop color without inferring a light native theme", async () => {
	persist({
		...defaultConfig(),
		mode: "dark",
		translucentSidebar: true,
		appearance: { dark: { background: "#ffffff", foreground: "#000000", accent: "#000000" } },
	});
	const { client } = nativeClient();
	await flush(client);
	assert.deepEqual(
		client.setThemeMode.mock.calls.map(([mode]) => mode),
		["dark"],
	);
	assert.equal(client.setBackdrop.mock.lastCall?.[1], "#ffffff");
});
