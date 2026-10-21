import assert from "node:assert/strict";
import { test } from "node:test";
import {
	type HistoryPage,
	type Message,
	parseHistoryPage,
	type RunResultObservation,
	type SearchHistoryWindow,
	type Snapshot,
} from "@hipi/work-runtime/contracts";
import { hasRunResultConflict } from "../../../src/features/workbench/conversation/activity/results.ts";
import {
	fitHistoryWindow,
	fitsHistory,
	HistoryCursorProgress,
	type HistoryViewport,
} from "../../../src/features/workbench/conversation/history/window.ts";
import { ConversationHistoryController } from "../../../src/features/workbench/conversation/history-controller.ts";

const scope = { workspaceId: "w", conversationId: "c" };
const message = (index: number): Message => ({
	id: `m${index}`,
	role: "user",
	text: `${index}`,
	textLength: `${index}`.length,
	truncated: false,
});
const all = Array.from({ length: 2200 }, (_, index) => message(index));
const latest: Snapshot = {
	...scope,
	messages: all.slice(-32),
	historyCursor: "2168",
	running: false,
	partial: "",
	partialLength: 0,
	partialTruncated: false,
};
const tick = () => new Promise<void>((resolve) => setImmediate(resolve));
const viewport = (direction: "older" | "newer", ids: string[] = []): HistoryViewport => ({
	olderDistance: direction === "older" ? 0 : 100_000,
	newerDistance: direction === "newer" ? 0 : 100_000,
	paused: false,
	pinnedIds: new Set(ids),
});
function harness() {
	let calls = 0;
	const owner = new ConversationHistoryController(
		scope,
		async (cursor) => {
			calls++;
			const end = Number(cursor);
			return { ...scope, messages: all.slice(Math.max(0, end - 32), end), nextCursor: end > 32 ? `${end - 32}` : null };
		},
		() => {},
	);
	owner.update(latest);
	return { owner, calls: () => calls };
}
async function settle(owner: ConversationHistoryController) {
	for (let index = 0; index < 100 && owner.state.loading; index++)
		await new Promise((resolve) => setTimeout(resolve, 1));
	assert.equal(owner.state.loading, false);
	assert.equal(owner.state.failed, false);
	assert.ok(fitsHistory(owner.state.snapshot?.messages ?? []));
}

test("ordinary local geometry loads without a user scroll and ignores far or paused demand", async () => {
	const { owner, calls } = harness();
	owner.setViewport({ ...viewport("older"), olderDistance: 801 });
	assert.equal(calls(), 0);
	owner.setViewport({ ...viewport("older"), paused: true });
	assert.equal(calls(), 0);
	owner.setViewport({ ...viewport("older"), olderDistance: 800 });
	await settle(owner);
	assert.equal(calls(), 1);
	owner.dispose();
});

test("bounded older eviction remains reachable in both directions by fenced replay", async () => {
	const { owner } = harness();
	const seen = new Set<string>(latest.messages.map((message) => message.id));
	for (let index = 0; index < 70 && owner.state.snapshot?.historyCursor; index++) {
		const first = owner.state.snapshot?.messages[0]?.id;
		owner.setViewport(viewport("older", first ? [first] : []));
		await settle(owner);
		for (const item of owner.state.snapshot?.messages ?? []) seen.add(item.id);
	}
	assert.equal(seen.size, all.length);
	assert.equal(owner.state.snapshot?.messages[0]?.id, "m0");
	assert.equal(owner.state.newer, true);
	assert.equal(owner.state.capacity, false);
	for (let index = 0; index < 20 && owner.state.newer; index++) {
		const tail = owner.state.snapshot?.messages.at(-1)?.id;
		owner.setViewport(viewport("newer", tail ? [tail] : []));
		await settle(owner);
	}
	assert.equal(owner.state.snapshot?.messages.at(-1)?.id, "m2199");
	assert.equal(owner.state.newer, false);
	assert.notEqual(owner.state.snapshot?.messages[0]?.id, "m0");
	for (let index = 0; index < 20 && owner.state.snapshot?.messages[0]?.id !== "m0"; index++) {
		const first = owner.state.snapshot?.messages[0]?.id;
		owner.setViewport(viewport("older", first ? [first] : []));
		await settle(owner);
	}
	assert.equal(owner.state.snapshot?.messages[0]?.id, "m0");
	owner.dispose();
});

test("both replay directions retain model-less and extra boundary sidecars before reaching the live fence", async () => {
	const fact: RunResultObservation = {
		id: "9000",
		terminalEntryId: "9002",
		responseMessageId: "9001_0",
		admittedAtMs: 1000,
		settledAtMs: 5000,
		terminalCause: "response",
		settlement: { status: "done" },
	};
	const boundaryFact = { ...fact, id: "9010", terminalEntryId: "9012", responseMessageId: "9011_0" };
	let inject: "none" | "newer" | "older" = "none";
	let boundaryCursor: string | undefined;
	const owner = new ConversationHistoryController(
		scope,
		async (cursor) => {
			const end = Number(cursor.replace("metadata:", ""));
			if (inject !== "none" && !cursor.startsWith("metadata:")) {
				const changed = inject === "older";
				inject = "none";
				return parseHistoryPage({
					...scope,
					messages: [],
					nextCursor: `metadata:${end}`,
					runResults: { items: [{ ...fact, settledAtMs: changed ? 6000 : 5000 }], omitted: true },
				});
			}
			return parseHistoryPage({
				...scope,
				messages: all.slice(Math.max(0, end - 32), end),
				nextCursor: end > 32 ? String(end - 32) : null,
				...(cursor === boundaryCursor ? { runResults: { items: [boundaryFact], omitted: true } } : {}),
			});
		},
		() => {},
	);
	owner.update(latest);
	for (let index = 0; index < 70 && owner.state.snapshot?.historyCursor; index++) {
		owner.setViewport(viewport("older"));
		await settle(owner);
	}
	assert.equal(owner.state.snapshot?.messages[0]?.id, "m0");
	inject = "newer";
	owner.setViewport(viewport("newer"));
	await settle(owner);
	assert.equal(owner.state.newer, true, "sidecar must survive an intermediate replay, not only the final live fence");
	assert.deepEqual(owner.state.snapshot?.runResults?.items, [fact]);
	for (let index = 0; index < 20 && owner.state.newer; index++) {
		owner.setViewport(viewport("newer"));
		await settle(owner);
	}
	assert.equal(owner.state.newer, false);
	const first = owner.state.snapshot?.messages[0]?.id;
	assert.ok(first);
	assert.notEqual(first, "m0");
	boundaryCursor = first.slice(1);
	inject = "older";
	owner.setViewport(viewport("older"));
	await settle(owner);
	assert.ok(owner.state.snapshot?.runResults?.items.some((item) => item.id === boundaryFact.id));
	assert.equal(hasRunResultConflict(owner.state.snapshot?.runResults, fact.id), true);
	owner.update({ ...latest, runResults: { items: [fact], omitted: false } });
	owner.setViewport(viewport("newer"));
	await settle(owner);
	assert.equal(hasRunResultConflict(owner.state.snapshot?.runResults, fact.id), true);
	owner.resetToLatest();
	assert.equal(
		hasRunResultConflict(owner.state.snapshot?.runResults, fact.id),
		false,
		"an explicit reset starts an independent retained view rather than persisting local evidence forever",
	);
	owner.dispose();
});

test("pinned capacity preserves content, never loops on unchanged geometry, and resumes after release", async () => {
	const { owner, calls } = harness();
	for (let index = 0; index < 65 && !owner.state.capacity; index++) {
		owner.setViewport(
			viewport(
				"older",
				owner.state.snapshot?.messages.map((item) => item.id),
			),
		);
		await settle(owner);
	}
	assert.equal(owner.state.capacity, true);
	const held = owner.state.snapshot;
	const before = calls();
	owner.setViewport(
		viewport(
			"older",
			held?.messages.map((item) => item.id),
		),
	);
	assert.equal(calls(), before);
	assert.equal(owner.state.snapshot, held);
	owner.setViewport(viewport("older", held?.messages[0] ? [held.messages[0].id] : []));
	await settle(owner);
	assert.equal(owner.state.capacity, false);
	assert.notEqual(owner.state.snapshot, held);
	owner.dispose();
});

test("window policy never drops a protected far edge to manufacture space", () => {
	assert.equal(fitHistoryWindow(all, "older", viewport("older", ["m2199"])), undefined);
	assert.equal(fitHistoryWindow(all, "newer", viewport("newer", ["m0"])), undefined);
	assert.equal(fitHistoryWindow(all, "older", null), undefined);
	assert.ok(fitsHistory(fitHistoryWindow(all, "older", viewport("older")) ?? []));
});

test("late replay cannot replace a reset view and stale boundary stays a retryable failure", async () => {
	const { owner } = harness();
	for (let index = 0; index < 64; index++) {
		owner.setViewport(viewport("older"));
		await settle(owner);
	}
	assert.equal(owner.state.newer, true);
	owner.setViewport(viewport("newer"));
	owner.resetToLatest();
	await tick();
	assert.deepEqual(owner.state.snapshot?.messages, latest.messages);
	owner.dispose();
	let resolve: ((page: HistoryPage) => void) | undefined;
	const stale = new ConversationHistoryController(
		scope,
		() =>
			new Promise((r) => {
				resolve = r;
			}),
		() => {},
	);
	stale.update(latest);
	stale.setViewport(viewport("older"));
	resolve?.({ ...scope, messages: [], nextCursor: "2168" });
	await tick();
	assert.equal(stale.state.failed, true);
	assert.deepEqual(stale.state.snapshot?.messages, latest.messages);
	stale.dispose();
});

test("search windows restore both evicted edges using their original opaque page identities", async () => {
	const window = (start: number, end: number): SearchHistoryWindow => ({
		...scope,
		messages: all.slice(start, end),
		target: { ...scope, messageId: "m1100", text: "1100", offset: 0, textLength: 4, nextOffset: null },
		matchStart: 0,
		matchEnd: 4,
		olderCursor: start > 0 ? `o${start}` : null,
		newerCursor: end < all.length ? `n${end}` : null,
	});
	const owner = new ConversationHistoryController(
		scope,
		async () => {
			throw new Error("Search never reads ordinary history");
		},
		() => {},
		async (_locator, cursor) => {
			const edge = Number(cursor.slice(1));
			return cursor.startsWith("o")
				? window(Math.max(0, edge - 32), edge)
				: window(edge, Math.min(all.length, edge + 32));
		},
	);
	owner.openAnchor({ locator: "match", window: window(1088, 1120) });
	for (let index = 0; index < 35 && owner.state.snapshot?.messages[0]?.id !== "m0"; index++) {
		owner.setViewport(viewport("older"));
		await settle(owner);
	}
	assert.equal(owner.state.snapshot?.messages[0]?.id, "m0");
	for (let index = 0; index < 35 && owner.state.snapshot?.messages.at(-1)?.id !== "m2199"; index++) {
		owner.setViewport(viewport("newer"));
		await settle(owner);
	}
	assert.equal(owner.state.snapshot?.messages.at(-1)?.id, "m2199");
	assert.notEqual(owner.state.snapshot?.messages[0]?.id, "m0");
	for (let index = 0; index < 15 && owner.state.snapshot?.messages[0]?.id !== "m0"; index++) {
		owner.setViewport(viewport("older"));
		await settle(owner);
	}
	assert.equal(owner.state.snapshot?.messages[0]?.id, "m0");
	assert.equal(owner.state.anchor?.window.target.messageId, "m1100");
	owner.dispose();
});

test("large live gaps switch to bounded boundary replay without publishing a false continuous tail", async () => {
	const publications: Snapshot[] = [];
	const owner = new ConversationHistoryController(
		scope,
		async (cursor) => {
			const end = Number(cursor);
			return { ...scope, messages: all.slice(Math.max(0, end - 32), end), nextCursor: end > 32 ? `${end - 32}` : null };
		},
		(state) => {
			if (state.snapshot) publications.push(state.snapshot);
		},
	);
	owner.update({ ...latest, messages: all.slice(0, 32), historyCursor: null });
	owner.setViewport(viewport("newer", ["m31"]));
	owner.update({ ...latest, running: true, partial: "new live output", partialLength: 15 });
	for (let index = 0; index < 100 && (owner.state.reconciling || owner.state.loading); index++)
		await new Promise((resolve) => setTimeout(resolve, 2));
	await new Promise((resolve) => setTimeout(resolve, 10));
	await settle(owner);
	assert.equal(owner.state.capacity, false);
	assert.equal(owner.state.newer, true);
	assert.equal(owner.state.snapshot?.running, false);
	assert.equal(owner.state.snapshot?.partial, "");
	assert.equal(owner.state.snapshot?.messages[0]?.id, "m0");
	assert.notEqual(owner.state.snapshot?.messages.at(-1)?.id, "m2199");
	for (const publication of publications) {
		const ids = publication.messages.map((message) => Number(message.id.slice(1)));
		assert.ok(ids.every((id, index) => index === 0 || id === (ids[index - 1] ?? -1) + 1));
	}
	owner.dispose();
});

test("constant-space progress detection catches cycles beyond the retained cursor checkpoint budget", () => {
	const progress = new HistoryCursorProgress();
	let rejected = false;
	for (let index = 0; index < 20_000; index++) {
		if (!progress.advance(`${index % 3000}`, `${(index + 1) % 3000}`)) {
			rejected = true;
			break;
		}
	}
	assert.equal(rejected, true);
});

test("disconnect aborts demand, retains the view, ignores late pages and resumes on connection", async () => {
	const reads: { signal: AbortSignal; resolve: (value: HistoryPage) => void }[] = [];
	const owner = new ConversationHistoryController(
		scope,
		(_cursor, signal) => new Promise((resolve) => reads.push({ signal, resolve })),
		() => {},
	);
	owner.update(latest);
	owner.setViewport(viewport("older"));
	owner.setConnected(false);
	assert.equal(reads[0]?.signal.aborted, true);
	reads[0]?.resolve({ ...scope, messages: [message(2167)], nextCursor: "2167" });
	await tick();
	owner.setViewport(viewport("older"));
	assert.equal(reads.length, 1);
	assert.deepEqual(owner.state.snapshot?.messages, latest.messages);
	owner.setConnected(true);
	assert.equal(reads.length, 2);
	reads[1]?.resolve({ ...scope, messages: all.slice(2136, 2168), nextCursor: "2136" });
	await settle(owner);
	assert.equal(owner.state.snapshot?.messages[0]?.id, "m2136");
	owner.dispose();
});
