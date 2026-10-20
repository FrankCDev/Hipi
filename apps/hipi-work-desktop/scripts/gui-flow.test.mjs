import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { runInNewContext } from "node:vm";
import {
	activityEvidence,
	assertCommittedStreamIdentity,
	assertDefaultChatScope,
	assertInitialChatUnsubmitted,
	assertNoAlerts,
	captureFailure,
	click,
	committedStreamEvidence,
	diagnosticTarget,
	fixture,
	historyEvidence,
	hover,
	inspectInitialChat,
	inspectModal,
	modalBounds,
	modalWheelPoint,
	observeMountedStream,
	observeStreamingActions,
	pressKey,
	receiptScope,
	resolvedTheme,
	selectReopenedConversation,
	settleFloatingAnimations,
	waitForOverlayClosed,
} from "./gui-flow.mjs";

test("persisted history uses canonical IDs even when final virtual key remains observer-local", async () => {
	const rows = [
		{
			dataset: { messageId: "user_1", messageKey: "message:user_1" },
			textContent: fixture.prompt,
			querySelector: (selector) => selector === "article.message-user",
		},
		{
			dataset: { messageId: "assistant_2", messageKey: 'stream:["workspace","conversation","partial"]' },
			textContent: fixture.answer,
			querySelector: (selector) => selector === "article.message-assistant",
		},
	];
	const cdp = {
		request: async (_method, params) => ({
			result: {
				value: runInNewContext(params.expression, {
					document: {
						querySelectorAll: (selector) => {
							assert.equal(selector, "[data-message-id]");
							return rows;
						},
					},
				}),
			},
		}),
	};
	assert.deepEqual(Array.from(await historyEvidence(cdp)), ["message:user_1", "message:assistant_2"]);
	rows[1].dataset.messageKey = "message:assistant_2";
	assert.deepEqual(Array.from(await historyEvidence(cdp)), ["message:user_1", "message:assistant_2"]);
	rows[1].dataset.messageId = "user_1";
	await assert.rejects(historyEvidence(cdp), /identities must be unique/);
});

function mountedStream() {
	const paragraph = { isConnected: true, textContent: fixture.answer };
	const body = { isConnected: true, children: [paragraph, {}], querySelector: () => paragraph };
	const copy = { disabled: false };
	let busy = true;
	const article = {
		isConnected: true,
		getAttribute: () => (busy ? "true" : "false"),
		querySelector: () => body,
		querySelectorAll: () => (busy ? [] : [copy]),
	};
	const row = {
		isConnected: true,
		dataset: {
			messageKey: `stream:${JSON.stringify(["workspace", "conversation", "partial"])}`,
			transcriptKind: "assistant-stream",
		},
		querySelector: () => article,
	};
	let rows = [row];
	const document = {
		querySelectorAll: (selector) =>
			selector === "[data-message-key]"
				? rows
				: rows.filter((node) => node.dataset.transcriptKind === "assistant-stream"),
	};
	return {
		document,
		row,
		article,
		body,
		paragraph,
		copy,
		replaceRows(value) {
			rows = value;
		},
		commit() {
			busy = false;
			row.dataset.transcriptKind = "assistant-message";
			row.dataset.messageId = "canonical_1";
		},
	};
}

test("mounted stream keeps row, article, markdown and settled paragraph through canonical commit", () => {
	const dom = mountedStream();
	const observation = {};
	observeMountedStream(dom.document, observation, fixture.answer);
	assert.equal(observation.streamNodes.row, dom.row);
	assert.equal(committedStreamEvidence(dom.document, observation).committed, false);
	dom.commit();
	const evidence = committedStreamEvidence(dom.document, observation);
	assertCommittedStreamIdentity(evidence, { workspaceId: "workspace", conversationId: "conversation" });
	assert.equal(evidence.messageId, "canonical_1");
	assert.throws(() =>
		assertCommittedStreamIdentity(evidence, { workspaceId: "other", conversationId: "conversation" }),
	);
});

test("identical text cannot hide a remounted stream node or duplicate/unfinished row", () => {
	for (const level of [
		"row",
		"article",
		"body",
		"paragraph",
		"disconnected",
		"copy",
		"duplicate",
		"extra-stream",
		"canonical",
	]) {
		const dom = mountedStream();
		const observation = {};
		observeMountedStream(dom.document, observation, fixture.answer);
		dom.commit();
		if (level === "row") dom.replaceRows([{ ...dom.row }]);
		if (level === "article") dom.row.querySelector = () => ({ ...dom.article });
		if (level === "body") dom.article.querySelector = () => ({ ...dom.body });
		if (level === "paragraph") dom.body.querySelector = () => ({ ...dom.paragraph });
		if (level === "disconnected") dom.paragraph.isConnected = false;
		if (level === "copy") dom.copy.disabled = true;
		if (level === "duplicate") dom.replaceRows([dom.row, dom.row]);
		if (level === "extra-stream")
			dom.replaceRows([dom.row, { dataset: { messageKey: "stream:other", transcriptKind: "assistant-stream" } }]);
		if (level === "canonical") delete dom.row.dataset.messageId;
		assert.throws(
			() =>
				assertCommittedStreamIdentity(committedStreamEvidence(dom.document, observation), {
					workspaceId: "workspace",
					conversationId: "conversation",
				}),
			level,
		);
	}
});

test("stream capture requires authoritative live identity and an actually settled paragraph", () => {
	for (const invalid of ["key", "short-key", "paragraph", "no-tail", "committed"]) {
		const dom = mountedStream();
		if (invalid === "key") dom.row.dataset.messageKey = "stream:not-json";
		if (invalid === "short-key") dom.row.dataset.messageKey = 'stream:["workspace"]';
		if (invalid === "paragraph") dom.paragraph.textContent = "unfinished";
		if (invalid === "no-tail") dom.body.children = [dom.paragraph];
		if (invalid === "committed") dom.commit();
		const observation = {};
		observeMountedStream(dom.document, observation, fixture.answer);
		assert.equal(observation.streamNodes, undefined, invalid);
	}
});

test("streaming observation retains every invalid action state even after a valid sole Stop", () => {
	const stop = { dataset: { action: "stop" }, type: "button", getAttribute: () => "Cancel execution" };
	const send = { dataset: { action: "send" }, type: "submit", getAttribute: () => "Submit task" };
	let actions = [stop];
	let executionState = "running";
	const document = {
		querySelector: () => ({ dataset: { executionState } }),
		querySelectorAll: () => actions,
	};
	const observation = { soleStopObserved: false, invalidRunningActions: 0 };
	observeStreamingActions(document, observation);
	assert.deepEqual(observation, { soleStopObserved: true, invalidRunningActions: 0 });
	for (const invalid of [[stop, send], [], [send], [{ ...stop, type: "submit" }]]) {
		actions = invalid;
		observeStreamingActions(document, observation);
	}
	actions = [stop];
	observeStreamingActions(document, observation);
	assert.deepEqual(observation, { soleStopObserved: true, invalidRunningActions: 4 });
	executionState = "idle";
	actions = [send];
	observeStreamingActions(document, observation);
	assert.equal(observation.invalidRunningActions, 4, "Idle Send is not a running-state failure");
});

test("default chat identity and cardinality reject duplicate backing workspaces, conversations and incorrect receipt scope", async () => {
	const valid = {
		count: 1,
		recent: 1,
		workspaceId: "receipt-work",
		selected: "true",
		conversations: 1,
		title: fixture.conversation,
	};
	const verify = (state, reopened = false) =>
		assertDefaultChatScope(
			{ request: async () => ({ result: { value: state } }) },
			{ workspaceId: "receipt-work", conversationId: "one" },
			reopened,
		);
	await verify(valid);
	await verify({ ...valid, count: 2 }, true);
	for (const [key, value] of Object.entries({
		count: 2,
		recent: 2,
		workspaceId: "same-name-wrong-id",
		selected: "false",
		conversations: 2,
		title: "wrong",
	}))
		await assert.rejects(verify({ ...valid, [key]: value }));
	await assert.rejects(verify(valid, true));
	await assert.rejects(verify({ ...valid, count: 3 }, true));
});

test("initial chat uses native draft input, Shift+Enter and IME without creating work before Send", async () => {
	let selected = false;
	let settings = false;
	let menu = false;
	const events = [];
	const make = (name, y) => ({
		name,
		value: "",
		getClientRects: () => [{}],
		scrollIntoView() {},
		getBoundingClientRect: () => ({ x: 0, y, width: 100, height: 20 }),
		contains(node) {
			return node === this;
		},
	});
	const goal = make("goal", 0),
		next = make("new", 30),
		model = make("model", 60),
		manage = make("manage", 90),
		back = make("back", 120);
	const nodes = {
		".prepared-task-input": goal,
		".new-conversation-trigger": next,
		".new-chat-model-trigger": model,
		".new-chat-manage-models": manage,
		".settings-back": back,
	};
	const document = {
		activeElement: goal,
		querySelector(selector) {
			if (selector === ".new-chat-composer")
				return {
					querySelector: (selector) =>
						selector.startsWith(".composer-submit") ? { type: "submit", disabled: false } : goal,
				};
			if (selector === ".settings-route") return settings ? {} : null;
			if (selector === ".settings-page-nav [aria-current=page]")
				return settings ? { dataset: { category: "models" } } : null;
			return nodes[selector] ?? null;
		},
		querySelectorAll(selector) {
			return nodes[selector] ? [nodes[selector]] : selector === '[role="dialog"]' && menu ? [{}] : [];
		},
		elementFromPoint(_x, y) {
			return Object.values(nodes).find((node) => node.getBoundingClientRect().y + 10 === y);
		},
	};
	const cdp = {
		async request(method, params) {
			if (method === "Runtime.evaluate")
				return {
					result: {
						value: await runInNewContext(params.expression, {
							document,
							location: { href: "hipi-work://app/index.html" },
							requestAnimationFrame: (callback) => callback(),
						}),
					},
				};
			events.push({ method, ...params });
			if (method === "Input.insertText") goal.value += params.text;
			if (method === "Input.dispatchMouseEvent" && params.type === "mouseReleased") {
				const target = document.elementFromPoint(params.x, params.y);
				document.activeElement = target;
				if (target === next) document.activeElement = goal;
				if (target === model) menu = true;
				if (target === manage) {
					menu = false;
					settings = true;
				}
				if (target === back) {
					settings = false;
					document.activeElement = model;
				}
			}
			if (method === "Input.dispatchKeyEvent" && params.type === "keyDown") {
				if (params.key === "a") selected = true;
				if (params.key === "Backspace" && selected) {
					goal.value = "";
					selected = false;
				}
				if (params.key === "Enter" && params.text && params.modifiers === 8) goal.value += "\n";
			}
		},
	};
	assert.deepEqual(await inspectInitialChat(cdp), {
		shiftEnterOnlyNewline: true,
		cdpCompositionDoesNotSend: true,
		navigationDoesNotCreate: true,
		settingsRetainsDraft: true,
		singleSendRequired: true,
	});
	assert.equal(goal.value, fixture.prompt);
	assert.ok(events.some((event) => event.windowsVirtualKeyCode === 229));
	assert.ok(events.some((event) => event.method === "Input.imeSetComposition"));
	assert.equal(
		events.filter((event) => event.method === "Input.dispatchMouseEvent" && event.type === "mouseReleased").length,
		5,
		"Only draft/navigation/model settings input, never Send",
	);
});

test("initial chat rejects premature backing objects, lost drafts and disabled-Send false positives", () => {
	const valid = {
		home: true,
		goal: "Goal\n",
		sendType: "submit",
		sendDisabled: false,
		dialogs: 0,
		workspaces: 0,
		conversations: 0,
		messages: 0,
	};
	assert.doesNotThrow(() => assertInitialChatUnsubmitted(valid, "Goal\n"));
	for (const [key, value] of Object.entries({
		home: false,
		goal: "Goal",
		sendType: "button",
		sendDisabled: true,
		dialogs: 1,
		workspaces: 1,
		conversations: 1,
		messages: 1,
	}))
		assert.throws(() => assertInitialChatUnsubmitted({ ...valid, [key]: value }, "Goal\n"));
});

test("capture waits for finite floating entrances and two frames, without awaiting infinite busy indicators", async () => {
	const events = [];
	const finite = { playState: "running", effect: { getComputedTiming: () => ({ endTime: 180 }) } };
	finite.finished = Promise.resolve().then(() => {
		events.push("finished");
		finite.playState = "finished";
	});
	const infinite = {
		playState: "running",
		effect: { getComputedTiming: () => ({ endTime: Infinity }) },
		finished: new Promise(() => {}),
	};
	const document = { querySelectorAll: () => [{ getAnimations: () => [finite, infinite] }] };
	await settleFloatingAnimations(document, 100, (callback) => {
		events.push("frame");
		callback();
	});
	assert.deepEqual(events, ["finished", "frame", "frame"]);
});

test("capture fails a bounded finite entrance stall instead of silently taking a translucent screenshot", async () => {
	const animation = {
		playState: "running",
		effect: { getComputedTiming: () => ({ endTime: 180 }) },
		finished: new Promise(() => {}),
	};
	const document = { querySelectorAll: () => [{ getAnimations: () => [animation] }] };
	await assert.rejects(
		settleFloatingAnimations(document, 10, (callback) => callback()),
		/did not settle/,
	);
});

test("focus timeout identifies only allowlisted targets, never dynamic titles or input values", async () => {
	assert.equal(diagnosticTarget('button[aria-label="Model status"]'), "Model status");
	assert.equal(
		diagnosticTarget('header button[aria-label="Conversation actions: private title"]'),
		"Conversation actions",
	);
	assert.equal(diagnosticTarget('input[value="secret"]', "private text"), "unrecognized target");
	await assert.rejects(
		waitForOverlayClosed(
			{ request: async () => ({ result: { value: false } }) },
			'button[aria-label="Model status"]',
			undefined,
			1,
		),
		/trigger focus restored: Model status/,
	);
});

test("overlay closure waits beyond DOM removal for the original trigger focus before further input", async () => {
	let reads = 0;
	const trigger = { textContent: "View activity" };
	const document = {
		activeElement: null,
		querySelector: () => (reads === 1 ? {} : null),
		querySelectorAll: () => [trigger],
	};
	const cdp = {
		async request(method, params) {
			assert.equal(method, "Runtime.evaluate", "No next input before autofocus is complete");
			reads++;
			if (reads === 3) document.activeElement = trigger;
			return {
				result: {
					value: await runInNewContext(params.expression, {
						document,
						requestAnimationFrame: (callback) => callback(),
					}),
				},
			};
		},
	};
	await waitForOverlayClosed(cdp, "button", "View activity");
	assert.equal(reads, 3, "Absent DOM alone cannot complete the lifecycle boundary");
});

test("receipt scope comes from exact visible receipt identifiers and rejects malformed IDs", async () => {
	let workspaceId = "work_123";
	const cdp = {
		async request(method, params) {
			assert.equal(method, "Runtime.evaluate");
			return {
				result: {
					value: runInNewContext(params.expression, {
						document: {
							querySelector: () => ({
								querySelector: (selector) => ({
									textContent: selector.includes("workspace-id") ? workspaceId : "conversation_456",
								}),
							}),
						},
					}),
				},
			};
		},
	};
	const scope = await receiptScope(cdp);
	assert.equal(scope.workspaceId, "work_123");
	assert.equal(scope.conversationId, "conversation_456");
	workspaceId = "wrong/path";
	await assert.rejects(receiptScope(cdp));
});

test("modal bounds rejects an offscreen or covered Close without sending input", async () => {
	for (const reason of ["offscreen", "covered", "title-offscreen", "title-covered", "valid", "center"]) {
		const rect = { x: 500, y: 10, width: 400, height: 600 };
		const close = {
			textContent: "Close",
			getBoundingClientRect: () => ({ x: 850, y: reason === "offscreen" ? -100 : 20, width: 30, height: 30 }),
			contains: () => reason !== "covered",
		};
		const body = { getBoundingClientRect: () => rect, scrollTop: 0, clientHeight: 500, scrollHeight: 500 };
		const title = {
			getBoundingClientRect: () => ({ x: 520, y: reason === "title-offscreen" ? -50 : 20, width: 200, height: 25 }),
			contains: () => reason !== "title-covered",
		};
		const dialog = {
			dataset: { placement: reason === "center" ? "center" : "right", scrollBody: "true" },
			getBoundingClientRect: () => rect,
			querySelectorAll: () => [close],
			querySelector: (selector) => {
				return selector === '[data-slot="dialog-title"]' ? title : body;
			},
		};
		const cdp = {
			async request(method, params) {
				assert.equal(method, "Runtime.evaluate");
				return {
					result: {
						value: runInNewContext(params.expression, {
							location: { href: "hipi-work://app/index.html" },
							innerWidth: 1000,
							innerHeight: 800,
							document: { querySelector: () => dialog, elementFromPoint: () => close },
						}),
					},
				};
			},
		};
		if (reason === "valid" || reason === "center")
			assert.equal((await modalBounds(cdp, ".dialog", 1, reason === "center" ? "center" : "right")).ready, true);
		else await assert.rejects(modalBounds(cdp, ".dialog", 1), /modal viewport and reachable Close/);
	}
});

test("overflowing modal scrolls through real wheel input and rechecks Close reachability", async () => {
	let scrolled = false;
	let reads = 0;
	const cdp = {
		async request(method, params) {
			if (method === "Runtime.evaluate" && params.expression.includes("let blocked=false"))
				return { result: { value: { x: 104, y: 300 } } };
			if (method === "Input.dispatchMouseEvent") {
				assert.equal(params.type, "mouseWheel");
				assert.equal(params.deltaY, 1200);
				assert.equal(params.x, 104);
				assert.equal(params.y, 300);
				scrolled = true;
				return {};
			}
			reads++;
			return {
				result: {
					value: {
						ready: true,
						body: { x: 100, y: 100, width: 300, height: 400 },
						scrollTop: scrolled ? 800 : 0,
						clientHeight: 400,
						scrollHeight: 1200,
					},
				},
			};
		},
	};
	assert.equal((await inspectModal(cdp, ".dialog")).scrolledToBottom, true);
	assert.ok(reads >= 3);
});

test("modal wheel hit testing avoids nested textareas and rejects an overlay covering the body", async () => {
	const body = {
		getBoundingClientRect: () => ({ x: 100, y: 100, width: 300, height: 400 }),
		contains: (node) => node === body || node === textarea,
	};
	const textarea = { tagName: "TEXTAREA", parentElement: body, scrollHeight: 600, clientHeight: 150 };
	let covered = false;
	const cdp = {
		request: async (method, params) => {
			assert.equal(method, "Runtime.evaluate");
			return {
				result: {
					value: runInNewContext(params.expression, {
						innerWidth: 1000,
						innerHeight: 800,
						getComputedStyle: () => ({ overflowY: "auto" }),
						document: {
							querySelector: () => ({ querySelector: () => body }),
							elementFromPoint: (x) => (covered ? {} : x === 250 ? textarea : body),
						},
					}),
				},
			};
		},
	};
	const point = await modalWheelPoint(cdp, ".tool-packs-dialog");
	assert.equal(point.x, 104);
	assert.equal(point.y, 300);
	textarea.tagName = "DIV";
	assert.equal((await modalWheelPoint(cdp, ".tool-packs-dialog")).x, 104);
	covered = true;
	await assert.rejects(modalWheelPoint(cdp, ".tool-packs-dialog"), /no unobstructed non-nested wheel target/);
});

test("click failure identifies requested text and refuses covered or ambiguous controls", async () => {
	for (const state of [
		{ count: 1, hit: false },
		{ count: 2, hit: false },
	]) {
		const cdp = {
			async request(method) {
				assert.equal(method, "Runtime.evaluate", "No input may be sent to an unverified target");
				return { result: { value: state } };
			},
		};
		await assert.rejects(
			click(cdp, '[role="dialog"] button', "Close", 1),
			/label "Close"; candidates [12], centerHit false/,
		);
	}
});

test("sidebar hover sends a native mouse move only after a unique unobstructed target", async () => {
	const events = [];
	const node = {
		getClientRects: () => [{}],
		getBoundingClientRect: () => ({ x: 20, y: 40, width: 100, height: 30 }),
		contains: (hit) => hit === node,
	};
	let reads = 0;
	const cdp = {
		request: async (method, params) => {
			if (method !== "Runtime.evaluate") {
				events.push({ method, ...params });
				return {};
			}
			reads++;
			return {
				result: {
					value: runInNewContext(params.expression, {
						document: {
							querySelectorAll: () => (reads === 1 ? [node, node] : [node]),
							elementFromPoint: () => (reads === 2 ? {} : node),
						},
					}),
				},
			};
		},
	};
	await hover(cdp, ".conversation-link");
	assert.equal(reads, 3);
	assert.deepEqual(events, [{ method: "Input.dispatchMouseEvent", type: "mouseMoved", x: 70, y: 55 }]);
});

test("failure capture is bounded and redacts unknown button text; renderer loss never throws", async () => {
	const directory = await mkdtemp(join(tmpdir(), "hipi-gui-diagnostic-test-"));
	const node = {
		textContent: "private-content-must-not-be-recorded",
		getAttribute: () => null,
		getBoundingClientRect: () => ({ x: 0, y: 0, width: 10, height: 10 }),
		getClientRects: () => [{}],
		closest: () => null,
		contains: () => false,
		get value() {
			throw new Error("Input values must never be read");
		},
	};
	const png = Buffer.alloc(1100);
	Buffer.from("89504e470d0a1a0a", "hex").copy(png);
	const cdp = {
		async request(method, params) {
			if (method === "Page.captureScreenshot") return { data: png.toString("base64") };
			assert.equal(method, "Runtime.evaluate");
			if (params.expression.startsWith("document.fonts.ready")) return { result: { value: true } };
			return {
				result: {
					value: runInNewContext(params.expression, {
						location: { href: "hipi-work://app/index.html" },
						document: {
							activeElement: node,
							querySelectorAll: () => Array.from({ length: 105 }, () => node),
							elementFromPoint: () => null,
						},
					}),
				},
			};
		},
	};
	try {
		assert.deepEqual(await captureFailure(cdp, directory), { controls: "saved", screenshot: "saved" });
		const raw = await readFile(join(directory, "failure-controls.json"), "utf8");
		assert.ok(!raw.includes("private-content"));
		const value = JSON.parse(raw);
		assert.equal(value.total, 105);
		assert.equal(value.controls.length, 100);
		assert.equal(value.truncated, true);
		assert.equal(value.controls[0].label, "<unrecognized>");
		assert.equal(value.controls[0].focused, true);
		assert.deepEqual(
			await captureFailure(
				{
					request: async () => {
						throw new Error("closed");
					},
				},
				directory,
			),
			{ controls: "unavailable", screenshot: "unavailable" },
		);
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
});

function renderer({ delay = 0, selected = false } = {}) {
	const clicks = [];
	let reads = 0;
	const conversation = {
		textContent: fixture.conversation,
		disabled: false,
		getClientRects: () => [{}],
		getBoundingClientRect: () => ({ x: 0, y: 40, width: 20, height: 20 }),
		scrollIntoView() {},
		contains(other) {
			return other === this;
		},
	};
	const document = {
		querySelector: () => (selected ? { textContent: fixture.conversation } : null),
		querySelectorAll(selector) {
			if (selector === ".recent-conversations") return ++reads > delay ? [{}] : [];
			if (selector === ".recent-conversations .conversation-link") return reads > delay ? [conversation] : [];
			throw new Error(`Unexpected selector: ${selector}`);
		},
		elementFromPoint: () => conversation,
	};
	return {
		clicks,
		async request(method, params) {
			if (method === "Runtime.evaluate")
				return {
					result: {
						value: runInNewContext(params.expression, { document, location: { href: "hipi-work://app/index.html" } }),
					},
				};
			assert.equal(method, "Input.dispatchMouseEvent");
			if (params.type === "mouseReleased") clicks.push("conversation");
			return {};
		},
	};
}

test("keyboard smoke emits paired native CDP events and rejects unknown keys", async () => {
	const events = [];
	const cdp = {
		async request(method, params) {
			events.push({ method, ...params });
		},
	};
	await pressKey(cdp, "Escape");
	assert.deepEqual(events, [
		{ method: "Input.dispatchKeyEvent", type: "keyDown", key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 },
		{ method: "Input.dispatchKeyEvent", type: "keyUp", key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 },
	]);
	await assert.rejects(pressKey(cdp, "Delete"), /Unsupported smoke key/);
	assert.equal(events.length, 2);
});

test("theme restoration distinguishes system preference from explicit light and dark", () => {
	assert.equal(resolvedTheme("system", false), "light");
	assert.equal(resolvedTheme("system", true), "dark");
	assert.equal(resolvedTheme("light", true), "light");
	assert.equal(resolvedTheme("dark", false), "dark");
	assert.throws(() => resolvedTheme("unknown", false), /Unknown appearance mode/);
});

test("unexpected application alerts fail even without console errors or visible geometry", async () => {
	let elements = [];
	const cdp = {
		async request(_method, params) {
			return {
				result: {
					value: runInNewContext(params.expression, {
						document: {
							querySelectorAll(selector) {
								assert.equal(selector, '[role="alert"]');
								return elements;
							},
						},
					}),
				},
			};
		},
	};
	await assertNoAlerts(cdp);
	elements = [{ textContent: " Records could not be read ", getClientRects: () => [] }];
	await assert.rejects(assertNoAlerts(cdp), /Unexpected application alert.*Records could not be read/);
});

test("reopen waits for the actual retained default Recent branch without creating another workspace", async () => {
	const cdp = renderer({ delay: 2 });
	await selectReopenedConversation(cdp);
	assert.deepEqual(cdp.clicks, ["conversation"]);
});

test("reopen preserves an already restored conversation selection without extra input", async () => {
	const cdp = renderer({ selected: true });
	await selectReopenedConversation(cdp);
	assert.deepEqual(cdp.clicks, []);
});

test("activity evidence requires a loaded successful page, not merely absence of console errors", async () => {
	let paragraphs = [];
	let loading = true;
	let failed = false;
	let reads = 0;
	const dialog = {
		querySelector(selector) {
			if (selector === "h2") return { textContent: "Tool activity" };
			if (selector === '[role="alert"]') return failed ? {} : null;
			throw new Error(`Unexpected selector: ${selector}`);
		},
		querySelectorAll(selector) {
			if (selector === "p") return paragraphs.map((textContent) => ({ textContent }));
			if (selector === "output") return loading ? [{ textContent: "Reading records…" }] : [];
			throw new Error(`Unexpected selector: ${selector}`);
		},
	};
	const cdp = {
		async request(method, params) {
			assert.equal(method, "Runtime.evaluate");
			if (++reads === 3) {
				loading = false;
				paragraphs = [
					"Task-record section",
					"No activity in this scanned page. More records may be available on the next page.",
				];
			}
			return {
				result: {
					value: runInNewContext(params.expression, {
						document: {
							querySelectorAll: () => [{ querySelector: () => ({ textContent: "Conversation details" }) }, dialog],
						},
					}),
				},
			};
		},
	};
	assert.deepEqual(await activityEvidence(cdp), { section: "Task-record section", empty: true });
	assert.equal(reads, 3);
	failed = true;
	await assert.rejects(activityEvidence(cdp), /Tool activity read failed/);
	failed = false;
	paragraphs = ["Task-record section"];
	await assert.rejects(activityEvidence(cdp), /confirmed empty activity page/);
});
