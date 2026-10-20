import assert from "node:assert/strict";
import type * as Query from "@tanstack/react-query";
import { QueryClient } from "@tanstack/react-query";
import type * as React from "react";
import { isValidElement } from "react";
import { afterEach, beforeEach, test, vi } from "vitest";
import { createCredentialClient } from "../src/app/credential-client.ts";
import { Button } from "../src/components/ui/button.tsx";
import { Input } from "../src/components/ui/input.tsx";
import { LegacyProviderEditor } from "../src/features/settings/legacy-provider-editor.tsx";

type Cell = { value: unknown; cleanup?: () => void };
const hooks = vi.hoisted(() => ({ cells: [] as Cell[], cursor: 0 }));
// Execute real credential handlers and cache invalidation; native focus and layout remain GUI acceptance.
vi.mock("react", async () => {
	const actual = await vi.importActual<typeof React>("react");
	return {
		...actual,
		useCallback: (callback: unknown) => callback,
		useState: <T,>(initial?: T | (() => T)) => {
			const index = hooks.cursor++;
			hooks.cells[index] ??= { value: typeof initial === "function" ? (initial as () => T)() : initial };
			const cell = hooks.cells[index];
			return [
				cell.value,
				(next: T | ((value: T) => T)) => {
					cell.value = typeof next === "function" ? (next as (value: T) => T)(cell.value as T) : next;
				},
			];
		},
		useRef: <T,>(initial: T) => {
			const index = hooks.cursor++;
			hooks.cells[index] ??= { value: { current: initial } };
			return hooks.cells[index].value;
		},
		useId: () => `legacy-key-${hooks.cursor++}`,
		useEffect: (effect: React.EffectCallback) => {
			const index = hooks.cursor++;
			if (!(index in hooks.cells)) {
				const cleanup = effect();
				hooks.cells[index] = { value: undefined, cleanup: typeof cleanup === "function" ? cleanup : undefined };
			}
		},
	};
});
vi.mock("@tanstack/react-query", async (original) => {
	const actual = await original<typeof Query>();
	return { ...actual, useQueryClient: () => cache };
});
vi.mock("../src/app/client-provider.tsx", () => ({ useCredentialClient: () => credentials }));
vi.mock("../src/app/preferences.tsx", () => ({ usePreferences: () => ({ locale }) }));

let cache: QueryClient;
let credentials: ReturnType<typeof createCredentialClient> | undefined;
let locale: "en" | "zh-CN";
let busy: boolean;
let keys: Map<string, string>;
const request = vi.fn<(input: unknown) => Promise<unknown>>();
const onBusy = vi.fn((value: boolean) => {
	busy = value;
});
const sentinel = "FAKE_OFFICIAL_KEY_ONLY";
type Node = React.ReactElement<Record<string, unknown> & { children?: React.ReactNode }>;
function nodes(node: React.ReactNode): Node[] {
	if (Array.isArray(node)) return node.flatMap(nodes);
	if (!isValidElement<Record<string, unknown> & { children?: React.ReactNode }>(node)) return [];
	return [node, ...nodes(node.props.children)];
}
function render() {
	hooks.cursor = 0;
	return LegacyProviderEditor({ onBusy });
}
function find(predicate: (node: Node) => boolean, tree = render()) {
	const result = nodes(tree).find(predicate);
	assert.ok(result, "Expected production control");
	return result;
}
function change(value: string) {
	const input = find((node) => node.type === Input);
	assert.equal(typeof input.props.onChange, "function");
	Reflect.apply(input.props.onChange, undefined, [{ target: { value } }]);
}
function submit(tree = render()) {
	const form = find((node) => node.type === "form", tree);
	assert.equal(typeof form.props.onSubmit, "function");
	Reflect.apply(form.props.onSubmit, undefined, [{ preventDefault() {} }]);
}
function click(label: string) {
	const button = find((node) => node.type === Button && node.props.children === label);
	assert.notEqual(button.props.disabled, true);
	assert.equal(typeof button.props.onClick, "function");
	Reflect.apply(button.props.onClick, undefined, []);
}
function text() {
	return nodes(render())
		.flatMap((node) => node.props.children)
		.filter((value) => typeof value === "string")
		.join(" ");
}
async function mount() {
	render();
	await vi.waitFor(() => assert.equal(busy, false));
}
beforeEach(() => {
	hooks.cells.length = 0;
	hooks.cursor = 0;
	locale = "en";
	busy = false;
	keys = new Map();
	cache = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity } } });
	cache.setQueryData(["models"], { providers: [] });
	cache.setQueryData(["conversation-model", "conversation"], { credentialState: "missing" });
	onBusy.mockClear();
	request.mockReset();
	request.mockImplementation(async (input) => {
		assert.ok(input && typeof input === "object" && "provider" in input && input.provider === "openai");
		assert.ok("operation" in input);
		if (input.operation === "set") {
			assert.ok("secret" in input && typeof input.secret === "string");
			keys.set("openai", input.secret);
		}
		if (input.operation === "remove") keys.delete("openai");
		return { ok: true, state: keys.has("openai") ? "configured" : "missing" };
	});
	credentials = createCredentialClient({ request }, "memory");
});
afterEach(() => {
	for (const cell of hooks.cells) cell?.cleanup?.();
	cache.clear();
	vi.restoreAllMocks();
});

test("mount reads only official key status; missing-key editor has no extra actions or configurable endpoint", async () => {
	await mount();
	render();
	assert.deepEqual(request.mock.calls, [[{ version: 1, operation: "status", provider: "openai" }]]);
	assert.equal(nodes(render()).filter((node) => node.type === Input).length, 1);
	assert.deepEqual(
		nodes(render())
			.filter((node) => node.type === Button)
			.map((node) => node.props.children),
		["Save"],
	);
	assert.match(text(), /official service and built-in models/);
	assert.match(text(), /development host restarts/);
	assert.equal(cache.getQueryState(["models"])?.isInvalidated, false);
});

test("save clears the key immediately, fences duplicate submits, and invalidates model state without leaking secrets", async () => {
	await mount();
	change(sentinel);
	const form = render();
	submit(form);
	submit(form);
	assert.equal(find((node) => node.type === Input).props.value, "");
	await vi.waitFor(() => assert.equal(busy, false));
	assert.equal(request.mock.calls.filter(([input]) => JSON.stringify(input).includes('"operation":"set"')).length, 1);
	assert.equal(keys.get("openai"), sentinel);
	assert.match(text(), /Key saved/);
	assert.equal(cache.getQueryState(["models"])?.isInvalidated, true);
	assert.equal(cache.getQueryState(["conversation-model", "conversation"])?.isInvalidated, true);
	assert.equal(
		JSON.stringify(
			cache
				.getQueryCache()
				.getAll()
				.map((query) => query.state.data),
		).includes(sentinel),
		false,
	);
	assert.equal(JSON.stringify(render()).includes(sentinel), false);
	assert.ok(find((node) => node.type === Button && node.props.children === "Remove key"));
	assert.equal(
		nodes(render()).some((node) => node.type === Button && node.props.children === "Refresh status"),
		false,
	);
});

test("remove is available only for a configured key and never touches custom identities", async () => {
	keys.set("openai", sentinel);
	keys.set("custom_other", "OTHER_FAKE_KEY_ONLY");
	await mount();
	click("Remove key");
	await vi.waitFor(() => assert.equal(busy, false));
	assert.equal(keys.has("openai"), false);
	assert.equal(keys.get("custom_other"), "OTHER_FAKE_KEY_ONLY");
	assert.match(text(), /Key removed/);
	assert.equal(
		nodes(render()).some((node) => node.type === Button && node.props.children === "Remove key"),
		false,
	);
	assert.equal(
		request.mock.calls.filter(([input]) => JSON.stringify(input).includes('"operation":"remove"')).length,
		1,
	);
});

test("invalid key input never reaches the bridge or alters an existing key", async () => {
	keys.set("openai", sentinel);
	await mount();
	change("invalid fake key");
	submit();
	await vi.waitFor(() => assert.equal(busy, false));
	assert.equal(request.mock.calls.length, 1);
	assert.equal(keys.get("openai"), sentinel);
	assert.match(text(), /without spaces/);
	assert.equal(find((node) => node.type === Input).props.value, "");
	assert.equal(cache.getQueryState(["models"])?.isInvalidated, false);
});

test("a lost write acknowledgement stays unknown until explicit status refresh without automatically retrying", async () => {
	await mount();
	request.mockImplementationOnce(async () => {
		keys.set("openai", sentinel);
		throw new Error(sentinel);
	});
	change(sentinel);
	submit();
	await vi.waitFor(() => assert.equal(busy, false));
	assert.match(text(), /change could not be confirmed/);
	assert.doesNotMatch(text(), /Key saved/);
	assert.equal(JSON.stringify(render()).includes(sentinel), false);
	assert.equal(request.mock.calls.length, 2);
	assert.equal(find((node) => node.type === Button && node.props.children === "Save").props.disabled, true);
	click("Refresh status");
	await vi.waitFor(() => assert.equal(busy, false));
	assert.match(text(), /Key configured/);
	assert.doesNotMatch(text(), /Key saved/);
	assert.equal(request.mock.calls.length, 3);
	assert.deepEqual(request.mock.calls[2], [{ version: 1, operation: "status", provider: "openai" }]);
});

test.each(["locked", "unavailable"] as const)(
	"%s status blocks mutation and offers only explicit recovery",
	async (state) => {
		request.mockResolvedValueOnce({ ok: true, state });
		await mount();
		assert.equal(find((node) => node.type === Input).props.disabled, true);
		assert.equal(
			nodes(render()).some((node) => node.type === Button && node.props.children === "Remove key"),
			false,
		);
		assert.ok(find((node) => node.type === Button && node.props.children === "Refresh status"));
		assert.doesNotMatch(text(), /No key configured/);
		submit();
		assert.equal(request.mock.calls.length, 1);
	},
);

test("a successful key write remains confirmed if catalog refresh fails", async () => {
	await mount();
	vi.spyOn(cache, "invalidateQueries").mockRejectedValue(new Error("synthetic-cache-failure"));
	change(sentinel);
	submit();
	await vi.waitFor(() => assert.equal(busy, false));
	assert.match(text(), /Key saved/);
	assert.doesNotMatch(text(), /could not be confirmed/);
	assert.equal(keys.get("openai"), sentinel);
});

test("unmount fences late mutation completion and reopening never restores a secret draft", async () => {
	await mount();
	const release = Promise.withResolvers<unknown>();
	request.mockImplementationOnce(() => release.promise);
	change(sentinel);
	submit();
	await vi.waitFor(() => assert.equal(request.mock.calls.length, 2));
	for (const cell of hooks.cells) cell?.cleanup?.();
	const busyCallbacks = onBusy.mock.calls.length;
	release.resolve({ ok: true, state: "configured" });
	await vi.waitFor(() => assert.equal(cache.getQueryState(["models"])?.isInvalidated, true));
	assert.equal(onBusy.mock.calls.length, busyCallbacks);
	assert.equal(find((node) => node.type === Input).props.value, "");
	assert.doesNotMatch(text(), /Key saved/);
	hooks.cells.length = 0;
	await mount();
	assert.equal(find((node) => node.type === Input).props.value, "");
	assert.equal(request.mock.calls.length, 3);
});

test("missing credential capability shows no nonfunctional key actions", async () => {
	credentials = undefined;
	await mount();
	assert.match(text(), /cannot manage API keys/);
	assert.equal(
		nodes(render()).some((node) => node.type === Input || node.type === Button),
		false,
	);
	assert.equal(request.mock.calls.length, 0);
});

test("Chinese system-storage editor stays inline and describes the official fixed service", async () => {
	locale = "zh-CN";
	credentials = createCredentialClient({ request }, "system");
	await mount();
	assert.match(text(), /OpenAI 官方服务与内置模型/);
	assert.match(text(), /密钥安全保存在本机/);
	assert.match(text(), /保存不会请求 OpenAI/);
	assert.equal(find((node) => node.type === Input).props.type, "password");
	assert.equal(
		nodes(render()).some((node) => node.props.role === "dialog"),
		false,
	);
});
