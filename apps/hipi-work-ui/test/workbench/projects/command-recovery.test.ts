import assert from "node:assert/strict";
import {
	type AppClient,
	PROTOCOL_VERSION,
	parseRequest,
	parseResult,
	projectCommandPayload,
} from "@hipi/work-runtime/contracts";
import { test } from "vitest";
import {
	currentInitialSend,
	finishLogicalInitialConversation,
	readInitialSendRecovery,
} from "../../../src/features/workbench/catalog/initial-send.ts";
import { readCatalogRecovery } from "../../../src/features/workbench/catalog/prepared-task.ts";
import { CatalogSession } from "../../../src/features/workbench/catalog/session.ts";
import { LocalState } from "../../../src/features/workbench/local-state.ts";
import { finishProjectCommand, parseProjectCommand } from "../../../src/features/workbench/projects/commands.ts";

const legacy = {
	version: 9,
	method: "createProjectConversation",
	params: {
		requestId: "original",
		projectId: "project",
		title: "Original",
		model: { provider: "fake", modelId: "test" },
	},
};
const commandJournal = { version: 6, kind: "project-command", request: legacy };
const initialJournal = {
	version: 6,
	kind: "logical-initial-send",
	request: legacy,
	initialSend: {
		workspaceCommand: null,
		conversationCommand: legacy,
		workspaceId: null,
		text: "Original input",
		submissionId: "submission",
		sourceKey: "new-chat-draft.source",
		sourceRevision: "revision",
		sourceGeneration: "generation",
		conversationId: null,
	},
};

test.each([10, 11, 12])(
	"protocol %i reload remains receipt-only and finishes only its byte-exact owned journal",
	async (version) => {
		const prior = { ...legacy, version };
		const journal = { ...commandJournal, request: prior };
		const raw = JSON.stringify(journal);
		const local = new LocalState();
		local.write("command.catalog", raw);
		const command = parseProjectCommand(prior);
		assert.deepEqual(command, { ...prior, version: PROTOCOL_VERSION });
		assert.throws(() => parseRequest(prior));
		const calls: string[] = [];
		const client: AppClient = {
			call: async (method) => {
				calls.push(method);
				assert.equal(method, "getProjectCommandResult");
				return parseResult(method, null);
			},
			observe: async () => {
				throw new Error("Recovery must not execute or observe");
			},
		};
		for (let mount = 0; mount < 2; mount++) {
			const session = new CatalogSession(client, local);
			try {
				await session.check();
				assert.deepEqual(session.getSnapshot().pending, command);
				assert.equal(session.getSnapshot().notFound, true);
				assert.equal(local.read("command.catalog"), raw);
			} finally {
				session.dispose();
			}
		}
		assert.deepEqual(calls, ["getProjectCommandResult", "getProjectCommandResult"]);
		local.write("command.catalog", JSON.stringify(journal, null, 2));
		await assert.rejects(finishProjectCommand(local, command, new AbortController().signal));
		local.write("command.catalog", raw);
		await finishProjectCommand(local, command, new AbortController().signal);
		assert.equal(local.read("command.catalog"), JSON.stringify({ version: 2, request: null }));

		const initial = {
			...initialJournal,
			request: prior,
			initialSend: { ...initialJournal.initialSend, conversationCommand: prior },
		};
		const initialRaw = JSON.stringify(initial);
		local.write("command.catalog", initialRaw);
		const expected = readInitialSendRecovery(initial);
		assert.deepEqual(currentInitialSend(local, expected), expected);
		assert.equal(local.read("command.catalog"), initialRaw);
		const next = await finishLogicalInitialConversation(
			local,
			expected,
			{ workspaceId: "physical", conversationId: "conversation" },
			new AbortController().signal,
		);
		assert.equal(next.initialSend.submissionId, initial.initialSend.submissionId);
		assert.equal(next.initialSend.text, initial.initialSend.text);
		assert.equal(next.initialSend.sourceRevision, initial.initialSend.sourceRevision);
		assert.equal(local.pending("physical.conversation"), null);
	},
);

test("all six protocol 9 logical commands preserve the exact digest payload through recovery", () => {
	for (const value of [
		legacy,
		{ version: 9, method: "createProject", params: { requestId: "request", name: "Name" } },
		{
			version: 9,
			method: "renameProject",
			params: { requestId: "request", projectId: "project", expectedRevision: 1, name: "Name" },
		},
		{
			version: 9,
			method: "setProjectPinned",
			params: { requestId: "request", projectId: "project", expectedPresentationRevision: 0, pinned: true },
		},
		{
			version: 9,
			method: "reorderPinnedProject",
			params: { requestId: "request", movedProjectId: "project", beforeProjectId: null, expectedOrderGeneration: 2 },
		},
		{
			version: 9,
			method: "adoptLegacyDefaultWorkspace",
			params: {
				requestId: "request",
				workspaceId: "workspace",
				expectedCatalogGeneration: 1,
				expectedDefaultWorkspaceId: null,
				provenance: { storeId: "store", markerVersion: 1, role: "default-chat-workspace", workspaceId: "workspace" },
			},
		},
	]) {
		const decoded = parseProjectCommand(value);
		assert.equal(
			projectCommandPayload(decoded.method, decoded.params),
			JSON.stringify({ method: value.method, params: value.params }),
		);
		assert.deepEqual(decoded.params, value.params);
		assert.throws(() => parseProjectCommand({ ...value, version: 8 }));
	}
});

test("protocol 9 logical journal decoder preserves exact command params but rejects unsupported wire and local versions", () => {
	const raw = JSON.stringify(legacy);
	assert.deepEqual(parseProjectCommand(legacy), { ...legacy, version: PROTOCOL_VERSION });
	assert.equal(JSON.stringify(legacy), raw);
	assert.throws(() => parseRequest(legacy));
	for (const invalid of [
		{ ...legacy, version: 8 },
		{ ...legacy, version: 7 },
		{ ...legacy, version: PROTOCOL_VERSION + 1 },
		{ ...legacy, expectedStoreId: "foreign" },
		{ ...legacy, extra: true },
		{ ...legacy, params: { ...legacy.params, requestId: "bad/id" } },
		{ ...legacy, params: { ...legacy.params, projectId: "bad/id" } },
		{ ...legacy, params: { ...legacy.params, extra: true } },
	]) {
		assert.throws(() => parseProjectCommand(invalid));
		assert.equal(readCatalogRecovery(JSON.stringify({ ...commandJournal, request: invalid })).incompatible, true);
	}
});

test.each([commandJournal, initialJournal])(
	"protocol 9 $kind recovery checks unknown outcome without changing journal or executing",
	async (journal) => {
		const raw = JSON.stringify(journal);
		const local = new LocalState();
		local.write("command.catalog", raw);
		const calls: unknown[] = [];
		const client: AppClient = {
			call: async (method, params) => {
				calls.push({ method, params });
				assert.equal(method, "getProjectCommandResult");
				return parseResult(method, null);
			},
			observe: async () => {
				throw new Error("No execution observation during recovery");
			},
		};
		for (let mount = 0; mount < 2; mount++) {
			const session = new CatalogSession(client, local);
			try {
				assert.equal(session.getSnapshot().incompatible, false);
				await session.check();
				assert.equal(session.getSnapshot().notFound, true);
				assert.deepEqual(session.getSnapshot().pending, { ...legacy, version: PROTOCOL_VERSION });
				assert.equal(local.read("command.catalog"), raw);
				assert.equal(local.hasUnsavedWork(), true);
			} finally {
				session.dispose();
			}
		}
		assert.deepEqual(calls, Array(2).fill({ method: "getProjectCommandResult", params: { requestId: "original" } }));
	},
);

test("protocol 9 project completion retains canonical byte ownership and rejects tampered wrappers or commands", async () => {
	const command = parseProjectCommand(legacy);
	for (const raw of [
		JSON.stringify({ ...commandJournal, version: 5 }),
		JSON.stringify({ ...commandJournal, kind: "logical-initial-send" }),
		JSON.stringify({ ...commandJournal, extra: true }),
		JSON.stringify({ ...commandJournal, request: { ...legacy, params: { ...legacy.params, requestId: "different" } } }),
		JSON.stringify({ ...commandJournal, request: { ...legacy, params: { ...legacy.params, title: "Different" } } }),
		JSON.stringify(commandJournal, null, 2),
	]) {
		const local = new LocalState();
		local.write("command.catalog", raw);
		await assert.rejects(finishProjectCommand(local, command, new AbortController().signal));
		assert.equal(local.read("command.catalog"), raw);
	}
	const local = new LocalState();
	local.write("command.catalog", JSON.stringify(commandJournal));
	await finishProjectCommand(local, command, new AbortController().signal);
	assert.equal(local.read("command.catalog"), JSON.stringify({ version: 2, request: null }));
});

test("protocol 9 initial-send ownership still requires all captured source and execution identities", () => {
	const local = new LocalState();
	const raw = JSON.stringify(initialJournal);
	local.write("command.catalog", raw);
	const expected = readInitialSendRecovery(initialJournal);
	assert.deepEqual(currentInitialSend(local, expected), expected);
	assert.equal(local.read("command.catalog"), raw);
	for (const patch of [
		{ submissionId: "other" },
		{ sourceRevision: "other" },
		{ sourceGeneration: "other" },
		{ text: "Changed" },
	]) {
		const changed = JSON.stringify({ ...initialJournal, initialSend: { ...initialJournal.initialSend, ...patch } });
		local.write("command.catalog", changed);
		assert.throws(() => currentInitialSend(local, expected));
		assert.equal(local.read("command.catalog"), changed);
	}
});

test("protocol 9 logical initial-send advances only the owned stage while preserving captured execution identity", async () => {
	const local = new LocalState();
	local.write("command.catalog", JSON.stringify(initialJournal));
	const expected = readInitialSendRecovery(initialJournal);
	const next = await finishLogicalInitialConversation(
		local,
		expected,
		{ workspaceId: "physical", conversationId: "conversation" },
		new AbortController().signal,
	);
	assert.equal(next.request, null);
	assert.deepEqual(next.initialSend, {
		...expected.initialSend,
		workspaceId: "physical",
		conversationId: "conversation",
	});
	assert.deepEqual(currentInitialSend(local, next), next);
	assert.equal(local.pending("physical.conversation"), null);
	assert.equal(local.hasUnsavedWork(), true);
});

test.each(["exact", "foreign"])(
	"protocol 9 logical receipt %s completes only exact params without another create or submit",
	async (identity) => {
		const local = new LocalState();
		const raw = JSON.stringify(commandJournal);
		local.write("command.catalog", raw);
		const conversation = {
			workspaceId: "physical",
			conversationId: "conversation",
			title: "Original",
			revision: 1,
			createdAt: 1,
			archivedAt: null,
		};
		const calls: string[] = [];
		const client: AppClient = {
			call: async (method) => {
				calls.push(method);
				assert.ok(method === "getProjectCommandResult" || method === "getConversation");
				return parseResult(
					method,
					method === "getConversation"
						? conversation
						: {
								status: "completed",
								method: legacy.method,
								params: { ...legacy.params, requestId: identity === "exact" ? "original" : "foreign" },
								result: {
									conversation,
									membership: {
										workspaceId: "physical",
										conversationId: "conversation",
										projectId: "project",
										revision: 1,
									},
								},
							},
				);
			},
			observe: async () => {
				throw new Error("No execution observation during recovery");
			},
		};
		const session = new CatalogSession(client, local);
		try {
			await session.check();
			assert.equal(session.getSnapshot().failed, identity !== "exact");
			assert.equal(session.getSnapshot().pending === null, identity === "exact");
			assert.equal(
				local.read("command.catalog"),
				identity === "exact" ? JSON.stringify({ version: 2, request: null }) : raw,
			);
			assert.deepEqual(
				calls,
				identity === "exact" ? ["getProjectCommandResult", "getConversation"] : ["getProjectCommandResult"],
			);
		} finally {
			session.dispose();
		}
	},
);
