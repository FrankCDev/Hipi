import { LIMITS, type Message, type Scope } from "@hipi/work-runtime/contracts";
import { useCallback, useEffect } from "react";
import { useAppClient } from "../../app/client-provider.tsx";
import { usePreferences } from "../../app/preferences.tsx";
import { Button } from "../../components/ui/button.tsx";
import { readMessagePage } from "./history-reads.ts";
import { MessageMarkdown } from "./message-markdown.tsx";
import { useBoundedRead } from "./use-bounded-read.ts";

export function MessageContent({
	message,
	scope,
	offset,
	onOffsetChange,
}: {
	message: Message;
	scope: Scope;
	offset: number | undefined;
	onOffsetChange: (offset: number | undefined) => void;
}) {
	const { t } = usePreferences();
	const opened = offset !== undefined;
	return (
		<>
			{message.truncated ? (
				<>
					<p className="small-copy">
						{t("history.preview")} ({message.text.length} / {message.textLength})
					</p>
					<div className="message-text">{message.text}</div>
					<Button size="sm" variant="outline" onClick={() => onOffsetChange(opened ? undefined : 0)}>
						{t(opened ? "common.close" : "history.readFull")}
					</Button>
					{offset !== undefined && (
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
				<MessageMarkdown source={message.text} />
			) : (
				<div className="message-text">{message.text}</div>
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
					<OriginalPageCopy
						key={`${scope.workspaceId}:${scope.conversationId}:${messageId}:${page.offset}`}
						text={page.text}
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

/** A page-keyed read owner suppresses stale clipboard feedback after navigation or unmount. */
function OriginalPageCopy({ text }: { text: string }) {
	const { t } = usePreferences();
	const write = useCallback(
		async (_input: true, _signal: AbortSignal) => {
			if (!navigator.clipboard) throw new Error("Clipboard unavailable");
			await navigator.clipboard.writeText(text);
			return true;
		},
		[text],
	);
	const copy = useBoundedRead(write);
	return (
		<>
			<Button size="sm" variant="outline" disabled={copy.loading} onClick={() => copy.load(true)}>
				{t(copy.value ? "common.copied" : "history.copyPage")}
			</Button>
			{copy.failed && <p role="alert">{t("common.copyFailed")}</p>}
		</>
	);
}
