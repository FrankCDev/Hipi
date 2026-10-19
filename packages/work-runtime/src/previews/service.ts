import { randomUUID } from "node:crypto";
import { FileServiceError, type FileTarget } from "../files/contracts.ts";
import { fileIdentifier } from "../files/protocol.ts";
import type { TrustedFileSnapshotSource } from "../files/service.ts";
import { type DocumentPreview, DocumentPreviewError, validateDocumentPreview } from "./contracts.ts";
import type { DocumentParserPool } from "./parser-pool.ts";
import {
	PREVIEW_LIMITS,
	type PreviewClient,
	type PreviewHandle,
	type PreviewKind,
	parsePreviewRequest,
} from "./protocol.ts";

type Entry = {
	target: FileTarget;
	handle: PreviewHandle;
	bytes?: Uint8Array;
	pages: DocumentPreview[];
	cost: number;
	expires: number;
};
type Waiter = { resolve(): void; reject(error: unknown): void; signal: AbortSignal; abort(): void };
function reject(code: "BLOCKED_RESOURCE" | "LIMIT_EXCEEDED" | "CLOSED" | "BUSY" | "NOT_FOUND" | "INVALID_PATH"): never {
	throw new FileServiceError(code);
}
function check(signal?: AbortSignal) {
	if (signal?.aborted) reject("CLOSED");
}
/** Structural signature gate only. PDF rendering remains an independently restricted consumer. */
function binaryKind(kind: PreviewKind, bytes: Uint8Array): void {
	const b = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
	if (kind === "pdf") {
		if (
			!/^%PDF-(?:1\.[0-7]|2\.0)[\r\n]/.test(b.subarray(0, 16).toString("latin1")) ||
			!/%%EOF[\t\r\n ]*$/.test(b.subarray(-1024).toString("latin1"))
		)
			reject("BLOCKED_RESOURCE");
		return;
	}
	let width = 0,
		height = 0;
	if (kind === "png") {
		if (b.length < 45 || !b.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])))
			reject("BLOCKED_RESOURCE");
		let p = 8,
			header = false,
			data = false,
			end = false;
		while (p + 12 <= b.length) {
			const n = b.readUInt32BE(p);
			if (n > b.length - p - 12) reject("BLOCKED_RESOURCE");
			const type = b.toString("ascii", p + 4, p + 8);
			if (!/^[A-Za-z]{4}$/.test(type)) reject("BLOCKED_RESOURCE");
			let crc = 0xffffffff;
			for (let i = p + 4; i < p + 8 + n; i++) {
				crc ^= b[i];
				for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
			}
			if ((crc ^ 0xffffffff) >>> 0 !== b.readUInt32BE(p + 8 + n)) reject("BLOCKED_RESOURCE");
			if (!header && (type !== "IHDR" || n !== 13)) reject("BLOCKED_RESOURCE");
			if (type === "IHDR") {
				if (header || n !== 13) reject("BLOCKED_RESOURCE");
				header = true;
				width = b.readUInt32BE(p + 8);
				height = b.readUInt32BE(p + 12);
				const depth = b[p + 16],
					color = b[p + 17];
				if (
					b[p + 18] !== 0 ||
					b[p + 19] !== 0 ||
					b[p + 20] > 1 ||
					!(
						(color === 0 && [1, 2, 4, 8, 16].includes(depth)) ||
						(color === 3 && [1, 2, 4, 8].includes(depth)) ||
						([2, 4, 6].includes(color) && [8, 16].includes(depth))
					)
				)
					reject("BLOCKED_RESOURCE");
			}
			if (type === "IDAT") data = true;
			if (type === "acTL" || type === "fcTL" || type === "fdAT") reject("BLOCKED_RESOURCE");
			p += n + 12;
			if (type === "IEND") {
				if (n !== 0 || p !== b.length) reject("BLOCKED_RESOURCE");
				end = true;
				break;
			}
		}
		if (!header || !data || !end) reject("BLOCKED_RESOURCE");
	} else {
		if (b.length < 12 || b[0] !== 255 || b[1] !== 216 || b[b.length - 2] !== 255 || b[b.length - 1] !== 217)
			reject("BLOCKED_RESOURCE");
		let p = 2,
			scan = false;
		while (p < b.length - 2) {
			if (scan) {
				while (p < b.length - 2 && b[p] !== 255) p++;
				if (p === b.length - 2) break;
			}
			if (b[p++] !== 255) reject("BLOCKED_RESOURCE");
			while (b[p] === 255) p++;
			const marker = b[p++];
			if (scan && (marker === 0 || (marker >= 0xd0 && marker <= 0xd7))) continue;
			if (marker === 0xdc || marker === 0xd8 || marker === 0xd9) reject("BLOCKED_RESOURCE");
			if (marker === undefined || p + 2 > b.length) reject("BLOCKED_RESOURCE");
			const n = b.readUInt16BE(p);
			if (n < 2 || p + n > b.length) reject("BLOCKED_RESOURCE");
			if (marker === 0xc0 || marker === 0xc1 || marker === 0xc2) {
				if (n < 8 || width) reject("BLOCKED_RESOURCE");
				height = b.readUInt16BE(p + 3);
				width = b.readUInt16BE(p + 5);
			}
			if (marker === 0xda) {
				scan = true;
			}
			p += n;
		}
		if (!scan) reject("BLOCKED_RESOURCE");
	}
	if (!width || !height || width * height > 16_000_000) reject("LIMIT_EXCEEDED");
}
function documentPages(document: DocumentPreview): DocumentPreview[] {
	if (document.kind === "document") {
		const pages: DocumentPreview[] = [];
		let start = 0;
		do {
			let end = Math.min(document.text.length, start + 16000);
			const previous = document.text.charCodeAt(end - 1),
				next = document.text.charCodeAt(end);
			if (previous >= 0xd800 && previous <= 0xdbff && next >= 0xdc00 && next <= 0xdfff) end--;
			pages.push({ ...document, text: document.text.slice(start, end) });
			start = end;
		} while (start < document.text.length);
		return pages;
	}
	const pages: DocumentPreview[] = [];
	for (const sheet of document.sheets) {
		let rows: typeof sheet.rows = [];
		const page = () => ({ ...document, sheets: [{ name: sheet.name, rows }] });
		for (const row of sheet.rows) {
			const candidate = { ...document, sheets: [{ name: sheet.name, rows: [...rows, row] }] };
			if (
				rows.length &&
				(rows.length >= 25 || Buffer.byteLength(JSON.stringify(candidate)) > PREVIEW_LIMITS.pageBytes)
			) {
				pages.push(page());
				rows = [];
			}
			rows.push(row);
			if (Buffer.byteLength(JSON.stringify(page())) > PREVIEW_LIMITS.pageBytes) reject("LIMIT_EXCEEDED");
		}
		pages.push(page());
	}
	return pages;
}
/** One runtime-wide cache, bound to one host principal and store. No implicit grants. */
export function createPreviewService(options: {
	source: TrustedFileSnapshotSource;
	parser: Pick<DocumentParserPool, "parse" | "close">;
	storeId: string;
	principalId: string;
	now?: () => number;
}) {
	fileIdentifier(options.storeId);
	fileIdentifier(options.principalId);
	const now = options.now ?? Date.now,
		entries = new Map<string, Entry>(),
		pending = new Set<AbortController>(),
		waiters: Waiter[] = [];
	const drained = Promise.withResolvers<void>();
	let closing: Promise<void> | undefined;
	let closed = false,
		active = 0,
		reserved = 0,
		cost = 0;
	const remove = (id: string) => {
		const e = entries.get(id);
		if (e) {
			cost -= e.cost;
			entries.delete(id);
		}
	};
	const sweep = () => {
		for (const [id, e] of entries) if (e.expires <= now()) remove(id);
	};
	const timer = setInterval(sweep, 1000);
	timer.unref();
	async function acquire(signal: AbortSignal) {
		check(signal);
		if (closed) reject("CLOSED");
		if (active < PREVIEW_LIMITS.concurrent) {
			active++;
			return;
		}
		if (waiters.length >= PREVIEW_LIMITS.queue) reject("BUSY");
		await new Promise<void>((resolve, reject) => {
			const waiter: Waiter = {
				resolve,
				reject,
				signal,
				abort() {
					const index = waiters.indexOf(waiter);
					if (index >= 0) waiters.splice(index, 1);
					reject(new FileServiceError("CLOSED"));
				},
			};
			waiters.push(waiter);
			signal.addEventListener("abort", waiter.abort, { once: true });
		});
	}
	function release() {
		const next = waiters.shift();
		if (next) {
			next.signal.removeEventListener("abort", next.abort);
			next.resolve();
		} else active--;
	}
	async function authorized(id: string, signal?: AbortSignal): Promise<Entry> {
		check(signal);
		if (closed) reject("CLOSED");
		sweep();
		fileIdentifier(id);
		const entry = entries.get(id);
		if (!entry) reject("NOT_FOUND");
		try {
			await options.source.assertAuthorized(entry.target);
		} catch (error) {
			remove(id);
			throw error;
		}
		check(signal);
		if (closed || entries.get(id) !== entry) reject("CLOSED");
		return entry;
	}
	const client: PreviewClient = {
		async open(target, signal) {
			const validated = parsePreviewRequest({
				version: 1,
				expectedStoreId: options.storeId,
				method: "open",
				params: target,
			});
			if (validated.method !== "open") reject("INVALID_PATH");
			target = validated.params;
			const suffix = target.path.split(".").at(-1)?.toLowerCase();
			const kind = suffix === "jpg" ? "jpeg" : suffix;
			if (
				kind !== "docx" &&
				kind !== "xlsx" &&
				kind !== "csv" &&
				kind !== "pdf" &&
				kind !== "png" &&
				kind !== "jpeg"
			)
				reject("BLOCKED_RESOURCE");
			const limit =
				kind === "pdf" ? 20 * 1024 * 1024 : kind === "png" || kind === "jpeg" ? 10 * 1024 * 1024 : 8 * 1024 * 1024;
			const controller = new AbortController(),
				abort = () => controller.abort();
			if (signal?.aborted) abort();
			signal?.addEventListener("abort", abort, { once: true });
			pending.add(controller);
			let admitted = false,
				reservation = false;
			try {
				await acquire(controller.signal);
				admitted = true;
				check(controller.signal);
				if (closed) reject("CLOSED");
				sweep();
				if (entries.size + active > PREVIEW_LIMITS.handles || cost + reserved + limit > PREVIEW_LIMITS.cacheBytes)
					reject("BUSY");
				reserved += limit;
				reservation = true;
				const snapshot = await options.source.read(target, limit);
				check(controller.signal);
				let pages: DocumentPreview[] = [],
					bytes: Uint8Array | undefined;
				if (kind === "docx" || kind === "xlsx" || kind === "csv")
					pages = documentPages(
						validateDocumentPreview(await options.parser.parse(kind, snapshot.bytes, controller.signal)),
					);
				else {
					binaryKind(kind, snapshot.bytes);
					bytes = snapshot.bytes;
				}
				const size = bytes?.byteLength ?? Buffer.byteLength(JSON.stringify(pages));
				if (cost + reserved - limit + size > PREVIEW_LIMITS.cacheBytes) reject("BUSY");
				await options.source.assertAuthorized(target);
				check(controller.signal);
				if (closed) reject("CLOSED");
				const handle: PreviewHandle = {
					id: randomUUID(),
					revision: snapshot.revision,
					kind,
					summary: {
						bytes: snapshot.bytes.byteLength,
						pages: pages.length,
						truncated: pages.some((page) => page.truncated),
					},
				};
				const entry: Entry = { target, handle, pages, bytes, cost: size, expires: now() + PREVIEW_LIMITS.ttlMs };
				entries.set(handle.id, entry);
				cost += size;
				return structuredClone(handle);
			} catch (error) {
				if (error instanceof DocumentPreviewError)
					throw new FileServiceError(
						error.code === "ABORTED" || error.code === "PARSER_CLOSED"
							? "CLOSED"
							: error.code === "PARSER_BUSY"
								? "BUSY"
								: error.code === "DOCUMENT_LIMIT"
									? "LIMIT_EXCEEDED"
									: "BLOCKED_RESOURCE",
					);
				throw error;
			} finally {
				if (reservation) reserved -= limit;
				if (admitted) release();
				pending.delete(controller);
				if (closed && pending.size === 0) drained.resolve();
				signal?.removeEventListener("abort", abort);
			}
		},
		async readPage(id, page, signal) {
			if (!Number.isSafeInteger(page) || page < 0) reject("INVALID_PATH");
			const entry = await authorized(id, signal);
			const content = entry.pages[page];
			if (!content) reject("NOT_FOUND");
			return { id, revision: entry.handle.revision, page, content: structuredClone(content) };
		},
		async readBytes(id, offset, signal) {
			if (!Number.isSafeInteger(offset) || offset < 0 || offset % PREVIEW_LIMITS.chunkBytes) reject("INVALID_PATH");
			const entry = await authorized(id, signal),
				bytes = entry.bytes;
			if (!bytes || offset > bytes.length) reject("NOT_FOUND");
			return {
				id,
				revision: entry.handle.revision,
				offset,
				total: bytes.length,
				base64: Buffer.from(bytes.subarray(offset, offset + PREVIEW_LIMITS.chunkBytes)).toString("base64"),
			};
		},
		async close(id, signal) {
			check(signal);
			fileIdentifier(id);
			remove(id);
		},
	};
	return {
		client,
		close() {
			closing ??= (async () => {
				closed = true;
				clearInterval(timer);
				for (const controller of pending) controller.abort();
				entries.clear();
				cost = 0;
				if (pending.size === 0) drained.resolve();
				await options.parser.close();
				await drained.promise;
			})();
			return closing;
		},
	};
}
