import { randomUUID } from "node:crypto";
import type { Op } from "@earendil-works/chord/delta";
import type { ConversationId, ConversationView, LiveState, TaskId } from "@earendil-works/pi-durable";
import type { HistoryPage, Snapshot } from "./contracts.ts";

type Episode = { taskId: TaskId; attempt: number; id: string };

/**
 * One exact-frame watch owns this disposable presentation projection. Nothing is persisted.
 * Task IDs alone are insufficient: retries and recovered attempts can reuse them.
 */
export class StreamIdentity {
	readonly #conversationId: ConversationId;
	#entryCount = 0;
	#episode: Episode | undefined;
	readonly #committed = new Map<string, string>();
	#disposed = false;

	constructor(conversationId: ConversationId) {
		this.#conversationId = conversationId;
	}

	project(
		view: ConversationView,
		history: HistoryPage,
		ops?: readonly Op[],
	): Pick<Snapshot, "messages" | "partialId"> {
		if (this.#disposed || view.conversation.id !== this.#conversationId) {
			this.#episode = undefined;
			this.#committed.clear();
			return { messages: history.messages };
		}
		// Only the watch's exact append operations establish which entries were
		// committed in this transition. A root replacement means a queue gap.
		let appended = 0;
		let continuous = ops !== undefined;
		for (const op of ops ?? []) {
			if (op[0] === "r") {
				continuous = false;
				continue;
			}
			if (op[1][0] !== "entries") continue;
			if (op[0] !== "p" || op[1].length !== 1 || op[2] !== this.#entryCount + appended || op[3] !== 0) {
				continuous = false;
				continue;
			}
			appended += op[4].length;
		}
		if (view.entries.length !== this.#entryCount + appended) continuous = false;
		if (!continuous) {
			this.#episode = undefined;
			this.#committed.clear();
		}
		const live = view.docs["pi.live"] as LiveState | undefined;
		const generation = live?.generation;
		const taskId = live?.run?.taskId;
		const current =
			taskId !== undefined &&
			Number.isSafeInteger(taskId) &&
			taskId > 0 &&
			generation?.message !== undefined &&
			Number.isSafeInteger(generation.attempt) &&
			generation.attempt > 0
				? { taskId, attempt: generation.attempt }
				: undefined;
		const prior = this.#episode;
		const ended = prior && (!current || prior.taskId !== current.taskId || prior.attempt !== current.attempt);
		if (ended && continuous) {
			// The exact splice positions above authorize this slice, not a latest-row
			// or equal-text guess. Any competing assistant entry makes it ambiguous.
			const candidates = view.entries
				.slice(this.#entryCount)
				.filter((entry) => entry.model?.some((message) => message.role === "assistant"));
			const entry = candidates.length === 1 ? candidates[0] : undefined;
			if (
				entry?.kind === "pi.assistant" &&
				entry.conversationId === this.#conversationId &&
				entry.byTaskId === prior.taskId &&
				entry.head === undefined &&
				entry.model?.length === 1 &&
				entry.model[0]?.role === "assistant"
			)
				this.#committed.set(`${entry.id}_0`, prior.id);
		}
		this.#episode = current ? (prior && !ended ? prior : { ...current, id: randomUUID() }) : undefined;
		this.#entryCount = view.entries.length;
		// At most one contract-sized history page is retained, without source text.
		const visible = new Set(history.messages.map((message) => message.id));
		for (const id of this.#committed.keys()) if (!visible.has(id)) this.#committed.delete(id);
		return {
			messages: history.messages.map((message) => {
				const streamId = this.#committed.get(message.id);
				return streamId && message.role === "assistant" ? { ...message, streamId } : message;
			}),
			...(this.#episode ? { partialId: this.#episode.id } : {}),
		};
	}

	dispose(): void {
		this.#disposed = true;
		this.#episode = undefined;
		this.#committed.clear();
	}
}
