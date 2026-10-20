import type { Params, PinKey, SidebarPinItem, SidebarPinPage } from "@hipi/work-runtime/contracts";
import type { SidebarOrderAction } from "./drag-provider.tsx";

export const pinKey = (item: SidebarPinItem): PinKey =>
	item.kind === "project"
		? { kind: "project", projectId: item.project.projectId }
		: {
				kind: "conversation",
				workspaceId: item.conversation.workspaceId,
				conversationId: item.conversation.conversationId,
			};
export const mixedPinKey = (key: PinKey) =>
	key.kind === "project"
		? JSON.stringify([key.kind, key.projectId])
		: JSON.stringify([key.kind, key.workspaceId, key.conversationId]);

/** Only authoritative keys/revision become insert-before commands, including unloaded lookahead. */
export function mixedPinOrderActions(
	pages: readonly SidebarPinPage[],
	items: readonly SidebarPinItem[],
	blocked: boolean,
	reorder: (input: Params<"reorderSidebarPin">) => void,
): Map<string, SidebarOrderAction> {
	const revision = pages[0]?.orderRevision;
	const targets = new Map(items.map((item) => [mixedPinKey(pinKey(item)), pinKey(item)]));
	const keys = items.map((item) => mixedPinKey(pinKey(item)));
	const successor = pages.at(-1)?.nextPinKey ?? null;
	if (successor) targets.set(mixedPinKey(successor), successor);
	const after = (index: number) => keys[index + 1] ?? (successor ? mixedPinKey(successor) : null);
	const disabled =
		blocked ||
		revision === undefined ||
		pages.some((page) => page.orderRevision !== revision || (page.nextCursor === null) !== (page.nextPinKey === null));
	return new Map(
		items.map((item, index) => [
			mixedPinKey(pinKey(item)),
			{
				item: {
					id: mixedPinKey(pinKey(item)),
					group: "pinned",
					label: item.kind === "project" ? item.project.name : item.conversation.title,
					revision: `${revision}:${disabled}`,
					disabled,
					after: after(index),
					move: (before: string | null) => {
						if (disabled || revision === undefined) return;
						const anchor = before === null ? null : targets.get(before);
						if (anchor === undefined || (anchor && mixedPinKey(anchor) === mixedPinKey(pinKey(item)))) return;
						reorder({
							requestId: crypto.randomUUID(),
							moved: pinKey(item),
							before: anchor ? { ...anchor } : null,
							expectedOrderRevision: revision,
						});
					},
				},
				up: keys[index - 1],
				down: index < items.length - 1 ? after(index + 1) : undefined,
			},
		]),
	);
}
