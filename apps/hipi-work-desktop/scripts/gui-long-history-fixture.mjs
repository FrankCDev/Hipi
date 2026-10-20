// Source-only fixture. This module is never included in the packaged application.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { lstat, mkdir, readdir, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { createModels, fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai";
import { LIMITS } from "@hipi/work-runtime/contracts";
import { openRuntime } from "@hipi/work-runtime/node";

export const historyFixture = {
	turns: 100,
	workspaceId: "history-work",
	workspaceTitle: "History GUI 中文",
	longTitle: "Long history 中文",
	controlTitle: "Control history 中文",
	controlUser: "CONTROL_ONLY_USER 中文隔离",
	controlAnswer: "CONTROL_ONLY_ANSWER 中文隔离",
	probe: "LONG_GUI_STREAM_PROBE 中文",
	expansionTurn: 1,
};
const marker = (n) => String(n).padStart(3, "0");
const digest = (text) => createHash("sha256").update(text).digest("hex");

export function historyAnswer(n) {
	const lead = `HISTORY_ANSWER_${marker(n)} 中文高度验证`;
	if (n === historyFixture.expansionTurn)
		return `${lead}\n\n${"Bounded original text 中文 with a stable reading position. ".repeat(120)}\nORIGINAL_END_001`;
	if (n % 4 === 0)
		return `${lead}\n\n## Section ${n}\n\n| Item | Value |\n| --- | --- |\n| 中文 | stable |\n| nested | bounded |\n\n> A block quote that wraps naturally across the available reading width.\n\n- First item\n  - Nested item with **bold** and *emphasis*\n- Second item\n\n\`\`\`typescript\nconst turn = ${n};\nconst text = "中文";\nconsole.log(turn, text);\n\`\`\`\n\n${"A bounded paragraph tests variable row height and wrapping. ".repeat(8)}`;
	return `${lead}\n\n${"Short stable text. ".repeat(1 + (n % 5))}`;
}
export function historyUser(n) {
	return `HISTORY_USER_${marker(n)} 中文\n${"Bounded user text. ".repeat((n % 3) + 1)}`;
}

async function storeDirectory(ownedProfileRoot) {
	// Caller retains its own mkdtemp identity. A report/JSON path never grants ownership.
	const root = await realpath(ownedProfileRoot);
	assert.equal(root, ownedProfileRoot, "Profile root must be canonical");
	assert.equal(dirname(root), await realpath(tmpdir()));
	assert.match(basename(root), /^Hipi GUI profile-[A-Za-z0-9]+$/);
	const owner = await lstat(root);
	assert.ok(owner.isDirectory() && !owner.isSymbolicLink());
	if (process.platform !== "win32") {
		assert.equal(owner.uid, process.getuid());
		assert.equal(owner.mode & 0o077, 0);
	}
	for (const part of ["profile", "profile/deterministic-store"]) {
		const path = join(root, part);
		await mkdir(path, { mode: 0o700 }).catch((error) => {
			if (error.code !== "EEXIST") throw error;
		});
		assert.equal(await realpath(path), path, "Fixture store escaped owned profile");
		assert.ok((await lstat(path)).isDirectory() && !(await lstat(path)).isSymbolicLink());
	}
	return join(root, "profile/deterministic-store");
}

function options(responses = []) {
	const faux = fauxProvider({
		tokensPerSecond: 100000,
		tokenSize: { min: 8192, max: 8192 },
		models: [{ id: "faux-1", contextWindow: 2000000, maxTokens: 32768 }],
	});
	faux.setResponses(responses.map((text) => fauxAssistantMessage(text)));
	const models = createModels({ authContext: { env: async () => undefined, fileExists: async () => false } });
	models.setProvider(faux.provider);
	return { models, model: { provider: "faux", modelId: "faux-1" } };
}

async function readHistory(runtime, conversationId) {
	let cursor;
	const messages = [];
	let pages = 0;
	do {
		const page = await runtime.call("getHistory", {
			workspaceId: historyFixture.workspaceId,
			conversationId,
			...(cursor ? { cursor } : {}),
		});
		messages.push(...page.messages);
		cursor = page.nextCursor;
		assert.ok(++pages <= 16, "History cursor exceeded bounded traversal");
	} while (cursor);
	assert.equal(new Set(messages.map((m) => m.id)).size, messages.length, "Duplicate message identity");
	return { messages, pages };
}

async function assertText(runtime, conversationId, message, expected) {
	assert.equal(message.text, expected.slice(0, LIMITS.messagePreview));
	assert.equal(message.textLength, expected.length);
	assert.equal(message.truncated, expected.length > LIMITS.messagePreview);
	if (message.truncated) {
		const page = await runtime.call("getMessageText", {
			workspaceId: historyFixture.workspaceId,
			conversationId,
			messageId: message.id,
			offset: 0,
		});
		assert.equal(page.text, expected);
		assert.equal(page.nextOffset, null);
	}
}

/** Seed only before native launch. Owns and closes each public runtime before returning. */
export async function seedLongHistory({ ownedProfileRoot, assertAllOwnedProcessesExited }) {
	await assertAllOwnedProcessesExited();
	const directory = await storeDirectory(ownedProfileRoot);
	assert.deepEqual(await readdir(directory), [], "Never seed a nonempty store");
	const start = performance.now();
	let peakSampledRssBytes = process.memoryUsage().rss;
	const sampler = setInterval(() => {
		peakSampledRssBytes = Math.max(peakSampledRssBytes, process.memoryUsage().rss);
	}, 10);
	let runtime;
	let long;
	let control;
	try {
		runtime = await openRuntime(
			directory,
			options([
				...Array.from({ length: historyFixture.turns }, (_, n) => historyAnswer(n)),
				historyFixture.controlAnswer,
			]),
		);
		await runtime.call("createWorkspace", {
			workspaceId: historyFixture.workspaceId,
			name: historyFixture.workspaceTitle,
		});
		long = await runtime.call("createConversation", {
			workspaceId: historyFixture.workspaceId,
			requestId: "long-create",
			title: historyFixture.longTitle,
		});
		const submit = async (conversationId, requestId, text) => {
			await runtime.call("submit", { workspaceId: historyFixture.workspaceId, conversationId, requestId, text });
			const deadline = Date.now() + 30000;
			for (;;) {
				const receipt = await runtime.call("getReceipt", { workspaceId: historyFixture.workspaceId, requestId });
				if (receipt?.execution === "done") return;
				assert.ok(Date.now() < deadline, "Seed receipt deadline exceeded");
				assert.ok(!["failed", "cancelled"].includes(receipt?.execution), "Seed execution did not complete");
				await new Promise((resolve) => setTimeout(resolve, 5));
			}
		};
		for (let n = 0; n < historyFixture.turns; n++)
			await submit(long.conversationId, `seed-${marker(n)}`, historyUser(n));
		control = await runtime.call("createConversation", {
			workspaceId: historyFixture.workspaceId,
			requestId: "control-create",
			title: historyFixture.controlTitle,
		});
		await submit(control.conversationId, "control-seed", historyFixture.controlUser);
		await runtime.close();
		runtime = undefined;
		// A separate open proves the fixture is durable rather than an in-memory projection.
		runtime = await openRuntime(directory, options());
		const { messages, pages } = await readHistory(runtime, long.conversationId);
		assert.equal(messages.length, historyFixture.turns * 2);
		for (let n = 0; n < historyFixture.turns; n++) {
			for (const [role, expected] of [
				["user", historyUser(n)],
				["assistant", historyAnswer(n)],
			]) {
				const matching = messages.filter(
					(message) => message.role === role && message.text === expected.slice(0, LIMITS.messagePreview),
				);
				assert.equal(matching.length, 1);
				await assertText(runtime, long.conversationId, matching[0], expected);
			}
		}
		const result = {
			...historyFixture,
			long: {
				conversationId: long.conversationId,
				title: long.title,
				messages: messages.map((m) => ({
					id: m.id,
					role: m.role,
					textLength: m.textLength,
					previewSha256: digest(m.text),
				})),
			},
			control: { conversationId: control.conversationId, title: control.title },
			expansionMessageId: messages.find((m) => m.text.startsWith("HISTORY_ANSWER_001")).id,
			persistedMessages: messages.length,
			coldReadPages: pages,
			seedViaPublicRuntime: true,
			manuallyEnteredViaGUI: false,
			elapsedMs: Math.round(performance.now() - start),
			peakSampledRssBytes,
			resourceMeasurement: "source fixture Node RSS, not native GUI memory or product budget",
		};
		return result;
	} finally {
		clearInterval(sampler);
		await runtime?.close();
	}
}

/** Call only after both native launches and process-tree/listener closure have been confirmed. */
export async function verifyColdHistory({ ownedProfileRoot, seed, gui, assertAllOwnedProcessesExited }) {
	await assertAllOwnedProcessesExited();
	const directory = await storeDirectory(ownedProfileRoot);
	assert.ok(gui.persistedProbe?.userKey && gui.persistedProbe?.answerKey && gui.persistedProbe?.requestId);
	const runtime = await openRuntime(directory, options());
	try {
		const { messages, pages } = await readHistory(runtime, seed.long.conversationId);
		assert.equal(messages.length, seed.persistedMessages + 2);
		for (const original of seed.long.messages) {
			const message = messages.find((m) => m.id === original.id);
			assert.ok(message, "Original seed ID missing");
			assert.equal(message.role, original.role);
			assert.equal(message.textLength, original.textLength);
			assert.equal(digest(message.text), original.previewSha256);
		}
		await assertText(
			runtime,
			seed.long.conversationId,
			messages.find((m) => m.id === seed.expansionMessageId),
			historyAnswer(seed.expansionTurn),
		);
		const probes = messages.filter((m) => m.role === "user" && m.text === historyFixture.probe);
		assert.equal(probes.length, 1);
		assert.equal(`message:${probes[0].id}`, gui.persistedProbe.userKey);
		const answer = messages.find((m) => `message:${m.id}` === gui.persistedProbe.answerKey);
		assert.equal(answer?.role, "assistant");
		assert.equal(answer.text, gui.persistedProbe.answerText);
		const receipt = await runtime.call("getReceipt", {
			workspaceId: seed.workspaceId,
			requestId: gui.persistedProbe.requestId,
		});
		assert.equal(receipt?.execution, "done");
		assert.equal(receipt.answer, answer.text);
		const control = await readHistory(runtime, seed.control.conversationId);
		assert.equal(control.messages.length, 2);
		assert.equal(control.messages.find((m) => m.role === "user")?.text, historyFixture.controlUser);
		assert.equal(control.messages.find((m) => m.role === "assistant")?.text, historyFixture.controlAnswer);
		return {
			originalSeedIdsAndTextPreserved: true,
			persistedMessages: messages.length,
			pages,
			probeCount: probes.length,
			controlMessages: 2,
			cleanColdRead: true,
		};
	} finally {
		await runtime.close();
	}
}
