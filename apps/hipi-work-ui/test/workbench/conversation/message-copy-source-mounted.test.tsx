// @vitest-environment jsdom
import assert from "node:assert/strict";
import type { Message } from "@hipi/work-runtime/contracts";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { test, vi } from "vitest";
import { useMessageCopyText } from "../../../src/features/workbench/conversation/use-message-copy-text.ts";

test("only complete current-message hydration enables copy; stale scope and preview cannot supply copied text", async () => {
	vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
	const host = document.createElement("div");
	const root = createRoot(host);
	let accept: (text: string | undefined) => void = () => {};
	const full = "# Complete\n\n**final body**";
	const message: Message = {
		id: "1_0",
		role: "assistant",
		text: full.slice(0, 5),
		textLength: full.length,
		truncated: true,
	};
	function Fixture({ conversation = "first", value = message }: { conversation?: string; value?: Message }) {
		const source = useMessageCopyText({ workspaceId: "w", conversationId: conversation }, value);
		accept = source.accept;
		return <output>{source.text ?? "unavailable"}</output>;
	}
	try {
		await act(async () => root.render(<Fixture />));
		assert.equal(host.textContent, "unavailable");
		await act(async () => accept(message.text));
		assert.equal(host.textContent, "unavailable");
		await act(async () => accept(full));
		assert.equal(host.textContent, full);
		const stale = accept;
		await act(async () => root.render(<Fixture conversation="second" />));
		assert.equal(host.textContent, "unavailable");
		await act(async () => stale(full));
		assert.equal(host.textContent, "unavailable");
		await act(async () => accept(full));
		assert.equal(host.textContent, full);
		await act(async () => stale(undefined));
		assert.equal(host.textContent, full);
		await act(async () => accept(undefined));
		assert.equal(host.textContent, "unavailable");
		const user = { ...message, role: "user" as const, text: "  exact\n", textLength: 8, truncated: false };
		await act(async () => root.render(<Fixture value={user} />));
		assert.equal(host.textContent, user.text);
	} finally {
		await act(async () => root.unmount());
		vi.unstubAllGlobals();
	}
});
