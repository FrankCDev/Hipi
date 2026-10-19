import { Component, memo, type ReactNode, useState } from "react";
import Markdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import { usePreferences } from "../../app/preferences.tsx";
import { Button } from "../../components/ui/button.tsx";
import {
	inertDestination,
	MAX_RICH_TEXT_UNITS,
	MAX_STREAMING_RICH_TEXT_UNITS,
	markdownDisplaySource,
	ORIGINAL_PAGE_UNITS,
	originalPage,
} from "./markdown-policy.ts";

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
const components: Components = {
	a: ({ children, href }) => (
		<span className="markdown-link">
			{children}
			{href && <span className="markdown-destination"> ({href})</span>}
		</span>
	),
	img: ({ alt }) => <ImagePlaceholder alt={alt ?? ""} />,
	input: ({ checked }) => <TaskMarker checked={checked ?? false} />,
	table: ({ children }) => (
		<div className="markdown-table">
			<table>{children}</table>
		</div>
	),
};

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

function RichText({ source, streaming }: { source: string; streaming: boolean }) {
	return (
		<div className="message-text markdown-body">
			<Markdown
				allowedElements={allowedElements}
				skipHtml
				remarkPlugins={plugins}
				components={components}
				urlTransform={inertDestination}
			>
				{markdownDisplaySource(source, streaming)}
			</Markdown>
		</div>
	);
}

export const MessageMarkdown = memo(function MessageMarkdown({
	source,
	streaming = false,
}: {
	source: string;
	streaming?: boolean;
}) {
	const { t } = usePreferences();
	const fallback = (
		<>
			<p className="small-copy">{t("markdown.fallback")}</p>
			<OriginalText source={source} />
		</>
	);
	if (source.length > (streaming ? MAX_STREAMING_RICH_TEXT_UNITS : MAX_RICH_TEXT_UNITS)) return fallback;
	return (
		<>
			<MarkdownBoundary source={source} fallback={fallback}>
				<RichText source={source} streaming={streaming} />
			</MarkdownBoundary>
			<details className="message-original">
				<summary>{t("markdown.original")}</summary>
				<OriginalText source={source} />
			</details>
		</>
	);
});
