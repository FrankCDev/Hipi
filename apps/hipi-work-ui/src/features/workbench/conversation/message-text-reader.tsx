import {
	LIMITS,
	type Message,
	type MessageTextChunk,
	type Scope,
	type SearchHistoryWindow,
} from "@hipi/work-runtime/contracts";
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { useAppClient } from "../../../app/client-provider.tsx";
import { usePreferences } from "../../../app/preferences.tsx";
import { Button } from "../../../components/ui/button.tsx";
import { SearchHighlight } from "../search/highlight.tsx";
import { conversationSearchLabels } from "../search/labels.ts";
import { useBoundedRead } from "../use-bounded-read.ts";
import { readMessagePage } from "./history-reads.ts";
import { ClipboardCopy } from "./markdown/clipboard-copy.tsx";
import { MessageMarkdown } from "./markdown/markdown.tsx";
import { UserMessageContent } from "./markdown/user-message-content.tsx";
import { messageContentLabels } from "./message-content-labels.ts";
import { MessageProjection, selectionIntersects } from "./message-projection.ts";

export function MessageContent({
	message,
	scope,
	offset,
	onOffsetChange,
	streaming,
	streamId,
	searchAnchor,
	onHydratedText,
}: {
	message: Message;
	scope: Scope;
	offset: number | undefined;
	onOffsetChange: (offset: number | undefined) => void;
	/** Undefined for committed content; false for a paused live preview. */
	streaming?: boolean;
	streamId?: string;
	searchAnchor?: SearchHistoryWindow;
	/** Complete, displayed first-page text only; never a truncated preview or later page. */
	onHydratedText?: (text: string | undefined) => void;
}) {
	const { t, locale } = usePreferences();
	const opened = offset !== undefined;
	const prior = useRef<{ identity: string; text: string; workspaceId: string; conversationId: string } | undefined>(
		undefined,
	);
	useLayoutEffect(() => {
		if (streaming !== undefined && streamId && message.role === "assistant")
			prior.current = {
				identity: streamId,
				text: message.text,
				workspaceId: scope.workspaceId,
				conversationId: scope.conversationId,
			};
	}, [streaming, streamId, message.role, message.text, scope.workspaceId, scope.conversationId]);
	if (searchAnchor?.target.messageId === message.id) {
		const { target, matchStart, matchEnd } = searchAnchor;
		return (
			<div className="original-text search-match-original">
				<p className="small-copy">{conversationSearchLabels(locale).match}</p>
				<p className="small-copy">
					{t("history.units")} {target.offset}–{target.offset + target.text.length} / {target.textLength}
				</p>
				<pre className="search-match-text">
					<SearchHighlight text={target.text} offset={target.offset} start={matchStart} end={matchEnd} />
				</pre>
				<ClipboardCopy text={target.text} label={t("history.copyPage")} variant="outline" />
			</div>
		);
	}
	if (message.role === "assistant") {
		if (message.truncated && streaming === undefined)
			return (
				<RetainedAssistantContent
					key={JSON.stringify([scope.workspaceId, scope.conversationId, message.id, message.textLength])}
					message={message}
					scope={scope}
					offset={offset}
					onOffsetChange={onOffsetChange}
					onHydratedText={onHydratedText}
					streamId={streamId}
					initialSource={
						prior.current &&
						prior.current.identity === streamId &&
						prior.current.workspaceId === scope.workspaceId &&
						prior.current.conversationId === scope.conversationId &&
						prior.current.text.startsWith(message.text) &&
						prior.current.text.length <= message.textLength
							? prior.current.text
							: message.text
					}
				/>
			);
		return <MessageMarkdown source={message.text} streaming={streaming} streamId={streamId} />;
	}
	return (
		<>
			{message.truncated ? (
				<>
					<p className="small-copy">
						{t(streaming === undefined ? "history.preview" : "history.partialPreview")} ({message.text.length} /{" "}
						{message.textLength})
					</p>
					<div className="message-text">{message.text}</div>
					{streaming === undefined && (
						<Button size="sm" variant="outline" onClick={() => onOffsetChange(opened ? undefined : 0)}>
							{t(opened ? "common.close" : "history.readFull")}
						</Button>
					)}
					{streaming === undefined && offset !== undefined && (
						<MessageTextReader
							scope={scope}
							messageId={message.id}
							textLength={message.textLength}
							offset={offset}
							onOffsetChange={onOffsetChange}
						/>
					)}
				</>
			) : (
				<UserMessageContent key={message.id} source={message.text} />
			)}
		</>
	);
}

/** One mounted committed assistant reads one bounded first page, never the whole history. */
function RetainedAssistantContent({
	message,
	scope,
	offset,
	onOffsetChange,
	streamId,
	initialSource,
	onHydratedText,
}: {
	message: Message;
	scope: Scope;
	offset?: number;
	onOffsetChange: (offset: number | undefined) => void;
	streamId?: string;
	initialSource: string;
	onHydratedText?: (text: string | undefined) => void;
}) {
	const client = useAppClient();
	const { t, locale } = usePreferences();
	const labels = messageContentLabels(locale);
	const root = useRef<HTMLDivElement>(null);
	const projection = useRef<MessageProjection<MessageTextChunk | undefined> | null>(null);
	const [page, setPage] = useState<MessageTextChunk>();
	const read = useCallback(
		(start: number, signal: AbortSignal) =>
			readMessagePage(
				client,
				{ workspaceId: scope.workspaceId, conversationId: scope.conversationId },
				message.id,
				message.textLength,
				start,
				signal,
			),
		[client, scope.workspaceId, scope.conversationId, message.id, message.textLength],
	);
	const reader = useBoundedRead(read, 0);
	useEffect(() => {
		const owner = new MessageProjection<MessageTextChunk | undefined>(undefined, setPage, () =>
			selectionIntersects(root.current, document.getSelection()),
		);
		projection.current = owner;
		const flush = () => owner.flush();
		document.addEventListener("selectionchange", flush);
		return () => {
			owner.dispose();
			projection.current = null;
			document.removeEventListener("selectionchange", flush);
		};
	}, []);
	useEffect(() => {
		projection.current?.update(reader.value, false);
	}, [reader.value]);
	useEffect(() => {
		onHydratedText?.(
			page?.offset === 0 && page.nextOffset === null && page.text.length === message.textLength ? page.text : undefined,
		);
		return () => onHydratedText?.(undefined);
	}, [page, message.textLength, onHydratedText]);
	return (
		<div ref={root} data-assistant-message-body="">
			<MessageMarkdown source={page?.text ?? initialSource} streamId={streamId} />
			{reader.failed && (
				<div className="original-pages">
					<span role="alert">{labels.unavailable}</span>
					<Button size="sm" variant="ghost" onClick={reader.retry}>
						{t("history.retry")}
					</Button>
				</div>
			)}
			{reader.loading && (
				<Button size="sm" variant="ghost" onClick={reader.cancel}>
					{labels.cancel}
				</Button>
			)}
			{!page && !reader.loading && !reader.failed && (
				<Button size="sm" variant="ghost" onClick={reader.retry}>
					{labels.continue}
				</Button>
			)}
			{page?.nextOffset !== null && page?.nextOffset !== undefined && (
				<div className="original-pages">
					<span>{labels.long}</span>
					<Button
						size="sm"
						variant="ghost"
						onClick={() => onOffsetChange(offset === undefined ? (page.nextOffset ?? 0) : undefined)}
					>
						{offset === undefined ? labels.continue : t("common.close")}
					</Button>
				</div>
			)}
			{offset !== undefined && (
				<MessageTextReader
					scope={scope}
					messageId={message.id}
					textLength={message.textLength}
					offset={offset}
					onOffsetChange={onOffsetChange}
				/>
			)}
		</div>
	);
}

export function MessageTextReader({
	scope,
	messageId,
	textLength,
	offset,
	onOffsetChange,
}: {
	scope: Scope;
	messageId: string;
	textLength: number;
	offset: number;
	onOffsetChange: (offset: number) => void;
}) {
	const client = useAppClient();
	const { t } = usePreferences();
	const read = useCallback(
		(offset: number, signal: AbortSignal) =>
			readMessagePage(
				client,
				{ workspaceId: scope.workspaceId, conversationId: scope.conversationId },
				messageId,
				textLength,
				offset,
				signal,
			),
		[client, scope.workspaceId, scope.conversationId, messageId, textLength],
	);
	const reader = useBoundedRead(read);
	useEffect(() => {
		reader.load(offset);
	}, [reader.load, offset]);
	const page = reader.value;
	return (
		<div className="original-text">
			<p className="small-copy">{t("history.originalPages")}</p>
			{page && (
				<>
					<p className="small-copy">
						{t("history.units")} {page.offset}–{page.offset + page.text.length} / {page.textLength}
					</p>
					<pre className="message-text">{page.text}</pre>
					<ClipboardCopy
						key={`${scope.workspaceId}:${scope.conversationId}:${messageId}:${page.offset}`}
						text={page.text}
						label={t("history.copyPage")}
						variant="outline"
					/>
				</>
			)}
			<div className="original-pages">
				{page && page.offset > 0 && (
					<Button
						size="sm"
						variant="outline"
						disabled={reader.loading}
						onClick={() => {
							onOffsetChange(Math.max(0, page.offset - LIMITS.textChunk));
						}}
					>
						{t("markdown.previous")}
					</Button>
				)}
				<Button
					size="sm"
					variant="outline"
					disabled={reader.loading}
					onClick={() => {
						if (offset === 0) reader.load(0);
						else onOffsetChange(0);
					}}
				>
					{t("history.firstPage")}
				</Button>
				{page?.nextOffset !== null && page?.nextOffset !== undefined && (
					<Button
						size="sm"
						variant="outline"
						disabled={reader.loading}
						onClick={() => {
							if (page.nextOffset !== null) onOffsetChange(page.nextOffset);
						}}
					>
						{t("markdown.next")}
					</Button>
				)}
				{reader.loading && (
					<Button size="sm" variant="outline" onClick={reader.cancel}>
						{t("common.cancel")}
					</Button>
				)}
				{reader.failed && (
					<>
						<p role="alert">{t("work.error")}</p>
						<Button size="sm" variant="outline" onClick={reader.retry}>
							{t("history.retry")}
						</Button>
					</>
				)}
			</div>
			{reader.loading && <output>{t("common.loading")}</output>}
		</div>
	);
}
