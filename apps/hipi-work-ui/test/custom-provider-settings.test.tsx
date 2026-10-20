import assert from "node:assert/strict";
import {
	AppError,
	type CustomProviderConfiguration,
	type ModelCatalog,
	type ModelReference,
	PROTOCOL_VERSION,
	parseRequest,
} from "@hipi/work-runtime/contracts";
import type * as Query from "@tanstack/react-query";
import { QueryClient, QueryObserver } from "@tanstack/react-query";
import type * as React from "react";
import { isValidElement } from "react";
import { afterEach, beforeEach, test, vi } from "vitest";
import { createCredentialClient } from "../src/app/credential-client.ts";
import { Button } from "../src/components/ui/button.tsx";
import { DialogContent } from "../src/components/ui/dialog.tsx";
import { Input } from "../src/components/ui/input.tsx";
import { Select } from "../src/components/ui/select.tsx";
import { CustomProviderEditor } from "../src/features/settings/custom-provider-editor.tsx";
import { CustomProviderSettings } from "../src/features/settings/custom-provider-settings.tsx";
import { LocalState } from "../src/features/workbench/local-state.ts";
import { PreparedTaskEntry } from "../src/features/workbench/prepared-task-entry.tsx";

type Cell = { value: unknown; cleanup?: () => void };
const hooks = vi.hoisted(() => ({ cells: [] as Cell[], cursor: 0 }));
// Run production handlers and TanStack invalidation. Native portals/focus/layout stay GUI acceptance gates.
vi.mock("react", async () => {
	const actual = await vi.importActual<typeof React>("react");
	return {
		...actual,
		useState: <T,>(initial?: T | (() => T)) => {
			const index = hooks.cursor++;
			hooks.cells[index] ??= {
				value: typeof initial === "function" ? (initial as () => T)() : initial,
			};
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
		useId: () => `provider-${hooks.cursor++}`,
		useEffect: (effect: React.EffectCallback) => {
			const index = hooks.cursor++;
			if (!(index in hooks.cells)) {
				const cleanup = effect();
				hooks.cells[index] = { value: undefined, cleanup: typeof cleanup === "function" ? cleanup : undefined };
			}
		},
		useLayoutEffect: () => {},
	};
});
vi.mock("@tanstack/react-query", async (original) => {
	const actual = await original<typeof Query>();
	return {
		...actual,
		useQueryClient: () => cache,
		useQuery: ({ queryKey }: { queryKey: string[] }) => ({
			data:
				queryKey[0] === "custom-providers"
					? { providers: [...profiles.values()] }
					: queryKey[0] === "built-in-provider-models"
						? { vendorId: queryKey[1], models: [{ id: "suggested-chat", name: "Suggested chat" }] }
						: cache.getQueryData(queryKey),
			isPending: false,
			isFetching: false,
			isError: false,
			refetch: vi.fn(),
		}),
	};
});
vi.mock("../src/app/client-provider.tsx", () => ({
	useAppClient: () => ({ call: runtimeCall }),
	useCredentialClient: () => credentials,
	useLocalState: () => local,
}));
vi.mock("../src/app/preferences.tsx", () => ({
	usePreferences: () => ({ locale, t: (key: string) => key }),
}));

let locale: "en" | "zh-CN";
let cache: QueryClient;
let unsubscribe: () => void;
let local: LocalState;
let profiles: Map<string, CustomProviderConfiguration>;
let keys: Map<string, string>;
let commands: Map<string, { params: string; result: CustomProviderConfiguration }>;
let nextProvider = 0;
let credentials: ReturnType<typeof createCredentialClient>;
let busy = false;
let initial: CustomProviderConfiguration | undefined;
const editorCells: Cell[] = [];
const entryCells: Cell[] = [];
const panelCells: Cell[] = [];
const runtimeCall = vi.fn<(method: string, input: unknown) => Promise<unknown>>();
const credentialRequests = vi.fn<(input: unknown) => Promise<unknown>>();
const sent = vi.fn<(text: string, model: ModelReference) => Promise<void>>();
const providerId = "custom_fixture";
const secret = "FAKE_CUSTOM_SECRET_ONLY";
function catalog(): ModelCatalog {
	return {
		providers: [
			{ provider: "openai", name: "OpenAI", credentialState: "missing" },
			...[...profiles.values()].map((profile) => ({
				provider: profile.provider,
				name: profile.name,
				credentialState: keys.has(profile.provider) ? ("configured" as const) : ("missing" as const),
			})),
		],
		models: [
			{ provider: "openai", modelId: "gpt-4", name: "Official default" },
			...[...profiles.values()].flatMap((profile) =>
				profile.models.map((model) => ({ provider: profile.provider, modelId: model.id, name: model.name })),
			),
		],
	};
}
type Node = React.ReactElement<Record<string, unknown> & { children?: React.ReactNode }>;
function nodes(node: React.ReactNode): Node[] {
	if (Array.isArray(node)) return node.flatMap(nodes);
	if (!isValidElement<Record<string, unknown> & { children?: React.ReactNode }>(node)) return [];
	return [node, ...nodes(node.props.children)];
}
function find(tree: React.ReactNode, predicate: (node: Node) => boolean) {
	const node = nodes(tree).find(predicate);
	assert.ok(node, "Expected production control");
	return node;
}
function renderEditor() {
	hooks.cells = editorCells;
	hooks.cursor = 0;
	return CustomProviderEditor({
		initial,
		onBusy: (value) => {
			busy = value;
		},
	});
}
function renderEntry() {
	hooks.cells = entryCells;
	hooks.cursor = 0;
	return PreparedTaskEntry({
		busy: false,
		disabled: false,
		draft: "An explicit trial message",
		onDraftChange: () => {},
		onSend: sent,
		onManageModels: () => {},
	});
}
function renderPanel() {
	hooks.cells = panelCells;
	hooks.cursor = 0;
	return CustomProviderSettings({ enabled: true, catalog: catalog() });
}
function change(suffix: string, value: string) {
	const node = find(renderEditor(), (node) => node.type === Input && String(node.props.id).endsWith(suffix));
	assert.equal(typeof node.props.onChange, "function");
	Reflect.apply(node.props.onChange, undefined, [{ target: { value } }]);
}
function click(tree: React.ReactNode, predicate: (node: Node) => boolean) {
	const button = find(tree, (node) => node.type === Button && predicate(node));
	assert.notEqual(button.props.disabled, true);
	assert.equal(typeof button.props.onClick, "function");
	Reflect.apply(button.props.onClick, undefined, [{ currentTarget: { focus() {} } }]);
}
function submit(tree = renderEditor()) {
	const form = find(tree, (node) => node.type === "form");
	assert.equal(typeof form.props.onSubmit, "function");
	Reflect.apply(form.props.onSubmit, undefined, [{ preventDefault() {} }]);
}
function configure() {
	change("-name", "My service");
	change("-url", "https://gateway.example/prefix/v1");
	change("-id", "trial-model");
	change("-key", secret);
}
beforeEach(() => {
	locale = "en";
	editorCells.length = 0;
	entryCells.length = 0;
	panelCells.length = 0;
	initial = undefined;
	busy = false;
	profiles = new Map();
	keys = new Map();
	commands = new Map();
	nextProvider = 0;
	local = new LocalState();
	cache = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity, gcTime: Infinity } } });
	cache.setQueryData(["models"], catalog());
	runtimeCall.mockReset();
	runtimeCall.mockImplementation(async (method, params) => {
		const request = parseRequest({ version: PROTOCOL_VERSION, method, params });
		if (request.method === "listModels") return catalog();
		if (request.method === "saveCustomProvider") {
			const existing = commands.get(request.params.requestId);
			if (existing) {
				if (existing.params !== JSON.stringify(request.params)) throw new AppError("IDEMPOTENCY_CONFLICT");
				return structuredClone(existing.result);
			}
			const { requestId: _requestId, provider, ...input } = request.params;
			const prior = provider ? profiles.get(provider) : undefined;
			const changed = prior && (prior.baseUrl !== input.baseUrl || prior.protocol !== input.protocol);
			const result = {
				...input,
				provider: changed
					? "custom_replaced"
					: (provider ?? (++nextProvider === 1 ? providerId : `${providerId}_${nextProvider}`)),
			};
			if (changed) profiles.delete(prior.provider);
			profiles.set(result.provider, result);
			commands.set(request.params.requestId, {
				params: JSON.stringify(request.params),
				result: structuredClone(result),
			});
			return result;
		}
		if (request.method === "removeCustomProvider") {
			profiles.delete(request.params.provider);
			return { provider: request.params.provider, removed: true };
		}
		throw new Error(`Unexpected application action: ${method}`);
	});
	credentialRequests.mockReset();
	credentialRequests.mockImplementation(async (input) => {
		assert.ok(input && typeof input === "object" && "provider" in input && typeof input.provider === "string");
		assert.ok("operation" in input);
		if (input.operation === "set") {
			assert.ok("secret" in input && typeof input.secret === "string");
			keys.set(input.provider, input.secret);
		}
		if (input.operation === "remove") keys.delete(input.provider);
		return { ok: true, state: keys.has(input.provider) ? "configured" : "missing" };
	});
	credentials = createCredentialClient({ request: credentialRequests }, "memory");
	sent.mockReset();
	sent.mockResolvedValue(undefined);
	unsubscribe = new QueryObserver(cache, {
		queryKey: ["models"],
		queryFn: () => runtimeCall("listModels", {}),
		staleTime: Infinity,
	}).subscribe(() => {});
});
afterEach(() => {
	unsubscribe();
	cache.clear();
	for (const cell of [...editorCells, ...entryCells, ...panelCells]) cell?.cleanup?.();
});

test("presets fill editable protocol/address and local model suggestions without submitting anything", () => {
	const select = find(renderEditor(), (node) => node.type === Select && node.props.value === "custom");
	assert.equal(typeof select.props.onValueChange, "function");
	Reflect.apply(select.props.onValueChange, undefined, ["anthropic"]);
	const tree = renderEditor();
	assert.ok(find(tree, (node) => node.type === Select && node.props.value === "anthropic-messages"));
	assert.ok(find(tree, (node) => node.type === Input && node.props.value === "https://api.anthropic.com"));
	click(tree, (node) => nodes(node.props.children).some((child) => child.props.children === "Suggested chat"));
	assert.ok(find(renderEditor(), (node) => node.type === Input && node.props.value === "suggested-chat"));
	change("-url", "https://my-proxy.example/anthropic");
	assert.ok(
		find(renderEditor(), (node) => node.type === Input && node.props.value === "https://my-proxy.example/anthropic"),
	);
	assert.equal(runtimeCall.mock.calls.length, 0);
	assert.equal(credentialRequests.mock.calls.length, 0);
});

test("save isolates secrets, refreshes catalog, and makes first usable custom model selectable before explicit Send", async () => {
	renderEntry();
	configure();
	const form = renderEditor();
	submit(form);
	submit(form);
	assert.equal(find(renderEditor(), (node) => node.type === Input && node.props.type === "password").props.value, "");
	await vi.waitFor(() => assert.equal(busy, false));
	assert.equal(runtimeCall.mock.calls.filter(([method]) => method === "saveCustomProvider").length, 1);
	assert.equal(JSON.stringify(runtimeCall.mock.calls).includes(secret), false);
	assert.equal(keys.get(providerId), secret);
	assert.ok(credentialRequests.mock.calls.some(([input]) => JSON.stringify(input).includes(secret)));
	assert.equal(JSON.stringify(cache.getQueryData(["models"])).includes(secret), false);
	assert.ok(find(renderEditor(), (node) => String(node.props.children).includes("Saving did not contact")));
	const prepared = renderEntry();
	assert.ok(find(prepared, (node) => node.type === "span" && node.props.children === "trial-model"));
	assert.equal(sent.mock.calls.length, 0);
	submit(prepared);
	assert.deepEqual(sent.mock.calls, [["An explicit trial message", { provider: providerId, modelId: "trial-model" }]]);
});

test("saving without a key keeps the model unavailable and does not claim a verified service", async () => {
	configure();
	change("-key", "");
	submit();
	await vi.waitFor(() => assert.equal(busy, false));
	assert.ok(profiles.has(providerId));
	assert.ok(find(renderEditor(), (node) => String(node.props.children).includes("Configuration saved without a key")));
	submit(renderEntry());
	assert.equal(sent.mock.calls.length, 0);
	assert.equal(
		credentialRequests.mock.calls.filter(([input]) => JSON.stringify(input).includes('"operation":"set"')).length,
		0,
	);
});

test("unconfirmed metadata save keeps fields, clears the secret, never writes it and reuses the command ID on explicit retry", async () => {
	configure();
	const implementation = runtimeCall.getMockImplementation();
	assert.ok(implementation);
	runtimeCall.mockImplementation(async (method, input) => {
		if (method === "saveCustomProvider") throw new AppError("CLOSED");
		return implementation(method, input);
	});
	submit();
	await vi.waitFor(() => assert.equal(busy, false));
	assert.equal(credentialRequests.mock.calls.length, 0);
	assert.ok(find(renderEditor(), (node) => node.type === Input && node.props.value === "My service"));
	assert.ok(
		find(renderEditor(), (node) => String(node.props.children).includes("Could not confirm the configuration")),
	);
	submit();
	await vi.waitFor(() => assert.equal(busy, false));
	const saves = runtimeCall.mock.calls.filter(([method]) => method === "saveCustomProvider");
	assert.equal(saves.length, 2);
	assert.deepEqual(saves[0], saves[1]);
});

test.each(["renamed service", "equivalent URL"] as const)(
	"lost save acknowledgement followed by %s reconciles the original command before applying edits",
	async (changeKind) => {
		configure();
		const implementation = runtimeCall.getMockImplementation();
		assert.ok(implementation);
		let dropped = false;
		runtimeCall.mockImplementation(async (method, input) => {
			const result = await implementation(method, input);
			if (method === "saveCustomProvider" && !dropped) {
				dropped = true;
				throw new AppError("CLOSED");
			}
			return result;
		});
		submit();
		await vi.waitFor(() => assert.equal(busy, false));
		if (changeKind === "renamed service") change("-name", "My renamed service");
		else change("-url", "https://gateway.example/prefix/v1/");
		change("-key", secret);
		submit();
		await vi.waitFor(() => assert.equal(busy, false));
		const saves = runtimeCall.mock.calls.filter(([method]) => method === "saveCustomProvider");
		assert.deepEqual(saves[0], saves[1]);
		assert.equal(saves.length, changeKind === "renamed service" ? 3 : 2);
		assert.equal(profiles.size, 1);
		assert.equal(
			profiles.get(providerId)?.name,
			changeKind === "renamed service" ? "My renamed service" : "My service",
		);
		assert.equal(keys.get(providerId), secret);
	},
);

test("close and reopen after a lost save acknowledgement uses authoritative metadata and does not invent key success", async () => {
	configure();
	const implementation = runtimeCall.getMockImplementation();
	assert.ok(implementation);
	runtimeCall.mockImplementation(async (method, input) => {
		const result = await implementation(method, input);
		if (method === "saveCustomProvider") throw new AppError("CLOSED");
		return result;
	});
	submit();
	await vi.waitFor(() => assert.equal(busy, false));
	assert.ok(profiles.has(providerId));
	for (const cell of editorCells) cell?.cleanup?.();
	editorCells.length = 0;
	initial = profiles.get(providerId);
	const reopened = renderEditor();
	assert.equal(find(reopened, (node) => node.type === Input && node.props.type === "password").props.value, "");
	assert.equal(
		nodes(reopened).some((node) => String(node.props.children).includes("Provider saved.")),
		false,
	);
	assert.ok(find(renderPanel(), (node) => node.type === "output" && node.props.children === "model.missing"));
});

test("changing a recipient does not copy keys or redirect a retained new-chat selection", async () => {
	initial = {
		provider: providerId,
		vendorId: "custom",
		name: "Old service",
		protocol: "openai-completions",
		baseUrl: "https://old.example/v1",
		models: [{ id: "trial-model", name: "Trial" }],
	};
	profiles.set(providerId, initial);
	keys.set(providerId, secret);
	local.write("new-chat-model", JSON.stringify([providerId, "trial-model"]));
	cache.setQueryData(["models"], catalog());
	renderEntry();
	change("-url", "https://new.example/v1");
	assert.ok(
		find(renderEditor(), (node) =>
			String(node.props.children).includes("old conversation permissions are not transferred"),
		),
	);
	submit();
	await vi.waitFor(() => assert.equal(busy, false));
	assert.equal(keys.has(providerId), false);
	assert.equal(keys.has("custom_replaced"), false);
	assert.equal(profiles.has(providerId), false);
	assert.equal(profiles.has("custom_replaced"), true);
	submit(renderEntry());
	assert.equal(sent.mock.calls.length, 0, "Removed identity must not fall back to a different configured service");
});

test("key-write uncertainty leaves saved metadata and offers an explicit new write, never a hidden retry", async () => {
	configure();
	credentialRequests.mockRejectedValue(new Error(secret));
	submit();
	await vi.waitFor(() => assert.equal(busy, false));
	assert.ok(profiles.has(providerId));
	assert.equal(credentialRequests.mock.calls.length, 1);
	assert.ok(find(renderEditor(), (node) => String(node.props.children).includes("key change could not be confirmed")));
	assert.equal(find(renderEditor(), (node) => node.type === Input && node.props.type === "password").props.value, "");
	assert.equal(JSON.stringify(renderEditor()).includes(secret), false);
});

test("unconfirmed key removal leaves the discoverable provider unchanged; an explicit retry removes only its key and profile", async () => {
	const profile: CustomProviderConfiguration = {
		provider: providerId,
		vendorId: "custom",
		name: "Trial service",
		protocol: "anthropic-messages",
		baseUrl: "https://gateway.example",
		models: [{ id: "trial", name: "Trial" }],
	};
	profiles.set(providerId, profile);
	keys.set(providerId, secret);
	keys.set("openai", "OTHER_FAKE_KEY");
	click(renderPanel(), (node) => node.props.children === "Remove provider");
	credentialRequests.mockRejectedValueOnce(new Error("locked"));
	const panel = renderPanel();
	const confirms = nodes(panel).filter((node) => node.type === Button && node.props.children === "Remove provider");
	const confirm = confirms.at(-1);
	assert.equal(typeof confirm?.props.onClick, "function");
	Reflect.apply(confirm.props.onClick, undefined, []);
	await vi.waitFor(() =>
		assert.ok(
			nodes(renderPanel()).some((node) =>
				String(node.props.children).includes("Could not confirm removal of the old key"),
			),
		),
	);
	assert.equal(profiles.has(providerId), true);
	assert.equal(runtimeCall.mock.calls.filter(([method]) => method === "removeCustomProvider").length, 0);
	const retry = nodes(renderPanel())
		.filter((node) => node.type === Button && node.props.children === "Remove provider")
		.at(-1);
	assert.equal(typeof retry?.props.onClick, "function");
	Reflect.apply(retry.props.onClick, undefined, []);
	await vi.waitFor(() => assert.equal(keys.has(providerId), false));
	await vi.waitFor(() => assert.equal(profiles.has(providerId), false));
	assert.equal(keys.get("openai"), "OTHER_FAKE_KEY");
	assert.equal(runtimeCall.mock.calls.filter(([method]) => method === "removeCustomProvider").length, 1);
	assert.ok(
		runtimeCall.mock.calls.every(
			([method]) => !["submit", "createConversation", "archiveConversation"].includes(method),
		),
	);
});

test("key removal succeeds but failed recipient update remains missing-key without automatic secret reinsertion", async () => {
	initial = {
		provider: providerId,
		vendorId: "custom",
		name: "Original",
		protocol: "openai-completions",
		baseUrl: "https://original.example/v1",
		models: [{ id: "trial", name: "Trial" }],
	};
	profiles.set(providerId, initial);
	keys.set(providerId, secret);
	const implementation = runtimeCall.getMockImplementation();
	assert.ok(implementation);
	runtimeCall.mockImplementation(async (method, input) => {
		if (method === "saveCustomProvider") throw new AppError("CLOSED");
		return implementation(method, input);
	});
	change("-url", "https://replacement.example/v1");
	change("-key", "NEW_FAKE_KEY");
	submit();
	await vi.waitFor(() => assert.equal(busy, false));
	assert.equal(profiles.get(providerId)?.baseUrl, initial.baseUrl);
	assert.equal(keys.has(providerId), false);
	assert.ok(find(renderEditor(), (node) => String(node.props.children).includes("old key was removed")));
	assert.equal(
		credentialRequests.mock.calls.filter(([input]) => JSON.stringify(input).includes('"operation":"set"')).length,
		0,
	);
	assert.equal(catalog().providers.find((provider) => provider.provider === providerId)?.credentialState, "missing");
});

test("unknown old-key removal never advances an endpoint edit", async () => {
	initial = {
		provider: providerId,
		vendorId: "custom",
		name: "Original",
		protocol: "openai-completions",
		baseUrl: "https://original.example/v1",
		models: [{ id: "trial", name: "Trial" }],
	};
	profiles.set(providerId, initial);
	keys.set(providerId, secret);
	credentialRequests.mockRejectedValueOnce(new Error("uncertain"));
	change("-url", "https://replacement.example/v1");
	submit();
	await vi.waitFor(() => assert.equal(busy, false));
	assert.equal(runtimeCall.mock.calls.filter(([method]) => method === "saveCustomProvider").length, 0);
	assert.equal(profiles.get(providerId)?.baseUrl, initial.baseUrl);
	assert.ok(
		find(renderEditor(), (node) => String(node.props.children).includes("provider configuration was not changed")),
	);
});

test.each(["invalid key", "invalid URL"] as const)(
	"an %s is rejected before any old-key deletion or metadata mutation",
	async (kind) => {
		initial = {
			provider: providerId,
			vendorId: "custom",
			name: "Original",
			protocol: "openai-completions",
			baseUrl: "https://original.example/v1",
			models: [{ id: "trial", name: "Trial" }],
		};
		profiles.set(providerId, initial);
		keys.set(providerId, secret);
		change(
			"-url",
			kind === "invalid URL"
				? "https://replacement.example/v1?api_key=not-a-real-key"
				: "https://replacement.example/v1",
		);
		if (kind === "invalid key") change("-key", "invalid fake key");
		submit();
		await vi.waitFor(() => assert.equal(busy, false));
		assert.equal(credentialRequests.mock.calls.length, 0);
		assert.equal(runtimeCall.mock.calls.filter(([method]) => method === "saveCustomProvider").length, 0);
		assert.equal(keys.get(providerId), secret);
	},
);

test.each(["locked", "unavailable"] as const)(
	"%s credential status is never presented as confirmed absence",
	async (state) => {
		configure();
		change("-key", "");
		credentialRequests.mockResolvedValue({ ok: true, state });
		submit();
		await vi.waitFor(() => assert.equal(busy, false));
		assert.ok(
			find(renderEditor(), (node) => String(node.props.children).includes("key change could not be confirmed")),
		);
		assert.equal(
			nodes(renderEditor()).some((node) => String(node.props.children).includes("Configuration saved without a key")),
			false,
		);
	},
);

test("key removal succeeds but failed profile removal is visibly partial and can retry without restoring any key", async () => {
	profiles.set(providerId, {
		provider: providerId,
		vendorId: "custom",
		name: "Original",
		protocol: "openai-completions",
		baseUrl: "https://original.example/v1",
		models: [{ id: "trial", name: "Trial" }],
	});
	keys.set(providerId, secret);
	const implementation = runtimeCall.getMockImplementation();
	assert.ok(implementation);
	runtimeCall.mockImplementation(async (method, input) => {
		if (method === "removeCustomProvider") throw new AppError("CLOSED");
		return implementation(method, input);
	});
	click(renderPanel(), (node) => node.props.children === "Remove provider");
	const confirm = nodes(renderPanel())
		.filter((node) => node.type === Button && node.props.children === "Remove provider")
		.at(-1);
	assert.equal(typeof confirm?.props.onClick, "function");
	Reflect.apply(confirm.props.onClick, undefined, []);
	await vi.waitFor(() =>
		assert.ok(
			nodes(renderPanel()).some((node) =>
				String(node.props.children).includes("key was removed, but provider removal could not be confirmed"),
			),
		),
	);
	assert.equal(profiles.has(providerId), true);
	assert.equal(keys.has(providerId), false);
	assert.equal(
		credentialRequests.mock.calls.filter(([input]) => JSON.stringify(input).includes('"operation":"set"')).length,
		0,
	);
});

test("Chinese editor explains protocols, secret retention and no-request-on-save without an internal ID field", () => {
	locale = "zh-CN";
	const text = nodes(renderEditor())
		.flatMap((node) => node.props.children)
		.filter((value) => typeof value === "string")
		.join(" ");
	assert.match(text, /API 协议/);
	assert.match(text, /Chat Completions/);
	assert.match(text, /Anthropic/);
	assert.match(text, /保存只写入配置/);
	assert.doesNotMatch(text, /服务商 ID|custom_fixture/);
});

test.each(["connected", "deleted", "rotated"] as const)("dialog close restores focus after a %s opener", (state) => {
	profiles.set(providerId, {
		provider: providerId,
		vendorId: "custom",
		name: "Original",
		protocol: "openai-completions",
		baseUrl: "https://original.example/v1",
		models: [{ id: "trial", name: "Trial" }],
	});
	const opener = { isConnected: true, disabled: false, focus: vi.fn() };
	const fallback = { isConnected: true, disabled: false, focus: vi.fn() };
	let panel = renderPanel();
	const add = find(
		panel,
		(node) =>
			node.type === Button && Array.isArray(node.props.children) && node.props.children.includes("Add provider"),
	);
	assert.ok(add.props.ref && typeof add.props.ref === "object");
	Reflect.set(add.props.ref, "current", fallback);
	const action = find(
		panel,
		(node) => node.type === Button && node.props.children === (state === "deleted" ? "Remove provider" : "Edit"),
	);
	assert.equal(typeof action.props.onClick, "function");
	Reflect.apply(action.props.onClick, undefined, [{ currentTarget: opener }]);
	if (state !== "connected") {
		opener.isConnected = false;
		profiles.delete(providerId);
	}
	panel = renderPanel();
	const contents = nodes(panel).filter((node) => node.type === DialogContent);
	const content = state === "deleted" ? contents[1] : contents[0];
	assert.equal(typeof content?.props.onCloseAutoFocus, "function");
	Reflect.apply(content.props.onCloseAutoFocus, undefined, [{ preventDefault() {} }]);
	assert.equal(opener.focus.mock.calls.length, state === "connected" ? 1 : 0);
	assert.equal(fallback.focus.mock.calls.length, state === "connected" ? 0 : 1);
});
