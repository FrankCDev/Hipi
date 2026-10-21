import { parseRunAdmission, type RunAdmission } from "../runs/contracts.ts";

/** Bounded, presentation-only metadata. Never command authority or a second execution state machine. */
export const EXECUTION_LIMITS = { tools: 16, submissions: 64, label: 256 } as const;

export type ExecutionTool = {
	taskId?: string;
	callId: string;
	name: string;
	/** done means the slot settled, not that the tool succeeded or its effects were rolled back. */
	status: "pending" | "running" | "done";
	parentTaskId?: string;
	/** Exact committed model-issued call placement. Nested calls have no own model block. */
	anchor?: { assistantEntryId: string; modelIndex: number; contentIndex: number };
};

export type ConversationExecution = {
	/** Same committed live run; presence does not mean execution is currently active. */
	run?: RunAdmission;
	/** Current generation owner. Changes on handover; not a permanent run or message ID. */
	ownerTaskId: string;
	/** Exact receipt.submissionId correlation; omitted IDs must never be inferred. */
	submissionIds: string[];
	submissionCount: number;
	generation?: { attempt: number; retryAt?: number; deferredPollAt?: number };
	/** Current model-issued and nested slots only, not historical tool activity. */
	tools: { items: ExecutionTool[]; total: number; active: number };
	blockingCompactionCount: number;
};

function object(value: unknown, keys: string[]): Record<string, unknown> {
	if (
		!value ||
		typeof value !== "object" ||
		Array.isArray(value) ||
		Object.keys(value).some((key) => !keys.includes(key))
	)
		throw new Error("Invalid execution metadata");
	return value as Record<string, unknown>;
}
function count(value: unknown): number {
	if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0)
		throw new Error("Invalid execution count");
	return value;
}
function identifier(value: unknown): string {
	if (typeof value !== "string" || !/^[1-9][0-9]{0,15}$/.test(value) || !Number.isSafeInteger(Number(value)))
		throw new Error("Invalid execution identifier");
	return value;
}
function label(value: unknown): string {
	if (typeof value !== "string" || !value.length || value.length > EXECUTION_LIMITS.label)
		throw new Error("Invalid execution label");
	return value;
}

export function parseExecution(value: unknown): ConversationExecution {
	const p = object(value, [
		"ownerTaskId",
		"run",
		"submissionIds",
		"submissionCount",
		"generation",
		"tools",
		"blockingCompactionCount",
	]);
	if (!Array.isArray(p.submissionIds) || p.submissionIds.length > EXECUTION_LIMITS.submissions)
		throw new Error("Invalid execution submissions");
	const submissionIds = Array.from(p.submissionIds, identifier);
	const submissionCount = count(p.submissionCount);
	if (
		new Set(submissionIds).size !== submissionIds.length ||
		submissionIds.length !== Math.min(submissionCount, EXECUTION_LIMITS.submissions)
	)
		throw new Error("Invalid execution submission coverage");
	const tools = object(p.tools, ["items", "total", "active"]);
	if (!Array.isArray(tools.items) || tools.items.length > EXECUTION_LIMITS.tools)
		throw new Error("Invalid execution tools");
	const items: ExecutionTool[] = Array.from(tools.items, (raw) => {
		const tool = object(raw, ["taskId", "callId", "name", "status", "parentTaskId", "anchor"]);
		if (tool.status !== "pending" && tool.status !== "running" && tool.status !== "done")
			throw new Error("Invalid tool status");
		if (tool.parentTaskId !== undefined && tool.taskId === undefined) throw new Error("Missing nested task");
		let anchor: ExecutionTool["anchor"];
		if (tool.anchor !== undefined) {
			if (tool.parentTaskId !== undefined) throw new Error("Nested call has no model anchor");
			const a = object(tool.anchor, ["assistantEntryId", "modelIndex", "contentIndex"]);
			anchor = {
				assistantEntryId: identifier(a.assistantEntryId),
				modelIndex: count(a.modelIndex),
				contentIndex: count(a.contentIndex),
			};
		}
		return {
			callId: label(tool.callId),
			name: label(tool.name),
			status: tool.status,
			...(tool.taskId === undefined ? {} : { taskId: identifier(tool.taskId) }),
			...(tool.parentTaskId === undefined ? {} : { parentTaskId: identifier(tool.parentTaskId) }),
			...(anchor ? { anchor } : {}),
		};
	});
	const total = count(tools.total),
		active = count(tools.active);
	const visibleActive = items.filter((item) => item.status !== "done").length;
	const taskIds = items.flatMap((item) => (item.taskId ? [item.taskId] : []));
	if (
		total < items.length ||
		active < visibleActive ||
		active > total - items.length + visibleActive ||
		new Set(taskIds).size !== taskIds.length
	)
		throw new Error("Invalid tool coverage");
	let generation: ConversationExecution["generation"];
	if (p.generation !== undefined) {
		const g = object(p.generation, ["attempt", "retryAt", "deferredPollAt"]);
		const attempt = count(g.attempt);
		if (!attempt || (g.retryAt !== undefined && g.deferredPollAt !== undefined))
			throw new Error("Invalid generation metadata");
		generation = {
			attempt,
			...(g.retryAt === undefined ? {} : { retryAt: count(g.retryAt) }),
			...(g.deferredPollAt === undefined ? {} : { deferredPollAt: count(g.deferredPollAt) }),
		};
	}
	return {
		ownerTaskId: identifier(p.ownerTaskId),
		...(p.run === undefined ? {} : { run: parseRunAdmission(p.run) }),
		submissionIds,
		submissionCount,
		...(generation ? { generation } : {}),
		tools: { items, total, active },
		blockingCompactionCount: count(p.blockingCompactionCount),
	};
}
