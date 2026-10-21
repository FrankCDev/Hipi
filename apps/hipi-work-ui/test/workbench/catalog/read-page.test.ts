import assert from "node:assert/strict";
import { AppError } from "@hipi/work-runtime/contracts";
import { test, vi } from "vitest";
import {
	type CatalogPage,
	type CatalogReadOwner,
	readCatalogPage,
} from "../../../src/features/workbench/catalog/read-page.ts";

type P = CatalogPage<number>;
test("sparse ranges do not consume visible page slots and preserve opposite boundary", async () => {
	const reads: (string | undefined)[] = [];
	const page = await readCatalogPage(
		async (cursor) => {
			reads.push(cursor);
			const index = Number(cursor ?? 0);
			return {
				items: index === 19 ? [19] : [],
				previousCursor: index ? String(index - 1) : null,
				nextCursor: String(index + 1),
			};
		},
		undefined,
		"forward",
		new AbortController().signal,
		{},
	);
	assert.equal(reads.length, 20);
	assert.deepEqual(page, { items: [19], previousCursor: null, nextCursor: "20" });
});
test("reverse sparse ranges retain the original forward boundary", async () => {
	const page = await readCatalogPage(
		async (cursor) => {
			const index = Number(cursor);
			return {
				items: index === 1 ? [1] : [],
				previousCursor: index ? String(index - 1) : null,
				nextCursor: String(index + 1),
			};
		},
		"9",
		"backward",
		new AbortController().signal,
		{},
	);
	assert.deepEqual(page, { items: [1], previousCursor: "0", nextCursor: "10" });
});
test("failed sparse demand resumes last verified cursor, without rescanning", async () => {
	const owner: CatalogReadOwner<P> = {};
	const reads: (string | undefined)[] = [];
	let fail = true;
	const read = async (cursor: string | undefined): Promise<P> => {
		reads.push(cursor);
		if (cursor === "2" && fail) throw new Error("offline");
		return { items: cursor === "2" ? [2] : [], previousCursor: null, nextCursor: String(Number(cursor ?? 0) + 1) };
	};
	await assert.rejects(readCatalogPage(read, undefined, "forward", new AbortController().signal, owner));
	fail = false;
	assert.deepEqual((await readCatalogPage(read, undefined, "forward", new AbortController().signal, owner)).items, [2]);
	assert.deepEqual(reads, [undefined, "1", "2", "2"]);
});
test("repeated cursor rejects rather than publishing an incomplete terminal page", async () => {
	await assert.rejects(
		readCatalogPage(
			async () => ({ items: [], previousCursor: null, nextCursor: "same" }),
			"same",
			"forward",
			new AbortController().signal,
			{},
		),
		(error) => error instanceof AppError && error.code === "INVALID_REQUEST",
	);
});
test("scope abort checks after a transport that ignores abort and never publishes late rows", async () => {
	const abort = new AbortController();
	await assert.rejects(
		readCatalogPage(
			async () => {
				abort.abort();
				return { items: [1], previousCursor: null, nextCursor: null };
			},
			undefined,
			"forward",
			abort.signal,
			{},
		),
		{ name: "AbortError" },
	);
});
test("deadline failure retains verified checkpoint", async () => {
	const deadline = new AbortController();
	const spy = vi.spyOn(AbortSignal, "timeout").mockReturnValue(deadline.signal);
	const owner: CatalogReadOwner<P> = {};
	try {
		await assert.rejects(
			readCatalogPage(
				async (cursor) => {
					if (cursor === "1") deadline.abort(new DOMException("Timed out", "TimeoutError"));
					return { items: [], previousCursor: null, nextCursor: "1" };
				},
				undefined,
				"forward",
				new AbortController().signal,
				owner,
			),
			{ name: "TimeoutError" },
		);
		assert.equal(owner.progress?.cursor, "1");
	} finally {
		spy.mockRestore();
	}
});

test("sparse pages changing publication fail before any mixed window is published", async () => {
	await assert.rejects(
		readCatalogPage(
			async (cursor) => ({
				items: cursor ? [1] : [],
				previousCursor: null,
				nextCursor: cursor ? null : "next",
				orderRevision: cursor ? 2 : 1,
			}),
			undefined,
			"forward",
			new AbortController().signal,
			{},
		),
		(error) => error instanceof AppError && error.code === "CURSOR_STALE",
	);
});
