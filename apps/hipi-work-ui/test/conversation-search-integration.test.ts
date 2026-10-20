import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { createModels, fauxAssistantMessage } from "@earendil-works/pi-ai";
import { type ConversationId, createRegistry, Harness } from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import type { AppClient, Method, Scope } from "@hipi/work-runtime/contracts";
import { openRuntime } from "@hipi/work-runtime/node";
import { deterministicModels, openTestRuntime } from "@hipi/work-runtime/testing";
// Fixture-only storage setup. Production UI imports only AppClient contracts.
import { ConversationMetaDoc } from "../../../packages/work-runtime/src/conversation-directory.ts";
import { ConversationHistoryController } from "../src/features/workbench/conversation-history-controller.ts";
import {
	ConversationSearchController,
	type ConversationSearchState,
} from "../src/features/workbench/conversation-search-controller.ts";
import { prepareSearchNavigation, readSearchHistoryWindow } from "../src/features/workbench/history-reads.ts";

async function seed(directory: string, scope: Scope, text: string) {
	const fixture = await Harness.open(
		await openNodeSqliteStorage(join(directory, scope.workspaceId, "workspace.sqlite")),
		{ models: deterministicModels(), registry: createRegistry() },
		context,
	);
	try {
		const metadata = (await fixture.snapshot(ConversationMetaDoc, scope.conversationId, context))?.value;
		assert.ok(metadata);
		const conversation = await fixture.conversation(metadata.durableId as ConversationId, context);
		assert.ok(conversation);
		const result = await (
			await conversation.submit(
				{
					type: "write",
					entry: {
						kind: "ui.search.fixture",
						model: [
							{ role: "user", content: text, timestamp: 0 },
							...Array.from({ length: 80 }, (_, index) => fauxAssistantMessage(`Later unrelated response ${index}`)),
						],
					},
				},
				context,
			)
		).wait(context);
		assert.equal(result.status, "done");
	} finally {
		await fixture.close(context);
	}
}
function until(owner: ConversationSearchController, ready: (state: ConversationSearchState) => boolean) {
	if (ready(owner.getSnapshot())) return Promise.resolve();
	return new Promise<void>((resolve, reject) => {
		const timer = setTimeout(() => {
			unsubscribe();
			reject(new Error("Search did not reach expected state"));
		}, 10000);
		const unsubscribe = owner.subscribe(() => {
			if (!ready(owner.getSnapshot())) return;
			clearTimeout(timer);
			unsubscribe();
			resolve();
		});
	});
}

test("real persisted corpus → UI search owner → validated old anchor stays bounded without starting execution", async () => {
	const directory = await mkdtemp(join(tmpdir(), "hipi-ui-search-"));
	let runtime = await openTestRuntime(directory);
	let search: ConversationSearchController | undefined;
	let history: ConversationHistoryController | undefined;
	try {
		await runtime.call("createWorkspace", { workspaceId: "collapsed", name: "Not loaded in sidebar" });
		const conversation = await runtime.call("createConversation", {
			workspaceId: "collapsed",
			requestId: "create",
			title: "Title does not contain query",
		});
		await runtime.close();
		const text = `${"before ".repeat(900)}😀 NeEdLe 中文 ${"after ".repeat(1000)}`;
		await seed(directory, conversation, text);
		runtime = await openRuntime(directory, {
			models: createModels(),
			resume: true,
			catalogFailpoint: async () => {
				throw new Error("Search or hydration opened a Harness");
			},
		});
		const calls: Method[] = [];
		const client: AppClient = {
			call(method, params, signal) {
				calls.push(method);
				return runtime.call(method, params, signal);
			},
			async observe() {
				throw new Error("Search must not observe execution");
			},
		};
		search = new ConversationSearchController(client);
		search.activate();
		search.setQuery("needle 中文");
		await until(
			search,
			(state) =>
				!state.loading &&
				!state.refreshing &&
				state.index?.state === "ready" &&
				state.queryGeneration === state.index.generation &&
				state.items.length === 1,
		);
		const hit = search.getSnapshot().items[0];
		assert.ok(hit?.kind === "message");
		assert.equal(hit.workspaceId, "collapsed");
		assert.ok(hit.matchStart > 4096, "Hit is outside the normal message preview");
		const opened = await prepareSearchNavigation(client, hit, new AbortController().signal);
		assert.ok(opened.anchor);
		assert.equal(opened.conversation.conversationId, conversation.conversationId);
		const { window } = opened.anchor;
		assert.ok(window.messages.length <= 32);
		assert.ok(window.newerCursor, "The old match is separated from the last of 80 newer messages");
		assert.equal(
			window.target.text.slice(window.matchStart - window.target.offset, window.matchEnd - window.target.offset),
			"NeEdLe 中文",
		);
		history = new ConversationHistoryController(
			conversation,
			async () => {
				throw new Error("Anchored reading must not bridge via getHistory");
			},
			() => {},
			(locator, cursor, signal) => readSearchHistoryWindow(client, conversation, locator, signal, cursor),
		);
		history.openAnchor(opened.anchor);
		history.update({
			...conversation,
			messages: [{ id: "live", role: "assistant", text: "live", textLength: 4, truncated: false }],
			partial: "streaming tail",
			partialLength: 14,
			partialTruncated: false,
			running: true,
			historyCursor: "far-tail",
		});
		history.setNearTop(true);
		assert.equal(history.state.snapshot?.messages.length, window.messages.length);
		assert.equal(history.state.snapshot?.partial, "");
		history.loadAnchored("newer");
		await new Promise<void>((resolve, reject) => {
			const timer = setTimeout(() => {
				clearInterval(check);
				reject(new Error("Directional history did not finish"));
			}, 10000);
			const check = setInterval(() => {
				if (history?.state.loading) return;
				clearInterval(check);
				clearTimeout(timer);
				resolve();
			}, 5);
		});
		assert.equal(history.state.failed, false);
		assert.ok((history.state.snapshot?.messages.length ?? 0) <= 64);
		assert.equal(calls.filter((method) => method === "getHistoryAroundMatch").length, 2);
		assert.equal(
			calls.some((method) =>
				["snapshot", "getHistory", "getMessageText", "continueWorkspace", "submit"].includes(method),
			),
			false,
		);
		history.resetToLatest();
		assert.equal(history.state.anchor, undefined);
		assert.deepEqual(
			history.state.snapshot?.messages.map((message) => message.id),
			["live"],
		);
	} finally {
		search?.dispose();
		history?.dispose();
		await runtime.close();
		await rm(directory, { recursive: true, force: true });
	}
});
