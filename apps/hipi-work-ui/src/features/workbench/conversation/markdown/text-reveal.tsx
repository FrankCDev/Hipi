import { usePageInView } from "framer-motion";
import { createContext, useContext, useLayoutEffect, useMemo, useState } from "react";
import { useReducedMotionPreference } from "../../../../app/theme/use-reduced-motion.ts";
import type { MarkdownSourceNode } from "./source-node.ts";
import "./text-reveal.css";

type RevealedText = { source: string; leaves: Map<number, string>; structures: Set<string> };
type RevealContextValue = { previous: RevealedText; preserved: number; active: boolean };
export const TextRevealContext = createContext<RevealContextValue | null>(null);

function commonPrefix(left: string, right: string) {
	let length = 0;
	while (length < left.length && length < right.length && left[length] === right[length]) length++;
	return length;
}

export function useTextReveal(source: string, active: boolean) {
	const [previous] = useState<RevealedText>(() => ({ source: "", leaves: new Map(), structures: new Set() }));
	const context = useMemo(
		() => ({ previous, preserved: commonPrefix(previous.source, source), active }),
		[previous, source, active],
	);
	useLayoutEffect(() => {
		previous.source = source;
	}, [previous, source]);
	return context;
}

export function useTextRevealVisible() {
	const pageVisible = usePageInView();
	const reduced = useReducedMotionPreference();
	return pageVisible && !reduced;
}

const wordSegmenter =
	typeof Intl.Segmenter === "function" ? new Intl.Segmenter(undefined, { granularity: "word" }) : null;

/** Native word segmentation preserves every code unit, including punctuation and whitespace. */
export function revealWords(text: string): { offset: number; text: string }[] {
	const result: { offset: number; text: string }[] = [];
	const segments =
		wordSegmenter && /[^\p{ASCII}]/u.test(text)
			? wordSegmenter.segment(text)
			: Array.from(text.matchAll(/[A-Za-z0-9]+[^A-Za-z0-9]*|[^A-Za-z0-9]+/gu), (match) => ({
					segment: match[0],
					index: match.index,
					isWordLike: true,
				}));
	for (const segment of segments) {
		const last = result.at(-1);
		if (!segment.isWordLike && last) last.text += segment.segment;
		else result.push({ offset: segment.index, text: segment.segment });
	}
	return result;
}

export function RevealedTextLeaf({
	node,
	start: explicitStart,
	text: explicitText,
}: {
	node?: MarkdownSourceNode;
	start?: number;
	text?: string;
}) {
	const context = useContext(TextRevealContext);
	const start = explicitStart ?? node?.position?.start.offset;
	const text = explicitText ?? node?.children.map((child) => (child.type === "text" ? child.value : "")).join("") ?? "";
	const words = useMemo(() => revealWords(text), [text]);
	const previousText = start === undefined ? undefined : context?.previous.leaves.get(start);
	// Decoded text offsets are compared only with decoded text from the same leaf.
	// A newly reparented leaf inside the committed Markdown prefix is already visible;
	// do not infer entity/escape source maps or replay it after a parser correction.
	const preserved =
		previousText !== undefined
			? commonPrefix(previousText, text)
			: start !== undefined && context && start < context.preserved
				? text.length
				: 0;
	useLayoutEffect(() => {
		if (context && start !== undefined) context.previous.leaves.set(start, text);
	}, [context, start, text]);
	return words.map((word) => (
		<RevealedWord
			key={`${start}:${word.offset}`}
			active={context?.active ?? false}
			fresh={word.offset >= preserved && !!word.text.trim()}
		>
			{word.text}
		</RevealedWord>
	));
}

export function useOneShotReveal(active: boolean, fresh: boolean) {
	const [revealing, setRevealing] = useState(active && fresh);
	// A hidden, completed or reduced-motion segment is settled, never restarted on return.
	if (!active && revealing) setRevealing(false);
	return { revealing: revealing && active, settle: () => setRevealing(false) };
}

function RevealedWord({ children, active, fresh }: { children: string; active: boolean; fresh: boolean }) {
	const { revealing, settle } = useOneShotReveal(active, fresh);
	return (
		<span
			className={revealing ? "markdown-word-reveal" : undefined}
			onAnimationEnd={(event) => {
				if (event.target === event.currentTarget) settle();
			}}
		>
			{children}
		</span>
	);
}
