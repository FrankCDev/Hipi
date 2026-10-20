import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createModels, fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai";
import type { AppClient, Method, Params } from "@hipi/work-runtime/contracts";
import { createFileAuthority } from "@hipi/work-runtime/files/node";
import { createRuntimeProjectFolders, openRuntime } from "@hipi/work-runtime/node";
import { CatalogSession } from "../src/features/workbench/catalog-session.ts";
import type { InitialSendInput } from "../src/features/workbench/initial-send.ts";
import { LocalState } from "../src/features/workbench/local-state.ts";

async function until<T>(read: () => Promise<T | undefined>): Promise<T> {
	const deadline = Date.now() + 10000;
	while (Date.now() < deadline) {
		const value = await read();
		if (value !== undefined) return value;
		await new Promise((resolve) => setTimeout(resolve, 10));
	}
	throw new Error("Condition timed out");
}

test("the first project Send reaches the real provider only after its exact grant, without host paths or inherited roots", async () => {
	const directory = await mkdtemp(join(tmpdir(), "hipi-initial-context-"));
	await writeFile(join(directory, "note.txt"), "Project notes");
	const authority = createFileAuthority({
		securityMode: "cooperative-local-files",
		assertWorkspaceAccess: async () => {},
	});
	const faux = fauxProvider({
		provider: "faux",
		api: "hipi-initial-context-test",
		models: [{ id: "faux-1", contextWindow: 100000, maxTokens: 1000 }],
		tokensPerSecond: 100000,
	});
	const models = createModels();
	models.setProvider(faux.provider);
	const model = { provider: "faux", modelId: "faux-1" };
	const runtime = await openRuntime(join(directory, "store"), {
		models,
		model,
		agentFiles: () => authority.forAgent("owner"),
	});
	const projects = createRuntimeProjectFolders(runtime, authority, "owner");
	assert.ok(projects);
	const entered = Promise.withResolvers<void>();
	const allowGrant = Promise.withResolvers<void>();
	const providerEntered = Promise.withResolvers<void>();
	const allowAnswer = Promise.withResolvers<void>();
	const calls: { method: Method; params: unknown }[] = [];
	const client: AppClient = {
		call: async <M extends Method>(method: M, params: Params<M>, signal?: AbortSignal) => {
			calls.push({ method, params: structuredClone(params) });
			if (method === "authorizeAgentContext") {
				entered.resolve();
				await allowGrant.promise;
			}
			return runtime.call(method, params, signal);
		},
		observe: runtime.observe,
	};
	const local = new LocalState();
	const session = new CatalogSession(client, local, { getProject: projects.get });
	try {
		await runtime.call("createWorkspace", { workspaceId: "project", name: "Project" });
		await runtime.call("createWorkspace", { workspaceId: "other", name: "Other" });
		const folder = await projects.bind("project", directory, null);
		const other = await projects.bind("other", directory, null);
		assert.equal(folder.status, "available");
		assert.ok(folder.bindingId && folder.root && other.root);
		const rootId = folder.root.rootId;
		const otherRootId = other.root.rootId;
		const text = "  What files may you use in this project?  ";
		local.write("task-draft.project", text);
		const input: InitialSendInput = {
			workspaceId: "project",
			sourceKey: "task-draft.project",
			title: "Inspect project",
			text,
			model,
			context: {
				workspaceId: "project",
				bindingId: folder.bindingId,
				bindingRevision: folder.revision,
				rootId,
				model,
				pathPrefixes: ["note.txt"],
				expiresAt: Date.now() + 60000,
				disclosureVersion: 1,
			},
		};
		faux.setResponses([
			async (context) => {
				providerEntered.resolve();
				const messages = JSON.stringify(context.messages);
				const system = JSON.stringify(context.messages.filter((message) => message.role === "system"));
				assert.ok(system.includes(rootId));
				assert.ok(system.includes("note.txt"));
				assert.ok(!messages.includes(otherRootId));
				assert.ok(!messages.includes(directory), "host paths are not model context");
				assert.ok(!messages.includes(folder.bindingId ?? ""), "binding identities are local UI provenance");
				assert.ok(messages.includes(text.trim()), "the meaningful first question reaches the provider");
				await allowAnswer.promise;
				return fauxAssistantMessage("Only the permitted project notes are available.");
			},
		]);
		const run = session.sendInitial(input);
		await until(async () => {
			assert.equal(session.getSnapshot().failed, false, JSON.stringify({ state: session.getSnapshot(), calls }));
			return calls.some((call) => call.method === "authorizeAgentContext") ? true : undefined;
		});
		await entered.promise;
		const conversations = await runtime.call("listConversations", { workspaceId: "project" });
		assert.equal(conversations.items.length, 1);
		const conversationId = conversations.items[0]?.conversationId;
		assert.ok(conversationId);
		assert.deepEqual(await runtime.call("listActiveAgentContexts", { workspaceId: "project", conversationId }), []);
		assert.equal(faux.state.callCount, 0);
		assert.equal(calls.filter((call) => call.method === "submit").length, 0);
		assert.equal(local.pending(`project.${conversationId}`), null);
		await session.sendInitial(input);
		allowGrant.resolve();
		await run;
		assert.equal(session.getSnapshot().failed, false);
		assert.equal(
			session.getSnapshot().initialSend,
			null,
			"acceptance releases the prerequisite owner before generation",
		);
		assert.equal(session.getSnapshot().receipt?.state, "accepted");
		await providerEntered.promise;
		assert.equal(calls.filter((call) => call.method === "createConversation").length, 1);
		assert.equal(calls.filter((call) => call.method === "authorizeAgentContext").length, 1);
		assert.equal(calls.filter((call) => call.method === "submit").length, 1);
		assert.equal(faux.state.callCount, 1);
		allowAnswer.resolve();
		const submission = session.getSnapshot().submission;
		assert.ok(submission);
		const receipt = await until(async () => {
			const result = await runtime.call("getReceipt", {
				workspaceId: "project",
				requestId: submission.requestId,
			});
			assert.notEqual(result?.execution, "unanswered", JSON.stringify(result));
			return result?.execution === "done" ? result : undefined;
		});
		assert.equal(receipt.answer, "Only the permitted project notes are available.");
		const second = new CatalogSession(client, local, { getProject: projects.get });
		faux.setResponses([
			(context) => {
				const transcript = JSON.stringify(context.messages);
				assert.ok(!transcript.includes(rootId), "a later new chat does not inherit consent");
				assert.ok(!transcript.includes(otherRootId));
				assert.ok(!transcript.includes(directory));
				assert.ok(transcript.includes("Permissions (权限)"));
				return fauxAssistantMessage("Use the app permissions to share project files.");
			},
		]);
		await second.sendInitial({ ...input, context: undefined, text: "A different question" });
		assert.equal(second.getSnapshot().failed, false);
		const secondSubmission = second.getSnapshot().submission;
		assert.ok(secondSubmission);
		assert.notEqual(secondSubmission.conversationId, conversationId);
		await until(async () => {
			const result = await runtime.call("getReceipt", {
				workspaceId: "project",
				requestId: secondSubmission.requestId,
			});
			return result?.execution === "done" ? result : undefined;
		});
		assert.equal(faux.state.callCount, 2);
		assert.equal(calls.filter((call) => call.method === "authorizeAgentContext").length, 1);
		second.dispose();
	} finally {
		allowGrant.resolve();
		allowAnswer.resolve();
		session.dispose();
		await projects.close();
		await runtime.close();
		await authority.close();
		await rm(directory, { recursive: true, force: true });
	}
});
