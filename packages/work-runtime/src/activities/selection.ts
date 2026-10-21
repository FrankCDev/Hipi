import type { EntryRecord } from "@earendil-works/pi-durable";
import { AppError } from "../contracts.ts";
import { ACTIVITY_LIMITS, type ActivityReadScope } from "./contracts.ts";
import { object, projectTask, type StoredTask } from "./projection.ts";

type Reads = {
	task(id: number): Promise<StoredTask | undefined>;
	entry(id: number): Promise<EntryRecord | undefined>;
};
const positive = (value: unknown): value is number =>
	typeof value === "number" && Number.isSafeInteger(value) && value > 0;

/** A request-local proof, not a new execution index. Never traverses another conversation's task inputs. */
export function taskSelection(read: Reads, scope: ActivityReadScope) {
	const tasks = new Map<number, StoredTask | undefined>();
	const task = async (id: number) => {
		if (!tasks.has(id)) {
			if (tasks.size >= ACTIVITY_LIMITS.taskHydrations) throw new AppError("CAPACITY_EXCEEDED");
			// Storage has no scoped task point-read. Check scope before following any input or reading evidence.
			const value = await read.task(id);
			tasks.set(
				id,
				value?.id === id && value.conversationId === scope.durableId && value.kind === "pi.tool"
					? value
					: undefined,
			);
		}
		return tasks.get(id);
	};
	return {
		task,
		async visible(value: StoredTask): Promise<boolean> {
			const seen = new Set<number>();
			let current: StoredTask | undefined = value;
			for (let edges = 0; current && edges <= ACTIVITY_LIMITS.parentEdges; edges++) {
				if (current.conversationId !== scope.durableId || current.kind !== "pi.tool" || seen.has(current.id))
					return false;
				seen.add(current.id);
				const input = object(current.input);
				if (input?.kind === "model" && positive(input.assistant)) {
					const assistant = await read.entry(input.assistant);
					if (
						assistant?.id !== input.assistant ||
						assistant.conversationId !== scope.durableId ||
						assistant.kind !== "pi.assistant"
					)
						return false;
					const projected = projectTask(current, assistant, undefined);
					const call = projected.anchor ? assistant.model?.[projected.anchor.modelIndex] : undefined;
					const content =
						call?.role === "assistant" && projected.anchor
							? call.content[projected.anchor.contentIndex]
							: undefined;
					return Boolean(
						projected.anchor &&
							content?.type === "toolCall" &&
							content.name.length > 0 &&
							content.name.length <= 256 &&
							projected.callId === input.callId &&
							typeof input.callId === "string" &&
							input.callId.length > 0 &&
							input.callId.length <= 256,
					);
				}
				if (input?.kind !== "nested" || !positive(input.parent) || edges === ACTIVITY_LIMITS.parentEdges)
					return false;
				const call = object(input.call);
				if (
					typeof call?.id !== "string" ||
					!call.id.length ||
					call.id.length > 256 ||
					typeof call.name !== "string" ||
					!call.name.length ||
					call.name.length > 256
				)
					return false;
				current = await task(input.parent);
			}
			return false;
		},
	};
}
