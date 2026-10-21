// @vitest-environment jsdom
import assert from "node:assert/strict";
import type { AppClient, Message, Scope } from "@hipi/work-runtime/contracts";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { test, vi } from "vitest";
import { AppClientProvider } from "../../../src/app/client-provider.tsx";
import { PreferencesProvider } from "../../../src/app/preferences.tsx";
import { MessageContent } from "../../../src/features/workbench/conversation/message-text-reader.tsx";

test("hydrated target renders the actual original UTF-16 match beyond the preview without requesting text", async () => {
	vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
	const call = vi.fn(async () => {
		throw new Error("A hydrated search target must not request text");
	});
	const observe = vi.fn(async () => {
		throw new Error("A hydrated search target must not observe execution");
	});
	const client: AppClient = { call, observe };
	const message: Message = {
		id: "1_0",
		role: "user",
		text: "preview without match",
		textLength: 20000,
		truncated: true,
	};
	const scope: Scope = { workspaceId: "closed", conversationId: "unloaded" };
	const host = document.createElement("div");
	document.body.append(host);
	const renderer = createRoot(host);
	try {
		await act(async () => {
			renderer.render(
				<AppClientProvider client={client}>
					<PreferencesProvider>
						<MessageContent
							message={message}
							scope={scope}
							offset={undefined}
							onOffsetChange={() => {}}
							searchAnchor={{
								...scope,
								messages: [message],
								target: {
									...scope,
									messageId: "1_0",
									text: "😀 NeEdLe 中文",
									offset: 9000,
									nextOffset: 9012,
									textLength: 20000,
								},
								matchStart: 9003,
								matchEnd: 9009,
								olderCursor: null,
								newerCursor: "opaque",
							}}
						/>
					</PreferencesProvider>
				</AppClientProvider>,
			);
		});
		assert.equal(
			host.querySelector(".search-match-text")?.innerHTML,
			'😀 <mark data-search-match="">NeEdLe</mark> 中文',
		);
		assert.equal(host.querySelectorAll("mark[data-search-match]").length, 1);
		assert.match(host.textContent ?? "", /9000–9012 \/ 20000/);
		assert.doesNotMatch(host.textContent ?? "", /preview without match/);
		assert.equal(call.mock.calls.length, 0);
		assert.equal(observe.mock.calls.length, 0);
	} finally {
		await act(async () => renderer.unmount());
		host.remove();
		vi.unstubAllGlobals();
	}
});
