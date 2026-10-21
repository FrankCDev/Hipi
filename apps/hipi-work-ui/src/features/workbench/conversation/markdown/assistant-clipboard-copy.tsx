import { type RefObject, useCallback } from "react";
import { assistantCopyPayload } from "./assistant-copy-payload.ts";
import { ClipboardCopy, type ClipboardCopyProps } from "./clipboard-copy.tsx";
import { writeClipboardPayload } from "./clipboard-writer.ts";

export function AssistantClipboardCopy({
	article,
	...props
}: Omit<ClipboardCopyProps, "write"> & { article: RefObject<HTMLElement | null> }) {
	const write = useCallback(
		async (source: string, signal?: AbortSignal) => {
			const root =
				article.current?.querySelector<HTMLElement>(
					':scope > .message-content > [data-assistant-public-body], :scope > .message-content > [data-assistant-message-body] > [data-assistant-public-body], :scope > .message-content > .markdown-body[data-markdown-tone="assistant"], :scope > .message-content > [data-assistant-message-body] > .markdown-body[data-markdown-tone="assistant"]',
				) ?? null;
			await writeClipboardPayload(assistantCopyPayload(root, source), signal);
		},
		[article],
	);
	return <ClipboardCopy {...props} write={write} />;
}
