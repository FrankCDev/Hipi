import { Component, createContext, memo, type ReactNode, useContext, useMemo, useRef, useState } from "react";
import Markdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import { usePreferences } from "../../app/preferences.tsx";
import { Button } from "../../components/ui/button.tsx";
import { ClipboardCopy } from "./clipboard-copy.tsx";
import {
	inertDestination,
	MAX_RICH_TEXT_UNITS,
	MAX_STREAMING_RICH_TEXT_UNITS,
	markdownDisplaySource,
	ORIGINAL_PAGE_UNITS,
	originalPage,
} from "./markdown-policy.ts";
import { isOpenCodeFence, markdownSegments } from "./markdown-segments.ts";
import { markdownLabels } from "./message-markdown-labels.ts";
import { SyntaxCode } from "./syntax-code.tsx";
import { useStreamingText } from "./use-streaming-text.ts";
import "./message-markdown.css";

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
];
const plugins = [remarkGfm];
type MarkdownTone = "user" | "assistant";
const SourceContext = createContext({ source: "", streaming: false, tone: "assistant" as MarkdownTone });
const components: Components = {
	a: ({ children, href }) => (
		<span className="markdown-link">
			{children}
			{href && <span className="markdown-destination"> ({href})</span>}
		</span>
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
	if (context.tone === "user") return <pre className="markdown-user-code">{children}</pre>;
	const unfinished =
		context.streaming && (!startLine || !endLine || isOpenCodeFence(context.source, startLine, endLine));
	return (
		<div className="markdown-code-block">
			<div className="markdown-code-header">
				<span className="markdown-code-language">{language ?? labels["markdown.code"]}</span>
				<ClipboardCopy
					text={text}
					label={labels["markdown.copyCode"]}
					disabled={unfinished}
					disabledLabel={labels["markdown.copyAfterStreaming"]}
					className="markdown-code-copy"
					containerClassName="markdown-code-actions"
					errorClassName="markdown-code-error"
					iconOnly
				/>
			</div>
			{/* biome-ignore lint/a11y/noNoninteractiveTabindex: Keyboard users must be able to scroll long code lines. */}
			<section className="markdown-code-scroll" aria-label={labels["markdown.code"]} tabIndex={0}>
				<pre>
					<SyntaxCode text={text} language={language} />
				</pre>
			</section>
		</div>
	);
}

function TaskMarker({ checked }: { checked: boolean }) {
	const { t } = usePreferences();
	return (
		<span role="img" aria-label={t(checked ? "markdown.checked" : "markdown.unchecked")}>
			{checked ? "☑ " : "☐ "}
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
}: {
	source: string;
	streaming: boolean;
	tone: MarkdownTone;
}) {
	const context = useMemo(() => ({ source, streaming, tone }), [source, streaming, tone]);
	return (
		<SourceContext.Provider value={context}>
			<Markdown
				allowedElements={allowedElements}
				skipHtml
				remarkPlugins={plugins}
				components={components}
				urlTransform={inertDestination}
			>
				{markdownDisplaySource(source, streaming)}
			</Markdown>
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
	const overCeiling =
		display.source.length > MAX_RICH_TEXT_UNITS ||
		(display.streaming &&
			segments.some((segment) => !segment.settled && segment.source.length > MAX_STREAMING_RICH_TEXT_UNITS));
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
						/>
					))}
				</MarkdownBoundary>
			)}
		</div>
	);
});
