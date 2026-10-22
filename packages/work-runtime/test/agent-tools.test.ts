import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createModels, fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai";
import type { ToolApproval } from "../src/contracts.ts";
import { createFileAuthority, type TrustedAgentFileService } from "../src/files/service.ts";
import { createRuntimeProjectFolders, openRuntime } from "../src/node.ts";
import type { Failpoint } from "../src/pi-workspace.ts";

async function until<T>(read: () => Promise<T | undefined>): Promise<T> {
	const deadline = Date.now() + 10000;
	while (Date.now() < deadline) {
		const value = await read();
		if (value !== undefined) return value;
		await new Promise((resolve) => setTimeout(resolve, 10));
	}
	throw new Error("Condition timed out");
}
async function fixture(
	transform?: (port: TrustedAgentFileService) => TrustedAgentFileService,
	failpoint?: (point: Failpoint) => Promise<void>,
) {
	const directory = await mkdtemp(join(tmpdir(), "hipi-tool-loop-"));
	const filename = join(directory, "note.txt");
	await writeFile(filename, "original");
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
	const current = await files.readText({ ...root, path: "note.txt" });
	const faux = fauxProvider({
		provider: "faux",
		api: "hipi-test",
		models: [{ id: "faux-1", contextWindow: 100000, maxTokens: 1000 }],
		tokensPerSecond: 100000,
	});
	const models = createModels();
	models.setProvider(faux.provider);
	const options = {
		failpoint,
		models,
		model: { provider: "faux", modelId: "faux-1" },
		agentFiles: () => (transform ? transform(files) : files),
	};
	let runtime = await openRuntime(join(directory, "store"), options);
	await runtime.call("createWorkspace", { workspaceId: "work", name: "Work" });
	const scope = await runtime.call("createConversation", {
		workspaceId: "work",
		requestId: "create-file-task",
		title: "File task",
	});
	const args = { rootId: root.rootId, path: "note.txt", text: "replacement", ifMatch: current.revision };
	const save = () =>
		fauxAssistantMessage([fauxToolCall("hipi_files_save", args, { id: "save-1" })], { stopReason: "toolUse" });
	return {
		directory,
		filename,
		authority,
		files,
		root,
		faux,
		scope,
		args,
		save,
		get runtime() {
			return runtime;
		},
		async reopen() {
			await runtime.close();
			runtime = await openRuntime(join(directory, "store"), options);
			await runtime.call("openWorkspace", { workspaceId: "work" });
		},
		authorize: () =>
			runtime.call("authorizeAgentContext", {
				workspaceId: scope.workspaceId,
				conversationId: scope.conversationId,
				requestId: "grant-1",
				rootId: root.rootId,
				pathPrefixes: [""],
				model: options.model,
				expiresAt: Date.now() + 60000,
				disclosureVersion: 1,
			}),
		approval: () =>
			until(
				async () =>
					(
						await runtime.call("listToolApprovals", {
							workspaceId: scope.workspaceId,
							conversationId: scope.conversationId,
						})
					).items[0],
			),
		decide: (value: ToolApproval, decision: "approve" | "reject" = "approve") =>
			runtime.call("decideToolApproval", {
				workspaceId: scope.workspaceId,
				conversationId: scope.conversationId,
				requestId: "decision-1",
				approvalId: value.approvalId,
				expectedRevision: value.revision,
				argumentsDigest: value.argumentsDigest,
				contentDigest: value.contentDigest,
				decision,
			}),
		submit: () =>
			runtime.call("submit", {
				workspaceId: scope.workspaceId,
				conversationId: scope.conversationId,
				requestId: "input-1",
				text: "Update the file.",
			}),
		done: () =>
			until(async () => {
				const r = await runtime.call("getReceipt", { workspaceId: "work", requestId: "input-1" });
				return r?.execution === "done" || r?.execution === "unanswered" ? r : undefined;
			}),
		async close() {
			await runtime.close();
			await authority.close();
			await rm(directory, { recursive: true, force: true });
		},
	};
}

test("real Durable model call waits for approval then saves a real file and answers", async () => {
	const f = await fixture();
	try {
		await f.authorize();
		f.faux.setResponses([f.save(), fauxAssistantMessage("Saved the file.")]);
		await f.submit();
		const approval = await f.approval();
		assert.equal(approval.status, "pending");
		assert.equal(approval.beforeText, "original");
		assert.equal(approval.submissionIds.length, 1);
		assert.equal(approval.receiptIds.length, 1);
		assert.equal(await readFile(f.filename, "utf8"), "original");
		await f.decide(approval);
		assert.match((await f.done()).answer ?? "", /Saved/);
		assert.equal(await readFile(f.filename, "utf8"), "replacement");
		const consumed = await f.approval();
		assert.equal(consumed.status, "consumed");
		assert.ok(consumed.operationId);
		assert.equal(
			(
				await f.runtime.call("getFileOperation", {
					workspaceId: "work",
					conversationId: f.scope.conversationId,
					operationId: consumed.operationId,
				})
			)?.status,
			"confirmed",
		);
	} finally {
		await f.close();
	}
});

test("manual root grant does not permit file access or create approval", async () => {
	const f = await fixture();
	try {
		f.faux.setResponses([f.save(), fauxAssistantMessage("Not authorized.")]);
		await f.submit();
		await f.done();
		assert.deepEqual(
			(await f.runtime.call("listToolApprovals", { workspaceId: "work", conversationId: f.scope.conversationId }))
				.items,
			[],
		);
		assert.equal(await readFile(f.filename, "utf8"), "original");
	} finally {
		await f.close();
	}
});

for (const decision of ["reject", "cancel", "revoke", "restart"] as const) {
	test(`${decision} while approval is pending never writes`, async () => {
		const f = await fixture();
		try {
			const grant = await f.authorize();
			f.faux.setResponses([f.save(), fauxAssistantMessage("No write.")]);
			await f.submit();
			const approval = await f.approval();
			if (decision === "reject") {
				await f.decide(approval, "reject");
				await f.done();
			}
			if (decision === "cancel")
				await f.runtime.call("cancelExecution", { workspaceId: "work", conversationId: f.scope.conversationId });
			if (decision === "revoke")
				await f.runtime.call("revokeAgentContext", {
					workspaceId: "work",
					conversationId: f.scope.conversationId,
					requestId: "revoke-1",
					grantId: grant.grantId,
					expectedRevision: grant.revision,
				});
			if (decision === "restart") {
				await f.reopen();
				await f.runtime.call("authorizeRetainedContext", {
					workspaceId: "work",
					conversationId: f.scope.conversationId,
					requestId: "retained-pending",
					sourceGrantId: grant.grantId,
					model: grant.model,
					expiresAt: Date.now() + 60000,
					disclosureVersion: 1,
				});
				assert.equal((await f.approval()).status, "invalidated");
				await f.runtime.call("continueWorkspace", { workspaceId: "work" });
				await f.done();
			}
			assert.equal(await readFile(f.filename, "utf8"), "original");
			await assert.rejects(f.decide(approval), (error: unknown) => error instanceof Error);
		} finally {
			await f.close();
		}
	});
}

test("unknown write is read-only reconciled and never replayed", async () => {
	let writes = 0;
	const f = await fixture((port) => ({
		...port,
		saveText: async (...args) => {
			writes++;
			await port.saveText(...args);
			throw new Error("lost acknowledgement");
		},
	}));
	try {
		await f.authorize();
		f.faux.setResponses([f.save(), fauxAssistantMessage("Outcome unknown.")]);
		await f.submit();
		await f.decide(await f.approval());
		await f.done();
		const approval = await f.approval();
		assert.ok(approval.operationId);
		const query = { workspaceId: "work", conversationId: f.scope.conversationId, operationId: approval.operationId };
		assert.equal((await f.runtime.call("getFileOperation", query))?.status, "unknown");
		assert.equal((await f.runtime.call("getFileOperation", { ...query, reconcile: true }))?.status, "observed_match");
		assert.equal(writes, 1);
		assert.equal(await readFile(f.filename, "utf8"), "replacement");
	} finally {
		await f.close();
	}
});

test("authorized roots are discoverable and UTF-8 read pages never flood the model; revoke blocks new admission", async () => {
	const f = await fixture();
	try {
		await writeFile(f.filename, "文🙂".repeat(15000));
		const grant = await f.authorize();
		let nextOffset: number | undefined;
		let revision: string | undefined;
		f.faux.setResponses([
			(context) => {
				const prompt = JSON.stringify(context.messages.filter((message) => message.role === "system"));
				assert.ok(prompt.includes(f.root.rootId));
				return fauxAssistantMessage(
					[fauxToolCall("hipi_files_read", { rootId: f.root.rootId, path: "note.txt" }, { id: "read-1" })],
					{ stopReason: "toolUse" },
				);
			},
			(context) => {
				const result = context.messages.find((message) => message.role === "toolResult");
				assert.ok(result && result.role === "toolResult");
				const content = result.content.find((item) => item.type === "text");
				assert.ok(content && content.type === "text");
				const value = JSON.parse(content.text) as { text: string; nextOffset: number; revision: string };
				assert.ok(Buffer.byteLength(value.text) <= 8192);
				assert.ok(value.nextOffset > 0);
				assert.equal(value.text, "文🙂".repeat(15000).slice(0, value.nextOffset));
				nextOffset = value.nextOffset;
				revision = value.revision;
				return fauxAssistantMessage("Read one bounded page.");
			},
		]);
		await f.submit();
		await f.done();
		assert.ok(nextOffset);
		assert.ok(revision);
		await f.runtime.call("revokeAgentContext", {
			workspaceId: "work",
			conversationId: f.scope.conversationId,
			requestId: "revoke-after-read",
			grantId: grant.grantId,
			expectedRevision: grant.revision,
		});
		await assert.rejects(
			f.runtime.call("submit", {
				workspaceId: "work",
				conversationId: f.scope.conversationId,
				requestId: "after-revoke",
				text: "Continue",
			}),
			{ code: "CONTEXT_AUTHORIZATION_REQUIRED" },
		);
	} finally {
		await f.close();
	}
});

test("without the trusted current-project capability, binding alone never infers model access from file roots", async () => {
	const f = await fixture();
	const projects = createRuntimeProjectFolders(f.runtime, f.authority, "owner");
	assert.ok(projects);
	const scope = { workspaceId: "work", conversationId: f.scope.conversationId };
	const run = async (requestId: string, conversationId = scope.conversationId) => {
		await f.runtime.call("submit", {
			workspaceId: "work",
			conversationId,
			requestId,
			text: "What is in this project?",
		});
		return until(async () => {
			const receipt = await f.runtime.call("getReceipt", { workspaceId: "work", requestId });
			return receipt?.execution === "done" || receipt?.execution === "unanswered" ? receipt : undefined;
		});
	};
	try {
		const bound = await projects.bind("work", f.directory, null);
		assert.ok(bound.root);
		const rootId = bound.root.rootId;
		assert.equal(bound.root.writable, false);
		await f.runtime.call("createWorkspace", { workspaceId: "other-project", name: "Other project" });
		const other = await projects.bind("other-project", f.directory, null);
		assert.ok(other.root);
		const otherRootId = other.root.rootId;
		f.faux.setResponses([
			(context) => {
				const transcript = JSON.stringify(context.messages);
				assert.ok(!transcript.includes(rootId));
				assert.ok(!transcript.includes(otherRootId));
				assert.ok(!transcript.includes(f.directory));
				assert.ok(transcript.includes("additional folders require explicit file-context permission"));
				assert.ok(!transcript.includes("Allow project access"));
				assert.ok(transcript.includes("never invent them or ask the user to type internal rootId"));
				assert.ok(!transcript.includes("Authorized file roots and relative path prefixes:"));
				return fauxAssistantMessage("Project access needs your permission.");
			},
		]);
		await run("before-project-consent");
		const grant = await f.runtime.call("authorizeAgentContext", {
			...scope,
			requestId: "project-consent",
			rootId,
			pathPrefixes: [""],
			model: { provider: "faux", modelId: "faux-1" },
			expiresAt: Date.now() + 60000,
			disclosureVersion: 1,
		});
		f.faux.setResponses([
			(context) => {
				const discovery = JSON.stringify(context.messages.filter((message) => message.role === "system").at(-1));
				assert.ok(
					discovery.includes(rootId),
					"the existing bounded grant prompt supplies the current project root",
				);
				assert.ok(!discovery.includes(otherRootId));
				assert.ok(!discovery.includes(f.root.rootId), "a separate manual writable grant is not model consent");
				assert.ok(!JSON.stringify(context.messages).includes(f.directory), "absolute host paths stay private");
				return fauxAssistantMessage([fauxToolCall("hipi_files_list", { rootId, path: "" })], {
					stopReason: "toolUse",
				});
			},
			(context) => {
				const result = context.messages.filter((message) => message.role === "toolResult").at(-1);
				assert.ok(result && result.role === "toolResult" && !result.isError);
				assert.ok(JSON.stringify(result).includes("note.txt"));
				return fauxAssistantMessage("The project contains note.txt.");
			},
		]);
		assert.equal((await run("after-project-consent")).answer, "The project contains note.txt.");
		await f.runtime.call("revokeAgentContext", {
			...scope,
			requestId: "revoke-project-consent",
			grantId: grant.grantId,
			expectedRevision: grant.revision,
		});
		const calls = f.faux.state.callCount;
		await assert.rejects(
			f.runtime.call("submit", { ...scope, requestId: "after-project-revoke", text: "Continue" }),
			{ code: "CONTEXT_AUTHORIZATION_REQUIRED" },
		);
		assert.equal(f.faux.state.callCount, calls);
		const second = await f.runtime.call("createConversation", {
			workspaceId: "work",
			requestId: "new-chat",
			title: "New chat",
		});
		f.faux.setResponses([
			(context) => {
				assert.ok(
					!JSON.stringify(context.messages).includes(rootId),
					"project membership never inherits another chat's consent",
				);
				return fauxAssistantMessage("This chat needs its own permission.");
			},
		]);
		await run("new-chat-no-consent", second.conversationId);
		assert.deepEqual(
			await f.runtime.call("listActiveAgentContexts", {
				workspaceId: "work",
				conversationId: second.conversationId,
			}),
			[],
		);
	} finally {
		await projects.close();
		await f.close();
	}
});

test("changed digest, stale revision and duplicate decision cannot produce a second write", async () => {
	let writes = 0;
	const f = await fixture((port) => ({
		...port,
		saveText: (...args) => {
			writes++;
			return port.saveText(...args);
		},
	}));
	try {
		await f.authorize();
		f.faux.setResponses([f.save(), fauxAssistantMessage("Saved.")]);
		await f.submit();
		const approval = await f.approval();
		await assert.rejects(f.decide({ ...approval, argumentsDigest: "0".repeat(64) }), {
			code: "IDEMPOTENCY_CONFLICT",
		});
		await assert.rejects(f.decide({ ...approval, revision: approval.revision + 1 }), {
			code: "IDEMPOTENCY_CONFLICT",
		});
		await f.decide(approval);
		await f.decide(approval);
		await f.done();
		await f.decide(approval);
		assert.equal(writes, 1);
	} finally {
		await f.close();
	}
});

test("expired pending approval cannot be approved or write", async () => {
	const f = await fixture();
	try {
		await f.runtime.call("authorizeAgentContext", {
			workspaceId: "work",
			conversationId: f.scope.conversationId,
			requestId: "short-grant",
			rootId: f.root.rootId,
			pathPrefixes: [""],
			model: { provider: "faux", modelId: "faux-1" },
			expiresAt: Date.now() + 1000,
			disclosureVersion: 1,
		});
		f.faux.setResponses([f.save(), fauxAssistantMessage("Expired.")]);
		await f.submit();
		const approval = await f.approval();
		await f.runtime.call("authorizeAgentContext", {
			workspaceId: "work",
			conversationId: f.scope.conversationId,
			requestId: "renewed-write-scope",
			rootId: f.root.rootId,
			pathPrefixes: [""],
			model: { provider: "faux", modelId: "faux-1" },
			expiresAt: Date.now() + 60000,
			disclosureVersion: 1,
		});
		await new Promise((resolve) => setTimeout(resolve, 1100));
		assert.equal((await f.approval()).status, "expired");
		await assert.rejects(f.decide(approval));
		assert.equal(await readFile(f.filename, "utf8"), "original");
	} finally {
		await f.close();
	}
});

test("cancel after approval consumption wins before the final rename gate", async () => {
	const entered = Promise.withResolvers<void>();
	const proceed = Promise.withResolvers<void>();
	const f = await fixture((port) => ({
		...port,
		saveText: async (target, text, ifMatch, guard) => {
			entered.resolve();
			await proceed.promise;
			return port.saveText(target, text, ifMatch, guard);
		},
	}));
	try {
		await f.authorize();
		f.faux.setResponses([f.save(), fauxAssistantMessage("Cancelled.")]);
		await f.submit();
		await f.decide(await f.approval());
		await entered.promise;
		const cancelling = f.runtime.call("cancelExecution", {
			workspaceId: "work",
			conversationId: f.scope.conversationId,
		});
		await until(async () => ((await f.approval()).status === "consumed" ? true : undefined));
		await new Promise((resolve) => setTimeout(resolve, 20));
		proceed.resolve();
		await cancelling;
		assert.equal(await readFile(f.filename, "utf8"), "original");
	} finally {
		proceed.resolve();
		await f.close();
	}
});

test("revoked conversation A cannot block resuming independently queued conversation B", async () => {
	let interrupt = false;
	const f = await fixture(undefined, async (point) => {
		if (interrupt && point === "after_accept") throw new Error("simulated interruption");
	});
	try {
		const grant = await f.authorize();
		f.faux.setResponses([f.save(), fauxAssistantMessage("B resumed.")]);
		await f.submit();
		await f.approval();
		await f.runtime.call("revokeAgentContext", {
			workspaceId: "work",
			conversationId: f.scope.conversationId,
			requestId: "revoke-A",
			grantId: grant.grantId,
			expectedRevision: grant.revision,
		});
		const b = await f.runtime.call("createConversation", { workspaceId: "work", requestId: "create-B", title: "B" });
		interrupt = true;
		await assert.rejects(
			f.runtime.call("submit", {
				workspaceId: "work",
				conversationId: b.conversationId,
				requestId: "input-B",
				text: "Only B may resume",
			}),
		);
		interrupt = false;
		await f.reopen();
		await f.runtime.call("continueWorkspace", { workspaceId: "work" });
		const result = await until(async () => {
			const value = await f.runtime.call("getReceipt", { workspaceId: "work", requestId: "input-B" });
			return value?.execution === "done" ? value : undefined;
		});
		assert.equal(result.answer, "B resumed.");
		assert.equal(await readFile(f.filename, "utf8"), "original");
	} finally {
		await f.close();
	}
});

test("host root revocation after asynchronous listing still prevents final model dispatch", async () => {
	let revoke: (() => void) | undefined;
	const f = await fixture((port) => ({
		...port,
		listRoots: async (workspaceId) => {
			const roots = await port.listRoots(workspaceId);
			revoke?.();
			return roots;
		},
	}));
	try {
		await f.authorize();
		revoke = () => f.authority.revokeRoot(f.root.rootId);
		f.faux.setResponses([fauxAssistantMessage("Must not be called")]);
		await f.submit();
		assert.equal((await f.done()).execution, "unanswered");
		assert.equal(f.faux.state.callCount, 0);
	} finally {
		await f.close();
	}
});

test("reselecting the same directory with a new root identity does not reauthorize old conversation history", async () => {
	const f = await fixture();
	try {
		const source = await f.authorize();
		f.faux.setResponses([
			fauxAssistantMessage([fauxToolCall("hipi_files_read", { rootId: f.root.rootId, path: "note.txt" })], {
				stopReason: "toolUse",
			}),
			fauxAssistantMessage("Read original file content."),
		]);
		await f.submit();
		await f.done();
		f.authority.revokeRoot(f.root.rootId);
		const replacement = await f.authority.grantRoot({
			principalId: "owner",
			workspaceId: "work",
			absolutePath: f.directory,
			writable: true,
		});
		assert.notEqual(replacement.rootId, f.root.rootId);
		await f.reopen();
		await f.runtime.call("authorizeAgentContext", {
			workspaceId: "work",
			conversationId: f.scope.conversationId,
			requestId: "new-root-grant",
			rootId: replacement.rootId,
			pathPrefixes: [""],
			model: { provider: "faux", modelId: "faux-1" },
			expiresAt: Date.now() + 60000,
			disclosureVersion: 1,
		});
		await assert.rejects(
			f.runtime.call("submit", {
				workspaceId: "work",
				conversationId: f.scope.conversationId,
				requestId: "old-history",
				text: "Continue",
			}),
			{ code: "CONTEXT_AUTHORIZATION_REQUIRED" },
		);
		assert.equal(f.faux.state.callCount, 2);
		const scope = { workspaceId: "work", conversationId: f.scope.conversationId };
		const request = {
			...scope,
			requestId: "retain-history",
			sourceGrantId: source.grantId,
			model: source.model,
			expiresAt: Date.now() + 60000,
			disclosureVersion: 1 as const,
		};
		const retained = await f.runtime.call("authorizeRetainedContext", request);
		assert.equal(retained.purpose, "retained-context");
		assert.equal(retained.rootId, f.root.rootId);
		assert.deepEqual(retained.pathPrefixes, source.pathPrefixes);
		assert.deepEqual(await f.runtime.call("authorizeRetainedContext", request), retained);
		await assert.rejects(
			f.runtime.call("authorizeRetainedContext", { ...request, expiresAt: request.expiresAt + 1 }),
			{ code: "IDEMPOTENCY_CONFLICT" },
		);
		for (const patch of [
			{ sourceGrantId: "forged" },
			{ sourceGrantId: retained.grantId },
			{ model: { ...source.model, modelId: "other" } },
		])
			await assert.rejects(
				f.runtime.call("authorizeRetainedContext", { ...request, requestId: "invalid", ...patch }),
				{ code: "UNAUTHORIZED" },
			);
		const other = await f.runtime.call("createConversation", {
			workspaceId: "work",
			requestId: "create-other",
			title: "Other",
		});
		await assert.rejects(
			f.runtime.call("authorizeRetainedContext", {
				...request,
				conversationId: other.conversationId,
				requestId: "cross-conversation",
			}),
			{ code: "UNAUTHORIZED" },
		);
		for (const expiresAt of [Date.now() - 1, Date.now() + 86410000])
			await assert.rejects(
				f.runtime.call("authorizeRetainedContext", { ...request, requestId: "invalid-expiry", expiresAt }),
				{ code: "INVALID_REQUEST" },
			);
		let oldRootDiscovered = false;
		let historyRetained = false;
		let oldReadRejected = false;
		f.faux.setResponses([
			(transcript) => {
				// PI preserves older system entries and appends section patches; only the latest discovery applies.
				const prompt = transcript.messages.filter((message) => message.role === "system").at(-1);
				oldRootDiscovered = JSON.stringify(prompt).includes(f.root.rootId);
				historyRetained = JSON.stringify(transcript.messages).includes("original");
				return fauxAssistantMessage(
					[fauxToolCall("hipi_files_read", { rootId: f.root.rootId, path: "note.txt" })],
					{ stopReason: "toolUse" },
				);
			},
			(transcript) => {
				const result = transcript.messages.filter((message) => message.role === "toolResult").at(-1);
				oldReadRejected = Boolean(result && result.role === "toolResult" && result.isError);
				return fauxAssistantMessage("Continued using retained content only.");
			},
		]);
		await f.runtime.call("cancelExecution", scope);
		await f.runtime.call("submit", { ...scope, requestId: "retained-answer", text: "Continue" });
		const answer = await until(async () => {
			const result = await f.runtime.call("getReceipt", { workspaceId: "work", requestId: "retained-answer" });
			return result?.execution === "done" || result?.execution === "unanswered" ? result : undefined;
		});
		assert.equal(answer.answer, "Continued using retained content only.", JSON.stringify(answer));
		assert.equal(oldRootDiscovered, false);
		assert.equal(historyRetained, true);
		assert.equal(oldReadRejected, true);
		await f.reopen();
		assert.equal((await f.runtime.call("authorizeRetainedContext", request)).status, "invalidated");
		await assert.rejects(f.runtime.call("submit", { ...scope, requestId: "restart-retained", text: "Continue" }), {
			code: "CONTEXT_AUTHORIZATION_REQUIRED",
		});
		assert.equal(await readFile(f.filename, "utf8"), "original");
	} finally {
		await f.close();
	}
});
