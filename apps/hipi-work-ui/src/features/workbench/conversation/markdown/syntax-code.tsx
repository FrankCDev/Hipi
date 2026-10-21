import { type ClipboardEvent, type CSSProperties, type ReactNode, useEffect, useRef, useState } from "react";
import { useThemeSettings } from "../../../../app/theme/index.ts";
import { selectionIntersects } from "../message-projection.ts";
import { type CodeHighlight, CodeHighlightProjection } from "./syntax-highlight.ts";
import "./syntax-code.css";

export function SyntaxCode({ text, language }: { text: string; language?: string }) {
	const { config } = useThemeSettings();
	const root = useRef<HTMLElement>(null);
	const owner = useRef<CodeHighlightProjection | null>(null);
	const [highlight, setHighlight] = useState<CodeHighlight>();
	useEffect(() => {
		let visible = typeof IntersectionObserver === "undefined";
		const projection = new CodeHighlightProjection(
			setHighlight,
			() =>
				!visible ||
				selectionIntersects(root.current?.closest(".markdown-body") ?? root.current, document.getSelection()),
		);
		owner.current = projection;
		const resume = () => projection.resume();
		const observer =
			typeof IntersectionObserver === "undefined"
				? undefined
				: new IntersectionObserver(
						(entries) => {
							visible = entries.some((entry) => entry.isIntersecting);
							if (visible) projection.resume();
						},
						{ rootMargin: "600px" },
					);
		if (root.current) observer?.observe(root.current);
		document.addEventListener("selectionchange", resume);
		return () => {
			projection.dispose();
			owner.current = null;
			observer?.disconnect();
			document.removeEventListener("selectionchange", resume);
		};
	}, []);
	useEffect(() => {
		owner.current?.update(text, language ?? "", config.codeTheme);
	}, [text, language, config.codeTheme]);
	return (
		<code ref={root} onCopy={copyCodeSelection}>
			<SyntaxCodeContent text={text} highlight={highlight?.language === (language ?? "") ? highlight : undefined} />
		</code>
	);
}

/** Token colors come only from bundled themes; code is always escaped React text, never HTML. */
export function SyntaxCodeContent({ text, highlight }: { text: string; highlight?: CodeHighlight }) {
	let prefix = 0;
	if (highlight) {
		while (prefix < text.length && prefix < highlight.source.length && text[prefix] === highlight.source[prefix])
			prefix++;
	}
	const children: ReactNode[] = [];
	let offset = 0;
	for (const token of highlight?.tokens ?? []) {
		if (!token.content) continue;
		if (token.offset >= prefix) break;
		if (token.offset > offset) children.push(text.slice(offset, token.offset));
		const end = Math.min(prefix, token.offset + token.content.length);
		const style: CSSProperties & { "--syntax-light"?: string; "--syntax-dark"?: string } = {
			"--syntax-light": token.light,
			"--syntax-dark": token.dark,
		};
		children.push(
			<span key={token.offset} className="markdown-syntax-token" style={style}>
				{text.slice(token.offset, end)}
			</span>,
		);
		offset = end;
	}
	children.push(text.slice(offset));
	return <>{children}</>;
}

/** Only code-contained selections override native copy; surrounding prose/user-message copy is untouched. */
export function copyCodeSelection(event: ClipboardEvent<HTMLElement>) {
	if (event.defaultPrevented || !event.clipboardData) return;
	const selection = event.currentTarget.ownerDocument.getSelection();
	if (!selection || selection.isCollapsed || selection.rangeCount !== 1) return;
	const range = selection.getRangeAt(0);
	if (!event.currentTarget.contains(range.startContainer) || !event.currentTarget.contains(range.endContainer)) return;
	const text = selection.toString();
	if (!text) return;
	try {
		event.clipboardData.setData("text/plain", text);
		event.preventDefault();
		event.stopPropagation();
	} catch {
		// A platform without writable clipboard event data keeps its normal copy behavior.
	}
}
