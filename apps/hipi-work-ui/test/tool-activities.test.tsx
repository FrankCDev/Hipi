import assert from "node:assert/strict";
import type { AppClient, ToolActivity, ToolActivityPage } from "@hipi/work-runtime/contracts";
import { renderToStaticMarkup } from "react-dom/server";
import { test, vi } from "vitest";
import { ActivitySession } from "../src/features/tool-activities/activity-session.ts";
import { activityLabels, toolLabel } from "../src/features/tool-activities/labels.ts";
import { ActivityCard } from "../src/features/tool-activities/tool-activities.tsx";

const activity: ToolActivity = {
	activityId: "task:1",
	taskId: "1",
	callId: "call",
	toolName: "new_pack_custom_tool",
	source: "task",
	inherited: false,
	phase: "terminal",
	outcome: "failed",
	toolResult: "error",
	abortRequested: true,
	receiptIds: [],
	effect: { operationId: "op-1", status: "unknown" },
	textAvailable: true,
	outputTruncated: true,
};
function page(item = activity): ToolActivityPage {
	return { items: [item], nextCursor: "next", coverage: "tasks", membershipFence: "fence" };
}
function fixture() {
	const requests: {
		method: string;
		params: unknown;
		signal?: AbortSignal;
		resolve: (value: unknown) => void;
		reject: () => void;
	}[] = [];
	// This fake implements the two read methods used by the session; all calls are recorded below.
	const client = {
		call: (method: string, params: unknown, signal?: AbortSignal) =>
			new Promise<unknown>((resolve, reject) =>
				requests.push({
					method,
					params,
					signal,
					resolve,
					reject: () => reject(new Error("private diagnostic must not be displayed")),
				}),
			),
	} as AppClient;
	const session = new ActivitySession(client, { workspaceId: "w", conversationId: "c" });
	session.activate();
	return { session, requests };
}
test("one in-flight request, bounded page replacement, stable identity updates", async () => {
	const { session, requests } = fixture();
	const initial = session.page();
	await session.page();
	assert.equal(requests.length, 1);
	requests[0]?.resolve(page());
	await initial;
	const refresh = session.page();
	requests[1]?.resolve(
		page({ ...activity, toolResult: "success", effect: { operationId: "op-1", status: "observed_match" } }),
	);
	await refresh;
	assert.equal(session.snapshot().page?.items.length, 1);
	assert.equal(session.snapshot().page?.items[0]?.activityId, "task:1");
	assert.equal(session.snapshot().page?.items[0]?.effect?.status, "observed_match");
	const next = session.page("next");
	requests[2]?.resolve({ items: [], nextCursor: "scan-more", coverage: "entries", membershipFence: "fence" });
	await next;
	assert.equal(session.snapshot().page?.items.length, 0);
	assert.equal(session.snapshot().page?.nextCursor, "scan-more");
	session.dispose();
});
test("cancel and dispose reject late results from old scope even if transport ignores abort", async () => {
	const old = fixture();
	const current = fixture();
	const pending = old.session.page();
	old.session.dispose();
	const fresh = current.session.page();
	current.requests[0]?.resolve(page());
	await fresh;
	old.requests[0]?.resolve(page({ ...activity, activityId: "task:foreign" }));
	await pending;
	assert.equal(old.requests[0]?.signal?.aborted, true);
	assert.equal(old.session.snapshot().page, undefined);
	assert.equal(current.session.snapshot().page?.items[0]?.activityId, "task:1");
	current.session.dispose();
});
test("raw output reads replace chunks and collapse releases all text and rejects late chunks", async () => {
	const { session, requests } = fixture();
	const initial = session.page();
	requests[0]?.resolve(page());
	await initial;
	const first = session.text("task:1");
	requests[1]?.resolve({ activityId: "task:1", text: "first", nextCursor: "chunk2", retainedOutputOnly: true });
	await first;
	const second = session.text("task:1", "chunk2");
	requests[2]?.resolve({ activityId: "task:1", text: "second", nextCursor: "chunk3", retainedOutputOnly: true });
	await second;
	assert.equal(session.snapshot().text?.text, "second");
	const late = session.text("task:1", "chunk3");
	session.collapse();
	requests[3]?.resolve({ activityId: "task:1", text: "late", nextCursor: null, retainedOutputOnly: true });
	await late;
	assert.equal(session.snapshot().text, undefined);
	assert.equal(session.snapshot().expanded, undefined);
	await session.text("task:foreign");
	assert.equal(requests.length, 4);
	session.dispose();
});
test("explicit retry preserves the failed cursor and never leaks exceptions", async () => {
	const { session, requests } = fixture();
	const pending = session.page("opaque");
	requests[0]?.reject();
	await pending;
	assert.equal(session.snapshot().failed, true);
	assert.equal(requests.length, 1);
	assert.doesNotMatch(JSON.stringify(session.snapshot()), /private diagnostic/);
	const retry = session.retry();
	assert.deepEqual(requests[1]?.params, { workspaceId: "w", conversationId: "c", cursor: "opaque" });
	requests[1]?.resolve(page());
	await retry;
	assert.equal(session.snapshot().failed, false);
	session.dispose();
});
test("deadline releases a read even when the transport ignores abort", async () => {
	vi.useFakeTimers();
	try {
		const { session, requests } = fixture();
		const pending = session.page();
		await vi.advanceTimersByTimeAsync(15000);
		await pending;
		assert.equal(session.snapshot().busy, false);
		assert.equal(session.snapshot().failed, true);
		assert.equal(requests[0]?.signal?.aborted, true);
		session.dispose();
	} finally {
		vi.useRealTimers();
	}
});
test("retained output rejects mismatched activity or unapproved full output", async () => {
	for (const result of [
		{ activityId: "task:other", retainedOutputOnly: true },
		{ activityId: "task:1", retainedOutputOnly: false },
	]) {
		const { session, requests } = fixture();
		const initial = session.page();
		requests[0]?.resolve(page());
		await initial;
		const read = session.text("task:1");
		requests[1]?.resolve({ ...result, text: "unapproved", nextCursor: null });
		await read;
		assert.equal(session.snapshot().failed, true);
		assert.equal(session.snapshot().text, undefined);
		session.dispose();
	}
});
test("status dimensions, generic tools, escaped retained text, provenance and accessible disclosure", () => {
	const { session } = fixture();
	const state = {
		busy: false,
		failed: false,
		expanded: "task:1",
		text: {
			activityId: "task:1",
			text: "<script>evil()</script><img src='https://bad'>",
			nextCursor: null,
			retainedOutputOnly: true as const,
		},
	};
	const html = renderToStaticMarkup(
		<ActivityCard activity={activity} locale="en" state={state} session={session} disabled={false} />,
	);
	assert.match(html, /Execution failed/);
	assert.match(html, /Tool result: error/);
	assert.match(html, /File effect: unknown/);
	assert.match(html, /does not confirm rollback/);
	assert.match(html, /new_pack_custom_tool/);
	assert.match(html, /aria-expanded="true"/);
	assert.match(html, /aria-controls=/);
	assert.match(html, /&lt;script&gt;/);
	assert.doesNotMatch(html, /<script>|<img/);
	const observed = renderToStaticMarkup(
		<ActivityCard
			activity={{ ...activity, effect: { operationId: "op-1", status: "observed_match" } }}
			locale="en"
			state={{ busy: false, failed: false }}
			session={session}
			disabled={false}
		/>,
	);
	assert.match(observed, /original write is not confirmed/);
	assert.doesNotMatch(observed, /File effect: confirmed/);
	assert.equal(toolLabel("hipi_files_read", "zh"), "读取文件");
	assert.equal(toolLabel("unknown_extension", "en"), "unknown_extension");
	session.dispose();
});
test("artifact action is absent without controlled host callback and never becomes a tool URL", () => {
	const { session } = fixture();
	const item = {
		...activity,
		artifact: { rootId: "root", path: "output.txt", operationId: "op-1", status: "unknown" as const },
	};
	const props = { activity: item, locale: "en", state: { busy: false, failed: false }, session, disabled: false };
	assert.doesNotMatch(renderToStaticMarkup(<ActivityCard {...props} />), /Inspect referenced file/);
	const html = renderToStaticMarkup(<ActivityCard {...props} onOpenArtifact={() => {}} />);
	assert.match(html, /Inspect referenced file/);
	assert.match(html, /current authorized file/);
	assert.doesNotMatch(html, /href=/);
	session.dispose();
});
test("translations use matching hierarchical keys", () => {
	assert.deepEqual(Object.keys(activityLabels("en")), Object.keys(activityLabels("zh")));
	for (const key of Object.keys(activityLabels("en"))) assert.match(key, /^activity\.[A-Za-z._]+$/);
});

test("closing after a page error does not silently retry; Strict Mode reactivation rejects prior reads", async () => {
	const { session, requests } = fixture();
	const failed = session.page("failed-cursor");
	requests[0]?.reject();
	await failed;
	session.collapse();
	assert.equal(session.snapshot().failed, true);
	const retry = session.retry();
	requests[1]?.resolve(page());
	await retry;
	const old = session.page();
	session.dispose();
	session.activate();
	const fresh = session.page();
	requests[3]?.resolve(page({ ...activity, phase: "running" }));
	await fresh;
	requests[2]?.resolve(page({ ...activity, phase: "pending" }));
	await old;
	assert.equal(session.snapshot().page?.items[0]?.phase, "running");
	session.dispose();
});
