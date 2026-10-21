import { Code, Text, WrapText } from "lucide-react";
import { Component, createContext, memo, type ReactNode, useContext, useMemo, useRef, useState } from "react";
import { usePreferences } from "../../../../app/preferences.tsx";
import { useCodeBlockWordWrap } from "../../../../app/presentation/provider.tsx";
import { ActionTooltip } from "../../../../components/ui/action-tooltip.tsx";
import { Button } from "../../../../components/ui/button.tsx";
import { ExternalLink } from "../../../../components/ui/external-link.tsx";
import { ReadOnlyCheckbox } from "../../../../components/ui/read-only-checkbox.tsx";
import { ClipboardCopy } from "./clipboard-copy.tsx";
import { ProjectFileLink } from "./file-links/link.tsx";
import { projectFilePath } from "./file-links/path.ts";
import { markdownLabels } from "./labels.ts";
import { parseMarkdown } from "./parse.ts";
import { completeMarkdownLink, markdownDisplaySource } from "./policy.ts";
import { isOpenCodeFence } from "./segments.ts";
import { useTaskDecorationReveal } from "./structure-reveal.tsx";
import { SyntaxCode } from "./syntax-code.tsx";
import { TextRevealContext, useTextReveal, useTextRevealVisible } from "./text-reveal.tsx";
import { type MarkdownTokenComponents, MarkdownTokens } from "./token-renderer.tsx";
import { useStreamingText } from "./use-streaming-text.ts";
import "./markdown.css";

type MarkdownTone = "user" | "assistant";
const SourceContext = createContext({
	source: "",
	unchangedPrefix: 0,
	streaming: false,
	tone: "assistant" as MarkdownTone,
});
const components: MarkdownTokenComponents = {
	link: (props) => <MarkdownLink {...props} />,
	code: (props) => <CodeBlock {...props} />,
	image: (props) => <ImagePlaceholder {...props} />,
	task: (props) => <TaskMarker {...props} />,
	table: (props) => <MarkdownTable {...props} />,
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
		// Bare autolinks may be fragments of unfinished inline links; references may have mutable definitions.
		// Both wait until this document's stream settles instead of guessing a URL terminator.
		complete = completeMarkdownLink(raw);
	}
	const path = complete ? projectFilePath(href) : undefined;
	if (path)
		return (
			<ProjectFileLink key={path} path={path} title={title}>
				{children}
			</ProjectFileLink>
		);
	return (
		<ExternalLink key={href} href={complete ? href : undefined} title={title}>
			{children}
		</ExternalLink>
	);
}

function MarkdownTable({
	children,
	sourceStart,
	sourceEnd,
}: {
	children: ReactNode;
	sourceStart?: number;
	sourceEnd?: number;
}) {
	const { locale } = usePreferences();
	return (
		<section
			className="markdown-table"
			aria-label={markdownLabels(locale)["markdown.table"]}
			// biome-ignore lint/a11y/noNoninteractiveTabindex: Keyboard users must be able to scroll a wide table.
			tabIndex={0}
			data-markdown-source-start={sourceStart}
			data-markdown-source-end={sourceEnd}
		>
			{children}
		</section>
	);
}

function CodeBlock({
	text,
	language,
	children,
	startLine,
	endLine,
	openFence,
	sourceStart,
	sourceEnd,
}: {
	text: string;
	language?: string;
	children: ReactNode;
	startLine?: number;
	endLine?: number;
	openFence?: boolean;
	sourceStart?: number;
	sourceEnd?: number;
}) {
	const { locale } = usePreferences();
	const labels = markdownLabels(locale);
	const context = useContext(SourceContext);
	const wrap = useCodeBlockWordWrap();
	if (context.tone === "user")
		return (
			<pre className="markdown-user-code" data-markdown-source-start={sourceStart} data-markdown-source-end={sourceEnd}>
				{children}
			</pre>
		);
	const unfinished =
		context.streaming && (openFence ?? (!startLine || !endLine || isOpenCodeFence(context.source, startLine, endLine)));
	const title = language ?? (unfinished ? "" : undefined);
	const wrapLabel = labels[wrap.wrapped ? "markdown.disableWrap" : "markdown.enableWrap"];
	return (
		<div
			className="markdown-code-block"
			data-wrapped={wrap.wrapped}
			data-markdown-source-start={sourceStart}
			data-markdown-source-end={sourceEnd}
		>
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

/** Error recovery is continuous and selectable, never a second pagination surface. */
export function OriginalText({ source }: { source: string }) {
	return (
		<div className="original-text">
			<pre className="message-text">{source}</pre>
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
	trackSourceRanges,
	sourceOffset,
}: {
	source: string;
	streaming: boolean;
	tone: MarkdownTone;
	reveal: boolean;
	visible: boolean;
	trackSourceRanges?: boolean;
	sourceOffset?: number;
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
	const document = useMemo(() => parseMarkdown(displaySource), [displaySource]);
	const [decorated, setDecorated] = useState(reveal);
	if (reveal && !decorated) setDecorated(true);
	const presentation = useTextReveal(source, reveal && visible);
	return (
		<SourceContext.Provider value={context}>
			<TextRevealContext.Provider value={presentation}>
				<MarkdownTokens
					document={document}
					components={components}
					decorate={decorated}
					trackSourceRanges={trackSourceRanges}
					sourceOffset={sourceOffset}
				/>
			</TextRevealContext.Provider>
		</SourceContext.Provider>
	);
});

export const MessageMarkdown = memo(function MessageMarkdown({
	source,
	streaming = false,
	streamId = "",
	tone = "assistant",
	trackSourceRanges = false,
	sourceOffset = 0,
}: {
	source: string;
	streaming?: boolean;
	streamId?: string;
	tone?: MarkdownTone;
	/** Search locates verified source blocks without replacing the normal rich document. */
	trackSourceRanges?: boolean;
	sourceOffset?: number;
}) {
	const { locale } = usePreferences();
	const root = useRef<HTMLDivElement>(null);
	const display = useStreamingText({ source, streaming, identity: streamId }, root);
	const visible = useTextRevealVisible();
	const fallback = (
		<>
			<p className="small-copy">{markdownLabels(locale)["markdown.renderFailed"]}</p>
			<OriginalText source={display.source} />
		</>
	);
	return (
		<div ref={root} className="message-text markdown-body" data-markdown-tone={tone}>
			<MarkdownBoundary source={display.source} fallback={fallback}>
				<MarkdownBlock
					key={display.identity}
					source={display.source}
					streaming={display.streaming}
					tone={tone}
					reveal={display.streaming && tone === "assistant"}
					visible={visible}
					trackSourceRanges={trackSourceRanges}
					sourceOffset={sourceOffset}
				/>
			</MarkdownBoundary>
		</div>
	);
});
