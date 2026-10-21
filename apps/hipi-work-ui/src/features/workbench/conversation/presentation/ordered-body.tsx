import { type Message, parseMessagePublicBlocks } from "@hipi/work-runtime/contracts";
import type { ReactNode } from "react";
import { MessageMarkdown } from "../markdown/markdown.tsx";
import "./ordered-body.css";

/** Ordering is presentation of one canonical source, never a new text or tool reader. */
export function OrderedAssistantBody({
	message,
	source,
	streaming,
	streamId,
	canonical,
	renderActivities,
	trackSourceRanges,
}: {
	message: Message;
	source: string;
	streaming?: boolean;
	streamId?: string;
	canonical: boolean;
	renderActivities?: (contentIndexes?: readonly number[]) => ReactNode;
	trackSourceRanges?: boolean;
}) {
	let blocks: Message["publicBlocks"];
	if (canonical && source.length === message.textLength && !message.publicBlocks?.omitted && message.publicBlocks) {
		try {
			blocks = parseMessagePublicBlocks(message.publicBlocks, {
				text: source,
				textLength: message.textLength,
				toolCalls: message.toolCalls,
			});
		} catch {
			/* A malformed optional ordering fact cannot hide readable canonical text. */
		}
	}
	if (!blocks || !renderActivities)
		return (
			<>
				<MessageMarkdown
					source={source}
					streaming={streaming}
					streamId={streamId}
					trackSourceRanges={trackSourceRanges}
				/>
				{renderActivities?.()}
			</>
		);
	const groups: (
		| { kind: "text"; contentIndex: number; start: number; end: number }
		| { kind: "tools"; contentIndexes: number[] }
	)[] = [];
	for (const block of blocks.items) {
		// Empty public text is a valid ordering fact, not a visual item or a
		// boundary between tools. Preserve canonical offsets without a gap node.
		if (block.kind === "text" && block.start === block.end) continue;
		if (block.kind === "text") groups.push(block);
		else {
			const previous = groups.at(-1);
			if (previous?.kind === "tools") previous.contentIndexes.push(block.contentIndex);
			else groups.push({ kind: "tools", contentIndexes: [block.contentIndex] });
		}
	}
	return (
		<div data-assistant-public-body="" className="assistant-public-body">
			{groups.map((block) =>
				block.kind === "text" ? (
					<MessageMarkdown
						key={block.contentIndex}
						source={source.slice(block.start, block.end)}
						trackSourceRanges={trackSourceRanges}
						sourceOffset={block.start}
					/>
				) : (
					<div key={block.contentIndexes[0]} data-markdown-copy="exclude">
						{renderActivities(block.contentIndexes)}
					</div>
				),
			)}
		</div>
	);
}
