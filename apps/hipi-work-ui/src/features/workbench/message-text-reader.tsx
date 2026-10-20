import { LIMITS, type Message, type Scope } from "@hipi/work-runtime/contracts";
import { useCallback, useEffect } from "react";
import { useAppClient } from "../../app/client-provider.tsx";
import { usePreferences } from "../../app/preferences.tsx";
import { Button } from "../../components/ui/button.tsx";
import { ClipboardCopy } from "./clipboard-copy.tsx";
import { readMessagePage } from "./history-reads.ts";
import { MessageMarkdown } from "./message-markdown.tsx";
import { useBoundedRead } from "./use-bounded-read.ts";
import { UserMessageContent } from "./user-message-content.tsx";

export function MessageContent({
	message,
	scope,
	offset,
	onOffsetChange,
	streaming,
	streamId,
}: {
	message: Message;
	scope: Scope;
	offset: number | undefined;
	onOffsetChange: (offset: number | undefined) => void;
	/** Undefined for committed content; false for a paused live preview. */
	streaming?: boolean;
	streamId?: string;
}) {
	const { t } = usePreferences();
	const opened = offset !== undefined;
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
			) : message.role === "assistant" ? (
				<MessageMarkdown source={message.text} streaming={streaming} streamId={streamId} />
			) : (
				<UserMessageContent key={message.id} source={message.text} />
			)}
		</>
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
