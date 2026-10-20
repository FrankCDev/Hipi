import { createHash, randomUUID } from "node:crypto";
import type { DatabaseSync, SQLOutputValue } from "node:sqlite";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import type { ConversationId } from "@earendil-works/pi-durable";
import { AppError, type Conversation, type Scope, type Workspace } from "../contracts.ts";
import { textEnd } from "../history.ts";
import {
	type ConversationSearchHit,
	type ConversationSearchPage,
	SEARCH_LIMITS,
	type SearchIndexStatus,
	searchQuery,
} from "./contracts.ts";
import {
	checkSearchAbort,
	decodeSearchToken,
	encodeSearchToken,
	type IndexPosition,
	indexSource,
	type SearchReader,
	type SearchSource,
	searchInteger,
} from "./storage.ts";

type Row = Record<string, SQLOutputValue>;
type State = {
	generation: string;
	cycle: string;
	revision: number;
	workspaceAfter: string;
	workspaceId: string | null;
	conversationAfter: string;
	currentId: string | null;
	completedAt: number | null;
	active: boolean;
};
export type SearchPorts = {
	nextWorkspace(after: string): Workspace | undefined;
	prepareWorkspace(workspaceId: string): Promise<boolean>;
	nextConversation(workspaceId: string, after: string): Conversation | undefined;
	read<T>(scope: Scope, operation: (storage: SearchReader, source: SearchSource) => Promise<T>): Promise<T>;
};
function string(value: SQLOutputValue | undefined): string {
	if (typeof value !== "string") throw new AppError("INDEX_RECOVERY_REQUIRED");
	return value;
}
function position(row: Row): IndexPosition {
	return {
		indexedEntry: searchInteger(row.indexed_entry),
		pendingEntry: searchInteger(row.pending_entry),
		pendingSlot: searchInteger(row.pending_slot),
		pendingOffset: searchInteger(row.pending_offset),
		upperEntry: searchInteger(row.upper_entry),
	};
}
/** Rebuildable text projection. Only StoreCatalog supplies the connection and verified source readers. */
export class SearchProjection {
	readonly #database: DatabaseSync;
	readonly #storeId: string;
	readonly #ports: SearchPorts;
	#pending: Promise<unknown> = Promise.resolve();
	#closed = false;
	constructor(database: DatabaseSync, storeId: string, ports: SearchPorts) {
		this.#database = database;
		this.#storeId = storeId;
		this.#ports = ports;
	}
	#state(): State {
		const row = this.#database.prepare("SELECT * FROM search_state WHERE singleton=1").get();
		if (!row) throw new AppError("INDEX_RECOVERY_REQUIRED");
		return {
			generation: string(row.generation),
			cycle: string(row.cycle),
			revision: searchInteger(row.revision),
			workspaceAfter: string(row.workspace_after),
			workspaceId: row.workspace_id === null ? null : string(row.workspace_id),
			conversationAfter: string(row.conversation_after),
			currentId: row.current_id === null ? null : string(row.current_id),
			completedAt: row.completed_at === null ? null : searchInteger(row.completed_at),
			active: row.active === 1,
		};
	}
	#save(state: State) {
		if (this.#state().revision !== state.revision) throw new AppError("CURSOR_STALE");
		if (!Number.isSafeInteger(state.revision + 1)) throw new AppError("CAPACITY_EXCEEDED");
		state.revision++;
		this.#database
			.prepare(
				"UPDATE search_state SET generation=?,cycle=?,revision=?,workspace_after=?,workspace_id=?,conversation_after=?,current_id=?,completed_at=?,active=? WHERE singleton=1",
			)
			.run(
				state.generation,
				state.cycle,
				state.revision,
				state.workspaceAfter,
				state.workspaceId,
				state.conversationAfter,
				state.currentId,
				state.completedAt,
				Number(state.active),
			);
	}
	#status(state = this.#state()): SearchIndexStatus {
		return {
			generation: state.generation,
			state: state.active ? (state.completedAt === null ? "building" : "refreshing") : "ready",
			completedAt: state.completedAt,
			nextCursor: state.active
				? encodeSearchToken({ kind: "refresh", storeId: this.#storeId, revision: state.revision })
				: null,
		};
	}
	refresh(cursor?: string, signal?: AbortSignal): Promise<SearchIndexStatus> {
		const result = this.#pending.then(() => this.#refresh(cursor, signal));
		this.#pending = result.catch(() => undefined);
		return result;
	}
	async #refresh(cursor?: string, signal?: AbortSignal): Promise<SearchIndexStatus> {
		if (this.#closed) throw new AppError("CLOSED");
		checkSearchAbort(signal);
		const state = this.#state();
		if (cursor) {
			const p = decodeSearchToken(cursor);
			if (
				Object.keys(p).sort().join() !== "kind,revision,storeId" ||
				p.kind !== "refresh" ||
				p.storeId !== this.#storeId
			)
				throw new AppError("INVALID_REQUEST");
			if (p.revision !== state.revision) throw new AppError("CURSOR_STALE");
		}
		if (!state.active) {
			state.active = true;
			state.cycle = randomUUID();
			state.generation = randomUUID();
			state.workspaceAfter = "";
			state.workspaceId = null;
			state.conversationAfter = "";
			state.currentId = null;
		}
		if (!state.workspaceId) {
			const workspace = this.#ports.nextWorkspace(state.workspaceAfter);
			if (!workspace) {
				state.active = false;
				state.completedAt = Date.now();
				this.#save(state);
				return this.#status(state);
			}
			const prepared = await this.#ports.prepareWorkspace(workspace.workspaceId);
			checkSearchAbort(signal);
			if (this.#state().revision !== state.revision) throw new AppError("CURSOR_STALE");
			if (!prepared) {
				this.#save(state);
				return this.#status(state);
			}
			state.workspaceId = workspace.workspaceId;
			state.conversationAfter = "";
		}
		if (!state.currentId) {
			const conversation = this.#ports.nextConversation(state.workspaceId, state.conversationAfter);
			if (!conversation) {
				state.workspaceAfter = state.workspaceId;
				state.workspaceId = null;
				this.#save(state);
				return this.#status(state);
			}
			state.currentId = conversation.conversationId;
		}
		const scope = { workspaceId: state.workspaceId, conversationId: state.currentId };
		await this.#ports.read(scope, async (storage, source) => {
			checkSearchAbort(signal);
			let row = this.#database
				.prepare("SELECT * FROM search_sources WHERE workspace_id=? AND public_id=?")
				.get(scope.workspaceId, scope.conversationId);
			const changed = !row || row.generation !== source.generation || row.durable_id !== source.durableId;
			const metadataChanged = !!row && (row.title !== source.title || row.archived !== Number(source.archived));
			const newest = await storage.scanEntries(
				{ conversationId: source.durableId as ConversationId, order: "descending" },
				1,
				undefined,
				context,
			);
			const upper = newest.items[0]?.id ?? 0;
			if (row && !changed && searchInteger(row.indexed_entry) > upper) throw new AppError("CURSOR_STALE");
			const initial = changed
				? { indexedEntry: 0, pendingEntry: 0, pendingSlot: 0, pendingOffset: 0, upperEntry: upper }
				: position(row as Row);
			if (!initial.pendingEntry) initial.upperEntry = upper;
			const batch = source.archived
				? {
						position: { ...initial, pendingEntry: 0, pendingSlot: 0, pendingOffset: 0 },
						chunks: [],
						complete: true,
					}
				: await indexSource(storage, source, initial, signal);
			checkSearchAbort(signal);
			// Another mutation may have synchronously updated metadata while the storage read awaited.
			row = this.#database
				.prepare("SELECT * FROM search_sources WHERE workspace_id=? AND public_id=?")
				.get(scope.workspaceId, scope.conversationId);
			if (
				row &&
				row.generation === source.generation &&
				row.durable_id === source.durableId &&
				searchInteger(row.revision) > source.revision
			)
				throw new AppError("CURSOR_STALE");
			const currentState = this.#state();
			if (currentState.revision !== state.revision) throw new AppError("CURSOR_STALE");
			state.generation = currentState.generation;
			state.revision = currentState.revision;
			this.#database.exec("BEGIN IMMEDIATE");
			try {
				if (changed)
					this.#database
						.prepare("DELETE FROM search_chunks WHERE workspace_id=? AND public_id=?")
						.run(scope.workspaceId, scope.conversationId);
				if (changed || metadataChanged || row?.cycle !== state.cycle) state.generation = randomUUID();
				const p = batch.position;
				this.#database
					.prepare(
						"INSERT INTO search_sources VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(workspace_id,public_id) DO UPDATE SET generation=excluded.generation,cycle=excluded.cycle,durable_id=excluded.durable_id,title=excluded.title,workspace_name=excluded.workspace_name,archived=excluded.archived,revision=excluded.revision,indexed_entry=excluded.indexed_entry,pending_entry=excluded.pending_entry,pending_slot=excluded.pending_slot,pending_offset=excluded.pending_offset,upper_entry=excluded.upper_entry",
					)
					.run(
						scope.workspaceId,
						scope.conversationId,
						source.generation,
						state.cycle,
						source.durableId,
						source.title,
						source.workspaceName,
						Number(source.archived),
						source.revision,
						p.indexedEntry,
						p.pendingEntry,
						p.pendingSlot,
						p.pendingOffset,
						p.upperEntry,
					);
				const insert = this.#database.prepare(
					"INSERT INTO search_chunks(workspace_id,public_id,message_id,offset,text_length,text) VALUES (?,?,?,?,?,?) ON CONFLICT(workspace_id,public_id,message_id,offset) DO UPDATE SET text_length=excluded.text_length,text=excluded.text",
				);
				insert.run(scope.workspaceId, scope.conversationId, "", 0, source.title.length, source.title);
				for (const chunk of batch.chunks)
					insert.run(
						scope.workspaceId,
						scope.conversationId,
						chunk.messageId,
						chunk.offset,
						chunk.textLength,
						chunk.text,
					);
				if (batch.complete) {
					state.conversationAfter = state.currentId ?? "";
					state.currentId = null;
				}
				this.#save(state);
				this.#database.exec("COMMIT");
			} catch (error) {
				this.#database.exec("ROLLBACK");
				throw error;
			}
		});
		return this.#status(state);
	}
	/** Called before returning successful mutations. Never a source of conversation authority. */
	changed(conversation: Conversation): void {
		const row = this.#database
			.prepare("SELECT revision FROM search_sources WHERE workspace_id=? AND public_id=?")
			.get(conversation.workspaceId, conversation.conversationId);
		if (!row || searchInteger(row.revision) >= conversation.revision) return;
		this.#database.exec("BEGIN IMMEDIATE");
		try {
			this.#database
				.prepare("UPDATE search_sources SET title=?,archived=?,revision=? WHERE workspace_id=? AND public_id=?")
				.run(
					conversation.title,
					Number(conversation.archivedAt !== null),
					conversation.revision,
					conversation.workspaceId,
					conversation.conversationId,
				);
			this.#database
				.prepare(
					"UPDATE search_chunks SET text=?,text_length=? WHERE workspace_id=? AND public_id=? AND message_id=''",
				)
				.run(conversation.title, conversation.title.length, conversation.workspaceId, conversation.conversationId);
			const state = this.#state();
			state.generation = randomUUID();
			this.#save(state);
			this.#database.exec("COMMIT");
		} catch (error) {
			this.#database.exec("ROLLBACK");
			throw error;
		}
	}
	/** Hide uncertain metadata immediately; the next refresh verifies it from durable authority. */
	invalidate(scope: Scope): void {
		this.#database.exec("BEGIN IMMEDIATE");
		try {
			this.#database
				.prepare("UPDATE search_sources SET cycle='' WHERE workspace_id=? AND public_id=?")
				.run(scope.workspaceId, scope.conversationId);
			const state = this.#state();
			state.generation = randomUUID();
			state.active = true;
			state.workspaceAfter = "";
			state.workspaceId = null;
			state.conversationAfter = "";
			state.currentId = null;
			this.#save(state);
			this.#database.exec("COMMIT");
		} catch (error) {
			this.#database.exec("ROLLBACK");
			throw error;
		}
	}
	query(rawQuery: string, cursor?: string, signal?: AbortSignal): ConversationSearchPage {
		if (this.#closed) throw new AppError("CLOSED");
		checkSearchAbort(signal);
		const query = searchQuery(rawQuery);
		const queryDigest = createHash("sha256").update(query).digest("hex");
		const state = this.#state();
		let after = 0,
			fence = searchInteger(this.#database.prepare("SELECT coalesce(max(id),0) AS id FROM search_chunks").get()?.id),
			emitted = "";
		if (cursor) {
			const p = decodeSearchToken(cursor);
			if (
				Object.keys(p).sort().join() !== "after,emitted,fence,generation,query,storeId" ||
				p.storeId !== this.#storeId ||
				p.query !== queryDigest ||
				typeof p.emitted !== "string" ||
				p.emitted.length > 600
			)
				throw new AppError("INVALID_REQUEST");
			if (p.generation !== state.generation) throw new AppError("CURSOR_STALE");
			after = searchInteger(p.after);
			fence = searchInteger(p.fence);
			emitted = p.emitted;
			if (after > fence) throw new AppError("INVALID_REQUEST");
		}
		const expression = new RegExp(query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "iu");
		const rows = this.#database
			.prepare(
				"SELECT c.*,s.title,s.workspace_name,s.generation,s.durable_id FROM search_chunks c JOIN search_sources s ON s.workspace_id=c.workspace_id AND s.public_id=c.public_id WHERE c.id>? AND c.id<=? AND s.archived=0 AND s.cycle=? ORDER BY c.id LIMIT ?",
			)
			.all(after, fence, state.cycle, SEARCH_LIMITS.queryChunks + 1);
		const items: ConversationSearchHit[] = [];
		let consumed = 0;
		for (const row of rows.slice(0, SEARCH_LIMITS.queryChunks)) {
			checkSearchAbort(signal);
			after = searchInteger(row.id);
			consumed++;
			const workspaceId = string(row.workspace_id),
				conversationId = string(row.public_id),
				messageId = string(row.message_id);
			const key = JSON.stringify([workspaceId, conversationId, messageId]);
			if (emitted === key) continue;
			const text = string(row.text),
				match = expression.exec(text);
			if (!match) continue;
			const offset = searchInteger(row.offset),
				start = offset + match.index,
				end = start + match[0].length;
			let snippetStart = Math.max(0, match.index - 96);
			if (/[\uDC00-\uDFFF]/.test(text[snippetStart] ?? "") && /[\uD800-\uDBFF]/.test(text[snippetStart - 1] ?? ""))
				snippetStart--;
			const snippet = text.slice(snippetStart, textEnd(text, snippetStart, SEARCH_LIMITS.snippet));
			const common = {
				workspaceId,
				conversationId,
				title: string(row.title),
				workspaceName: string(row.workspace_name),
				snippet,
				snippetOffset: offset + snippetStart,
				matchStart: start,
				matchEnd: end,
			};
			items.push(
				messageId
					? {
							...common,
							kind: "message",
							messageId,
							locator: encodeSearchToken({
								workspaceId,
								conversationId,
								storeId: this.#storeId,
								generation: string(row.generation),
								durableId: searchInteger(row.durable_id),
								messageId,
								start,
								end,
								match: createHash("sha256").update(match[0]).digest("hex"),
								textLength: searchInteger(row.text_length),
							}),
						}
					: { ...common, kind: "title" },
			);
			emitted = key;
			if (items.length === SEARCH_LIMITS.results) break;
		}
		const more = rows.length > consumed;
		return {
			items,
			index: this.#status(state),
			nextCursor: more
				? encodeSearchToken({
						query: queryDigest,
						storeId: this.#storeId,
						generation: state.generation,
						after,
						fence,
						emitted,
					})
				: null,
		};
	}
	async close(): Promise<void> {
		this.#closed = true;
		await this.#pending;
	}
}
