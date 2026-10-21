import {
	type AnimationEvent,
	type ComponentProps,
	createContext,
	createElement,
	type HTMLAttributes,
	useContext,
	useLayoutEffect,
} from "react";
import type { MarkdownSourceNode } from "./source-node.ts";
import { TextRevealContext, useOneShotReveal } from "./text-reveal.tsx";

const TaskDecorationContext = createContext({ active: false, fresh: false });

function useStructureReveal(start: number | undefined, kind: string) {
	const context = useContext(TextRevealContext);
	const key = start === undefined ? undefined : `${kind}:${start}`;
	// A streamed list marker may first be repaired into plain text. Its bytes are
	// not evidence that the parser-produced row or checkbox was already visible.
	// Track their actual structure identity; retain the prefix guard for paragraph
	// restructuring into a quote, rule or table.
	const fresh =
		!!context &&
		start !== undefined &&
		(kind === "li" || kind === "task" || start >= context.preserved) &&
		!context.previous.structures.has(key ?? "");
	useLayoutEffect(() => {
		if (context && key !== undefined) context.previous.structures.add(key);
	}, [context, key]);
	return { active: context?.active ?? false, fresh };
}

/** Keep the actual list item and its children stable; marker and row opacity have separate clocks. */
export function RevealedListItem({
	children,
	className,
	node,
	start: explicitStart,
	...props
}: ComponentProps<"li"> & { node?: MarkdownSourceNode; start?: number }) {
	const start = explicitStart ?? node?.position?.start.offset;
	const task = className?.split(/\s+/u).includes("task-list-item") ?? false;
	const decoration = useStructureReveal(start, "li");
	const taskDecoration = useStructureReveal(task ? start : undefined, "task");
	const row = useOneShotReveal(decoration.active, decoration.fresh);
	const marker = useOneShotReveal(decoration.active, decoration.fresh && !task);
	const classes = [
		className,
		row.revealing && "markdown-structure-reveal",
		marker.revealing && !task && "markdown-marker-reveal",
	]
		.filter(Boolean)
		.join(" ");
	return (
		<li
			{...props}
			className={classes || undefined}
			onAnimationEnd={(event) => {
				if (event.target !== event.currentTarget) return;
				if (event.animationName === "markdown-structure-reveal") row.settle();
				if (event.animationName === "markdown-marker-reveal" && event.pseudoElement === "::marker") marker.settle();
			}}
		>
			<TaskDecorationContext.Provider value={taskDecoration}>{children}</TaskDecorationContext.Provider>
		</li>
	);
}

export function useTaskDecorationReveal() {
	const { active, fresh } = useContext(TaskDecorationContext);
	return useOneShotReveal(active, fresh);
}

/** Parser-produced quote/row/rule elements keep their native tag, props and React identity. */
export function RevealedStructure({
	tag,
	children,
	className,
	node,
	start: explicitStart,
	...props
}: HTMLAttributes<HTMLElement> & { node?: MarkdownSourceNode; tag: "blockquote" | "tr" | "hr"; start?: number }) {
	const { active, fresh } = useStructureReveal(explicitStart ?? node?.position?.start.offset, tag);
	const { revealing, settle } = useOneShotReveal(active, fresh);
	return createElement(
		tag,
		{
			...props,
			className: [className, revealing && "markdown-structure-reveal"].filter(Boolean).join(" ") || undefined,
			onAnimationEnd: (event: AnimationEvent<HTMLElement>) => {
				if (event.target === event.currentTarget && event.animationName === "markdown-structure-reveal") settle();
			},
		},
		children,
	);
}
