import { Code, Text, WrapText } from "lucide-react";
import { Component, createContext, memo, type ReactNode, useContext, useMemo, useRef, useState } from "react";
import Markdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import { usePreferences } from "../../../../app/preferences.tsx";
import { useCodeBlockWordWrap } from "../../../../app/presentation/provider.tsx";
import { ActionTooltip } from "../../../../components/ui/action-tooltip.tsx";
import { Button } from "../../../../components/ui/button.tsx";
import { ExternalLink } from "../../../../components/ui/external-link.tsx";
import { ReadOnlyCheckbox } from "../../../../components/ui/read-only-checkbox.tsx";
import { ClipboardCopy } from "./clipboard-copy.tsx";
import { markdownLabels } from "./labels.ts";
import {
	inertDestination,
	MAX_RICH_TEXT_UNITS,
	markdownDisplaySource,
	ORIGINAL_PAGE_UNITS,
	originalPage,
} from "./policy.ts";
import { revealTextPlugin } from "./reveal-plugin.ts";
import { isOpenCodeFence, markdownSegments } from "./segments.ts";
import { RevealedListItem, RevealedStructure, useTaskDecorationReveal } from "./structure-reveal.tsx";
import { SyntaxCode } from "./syntax-code.tsx";
import { RevealedTextLeaf, TextRevealContext, useTextReveal, useTextRevealVisible } from "./text-reveal.tsx";
import { useStreamingText } from "./use-streaming-text.ts";
import "./markdown.css";

const allowedElements = [
	"p",
	"br",
	"hr",
	"h1",
	"h2",
	"h3",
	"h4",
	"h5",
	"h6",
	"blockquote",
	"ul",
	"ol",
	"li",
	"strong",
	"em",
	"del",
	"pre",
	"code",
	"table",
	"thead",
	"tbody",
	"tr",
	"th",
	"td",
	"a",
	"img",
	"input",
	"span",
];
const plugins = [remarkGfm];
const revealPlugins = [revealTextPlugin];
type MarkdownTone = "user" | "assistant";
const SourceContext = createContext({
	source: "",
	unchangedPrefix: 0,
	streaming: false,
	tone: "assistant" as MarkdownTone,
});
const components: Components = {
	span: RevealedTextLeaf,
	li: RevealedListItem,
	blockquote: (props) => <RevealedStructure tag="blockquote" {...props} />,
	tr: (props) => <RevealedStructure tag="tr" {...props} />,
	hr: (props) => <RevealedStructure tag="hr" {...props} />,
	a: ({ children, href, title, node }) => (
		<MarkdownLink href={href} title={title} start={node?.position?.start.offset} end={node?.position?.end.offset}>
			{children}
		</MarkdownLink>
	),
	img: ({ alt }) => <ImagePlaceholder alt={alt ?? ""} />,
	input: ({ checked }) => <TaskMarker checked={checked ?? false} />,
	table: ({ children }) => <MarkdownTable>{children}</MarkdownTable>,
	th: ({ children, style }) => (
		<th scope="col" data-align={style?.textAlign}>
			{children}
		</th>
	),
	td: ({ children, style }) => <td data-align={style?.textAlign}>{children}</td>,
	pre: ({ children, node }) => {
		const code = node?.children[0];
		if (code?.type !== "element" || code.tagName !== "code") return <pre>{children}</pre>;
		const classes = Array.isArray(code.properties.className) ? code.properties.className : [];
		const language = classes
			.find((value) => typeof value === "string" && /^language-[\w+#.-]{1,40}$/u.test(value))
			?.toString()
			.slice("language-".length);
		const text = code.children.map((child) => (child.type === "text" ? child.value : "")).join("");
		return (
			<CodeBlock
				text={text}
				language={language}
				startLine={node?.position?.start.line}
				endLine={node?.position?.end.line}
			>
				{children}
			</CodeBlock>
		);
	},
};

/** A mutable destination is not an actionable URL, even when GFM autolinks its prefix. */
function MarkdownLink({
	href,
	title,
	start,
	end,
	children,
}: {
	href?: string;
	title?: string;
	start?: number;
	end?: number;
	children: ReactNode;
}) {
	const { source, streaming, unchangedPrefix } = useContext(SourceContext);
	let complete = !streaming;
	if (streaming && start !== undefined && end !== undefined && end <= unchangedPrefix) {
		const raw = source.slice(start, end);
		const explicit =
			(raw.startsWith("[") && raw.includes("](") && raw.endsWith(")")) || (raw.startsWith("<") && raw.endsWith(">"));
		// Bare autolinks may be fragments of unfinished inline links; references may have mutable definitions.
		// Both wait for the existing segment-settled boundary instead of guessing a URL terminator.
		complete = explicit;
	}
	return (
		<ExternalLink key={href} href={complete ? href : undefined} title={title}>
			{children}
		</ExternalLink>
	);
}

function MarkdownTable({ children }: { children: ReactNode }) {
	const { locale } = usePreferences();
	return (
		// biome-ignore lint/a11y/noNoninteractiveTabindex: Keyboard users must be able to scroll a wide table.
		<section className="markdown-table" aria-label={markdownLabels(locale)["markdown.table"]} tabIndex={0}>
			<table>{children}</table>
		</section>
	);
}

function CodeBlock({
	text,
	language,
	children,
	startLine,
	endLine,
}: {
	text: string;
	language?: string;
	children: ReactNode;
	startLine?: number;
	endLine?: number;
}) {
	const { locale } = usePreferences();
	const labels = markdownLabels(locale);
	const context = useContext(SourceContext);
	const wrap = useCodeBlockWordWrap();
	if (context.tone === "user") return <pre className="markdown-user-code">{children}</pre>;
	const unfinished =
		context.streaming && (!startLine || !endLine || isOpenCodeFence(context.source, startLine, endLine));
	const title = language ?? (unfinished ? "" : undefined);
	const wrapLabel = labels[wrap.wrapped ? "markdown.disableWrap" : "markdown.enableWrap"];
	return (
		<div className="markdown-code-block" data-wrapped={wrap.wrapped}>
			<div className="markdown-code-header" data-markdown-copy="exclude">
				{title !== undefined && <Code size={20} aria-hidden="true" className="markdown-code-glyph" />}
				<span className="markdown-code-language">{title}</span>
				<div className="markdown-code-controls">
					<ActionTooltip label={wrapLabel}>
						<Button
							variant="ghost"
							size="icon-sm"
							className="markdown-code-wrap"
							aria-label={wrapLabel}
							aria-pressed={wrap.wrapped}
							onClick={wrap.toggle}
						>
							{wrap.wrapped ? <WrapText size={16} aria-hidden="true" /> : <Text size={16} aria-hidden="true" />}
						</Button>
					</ActionTooltip>
					{!unfinished && (
						<ClipboardCopy
							text={text}
							label={labels["markdown.copyCode"]}
							className="markdown-code-copy"
							containerClassName="markdown-code-actions"
							errorClassName="markdown-code-error"
							iconOnly
						/>
					)}
				</div>
			</div>
			{/* biome-ignore lint/a11y/noNoninteractiveTabindex: Keyboard users must be able to scroll long code lines. */}
			<section className="markdown-code-scroll" aria-label={labels["markdown.code"]} tabIndex={0} dir="ltr">
				<pre>
					<SyntaxCode text={text} language={language} />
				</pre>
			</section>
		</div>
	);
}

function TaskMarker({ checked }: { checked: boolean }) {
	const { t } = usePreferences();
	const { revealing, settle } = useTaskDecorationReveal();
	return (
		<span
			className={`markdown-task-marker${revealing ? " markdown-task-reveal" : ""}`}
			onAnimationEnd={(event) => {
				if (event.target === event.currentTarget && event.animationName === "markdown-task-reveal") settle();
			}}
		>
			<ReadOnlyCheckbox checked={checked} label={t(checked ? "markdown.checked" : "markdown.unchecked")} />
		</span>
	);
}

function ImagePlaceholder({ alt }: { alt: string }) {
	const { t } = usePreferences();
	return (
		<span className="markdown-image">
			[{t("markdown.image")}
			{alt ? `: ${alt}` : ""}]
		</span>
	);
}

export function OriginalText({ source }: { source: string }) {
	const { t } = usePreferences();
	const [page, setPage] = useState(0);
	const count = Math.max(1, Math.ceil(source.length / ORIGINAL_PAGE_UNITS));
	const current = Math.min(page, count - 1);
	return (
		<div className="original-text">
			<pre className="message-text">{originalPage(source, current)}</pre>
			{count > 1 && (
				<div className="original-pages">
					<Button size="sm" variant="outline" disabled={current === 0} onClick={() => setPage(current - 1)}>
						{t("markdown.previous")}
					</Button>
					<span>
						{current + 1} / {count}
					</span>
					<Button size="sm" variant="outline" disabled={current + 1 === count} onClick={() => setPage(current + 1)}>
						{t("markdown.next")}
					</Button>
				</div>
			)}
		</div>
	);
}

class MarkdownBoundary extends Component<
	{ source: string; children: ReactNode; fallback: ReactNode },
	{ failed: boolean; source: string }
> {
	state = { failed: false, source: this.props.source };
	static getDerivedStateFromError() {
		return { failed: true };
	}
	static getDerivedStateFromProps(props: { source: string }, state: { source: string }) {
		return props.source !== state.source ? { failed: false, source: props.source } : null;
	}
	render() {
		return this.state.failed ? this.props.fallback : this.props.children;
	}
}

const MarkdownBlock = memo(function MarkdownBlock({
	source,
	streaming,
	tone,
	reveal,
	visible,
}: {
	source: string;
	streaming: boolean;
	tone: MarkdownTone;
	reveal: boolean;
	visible: boolean;
}) {
	const displaySource = useMemo(() => markdownDisplaySource(source, streaming), [source, streaming]);
	const context = useMemo(() => {
		// Parser offsets are usable only inside the unchanged real-source prefix.
		// Repair may append/remove syntax, but cannot manufacture an actionable destination.
		let unchangedPrefix = 0;
		while (unchangedPrefix < source.length && source[unchangedPrefix] === displaySource[unchangedPrefix])
			unchangedPrefix++;
		return { source, unchangedPrefix, streaming, tone };
	}, [source, displaySource, streaming, tone]);
	const [decorated, setDecorated] = useState(reveal);
	if (reveal && !decorated) setDecorated(true);
	const presentation = useTextReveal(source, reveal && visible);
	return (
		<SourceContext.Provider value={context}>
			<TextRevealContext.Provider value={presentation}>
				<Markdown
					allowedElements={allowedElements}
					skipHtml
					remarkPlugins={plugins}
					rehypePlugins={decorated ? revealPlugins : undefined}
					components={components}
					urlTransform={inertDestination}
				>
					{displaySource}
				</Markdown>
			</TextRevealContext.Provider>
		</SourceContext.Provider>
	);
});

export const MessageMarkdown = memo(function MessageMarkdown({
	source,
	streaming = false,
	streamId = "",
	tone = "assistant",
}: {
	source: string;
	streaming?: boolean;
	streamId?: string;
	tone?: MarkdownTone;
}) {
	const { t } = usePreferences();
	const root = useRef<HTMLDivElement>(null);
	const display = useStreamingText({ source, streaming, identity: streamId }, root);
	const visible = useTextRevealVisible();
	const segments = useMemo(
		() => (display.source.length > MAX_RICH_TEXT_UNITS ? [] : markdownSegments(display.source)),
		[display.source],
	);
	const fallback = (
		<>
			<p className="small-copy">{t("markdown.fallback")}</p>
			<OriginalText source={display.source} />
		</>
	);
	const overCeiling = display.source.length > MAX_RICH_TEXT_UNITS;
	return (
		<div ref={root} className={overCeiling ? undefined : "message-text markdown-body"} data-markdown-tone={tone}>
			{overCeiling ? (
				fallback
			) : (
				<MarkdownBoundary source={display.source} fallback={fallback}>
					{segments.map((segment) => (
						<MarkdownBlock
							key={`${display.identity}:${segment.key}`}
							source={segment.source}
							streaming={display.streaming && !segment.settled}
							tone={tone}
							reveal={display.streaming && tone === "assistant"}
							visible={visible}
						/>
					))}
				</MarkdownBoundary>
			)}
		</div>
	);
});
