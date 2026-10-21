import {
	type AnimationEvent,
	type ComponentProps,
	createContext,
	createElement,
	type HTMLAttributes,
	useContext,
	useLayoutEffect,
} from "react";
import type { ExtraProps } from "react-markdown";
import { TextRevealContext, useOneShotReveal } from "./text-reveal.tsx";

const TaskDecorationContext = createContext({ active: false, fresh: false });

function useStructureReveal(node: ExtraProps["node"], kind: string) {
	const context = useContext(TextRevealContext);
	const start = node?.position?.start.offset;
	const key = start === undefined ? undefined : `${kind}:${start}`;
	const fresh =
		!!context && start !== undefined && start >= context.preserved && !context.previous.structures.has(key ?? "");
	useLayoutEffect(() => {
		if (context && key !== undefined) context.previous.structures.add(key);
	}, [context, key]);
	return { active: context?.active ?? false, fresh };
}

/** Keep the actual list item and its children stable; marker and row opacity have separate clocks. */
export function RevealedListItem({ children, className, node, ...props }: ComponentProps<"li"> & ExtraProps) {
	const task = className?.split(/\s+/u).includes("task-list-item") ?? false;
	const decoration = useStructureReveal(node, "li");
	const row = useOneShotReveal(decoration.active, decoration.fresh);
	const marker = useOneShotReveal(decoration.active, decoration.fresh && !task);
	const classes = [
		className,
		row.revealing && "markdown-structure-reveal",
		marker.revealing && "markdown-marker-reveal",
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
			<TaskDecorationContext.Provider value={decoration}>{children}</TaskDecorationContext.Provider>
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
	...props
}: HTMLAttributes<HTMLElement> & ExtraProps & { tag: "blockquote" | "tr" | "hr" }) {
	const { active, fresh } = useStructureReveal(node, tag);
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
