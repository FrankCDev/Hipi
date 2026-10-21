import { decodeHTMLStrict } from "entities";
import type { MarkedToken, Tokens } from "marked";
import { createElement, type ReactNode } from "react";
import { locateMarkdownRaw, type MarkdownDocument, type MarkdownRange } from "./parse.ts";
import { isOpenCodeFence } from "./segments.ts";
import { RevealedListItem, RevealedStructure } from "./structure-reveal.tsx";
import { RevealedTextLeaf } from "./text-reveal.tsx";

export type MarkdownTokenComponents = {
	link: (props: { href: string; title?: string; start?: number; end?: number; children: ReactNode }) => ReactNode;
	code: (props: {
		text: string;
		language?: string;
		startLine: number;
		openFence: boolean;
		sourceStart?: number;
		sourceEnd?: number;
		endLine: number;
		children: ReactNode;
	}) => ReactNode;
	image: (props: { alt: string }) => ReactNode;
	task: (props: { checked: boolean }) => ReactNode;
	table: (props: { children: ReactNode; sourceStart?: number; sourceEnd?: number }) => ReactNode;
};

type Context = {
	document: MarkdownDocument;
	components: MarkdownTokenComponents;
	decorate: boolean;
	trackSourceRanges?: boolean;
	sourceOffset?: number;
};

export function MarkdownTokens(context: Context) {
	const { document } = context;
	return renderTokens(
		document.tokens,
		context,
		{ start: 0, end: document.normalized.length, exact: true },
		false,
		true,
	);
}

function renderTokens(
	tokens: readonly MarkedToken[],
	context: Context,
	parent: MarkdownRange,
	tight = false,
	topLevel = false,
): ReactNode[] {
	let cursor = parent.start;
	return tokens.map((token, index) => {
		const range = locateMarkdownRaw(context.document, token.raw, cursor, parent.end);
		// Failed container mapping must not consume the rest of the document and
		// prevent later siblings from being located independently.
		cursor = range.exact ? range.end : range.start + (token.raw.split("\n", 1)[0]?.length ?? 0);
		return createElement(Token, {
			key: `${token.type}:${range.start}:${index}`,
			token,
			context,
			range,
			tight,
			topLevel,
		});
	});
}

function Token({
	token,
	context,
	range,
	tight,
	topLevel,
}: {
	token: MarkedToken;
	context: Context;
	range: MarkdownRange;
	tight: boolean;
	topLevel: boolean;
}): ReactNode {
	const { document, components, decorate } = context;
	const start = document.offset(range.start);
	const sourceStart =
		topLevel && range.exact && context.trackSourceRanges ? start + (context.sourceOffset ?? 0) : undefined;
	const sourceEnd = sourceStart === undefined ? undefined : document.offset(range.end) + (context.sourceOffset ?? 0);
	const attributes = { "data-markdown-source-start": sourceStart, "data-markdown-source-end": sourceEnd };
	const children = (tokens: readonly MarkedToken[], inline = true, childRange = range) =>
		renderTokens(tokens, context, childRange, inline);
	const text = (value: string, decode = true) => {
		const displayed = decode ? decodeHTMLStrict(value) : value;
		return decorate ? <RevealedTextLeaf text={displayed} start={start} /> : displayed;
	};
	const nested = (tokens: Tokens.Generic[] | MarkedToken[]) => children(tokens as MarkedToken[]);
	switch (token.type) {
		case "space":
		case "def":
			return null;
		case "paragraph":
			return <p {...attributes}>{nested(token.tokens)}</p>;
		case "heading":
			return createElement(`h${token.depth}`, attributes, nested(token.tokens));
		case "text":
			return token.tokens ? tight ? nested(token.tokens) : <p>{nested(token.tokens)}</p> : text(token.text);
		case "escape":
			return text(token.text, false);
		case "strong":
			return <strong>{nested(token.tokens)}</strong>;
		case "em":
			return <em>{nested(token.tokens)}</em>;
		case "del":
			return <del>{nested(token.tokens)}</del>;
		case "br":
			return <br />;
		case "hr":
			return <RevealedStructure tag="hr" start={start} {...attributes} />;
		case "html":
			return /^<br\s*\/?>$/iu.test(token.raw.trim()) ? <br /> : token.raw;
		case "codespan":
			return <code>{token.text}</code>;
		case "link":
			return components.link({
				href: decodeHTMLStrict(token.href),
				title: token.title ?? undefined,
				start: range.exact ? start : undefined,
				end: range.exact ? document.offset(range.end) : undefined,
				children: nested(token.tokens),
			});
		case "image":
			return components.image({ alt: decodeHTMLStrict(token.text) });
		case "checkbox":
			return <>{components.task({ checked: token.checked })} </>;
		case "code": {
			const candidate = token.lang?.split(/\s+/u, 1)[0];
			const language = candidate && /^[\w+#.-]{1,40}$/u.test(candidate) ? candidate : undefined;
			// Code text is not entity-decoded. Preserve the conventional final LF
			// used by the existing code-copy surface, including blank source lines.
			const value = `${token.text}\n`;
			return components.code({
				text: value,
				language,
				sourceStart,
				sourceEnd,
				startLine: document.line(range.start),
				openFence: isOpenCodeFence(token.raw, 1, token.raw.replace(/\n$/u, "").split("\n").length),
				endLine: document.line(Math.max(range.start, range.end - (token.raw.endsWith("\n") ? 1 : 0))),
				children: <code>{value}</code>,
			});
		}
		case "blockquote":
			return (
				<RevealedStructure tag="blockquote" start={start} {...attributes}>
					{children(token.tokens as MarkedToken[], false)}
				</RevealedStructure>
			);
		case "list": {
			let cursor = range.start;
			const items = token.items.map((item) => {
				const itemRange = locateMarkdownRaw(document, item.raw, cursor, range.end);
				cursor = itemRange.exact ? itemRange.end : itemRange.start + (item.raw.split("\n", 1)[0]?.length ?? 0);
				return (
					<RevealedListItem
						key={itemRange.start}
						start={document.offset(itemRange.start)}
						className={item.task ? "task-list-item" : undefined}
					>
						{children(item.tokens as MarkedToken[], !token.loose, itemRange)}
					</RevealedListItem>
				);
			});
			return token.ordered ? (
				<ol start={token.start === 1 ? undefined : Number(token.start)} {...attributes}>
					{items}
				</ol>
			) : (
				<ul {...attributes}>{items}</ul>
			);
		}
		case "list_item":
			return (
				<RevealedListItem start={start} className={token.task ? "task-list-item" : undefined}>
					{children(token.tokens as MarkedToken[], !token.loose)}
				</RevealedListItem>
			);
		case "table": {
			const lines = token.raw.split("\n");
			const starts = [range.start];
			for (const line of lines) starts.push((starts.at(-1) ?? range.start) + line.length + 1);
			const row = (cells: Tokens.TableCell[], rowIndex: number, header: boolean) => {
				const rowStart = starts[rowIndex] ?? range.start;
				const rowEnd = Math.min(starts[rowIndex + 1] ?? range.end, range.end);
				let cursor = rowStart;
				return (
					<RevealedStructure tag="tr" key={rowIndex} start={document.offset(rowStart)}>
						{cells.map((cell, index) => {
							const cellRange = locateMarkdownRaw(document, cell.text, cursor, rowEnd);
							cursor = cellRange.exact ? cellRange.end : cursor;
							const content = children(cell.tokens as MarkedToken[], true, cellRange);
							// Columns belong to this source row; appending rows must not remount them.
							const key = `${rowStart}:column:${index}`;
							return header ? (
								<th key={key} scope="col" data-align={token.align[index] ?? undefined}>
									{content}
								</th>
							) : (
								<td key={key} data-align={token.align[index] ?? undefined}>
									{content}
								</td>
							);
						})}
					</RevealedStructure>
				);
			};
			return components.table({
				sourceStart,
				sourceEnd,
				children: (
					<table>
						<thead>{row(token.header, 0, true)}</thead>
						<tbody>{token.rows.map((cells, index) => row(cells, index + 2, false))}</tbody>
					</table>
				),
			});
		}
	}
}
