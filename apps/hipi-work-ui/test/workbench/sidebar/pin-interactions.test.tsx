import assert from "node:assert/strict";
import {
	type AppClient,
	type Conversation,
	type ConversationPresentation,
	type Method,
	PROTOCOL_VERSION,
	parseRequest,
	parseResult,
} from "@hipi/work-runtime/contracts";
import type * as Query from "@tanstack/react-query";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type * as React from "react";
import { createRef } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, test, vi } from "vitest";
import { ThemeProvider } from "../../../src/app/theme/index.ts";
import { CatalogSession } from "../../../src/features/workbench/catalog/session.ts";
import { LocalState } from "../../../src/features/workbench/local-state.ts";
import {
	PinConversationButton,
	PinConversationItem,
	PinRecovery,
} from "../../../src/features/workbench/sidebar/pin-conversation.tsx";
import { PinnedConversations } from "../../../src/features/workbench/sidebar/pinned-conversations.tsx";
import { PresentationSession } from "../../../src/features/workbench/sidebar/presentation-session.ts";
import { SidebarPreviewProvider } from "../../../src/features/workbench/sidebar/preview-provider.tsx";
import { SidebarSelectionProvider } from "../../../src/features/workbench/sidebar/selection-provider.tsx";

vi.mock("react", async () => ({
	...(await vi.importActual<typeof React>("react")),
	useSyncExternalStore: (_subscribe: unknown, snapshot: () => unknown, serverSnapshot?: () => unknown) =>
		(serverSnapshot ?? snapshot)(),
}));
vi.mock("@tanstack/react-query", async () => ({
	...(await vi.importActual<typeof Query>("@tanstack/react-query")),
	useQuery: (options: { enabled: boolean }) => {
		enabled.push(options.enabled);
		return { data: current, isError: readFailed, isFetching: fetching, refetch };
	},
}));
vi.mock("../../../src/app/preferences.tsx", () => ({ usePreferences: () => ({ locale, t: (key: string) => key }) }));
vi.mock("../../../src/app/client-provider.tsx", () => ({ useAppClient: () => client }));
const conversation: Conversation = {
	workspaceId: "project",
	conversationId: "chat",
	title: "A real task",
	revision: 4,
	createdAt: 1,
	archivedAt: null,
};
const original = { workspaceId: "project", conversationId: "chat", revision: 0, pinned: false };
let current: ConversationPresentation | undefined;
let readFailed = false;
let fetching = false;
let locale = "en";
const enabled: boolean[] = [];
const refetch = vi.fn();
const client: AppClient = {
	call: vi.fn(async <M extends Method>(method: M, params: unknown) => {
		const request = parseRequest({ version: PROTOCOL_VERSION, method, params });
		if (request.method === "setConversationPinned") {
			current = {
				workspaceId: request.params.workspaceId,
				conversationId: request.params.conversationId,
				pinned: request.params.pinned,
				revision: request.params.expectedPresentationRevision + 1,
			};
		}
		return parseResult(method, current);
	}),
	observe: vi.fn(async () => {
		throw new Error("Pin must not observe execution");
	}),
};
beforeEach(() => {
	current = { ...original };
	readFailed = false;
	fetching = false;
	locale = "en";
	enabled.length = 0;
	vi.clearAllMocks();
});

test("the existing menu action pins and unpins using exact presentation CAS without execution calls", async () => {
	const local = new LocalState();
	local.write("draft.project.chat", "Unsent work");
	const session = new PresentationSession(client, local);
	const item = () => PinConversationItem({ conversation, session, open: true });
	assert.equal(item()?.props.children[1], "Pin conversation");
	item()?.props.onSelect?.(new Event("select"));
	await vi.waitFor(() => assert.equal(session.getSnapshot().busy, false));
	assert.equal(session.getSnapshot().result?.pinned, true);
	assert.equal(item()?.props.children[1], "Unpin conversation");
	item()?.props.onSelect?.(new Event("select"));
	await vi.waitFor(() => assert.equal(session.getSnapshot().result?.pinned, false));
	const mutations = vi.mocked(client.call).mock.calls.filter(([method]) => method === "setConversationPinned");
	assert.equal(mutations.length, 2);
	assert.deepEqual(
		mutations
			.map(([, params]) => {
				const request = parseRequest({ version: PROTOCOL_VERSION, method: "setConversationPinned", params });
				assert.equal(request.method, "setConversationPinned");
				return request.params;
			})
			.map((params) => [params.workspaceId, params.conversationId, params.expectedPresentationRevision, params.pinned]),
		[
			["project", "chat", 0, true],
			["project", "chat", 1, false],
		],
	);
	assert.equal(local.read("draft.project.chat"), "Unsent work");
	assert.equal(vi.mocked(client.observe).mock.calls.length, 0);
	session.dispose();
});

test("closed menus perform no metadata read; loading, refresh and archive states never offer a stale mutation", () => {
	const session = new PresentationSession(client, new LocalState());
	PinConversationItem({ conversation, session, open: false });
	assert.deepEqual(enabled, [false]);
	fetching = true;
	assert.equal(PinConversationItem({ conversation, session, open: true })?.props.disabled, true);
	fetching = false;
	current = undefined;
	assert.equal(PinConversationItem({ conversation, session, open: true })?.props.disabled, true);
	readFailed = true;
	const retry = PinConversationItem({ conversation, session, open: true });
	assert.equal(retry?.props.children, "Reload pin status");
	const event = new Event("select", { cancelable: true });
	retry?.props.onSelect?.(event);
	assert.equal(event.defaultPrevented, true);
	assert.equal(refetch.mock.calls.length, 1);
	assert.equal(PinConversationItem({ conversation: { ...conversation, archivedAt: 2 }, session, open: true }), null);
	assert.equal(vi.mocked(client.call).mock.calls.length, 0);
	session.dispose();
});

test("the direct hover action uses the same exact mutation owner as its menu", async () => {
	const session = new PresentationSession(client, new LocalState());
	const button = () => PinConversationButton({ conversation, session, open: true })?.props.children;
	assert.equal(button()?.props["aria-label"], "Pin conversation");
	button()?.props.onClick?.();
	await vi.waitFor(() => assert.equal(session.getSnapshot().busy, false));
	assert.equal(button()?.props["aria-label"], "Unpin conversation");
	assert.equal(current?.pinned, true);
	assert.equal(vi.mocked(client.call).mock.calls.filter(([method]) => method === "setConversationPinned").length, 1);
	assert.equal(vi.mocked(client.observe).mock.calls.length, 0);
	session.dispose();
});

test("a stale direct pin callback cannot replace an unknown original request", async () => {
	const calls: Method[] = [];
	const session = new PresentationSession(
		{
			call: async <M extends Method>(method: M) => {
				calls.push(method);
				if (method === "getPresentationCommandResult") return parseResult(method, null);
				throw new Error("Unknown outcome");
			},
			observe: client.observe,
		},
		new LocalState(),
	);
	const button = PinConversationButton({ conversation, session, open: true })?.props.children;
	button?.props.onClick?.();
	await vi.waitFor(() => assert.equal(session.getSnapshot().busy, false));
	const request = session.getSnapshot().pending;
	assert.ok(request);
	assert.equal(PinConversationButton({ conversation, session, open: true })?.props.children?.props.disabled, true);
	button?.props.onClick?.();
	await Promise.resolve();
	assert.deepEqual(session.getSnapshot().pending, request);
	assert.deepEqual(calls, ["setConversationPinned", "getPresentationCommandResult"]);
	session.dispose();
});

test.each(["en", "zh-CN"])(
	"pinned rows retain canonical location and shared actions without SSR selection in %s",
	(language) => {
		locale = language;
		const navigationRoot = createRef<HTMLElement>();
		const cache = new QueryClient();
		cache.setQueryData(["pinned-conversations", "pages"], {
			pages: [
				{
					items: [{ conversation, presentation: { ...original, revision: 1, pinned: true } }],
					nextCursor: null,
					orderGeneration: 1,
					nextPinnedScope: null,
				},
			],
			pageParams: [undefined],
		});
		const local = new LocalState();
		const presentation = new PresentationSession(client, local);
		const html = renderToStaticMarkup(
			<ThemeProvider>
				<QueryClientProvider client={cache}>
					<aside ref={navigationRoot}>
						<SidebarSelectionProvider
							scope={conversation}
							preferredLocation={{ kind: "pinned" }}
							rootRef={navigationRoot}
						>
							<SidebarPreviewProvider disabled={false} navigationKey="pin-fixture">
								<PinnedConversations
									catalog={new CatalogSession(client, local)}
									presentation={presentation}
									onSelect={() => {}}
								/>
							</SidebarPreviewProvider>
						</SidebarSelectionProvider>
					</aside>
				</QueryClientProvider>
			</ThemeProvider>,
		);
		assert.match(html, /class="pinned-conversations"/);
		assert.match(html, /data-workspace-id="project" data-conversation-id="chat" data-sidebar-location="pinned"/);
		assert.match(html, /class="sidebar-preview-row conversation-preview-row" data-selected="false"/);
		assert.doesNotMatch(html, /aria-current=|data-sidebar-location-workspace=/);
		assert.match(html, /conversation-actions-trigger/);
		assert.match(html, language === "en" ? />Pinned<\/h3>/ : />已固定<\/h3>/);
		assert.doesNotMatch(html, /role="dialog"|checkbox|pin-count/);
		cache.clear();
		presentation.dispose();
	},
);

test("an unresolved pin exposes only exact lookup and explicit unchanged retry, with no extra confirmation dialog", async () => {
	const failed: AppClient = {
		call: async <M extends Method>(method: M) => {
			if (method === "getPresentationCommandResult") return parseResult(method, null);
			throw new Error("Unknown");
		},
		observe: client.observe,
	};
	const session = new PresentationSession(failed, new LocalState());
	await session.execute({
		workspaceId: "project",
		conversationId: "chat",
		requestId: "saved",
		expectedPresentationRevision: 0,
		pinned: true,
	});
	const html = renderToStaticMarkup(<PinRecovery session={session} />);
	assert.match(html, /Check pin change/);
	assert.match(html, /Retry original pin change/);
	assert.doesNotMatch(html, /role="dialog"/);
	session.dispose();
});

test("mixed pins render server project/conversation order without regrouping and keep canonical conversation scope", () => {
	const cache = new QueryClient();
	const project = {
		kind: "project" as const,
		project: { projectId: "logical", name: "Renamed logical", revision: 2, homeWorkspaceId: "adapter" },
		presentation: { projectId: "logical", pinned: true, revision: 1 },
	};
	cache.setQueryData(["sidebar-pins", "pages"], {
		pages: [
			{
				items: [
					project,
					{
						kind: "conversation",
						conversation,
						presentation: { ...original, revision: 1, pinned: true },
						membership: { workspaceId: "project", conversationId: "chat", projectId: "logical", revision: 1 },
					},
				],
				nextCursor: null,
				nextPinKey: null,
				orderRevision: 8,
			},
		],
		pageParams: [undefined],
	});
	const local = new LocalState();
	const presentation = new PresentationSession(client, local);
	const root = createRef<HTMLElement>();
	const html = renderToStaticMarkup(
		<ThemeProvider>
			<QueryClientProvider client={cache}>
				<aside ref={root}>
					<SidebarSelectionProvider scope={conversation} preferredLocation={{ kind: "pinned" }} rootRef={root}>
						<SidebarPreviewProvider disabled={false} navigationKey="mixed">
							<PinnedConversations
								mixed
								catalog={new CatalogSession(client, local)}
								presentation={presentation}
								onSelect={() => {}}
								renderProject={(item, action) => {
									assert.equal(action?.item.group, "pinned");
									assert.match(action?.item.id ?? "", /logical/);
									return (
										<li key={item.project.projectId} data-pinned-project="">
											{item.project.name}
										</li>
									);
								}}
							/>
						</SidebarPreviewProvider>
					</SidebarSelectionProvider>
				</aside>
			</QueryClientProvider>
		</ThemeProvider>,
	);
	assert.ok(html.indexOf("Renamed logical") < html.indexOf("A real task"));
	assert.match(html, /data-workspace-id="project" data-conversation-id="chat" data-sidebar-location="pinned"/);
	assert.doesNotMatch(html, /data-workspace-id="adapter"/);
	assert.equal(
		vi.mocked(client.call).mock.calls.length,
		0,
		"SSR and closed previews do not request per-row project metadata",
	);
	cache.clear();
	presentation.dispose();
});
