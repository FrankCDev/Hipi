import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createModels, fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai";
import { createFileAuthority, type TrustedAgentFileService } from "../src/files/service.ts";
import { openRuntime } from "../src/node.ts";

async function until<T>(read: () => Promise<T | undefined>): Promise<T> {
	const deadline = Date.now() + 10000;
	while (Date.now() < deadline) {
		const value = await read();
		if (value !== undefined) return value;
		await new Promise((resolve) => setTimeout(resolve, 10));
	}
	throw new Error("Timed out");
}
async function fixture(text: string, transform?: (port: TrustedAgentFileService) => TrustedAgentFileService) {
	const directory = await mkdtemp(join(tmpdir(), "hipi-pack-loop-"));
	await writeFile(join(directory, "note.txt"), text);
	const authority = createFileAuthority({
		securityMode: "cooperative-local-files",
		assertWorkspaceAccess: async () => {},
	});
	const root = await authority.grantRoot({
		principalId: "owner",
		workspaceId: "work",
		absolutePath: directory,
		writable: true,
	});
	const files = authority.forAgent("owner");
	const faux = fauxProvider({
		provider: "faux",
		api: "test",
		models: [{ id: "one", contextWindow: 100000, maxTokens: 1000 }],
		tokensPerSecond: 100000,
	});
	const models = createModels();
	models.setProvider(faux.provider);
	const model = { provider: "faux", modelId: "one" };
	const runtime = await openRuntime(join(directory, "store"), {
		models,
		model,
		agentFiles: () => (transform ? transform(files) : files),
	});
	await runtime.call("createWorkspace", { workspaceId: "work", name: "Work" });
	const scope = await runtime.call("createConversation", {
		workspaceId: "work",
		requestId: "create",
		title: "Pack test",
	});
	const packageText = JSON.stringify({
		formatVersion: 1,
		id: "example.cleanup",
		version: "1.0.0",
		name: "Cleanup",
		description: "Trim trailing spaces",
		tools: [{ id: "clean", name: "Clean", description: "Cleanup file", pipeline: [{ op: "trimLineEnds" }] }],
	});
	const preview = await runtime.call("previewToolPack", { workspaceId: "work", packageText });
	const pack = await runtime.call("installToolPack", {
		workspaceId: "work",
		requestId: "install",
		packageText,
		expectedDigest: preview.digest,
		disclosureVersion: 1,
	});
	const enabled = await runtime.call("setToolPackEnabled", {
		workspaceId: "work",
		requestId: "enable",
		digest: pack.digest,
		expectedRevision: pack.revision,
		enabled: true,
	});
	await runtime.call("bindToolPack", {
		workspaceId: "work",
		conversationId: scope.conversationId,
		requestId: "bind",
		digest: enabled.digest,
		expectedPackRevision: enabled.revision,
		model,
		expiresAt: Date.now() + 60000,
		disclosureVersion: 1,
	});
	await runtime.call("authorizeAgentContext", {
		workspaceId: "work",
		conversationId: scope.conversationId,
		requestId: "files",
		rootId: root.rootId,
		pathPrefixes: [""],
		model,
		expiresAt: Date.now() + 60000,
		disclosureVersion: 1,
	});
	const toolName = `pack_${preview.digest.slice(0, 32)}_clean`;
	return {
		pack: enabled,
		initial: await files.readText({ workspaceId: "work", rootId: root.rootId, path: "note.txt" }),
		directory,
		runtime,
		faux,
		scope,
		root,
		toolName,
		submit: () =>
			runtime.call("submit", {
				workspaceId: "work",
				conversationId: scope.conversationId,
				requestId: "input",
				text: "Clean the file and save after approval.",
			}),
		done: () =>
			until(async () => {
				const receipt = await runtime.call("getReceipt", { workspaceId: "work", requestId: "input" });
				return receipt?.execution === "done" || receipt?.execution === "unanswered" ? receipt : undefined;
			}),
		async close() {
			await runtime.close();
			await authority.close();
			await rm(directory, { recursive: true, force: true });
		},
	};
}
test("installed declarative tool transforms a real authorized file and core save still waits for approval", async () => {
	const f = await fixture("one  \ntwo\t");
	try {
		let transformed = false;
		f.faux.setResponses([
			fauxAssistantMessage([fauxToolCall(f.toolName, { rootId: f.root.rootId, path: "note.txt" })], {
				stopReason: "toolUse",
			}),
			(transcript) => {
				const result = transcript.messages.findLast((message) => message.role === "toolResult");
				assert.ok(result && result.role === "toolResult");
				assert.equal(result.isError, false);
				const text = result.content.find((content) => content.type === "text");
				assert.ok(text && text.type === "text");
				const value: unknown = JSON.parse(text.text);
				assert.ok(value && typeof value === "object" && "text" in value && "revision" in value);
				assert.equal(value.text, "one\ntwo");
				assert.ok(typeof value.text === "string" && typeof value.revision === "string");
				transformed = true;
				return fauxAssistantMessage(
					[
						fauxToolCall("hipi_files_save", {
							rootId: f.root.rootId,
							path: "note.txt",
							text: value.text,
							ifMatch: value.revision,
						}),
					],
					{ stopReason: "toolUse" },
				);
			},
			fauxAssistantMessage("Saved"),
		]);
		await f.submit();
		const approval = await until(
			async () =>
				(
					await f.runtime.call("listPendingToolApprovals", {
						workspaceId: "work",
						conversationId: f.scope.conversationId,
					})
				).items[0],
		);
		assert.equal(transformed, true);
		assert.equal(await readFile(join(f.directory, "note.txt"), "utf8"), "one  \ntwo\t");
		await f.runtime.call("decideToolApproval", {
			workspaceId: "work",
			conversationId: f.scope.conversationId,
			requestId: "approve",
			approvalId: approval.approvalId,
			expectedRevision: approval.revision,
			argumentsDigest: approval.argumentsDigest,
			contentDigest: approval.contentDigest,
			decision: "approve",
		});
		assert.equal((await f.done()).execution, "done");
		assert.equal(await readFile(join(f.directory, "note.txt"), "utf8"), "one\ntwo");
	} finally {
		await f.close();
	}
});
test("whole-file transform refuses a paginated 8193-byte file rather than truncating", async () => {
	const f = await fixture("x".repeat(8193));
	try {
		let refused = false;
		f.faux.setResponses([
			fauxAssistantMessage([fauxToolCall(f.toolName, { rootId: f.root.rootId, path: "note.txt" })], {
				stopReason: "toolUse",
			}),
			(transcript) => {
				const result = transcript.messages.findLast((message) => message.role === "toolResult");
				assert.ok(result && result.role === "toolResult");
				refused = result.isError;
				return fauxAssistantMessage("Too large");
			},
		]);
		await f.submit();
		await f.done();
		assert.equal(refused, true);
		assert.equal((await readFile(join(f.directory, "note.txt"))).byteLength, 8193);
	} finally {
		await f.close();
	}
});

test("workspace pack disable after approval consumption wins before the final filesystem commit gate", async () => {
	const entered = Promise.withResolvers<void>();
	const proceed = Promise.withResolvers<void>();
	const f = await fixture("original", (port) => ({
		...port,
		saveText: async (target, text, revision, guard) => {
			entered.resolve();
			await proceed.promise;
			return port.saveText(target, text, revision, guard);
		},
	}));
	try {
		f.faux.setResponses([
			fauxAssistantMessage(
				[
					fauxToolCall("hipi_files_save", {
						rootId: f.root.rootId,
						path: "note.txt",
						text: "replacement",
						ifMatch: f.initial.revision,
					}),
				],
				{ stopReason: "toolUse" },
			),
			fauxAssistantMessage("Stopped"),
		]);
		await f.submit();
		const approval = await until(
			async () =>
				(
					await f.runtime.call("listPendingToolApprovals", {
						workspaceId: "work",
						conversationId: f.scope.conversationId,
					})
				).items[0],
		);
		await f.runtime.call("decideToolApproval", {
			workspaceId: "work",
			conversationId: f.scope.conversationId,
			requestId: "approve",
			approvalId: approval.approvalId,
			expectedRevision: approval.revision,
			argumentsDigest: approval.argumentsDigest,
			contentDigest: approval.contentDigest,
			decision: "approve",
		});
		await entered.promise;
		const disabling = f.runtime.call("setToolPackEnabled", {
			workspaceId: "work",
			requestId: "disable",
			digest: f.pack.digest,
			expectedRevision: f.pack.revision,
			enabled: false,
		});
		await until(async () =>
			(await f.runtime.call("listToolPacks", { workspaceId: "work" })).items[0]?.status === "disabled"
				? true
				: undefined,
		);
		proceed.resolve();
		await disabling;
		await f.done();
		assert.equal(await readFile(join(f.directory, "note.txt"), "utf8"), "original");
		const operation = (
			await f.runtime.call("listToolApprovals", { workspaceId: "work", conversationId: f.scope.conversationId })
		).items[0];
		assert.ok(operation.operationId);
		assert.equal(
			(
				await f.runtime.call("getFileOperation", {
					workspaceId: "work",
					conversationId: f.scope.conversationId,
					operationId: operation.operationId,
				})
			)?.status,
			"unknown",
		);
	} finally {
		proceed.resolve();
		await f.close();
	}
});
