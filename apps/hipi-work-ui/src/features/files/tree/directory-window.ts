import { FILE_LIMITS, type FilePage, FileServiceError, type FileTarget } from "@hipi/work-runtime/files";
import type { FileClient } from "@hipi/work-runtime/files/protocol";

export const DIRECTORY_WINDOW_PAGES = 3;
const MAX_PAGES = Math.ceil(FILE_LIMITS.directoryEntries / FILE_LIMITS.page);
export type DirectoryEdge = "before" | "after";
type Page = { index: number; data: FilePage };
export type DirectoryBookmark = { cursors: (string | undefined)[]; index: number };
export type DirectoryWindowSnapshot = {
	pages: readonly Page[];
	pending: boolean;
	failed: boolean;
	before: boolean;
	after: boolean;
};

/** Read-only metadata window. Cursors are opaque and retained only to revisit evicted pages. */
export class DirectoryWindow {
	private state: DirectoryWindowSnapshot = { pages: [], pending: false, failed: false, before: false, after: false };
	private cursors: (string | undefined)[] = [undefined];
	private request?: AbortController;
	private closed = false;
	private failedEdge: DirectoryEdge = "after";
	private failedValidation = false;
	private files: FileClient;
	private target: FileTarget;
	private changed: () => void;
	private initialIndex = 0;
	constructor(files: FileClient, target: FileTarget, changed: () => void, bookmark?: DirectoryBookmark) {
		this.files = files;
		this.target = target;
		this.changed = changed;
		if (bookmark && bookmark.index >= 0 && bookmark.index < MAX_PAGES && bookmark.cursors.length <= MAX_PAGES + 1) {
			this.cursors = [...bookmark.cursors];
			this.initialIndex = bookmark.index;
		}
	}
	bookmark(): DirectoryBookmark {
		return { cursors: [...this.cursors], index: this.state.pages[0]?.index ?? this.initialIndex };
	}
	snapshot = () => this.state;
	private publish(patch: Partial<DirectoryWindowSnapshot>) {
		this.state = { ...this.state, ...patch };
		this.changed();
	}
	async load(edge: DirectoryEdge, protectedPaths: ReadonlySet<string> = new Set(), retry = false, validate = false) {
		if (this.closed || this.request || (this.state.failed && !retry)) return;
		if (retry) {
			edge = this.failedEdge;
			validate = this.failedValidation;
		}
		const pages = this.state.pages;
		const index =
			pages.length === 0
				? this.initialIndex
				: validate
					? (pages[0]?.index ?? 0)
					: edge === "before"
						? (pages[0]?.index ?? 0) - 1
						: (pages.at(-1)?.index ?? 0) + 1;
		if (index < 0 || index >= MAX_PAGES || (index > 0 && this.cursors[index] === undefined)) return;
		const evicted =
			!validate && pages.length >= DIRECTORY_WINDOW_PAGES ? (edge === "after" ? pages[0] : pages.at(-1)) : undefined;
		if (evicted?.data.entries.some((entry) => protectedPaths.has(entry.path))) return;
		const request = new AbortController();
		this.request = request;
		const timer = setTimeout(() => request.abort(), 15000);
		this.publish({ pending: true, failed: false });
		try {
			const data = await this.files.list(this.target, this.cursors[index], request.signal);
			if (this.closed || this.request !== request) return;
			request.signal.throwIfAborted();
			if (data.nextCursor && (index + 1 >= MAX_PAGES || this.cursors.slice(0, index + 1).includes(data.nextCursor)))
				throw new FileServiceError("IO_ERROR");
			const changed =
				(validate && JSON.stringify(data) !== JSON.stringify(pages[0]?.data)) ||
				(index === 0 && pages.length > 0 && this.cursors[1] !== undefined && this.cursors[1] !== data.nextCursor);
			this.cursors[index + 1] = data.nextCursor ?? undefined;
			if (!data.nextCursor || changed) this.cursors.length = index + 2;
			const next = changed
				? [{ index, data }]
				: validate
					? [...pages]
					: edge === "before"
						? [{ index, data }, ...pages]
						: [...pages, { index, data }];
			if (next.length > DIRECTORY_WINDOW_PAGES) edge === "after" ? next.shift() : next.pop();
			this.publish({ pages: next, before: (next[0]?.index ?? 0) > 0, after: !!next.at(-1)?.data.nextCursor });
		} catch (error) {
			if (this.closed || this.request !== request) return;
			this.failedEdge = edge;
			this.failedValidation = validate;
			if (error instanceof FileServiceError && error.code === "VERSION_CONFLICT") {
				// A new first page is a new coherent directory, never appended to old siblings.
				try {
					const data = await this.files.list(this.target, undefined, request.signal);
					if (this.closed || this.request !== request) return;
					request.signal.throwIfAborted();
					this.cursors = [undefined, data.nextCursor ?? undefined];
					this.initialIndex = 0;
					this.publish({ pages: [{ index: 0, data }], before: false, after: !!data.nextCursor });
				} catch {
					if (!this.closed && this.request === request) {
						this.cursors = [undefined];
						this.initialIndex = 0;
						this.publish({ failed: true, pages: [], before: false, after: false });
					}
				}
			} else {
				const denied =
					error instanceof FileServiceError && ["UNAUTHORIZED", "BLOCKED_RESOURCE", "NOT_FOUND"].includes(error.code);
				if (denied) {
					this.cursors = [undefined];
					this.initialIndex = 0;
				}
				this.publish({ failed: true, ...(denied ? { pages: [], before: false, after: false } : {}) });
			}
		} finally {
			clearTimeout(timer);
			if (!this.closed && this.request === request) {
				this.request = undefined;
				this.publish({ pending: false });
			}
		}
	}
	validate() {
		return this.load("after", new Set(), false, true);
	}
	dispose() {
		this.closed = true;
		this.request?.abort();
		this.request = undefined;
	}
}
