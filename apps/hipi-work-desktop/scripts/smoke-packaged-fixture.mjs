// Source-only deterministic fixture producer; never included in the packaged application.
import assert from "node:assert/strict";
import { openTestRuntime } from "../../../packages/work-runtime/src/testing.ts";

const runtime = await openTestRuntime(process.argv[2], { tokensPerSecond: 100000 });
try {
	if (process.argv[3] === "reopen") {
		const conversationId = process.argv[4];
		assert.ok(conversationId);
		const receipt = await runtime.call("getReceipt", { workspaceId: "work", requestId: "submit" });
		assert.equal(receipt.execution, "done");
		const snapshot = await runtime.call("snapshot", { workspaceId: "work", conversationId });
		assert.match(JSON.stringify(snapshot.messages), /Packaged maintenance fixture 中文原文/);
		console.log(
			JSON.stringify({
				conversationId,
				execution: receipt.execution,
				messageIds: snapshot.messages.map((message) => message.id),
			}),
		);
	} else {
		assert.equal(process.argv.length, 3, "Unexpected maintenance fixture arguments");
		await runtime.call("createWorkspace", { workspaceId: "work", name: "打包 验证" });
		const conversation = await runtime.call("createConversation", {
			workspaceId: "work",
			requestId: "create",
			title: "历史 原文",
		});
		await runtime.call("submit", {
			workspaceId: "work",
			conversationId: conversation.conversationId,
			requestId: "submit",
			text: "Packaged maintenance fixture 中文原文",
		});
		const deadline = Date.now() + 20000;
		while ((await runtime.call("getReceipt", { workspaceId: "work", requestId: "submit" }))?.execution !== "done") {
			assert.ok(Date.now() < deadline, "Deterministic fixture did not finish");
			await new Promise((resolve) => setTimeout(resolve, 10));
		}
		const snapshot = await runtime.call("snapshot", {
			workspaceId: "work",
			conversationId: conversation.conversationId,
		});
		console.log(
			JSON.stringify({
				conversationId: conversation.conversationId,
				provider: "faux",
				execution: "done",
				messageIds: snapshot.messages.map((message) => message.id),
			}),
		);
	}
} finally {
	await runtime.close();
}
