import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { BACKGROUND_CONTEXT as background } from "@earendil-works/chord/context";
import { createModels, fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai";
import { type ConversationId, defineDocFamily, Harness, MemoryStorage } from "@earendil-works/pi-durable";
import { ContextDoc, DefaultProjectDoc } from "../src/agent-tools/authorization-store.ts";
import { createWorkspaceModels } from "../src/agent-tools/model-gate.ts";
import { AgentToolBroker, agentRegistry } from "../src/agent-tools.ts";
import { createFileAuthority, type TrustedAgentFileService, type TrustedProjectContext } from "../src/files/service.ts";
import { createRuntimeProjectFolders, openRuntime } from "../src/node.ts";
import type { Failpoint } from "../src/pi-workspace.ts";

const model = { provider: "faux", modelId: "faux-1" };
const secret = "project content from the real file";
function provider() {
	const faux = fauxProvider({
		provider: model.provider,
		api: "hipi-test",
		models: [{ id: model.modelId, contextWindow: 100000, maxTokens: 1000 }],
		tokensPerSecond: 1000000,
	});
	const models = createModels();
	models.setProvider(faux.provider);
	return { faux, models };
}
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
	transform: (files: TrustedAgentFileService) => TrustedAgentFileService = (files) => files,
	failpoint?: (point: Failpoint) => Promise<void>,
) {
	const directory = await mkdtemp(join(tmpdir(), "hipi-default-project-"));
	const folder = join(directory, "project");
	await mkdir(folder);
	await writeFile(join(folder, "note.txt"), secret);
	const { faux, models } = provider();
	const makeAuthority = () =>
		createFileAuthority({ securityMode: "cooperative-local-files", assertWorkspaceAccess: async () => {} });
	let authority = makeAuthority();
	let files: TrustedAgentFileService | undefined;
	const options = { models, model, agentFiles: () => files, failpoint };
	let runtime = await openRuntime(join(directory, "store"), options);
	await runtime.call("createWorkspace", { workspaceId: "work", name: "Work" });
	let projects = createRuntimeProjectFolders(runtime, authority, "owner");
	assert.ok(projects);
	const connect = () => {
		files = transform({
			...authority.forAgent("owner"),
			currentProject: async (workspaceId) => {
				const current = await projects?.get(workspaceId);
				return current?.status === "available"
					? {
							workspaceId,
							bindingId: current.bindingId,
							bindingRevision: current.revision,
							root: current.root,
						}
					: null;
			},
		});
	};
	connect();
	await projects.bind("work", folder, null);
	const create = async (requestId = "create") => {
		const conversation = await runtime.call("createConversation", { workspaceId: "work", requestId, title: "Chat" });
		return { workspaceId: "work", conversationId: conversation.conversationId };
	};
	const scope = await create();
	const project = async () => {
		const current = await projects?.get("work");
		assert.equal(current?.status, "available");
		if (current?.status !== "available") throw new Error("Expected current project");
		return current;
	};
	return {
		directory,
		folder,
		faux,
		scope,
		create,
		project,
		get runtime() {
			return runtime;
		},
		get authority() {
			return authority;
		},
		get files() {
			assert.ok(files);
			return files;
		},
		get projects() {
			assert.ok(projects);
			return projects;
		},
		async reopen() {
			await runtime.close();
			await projects?.close();
			await authority.close();
			files = undefined;
			authority = makeAuthority();
			runtime = await openRuntime(join(directory, "store"), options);
			projects = createRuntimeProjectFolders(runtime, authority, "owner");
			connect();
			await runtime.call("openWorkspace", { workspaceId: "work" });
		},
		submit: (requestId: string, target = scope) =>
			runtime.call("submit", { ...target, requestId, text: "Read the file." }),
		done: (requestId: string) =>
			until(async () => {
				const receipt = await runtime.call("getReceipt", { workspaceId: "work", requestId });
				return receipt?.execution === "done" || receipt?.execution === "unanswered" ? receipt : undefined;
			}),
		authorize: (rootId: string, requestId = "grant", target = scope) =>
			runtime.call("authorizeAgentContext", {
				...target,
				requestId,
				rootId,
				pathPrefixes: [""],
				model,
				expiresAt: Date.now() + 60000,
				disclosureVersion: 1,
			}),
		async close() {
			await runtime.close();
			await projects?.close();
			await authority.close();
			await rm(directory, { recursive: true, force: true });
		},
	};
}
function read(rootId: string, path = "note.txt") {
	return fauxAssistantMessage([fauxToolCall("hipi_files_read", { rootId, path })], { stopReason: "toolUse" });
}

test("real creation owns default project reads without grants, and restart uses a fresh root for the same binding", async () => {
	const f = await fixture();
	try {
		const first = await f.project();
		assert.deepEqual(await f.create(), f.scope, "duplicate create returns the same conversation");
		assert.deepEqual(await f.runtime.call("listActiveAgentContexts", f.scope), []);
		f.faux.setResponses([
			(transcript) => {
				assert.ok(
					JSON.stringify(transcript.messages.filter((item) => item.role === "system")).includes(first.root.rootId),
				);
				return read(first.root.rootId);
			},
			(transcript) => {
				assert.ok(JSON.stringify(transcript.messages).includes(secret));
				return fauxAssistantMessage("Read project");
			},
		]);
		await f.submit("first");
		assert.equal((await f.done("first")).answer, "Read project");
		await f.reopen();
		assert.equal(f.faux.state.callCount, 2, "restart never submits or resumes by itself");
		const reopened = await f.project();
		assert.equal(reopened.bindingId, first.bindingId);
		assert.equal(reopened.revision, first.revision);
		assert.notEqual(reopened.root.rootId, first.root.rootId);
		assert.deepEqual(await f.runtime.call("listActiveAgentContexts", f.scope), []);
		f.faux.setResponses([
			(transcript) => {
				const latest = JSON.stringify(transcript.messages.filter((item) => item.role === "system").at(-1));
				assert.ok(latest.includes(reopened.root.rootId));
				assert.ok(!latest.includes(first.root.rootId));
				return read(first.root.rootId);
			},
			(transcript) => {
				const result = transcript.messages.filter((item) => item.role === "toolResult").at(-1);
				assert.ok(result?.role === "toolResult" && result.isError, "historical root cannot be a live tool target");
				return read(reopened.root.rootId);
			},
			() => fauxAssistantMessage("Read fresh root"),
		]);
		await f.submit("restart");
		assert.equal((await f.done("restart")).answer, "Read fresh root");
	} finally {
		await f.close();
	}
});

test("lost creation reply survives restart and replay with its original default project policy", async () => {
	let lost = false;
	const f = await fixture(undefined, async (point) => {
		if (lost && point === "after_directory_commit") throw new Error("lost creation reply");
	});
	try {
		lost = true;
		await assert.rejects(f.create("lost-create"), /lost creation reply/);
		const command = await f.runtime.call("getConversationCommandResult", {
			workspaceId: "work",
			requestId: "lost-create",
		});
		assert.equal(command?.method, "createConversation");
		assert.ok(command);
		await f.reopen();
		assert.equal(f.faux.state.callCount, 0);
		const scope = await f.create("lost-create");
		assert.equal(scope.conversationId, command.result.conversationId);
		assert.equal((await f.runtime.call("listConversations", { workspaceId: "work" })).items.length, 2);
		assert.deepEqual(await f.runtime.call("listActiveAgentContexts", scope), []);
		f.faux.setResponses([read((await f.project()).root.rootId), fauxAssistantMessage("Original default")]);
		await f.submit("after-lost-create", scope);
		assert.equal((await f.done("after-lost-create")).answer, "Original default");
	} finally {
		await f.close();
	}
});

test("a different binding permits clean/new chats but never silently carries old project history", async () => {
	const f = await fixture();
	try {
		const first = await f.project();
		const clean = await f.create("clean-before-rebind");
		f.faux.setResponses([read(first.root.rootId), fauxAssistantMessage("Read")]);
		await f.submit("read");
		await f.done("read");
		const second = await f.projects.bind("work", f.folder, first.bindingId);
		assert.notEqual(second.bindingId, first.bindingId);
		await assert.rejects(f.submit("old-history"), { code: "CONTEXT_AUTHORIZATION_REQUIRED" });
		for (const scope of [clean, await f.create("new-after-rebind")]) {
			const current = await f.project();
			f.faux.setResponses([read(current.root.rootId), fauxAssistantMessage("New binding")]);
			await f.submit(scope.conversationId, scope);
			assert.equal((await f.done(scope.conversationId)).answer, "New binding");
		}
	} finally {
		await f.close();
	}
});

test("matching explicit revoke vetoes the default binding across duplicate creation and restart", async () => {
	const f = await fixture();
	try {
		const current = await f.project();
		const grant = await f.authorize(current.root.rootId);
		f.faux.setResponses([read(current.root.rootId), fauxAssistantMessage("Read")]);
		await f.submit("read");
		await f.done("read");
		await f.runtime.call("revokeAgentContext", {
			...f.scope,
			requestId: "revoke",
			grantId: grant.grantId,
			expectedRevision: grant.revision,
		});
		assert.deepEqual(await f.create(), f.scope);
		await assert.rejects(f.submit("revoked"), { code: "CONTEXT_AUTHORIZATION_REQUIRED" });
		await f.reopen();
		await assert.rejects(f.submit("revoked-restart"), { code: "CONTEXT_AUTHORIZATION_REQUIRED" });
		const other = await f.create("independent-chat");
		f.faux.setResponses([read((await f.project()).root.rootId), fauxAssistantMessage("Independent")]);
		await f.submit("independent", other);
		assert.equal((await f.done("independent")).answer, "Independent");
	} finally {
		await f.close();
	}
});

test("a successful revoke during unavailable binding lookup cannot silently restore project access", async () => {
	let unavailable = false;
	const f = await fixture((files) => ({
		...files,
		currentProject: async (workspaceId) => {
			if (unavailable) throw new Error("host temporarily busy");
			return (await files.currentProject?.(workspaceId)) ?? null;
		},
	}));
	try {
		const current = await f.project();
		const grant = await f.authorize(current.root.rootId);
		f.faux.setResponses([read(current.root.rootId), fauxAssistantMessage("Read")]);
		await f.submit("read");
		await f.done("read");
		unavailable = true;
		await f.runtime.call("revokeAgentContext", {
			...f.scope,
			requestId: "revoke-busy",
			grantId: grant.grantId,
			expectedRevision: grant.revision,
		});
		unavailable = false;
		assert.ok((await f.files.listRoots("work")).some((root) => root.rootId === current.root.rootId));
		await assert.rejects(f.submit("host-recovered"), { code: "CONTEXT_AUTHORIZATION_REQUIRED" });
	} finally {
		unavailable = false;
		await f.close();
	}
});

for (const action of ["unbind", "root-revoke", "unavailable", "replaced-inode"] as const) {
	test(`${action} remains host-authoritative after default project disclosure`, async () => {
		const f = await fixture();
		try {
			const current = await f.project();
			f.faux.setResponses([read(current.root.rootId), fauxAssistantMessage("Read")]);
			await f.submit("read");
			await f.done("read");
			if (action === "unbind") await f.projects.unbind("work", current.bindingId);
			if (action === "root-revoke") f.authority.revokeRoot(current.root.rootId);
			if (action === "unavailable" || action === "replaced-inode")
				await rename(f.folder, join(f.directory, "moved"));
			if (action === "replaced-inode") {
				await mkdir(f.folder);
				await writeFile(join(f.folder, "note.txt"), "different identity");
			}
			await assert.rejects(f.submit("after-loss"), { code: "CONTEXT_AUTHORIZATION_REQUIRED" });
			assert.equal(f.faux.state.callCount, 2);
		} finally {
			await f.close();
		}
	});
}

test("default read access never creates a write approval or permits saving", async () => {
	const f = await fixture();
	try {
		const { root } = await f.project();
		const content = await f.files.readText({ ...root, path: "note.txt" });
		f.faux.setResponses([
			fauxAssistantMessage(
				[
					fauxToolCall("hipi_files_save", {
						rootId: root.rootId,
						path: "note.txt",
						text: "changed",
						ifMatch: content.revision,
					}),
				],
				{ stopReason: "toolUse" },
			),
			fauxAssistantMessage("No write"),
		]);
		await f.submit("write");
		await f.done("write");
		assert.equal(await readFile(join(f.folder, "note.txt"), "utf8"), secret);
		assert.deepEqual((await f.runtime.call("listToolApprovals", f.scope)).items, []);
	} finally {
		await f.close();
	}
});

test("missing host capability does not infer a project from roots; separate external permissions still work", async () => {
	const f = await fixture(({ currentProject: _project, ...files }) => files);
	try {
		const { root } = await f.project();
		f.faux.setResponses([
			read(root.rootId),
			(transcript) => {
				const result = transcript.messages.filter((item) => item.role === "toolResult").at(-1);
				assert.ok(result?.role === "toolResult" && result.isError);
				return fauxAssistantMessage("Not inferred");
			},
		]);
		await f.submit("unavailable");
		assert.equal((await f.done("unavailable")).answer, "Not inferred");
		await f.authorize(root.rootId);
		f.faux.setResponses([read(root.rootId), fauxAssistantMessage("Explicit context")]);
		await f.submit("explicit");
		assert.equal((await f.done("explicit")).answer, "Explicit context");
	} finally {
		await f.close();
	}
});

test("revoking a positively identified external root does not veto the default project binding", async () => {
	const f = await fixture();
	try {
		const externalPath = join(f.directory, "external");
		await mkdir(externalPath);
		await writeFile(join(externalPath, "note.txt"), "external private content");
		const external = await f.authority.grantRoot({
			principalId: "owner",
			workspaceId: "work",
			absolutePath: externalPath,
			writable: false,
		});
		f.faux.setResponses([
			read(external.rootId),
			(transcript) => {
				const result = transcript.messages.filter((item) => item.role === "toolResult").at(-1);
				assert.ok(result?.role === "toolResult" && result.isError);
				assert.equal(JSON.stringify(transcript.messages).includes("external private content"), false);
				return fauxAssistantMessage("External context is separate");
			},
		]);
		await f.submit("no-implicit-external-access");
		assert.equal((await f.done("no-implicit-external-access")).answer, "External context is separate");
		const grant = await f.authorize(external.rootId);
		await f.runtime.call("revokeAgentContext", {
			...f.scope,
			requestId: "revoke-external",
			grantId: grant.grantId,
			expectedRevision: grant.revision,
		});
		f.faux.setResponses([read((await f.project()).root.rootId), fauxAssistantMessage("Project still available")]);
		await f.submit("project-after-external-revoke");
		assert.equal((await f.done("project-after-external-revoke")).answer, "Project still available");
	} finally {
		await f.close();
	}
});

test("explicit scope admission reserves default project metadata instead of accepting an unusable near-limit grant", async () => {
	const f = await fixture();
	try {
		const externalPath = join(f.directory, "metadata-only");
		await mkdir(externalPath);
		const root = await f.authority.grantRoot({
			principalId: "owner",
			workspaceId: "work",
			absolutePath: externalPath,
			writable: false,
		});
		const prefixes = Array.from({ length: 32 }, (_, index) => `${String(index).padStart(2, "0")}-${"x".repeat(247)}`);
		const bytes = () => Buffer.byteLength(JSON.stringify([{ rootId: root.rootId, pathPrefixes: prefixes }]));
		const last = prefixes.length - 1;
		const tail = prefixes.at(-1);
		assert.ok(tail);
		prefixes[last] = tail.slice(0, tail.length - (bytes() - 8130));
		assert.equal(bytes(), 8130, "explicit metadata alone is below the existing 8 KiB limit");
		const input = {
			...f.scope,
			requestId: "too-large-with-project",
			rootId: root.rootId,
			pathPrefixes: prefixes,
			model,
			expiresAt: Date.now() + 60000,
			disclosureVersion: 1 as const,
		};
		await assert.rejects(f.runtime.call("authorizeAgentContext", input), { code: "CAPACITY_EXCEEDED" });
		assert.deepEqual(await f.runtime.call("listActiveAgentContexts", f.scope), []);
		prefixes[last] = tail.slice(0, 10);
		await f.runtime.call("authorizeAgentContext", { ...input, requestId: "fits-with-project" });
		const project = await f.project();
		f.faux.setResponses([
			(transcript) => {
				const prompt = JSON.stringify(transcript.messages.filter((item) => item.role === "system"));
				assert.ok(prompt.includes(root.rootId) && prompt.includes(project.root.rootId));
				return fauxAssistantMessage("Both scopes fit");
			},
		]);
		await f.submit("near-limit-prompt");
		assert.equal((await f.done("near-limit-prompt")).answer, "Both scopes fit");
	} finally {
		await f.close();
	}
});

for (const operation of ["read", "list"] as const) {
	test(`cancellation during default project ${operation} blocks post-I/O disclosure`, async () => {
		let entered = false;
		const release = Promise.withResolvers<void>();
		const f = await fixture((files) => ({
			...files,
			readText: async (target) => {
				const value = await files.readText(target);
				if (operation === "read") {
					entered = true;
					await release.promise;
				}
				return value;
			},
			list: async (target, cursor) => {
				const value = await files.list(target, cursor);
				if (operation === "list") {
					entered = true;
					await release.promise;
				}
				return value;
			},
		}));
		try {
			const { root } = await f.project();
			f.faux.setResponses([
				fauxAssistantMessage(
					[
						fauxToolCall(`hipi_files_${operation}`, {
							rootId: root.rootId,
							path: operation === "read" ? "note.txt" : "",
						}),
					],
					{ stopReason: "toolUse" },
				),
				fauxAssistantMessage("Must not be called"),
			]);
			await f.submit("cancel-io");
			await until(async () => (entered ? true : undefined));
			const cancelling = f.runtime.call("cancelExecution", f.scope);
			await until(async () =>
				(await f.runtime.call("getToolActivities", f.scope)).items.some((item) => item.abortRequested)
					? true
					: undefined,
			);
			release.resolve();
			await cancelling;
			assert.equal((await f.done("cancel-io")).execution, "unanswered");
			assert.equal(f.faux.state.callCount, 1);
			assert.equal(JSON.stringify(await f.runtime.call("getHistory", f.scope)).includes(secret), false);
		} finally {
			release.resolve();
			await f.close();
		}
	});
}

test("revocation after asynchronous file read cannot disclose the result or dispatch another model call", async () => {
	let revoke: (() => Promise<void>) | undefined;
	const f = await fixture((files) => ({
		...files,
		readText: async (target) => {
			const content = await files.readText(target);
			await revoke?.();
			return content;
		},
	}));
	try {
		const current = await f.project();
		revoke = async () => {
			await f.projects.unbind("work", current.bindingId);
		};
		f.faux.setResponses([read(current.root.rootId), fauxAssistantMessage("Must not be called")]);
		await f.submit("read-race");
		assert.equal((await f.done("read-race")).execution, "unanswered");
		assert.equal(f.faux.state.callCount, 1);
		assert.equal(JSON.stringify(await f.runtime.call("getHistory", f.scope)).includes(secret), false);
	} finally {
		await f.close();
	}
});

test("rebind after prompt construction and stale asynchronous listing cannot pass final dispatch", async () => {
	let entered = false;
	const release = Promise.withResolvers<void>();
	let reads = 0;
	const f = await fixture((files) => ({
		...files,
		listRoots: async (workspaceId) => {
			const roots = await files.listRoots(workspaceId);
			// Admission and prompt each verify currentProject once; the third check is model dispatch.
			if (++reads === 3) {
				entered = true;
				await release.promise;
			}
			return roots;
		},
	}));
	try {
		const current = await f.project();
		f.faux.setResponses([fauxAssistantMessage("Must not be called")]);
		await f.submit("dispatch-race");
		await until(async () => (entered ? true : undefined));
		await f.projects.bind("work", f.folder, current.bindingId);
		release.resolve();
		assert.equal((await f.done("dispatch-race")).execution, "unanswered");
		assert.equal(f.faux.state.callCount, 0);
	} finally {
		release.resolve();
		await f.close();
	}
});

async function brokerFixture() {
	const directory = await mkdtemp(join(tmpdir(), "hipi-default-policy-"));
	const authority = createFileAuthority({
		securityMode: "cooperative-local-files",
		assertWorkspaceAccess: async () => {},
	});
	const root = await authority.grantRoot({
		principalId: "owner",
		workspaceId: "work",
		absolutePath: directory,
		writable: false,
	});
	let project: TrustedProjectContext = { workspaceId: "work", bindingId: "binding", bindingRevision: 1, root };
	const files = { ...authority.forAgent("owner"), currentProject: async () => project };
	const broker = new AgentToolBroker(
		"work",
		() => files,
		async (_tx, ids) => ids,
	);
	const { models } = provider();
	const harness = await Harness.open(
		new MemoryStorage(),
		{
			models: createWorkspaceModels(models, broker),
			registry: agentRegistry(broker),
			conversationCreated: (tx, record) => broker.conversationCreated(tx, record),
		},
		background,
	);
	broker.attach(harness);
	return {
		broker,
		harness,
		root,
		authority,
		models,
		directory,
		setProject(value: TrustedProjectContext) {
			project = value;
		},
		create: (initialize = false) =>
			harness.createConversation(
				{
					ownership: { kind: "ownerless" },
					agent: { model },
					init: async (tx, id) => {
						await broker.register(tx, id, `chat-${id}`);
						if (initialize) await broker.initializeProjectAccess(tx, id);
					},
				},
				background,
			),
		async close() {
			broker.close();
			await harness.close(background);
			await authority.close();
			await rm(directory, { recursive: true, force: true });
		},
	};
}

test("default policy creation rolls back atomically; registration and recovery never initialize it", async () => {
	const f = await brokerFixture();
	try {
		let failedId: ConversationId | undefined;
		await assert.rejects(
			f.harness.createConversation(
				{
					ownership: { kind: "ownerless" },
					agent: { model },
					init: async (tx, id) => {
						failedId = id;
						await f.broker.register(tx, id, "failed");
						await f.broker.initializeProjectAccess(tx, id);
						throw new Error("rollback");
					},
				},
				background,
			),
			/rollback/,
		);
		assert.ok(failedId);
		assert.equal(await f.harness.snapshot(DefaultProjectDoc, String(failedId), background), undefined);
		const conversation = await f.create();
		await f.broker.recover(conversation.id);
		assert.ok(!(await f.broker.promptContext(conversation.id))?.includes(f.root.rootId));
		await f.broker.assertContext(conversation.id);
		assert.ok((await f.broker.promptContext(conversation.id))?.includes(f.root.rootId));
		assert.equal((await f.harness.snapshot(DefaultProjectDoc, String(conversation.id), background))?.mode, "default");
	} finally {
		await f.close();
	}
});

for (const history of ["prior-grants", "unmapped-dependency"] as const) {
	test(`legacy ${history} is restricted even when no active grant remains`, async () => {
		const f = await brokerFixture();
		try {
			const conversation = await f.create();
			await f.harness.commit(async (tx) => {
				const state = await tx.doc(ContextDoc, String(conversation.id), null);
				if (history === "prior-grants") state.grantCount = 1;
				else state.dependencies.push({ rootId: f.root.rootId, path: "" });
			}, background);
			if (history === "prior-grants") await f.broker.assertContext(conversation.id);
			else await assert.rejects(f.broker.assertContext(conversation.id), { code: "CONTEXT_AUTHORIZATION_REQUIRED" });
			assert.ok(!(await f.broker.promptContext(conversation.id))?.includes(f.root.rootId));
		} finally {
			await f.close();
		}
	});
}

test("same-binding root turnover deduplicates historical project provenance beyond the dependency cap", async () => {
	const f = await brokerFixture();
	try {
		const conversation = await f.create(true);
		let root = f.root;
		for (let index = 0; index < 260; index++) {
			await f.broker.promptContext(conversation.id);
			await f.broker.assertContext(conversation.id);
			f.authority.revokeRoot(root.rootId);
			root = await f.authority.grantRoot({
				principalId: "owner",
				workspaceId: "work",
				absolutePath: f.directory,
				writable: false,
			});
			f.setProject({ workspaceId: "work", bindingId: "binding", bindingRevision: 1, root });
		}
		assert.ok((await f.broker.promptContext(conversation.id))?.includes(root.rootId));
		assert.deepEqual((await f.harness.snapshot(ContextDoc, String(conversation.id), background))?.dependencies, [
			{ rootId: f.root.rootId, path: "", project: { bindingId: "binding", bindingRevision: 1 } },
		]);
	} finally {
		await f.close();
	}
});

test("unknown default document versions, modes and dependency provenance fail closed", async () => {
	const f = await brokerFixture();
	try {
		const future = await f.create();
		const FutureDoc = defineDocFamily({
			kind: "hipi.default-project-context",
			scope: "session",
			version: 2,
			family: true,
			initial: () => ({ mode: "default", blockedBindingId: null }),
		});
		await f.harness.commit(async (tx) => {
			await tx.doc(FutureDoc, String(future.id), null);
		}, background);
		await assert.rejects(f.broker.assertContext(future.id), { code: "CONTEXT_AUTHORIZATION_REQUIRED" });
		const invalid = await f.create(true);
		await f.harness.commit(async (tx) => {
			Reflect.set(await tx.doc(DefaultProjectDoc, String(invalid.id), null), "mode", "future");
		}, background);
		await assert.rejects(f.broker.assertContext(invalid.id), { code: "CONTEXT_AUTHORIZATION_REQUIRED" });
		for (const provenance of [
			null,
			{ bindingId: "binding", bindingRevision: 0 },
			{ bindingId: "binding", bindingRevision: 1, version: 2 },
		]) {
			const conversation = await f.create(true);
			await f.harness.commit(async (tx) => {
				const dependency = { rootId: f.root.rootId, path: "" };
				Reflect.set(dependency, "project", provenance);
				(await tx.doc(ContextDoc, String(conversation.id), null)).dependencies.push(dependency);
			}, background);
			await assert.rejects(f.broker.assertContext(conversation.id), { code: "CONTEXT_AUTHORIZATION_REQUIRED" });
			await assert.rejects(f.broker.promptContext(conversation.id), { code: "UNAUTHORIZED" });
		}
	} finally {
		await f.close();
	}
});

test("host project defaults reject writable or mismatched scopes, including a disguised writable root", async () => {
	const f = await brokerFixture();
	try {
		const conversation = await f.create(true);
		const base = { workspaceId: "work", bindingId: "binding", bindingRevision: 1, root: f.root };
		for (const patch of [
			{ root: { ...f.root, writable: true } },
			{ workspaceId: "other" },
			{ root: { ...f.root, workspaceId: "other" } },
			{ bindingRevision: 0 },
		]) {
			f.setProject({ ...base, ...patch });
			await assert.rejects(f.broker.assertContext(conversation.id), { code: "CONTEXT_AUTHORIZATION_REQUIRED" });
		}
		const writable = await f.authority.grantRoot({
			principalId: "owner",
			workspaceId: "work",
			absolutePath: f.directory,
			writable: true,
		});
		f.setProject({ ...base, root: { ...writable, writable: false } });
		await assert.rejects(f.broker.assertContext(conversation.id), { code: "CONTEXT_AUTHORIZATION_REQUIRED" });
	} finally {
		await f.close();
	}
});
