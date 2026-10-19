import assert from "node:assert/strict";
import test from "node:test";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { createModels, fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai";
import { AgentDoc, Harness, MemoryStorage, ProviderDoc } from "@earendil-works/pi-durable";
import { AgentToolBroker, agentRegistry } from "../src/agent-tools.ts";
import { ConversationMetaDoc } from "../src/conversation-directory.ts";
import { previewToolPack, ToolPackLifecycle } from "../src/extensions/lifecycle.ts";
import { packageDescriptors, packDescriptor } from "../src/extensions/lifecycle-descriptors.ts";
import { PackBindingDoc, PackConversationDoc, PackDoc } from "../src/extensions/lifecycle-store.ts";
import { parseToolPack } from "../src/extensions/pack.ts";

const packageText = JSON.stringify({
	formatVersion: 1,
	id: "example.cleanup",
	version: "1.0.0",
	name: "Cleanup",
	description: "Private package explanation",
	tools: [{ id: "clean", name: "Clean", description: "Remove extra spaces", pipeline: [{ op: "trimLineEnds" }] }],
});
const parsed = parseToolPack(Buffer.from(packageText));
const descriptors = packageDescriptors({ messages: [], tools: [packDescriptor(parsed, parsed.manifest.tools[0])] });
async function fixture() {
	const models = createModels();
	const faux = fauxProvider({
		provider: "faux",
		api: "test",
		models: [{ id: "one", contextWindow: 10000, maxTokens: 100 }],
	});
	models.setProvider(faux.provider);
	const model = models.getModel("faux", "one");
	assert.ok(model);
	const broker = new AgentToolBroker("work", undefined, async () => []);
	const registry = agentRegistry(broker);
	const lifecycle = new ToolPackLifecycle("work", broker, registry, async () => {});
	broker.attachExtensions(lifecycle);
	const storage = new MemoryStorage();
	const harness = await Harness.open(
		storage,
		{
			models,
			registry,
			conversationCreated: async (tx, record) => {
				await broker.conversationCreated(tx, record);
				await lifecycle.conversationCreated(tx, record);
			},
		},
		context,
	);
	broker.attach(harness);
	const conversation = await harness.createConversation(
		{
			ownership: { kind: "ownerless" },
			agent: { model: { provider: "faux", modelId: "one" } },
			init: async (tx, id) => {
				await broker.register(tx, id, "chat");
				await lifecycle.register(tx, id, "chat");
				(await tx.doc(ConversationMetaDoc, "chat", null)).value = {
					workspaceId: "work",
					conversationId: "chat",
					durableId: id,
					title: "Chat",
					ordinal: 0,
					revision: 1,
					createdAt: 1,
					archivedAt: null,
				};
			},
		},
		context,
	);
	const sessionId = (await harness.snapshot(ProviderDoc, conversation.id, context))?.sessionId;
	assert.ok(sessionId);
	let sequence = 0;
	const requestId = () => `request-${++sequence}`;
	const install = () =>
		lifecycle.install({
			workspaceId: "work",
			requestId: requestId(),
			packageText,
			expectedDigest: parsed.digest,
			disclosureVersion: 1,
		});
	const enable = async () => {
		const pack = await install();
		return lifecycle.change("setToolPackEnabled", {
			workspaceId: "work",
			requestId: requestId(),
			digest: pack.digest,
			expectedRevision: pack.revision,
			enabled: true,
		});
	};
	const bind = async () => {
		const pack = await enable();
		return lifecycle.bind(conversation.id, {
			workspaceId: "work",
			conversationId: "chat",
			requestId: requestId(),
			digest: pack.digest,
			expectedPackRevision: pack.revision,
			model: { provider: "faux", modelId: "one" },
			expiresAt: Date.now() + 60000,
			disclosureVersion: 1,
		});
	};
	const current = async (bindingId: string) => {
		const value = (await harness.snapshot(PackBindingDoc, bindingId, context))?.value;
		assert.ok(value);
		return value;
	};
	const revoke = async (bindingId: string) =>
		lifecycle.revoke(conversation.id, {
			workspaceId: "work",
			conversationId: "chat",
			requestId: requestId(),
			bindingId,
			expectedRevision: (await current(bindingId)).revision,
		});
	let sends = 0;
	const start = (evidence = descriptors, controller = new AbortController()) =>
		broker.start(
			sessionId,
			model,
			controller,
			async () => {
				sends++;
				return new Response("ok");
			},
			evidence,
		);
	return {
		faux,
		models,
		model,
		broker,
		registry,
		lifecycle,
		harness,
		conversation,
		sessionId,
		requestId,
		install,
		enable,
		bind,
		current,
		revoke,
		start,
		sends: () => sends,
		async close() {
			lifecycle.close();
			broker.close();
			await harness.close(context);
		},
	};
}

test("installation is disabled, enable does not select tools, binding remains undisclosed until dispatch", async () => {
	const f = await fixture();
	try {
		const installed = await f.install();
		assert.equal(installed.status, "disabled");
		assert.deepEqual((await f.harness.snapshot(AgentDoc, f.conversation.id, context))?.extensions, ["hipi.files"]);
		await assert.rejects(f.start(), { code: "UNAUTHORIZED" });
		const binding = await f.bind();
		await f.broker.check(f.sessionId, f.model, descriptors);
		assert.equal((await f.current(binding.bindingId)).disclosed, false);
		const sent = await f.start();
		await sent.response;
		sent.release();
		assert.equal((await f.current(binding.bindingId)).disclosed, true);
		assert.equal(f.sends(), 1);
	} finally {
		await f.close();
	}
});
test("captured but undisclosed descriptor cannot bypass revoke through an empty current binding set", async () => {
	const f = await fixture();
	try {
		const binding = await f.bind();
		await f.broker.check(f.sessionId, f.model, descriptors);
		await f.revoke(binding.bindingId);
		await assert.rejects(f.start(), { code: "UNAUTHORIZED" });
		assert.equal(f.sends(), 0);
		await f.harness.commit((tx) => f.broker.submitted(tx, f.conversation.id), context);
		const fresh = await f.start([]);
		await fresh.response;
		fresh.release();
		assert.equal(f.sends(), 1);
		assert.deepEqual(
			(await f.harness.snapshot(PackConversationDoc, String(f.conversation.id), context))?.dependencies,
			[],
		);
	} finally {
		await f.close();
	}
});
test("retained authorization permits historical descriptors and compacted history without restoring tools", async () => {
	const f = await fixture();
	try {
		const binding = await f.bind();
		const first = await f.start();
		first.release();
		await f.revoke(binding.bindingId);
		await assert.rejects(f.start([]), { code: "UNAUTHORIZED" });
		await f.lifecycle.bind(f.conversation.id, {
			workspaceId: "work",
			conversationId: "chat",
			requestId: f.requestId(),
			sourceBindingId: binding.bindingId,
			model: { provider: "faux", modelId: "one" },
			expiresAt: Date.now() + 60000,
			disclosureVersion: 1,
		});
		await f.harness.commit((tx) => f.broker.submitted(tx, f.conversation.id), context);
		const history = descriptors.map((descriptor) => ({ ...descriptor, active: false }));
		const retained = await f.start(history);
		retained.release();
		const compacted = await f.start([]);
		compacted.release();
		await assert.rejects(f.start(), { code: "UNAUTHORIZED" });
		const restoredInSameDelta = packageDescriptors({
			messages: [
				{
					role: "system",
					content: "",
					timestamp: 0,
					toolsRemoved: [{ name: descriptors[0].name }],
					toolsAdded: [packDescriptor(parsed, parsed.manifest.tools[0])],
				},
			],
		});
		assert.equal(restoredInSameDelta[0].active, true);
		await assert.rejects(f.start(restoredInSameDelta), { code: "UNAUTHORIZED" });
		assert.deepEqual((await f.harness.snapshot(AgentDoc, f.conversation.id, context))?.extensions, ["hipi.files"]);
	} finally {
		await f.close();
	}
});
test("descriptor description/schema tampering is denied even with the correct wire name", async () => {
	const f = await fixture();
	try {
		await f.bind();
		await assert.rejects(f.start([{ ...descriptors[0], digest: "0".repeat(64) }]), { code: "UNAUTHORIZED" });
		assert.equal(f.sends(), 0);
	} finally {
		await f.close();
	}
});
test("disable aborts existing dispatch and prevents subsequent effects; missing registry cannot block revoke", async () => {
	const f = await fixture();
	try {
		const binding = await f.bind();
		const controller = new AbortController();
		const sent = await f.start(descriptors, controller);
		const pack = (await f.harness.snapshot(PackDoc, parsed.digest, context))?.value;
		assert.ok(pack);
		await f.lifecycle.change("setToolPackEnabled", {
			workspaceId: "work",
			requestId: f.requestId(),
			digest: parsed.digest,
			expectedRevision: pack.revision,
			enabled: false,
		});
		assert.equal(controller.signal.aborted, true);
		sent.release();
		await assert.rejects(f.start(), { code: "UNAUTHORIZED" });
		await f.revoke(binding.bindingId);
		await f.broker.cancel(f.conversation.id);
	} finally {
		await f.close();
	}
});
test("recovery invalidates grants and preserves exact source bytes and history dependencies", async () => {
	const f = await fixture();
	try {
		const binding = await f.bind();
		const sent = await f.start();
		sent.release();
		await f.lifecycle.recover();
		assert.equal((await f.current(binding.bindingId)).status, "invalidated");
		assert.equal((await f.harness.snapshot(PackDoc, parsed.digest, context))?.packageText, packageText);
		await assert.rejects(f.start([]), { code: "UNAUTHORIZED" });
	} finally {
		await f.close();
	}
});
test("preview preserves UTF-8 installation identity and rejects malformed text", () => {
	assert.equal(previewToolPack(packageText).digest, parsed.digest);
	assert.throws(() => previewToolPack(`\ufeff${packageText}`));
	assert.throws(() => previewToolPack("\ud800"));
});

test("missing core or package registry identity blocks dispatch but does not block cancellation or revocation", async () => {
	for (const core of [false, true]) {
		const f = await fixture();
		try {
			const binding = await f.bind();
			const extension = f.registry
				.snapshot()
				.installed()
				.find((item) => (core ? item.name === "hipi.files" : item.name.startsWith("hipi.pack.")));
			assert.ok(extension);
			f.registry.uninstall(extension);
			await assert.rejects(f.start(), { code: "UNAUTHORIZED" });
			assert.equal(f.sends(), 0);
			await f.revoke(binding.bindingId);
			await f.broker.cancel(f.conversation.id);
		} finally {
			await f.close();
		}
	}
});

test("workspace disable waits for all affected conversation gates before committing; a queued fetch cannot slip through", async () => {
	const f = await fixture();
	try {
		await f.bind();
		const second = await f.harness.createConversation(
			{
				ownership: { kind: "ownerless" },
				agent: { model: { provider: "faux", modelId: "one" } },
				init: async (tx, id) => {
					await f.broker.register(tx, id, "other");
					await f.lifecycle.register(tx, id, "other");
					(await tx.doc(ConversationMetaDoc, "other", null)).value = {
						workspaceId: "work",
						conversationId: "other",
						durableId: id,
						title: "Other",
						ordinal: 1,
						revision: 1,
						createdAt: 1,
						archivedAt: null,
					};
				},
			},
			context,
		);
		const pack = (await f.harness.snapshot(PackDoc, parsed.digest, context))?.value;
		assert.ok(pack);
		await f.lifecycle.bind(second.id, {
			workspaceId: "work",
			conversationId: "other",
			requestId: f.requestId(),
			digest: parsed.digest,
			expectedPackRevision: pack.revision,
			model: { provider: "faux", modelId: "one" },
			expiresAt: Date.now() + 60000,
			disclosureVersion: 1,
		});
		const entered = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		const held = f.broker.locked(second.id, async () => {
			entered.resolve();
			await release.promise;
		});
		await entered.promise;
		let finished = false;
		const disabling = f.lifecycle
			.change("setToolPackEnabled", {
				workspaceId: "work",
				requestId: f.requestId(),
				digest: parsed.digest,
				expectedRevision: pack.revision,
				enabled: false,
			})
			.then((value) => {
				finished = true;
				return value;
			});
		await new Promise((resolve) => setTimeout(resolve, 20));
		assert.equal(finished, false);
		assert.equal((await f.harness.snapshot(PackDoc, parsed.digest, context))?.value?.status, "enabled");
		const denied = assert.rejects(f.start(), { code: "UNAUTHORIZED" });
		release.resolve();
		await held;
		await disabling;
		await denied;
		assert.equal(f.sends(), 0);
	} finally {
		await f.close();
	}
});

test("expiry is checked at the effect gate even before the scheduled timer runs", async () => {
	const f = await fixture();
	try {
		const binding = await f.bind();
		await f.harness.commit(async (tx) => {
			const doc = await tx.doc(PackBindingDoc, binding.bindingId, null);
			assert.ok(doc.value);
			doc.value.expiresAt = Date.now() - 1;
		}, context);
		await assert.rejects(f.start(), { code: "UNAUTHORIZED" });
		assert.equal(f.sends(), 0);
		await f.revoke(binding.bindingId);
	} finally {
		await f.close();
	}
});

test("a revocation's delayed cancellation tail only stops captured work, never a newer submission", async () => {
	const f = await fixture();
	const tail = Promise.withResolvers<void>();
	const resumeTail = Promise.withResolvers<void>();
	const began = Promise.withResolvers<void>();
	const finishModel = Promise.withResolvers<void>();
	try {
		const binding = await f.bind();
		const capture = f.broker.captureStop.bind(f.broker);
		f.broker.captureStop = async (id) => {
			const stop = await capture(id);
			return async () => {
				tail.resolve();
				await resumeTail.promise;
				await stop();
			};
		};
		const revoking = f.revoke(binding.bindingId);
		await tail.promise;
		await f.broker.assertContext(f.conversation.id);
		await f.harness.commit((tx) => f.broker.submitted(tx, f.conversation.id), context);
		f.faux.setResponses([
			async () => {
				began.resolve();
				await finishModel.promise;
				return fauxAssistantMessage("New work");
			},
		]);
		await f.conversation.submit(
			{ type: "input", content: "New independent work", requestId: "new-work", whenBusy: "followUp" },
			context,
		);
		await began.promise;
		resumeTail.resolve();
		await revoking;
		const newer = (await f.harness.inspect(context)).tasks;
		assert.ok(newer.length > 0);
		assert.ok(newer.every(({ record }) => !record.abortRequested));
	} finally {
		resumeTail.resolve();
		finishModel.resolve();
		await f.close();
	}
});
