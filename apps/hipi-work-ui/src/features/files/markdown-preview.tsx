import { useEffect, useRef } from "react";
import { usePreferences } from "../../app/preferences.tsx";
import { MessageMarkdown } from "../workbench/message-markdown.tsx";
import type { EditorViewMemory } from "./editor-view-memory.ts";
import { fileLabels } from "./file-labels.ts";
import "./markdown-preview.css";

/** Presentation of the current draft, never a second file reader or writer. */
export function MarkdownPreview({ text, memory }: { text: string; memory: EditorViewMemory }) {
	const { locale } = usePreferences();
	const viewport = useRef<HTMLElement>(null);
	useEffect(() => {
		const element = viewport.current;
		if (!element) return;
		element.scrollTop = memory.markdownPreview?.scrollTop ?? 0;
		element.scrollLeft = memory.markdownPreview?.scrollLeft ?? 0;
		return () => {
			memory.markdownPreview = { scrollTop: element.scrollTop, scrollLeft: element.scrollLeft };
		};
	}, [memory]);
	return (
		<section
			ref={viewport}
			className="file-markdown-preview"
			aria-label={fileLabels(locale)["view.preview"]}
			// biome-ignore lint/a11y/noNoninteractiveTabindex: The preview is an independently keyboard-scrollable document.
			tabIndex={0}
		>
			<MessageMarkdown source={text} />
		</section>
	);
}
