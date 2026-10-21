import type { Message, Scope, SearchHistoryWindow } from "@hipi/work-runtime/contracts";
import { type ReactNode, useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { useAppClient } from "../../../app/client-provider.tsx";
import { usePreferences } from "../../../app/preferences.tsx";
import { Button } from "../../../components/ui/button.tsx";
import type { DocumentSnapshot } from "./document/owner.ts";
import { messageDocumentPool } from "./document/pool.ts";
import { findDocumentSearchBlock } from "./document/search-target.ts";
import { readMessagePage } from "./history-reads.ts";
import { UserMessageContent } from "./markdown/user-message-content.tsx";
import { messageContentLabels } from "./message-content-labels.ts";
import { MessageProjection, selectionIntersects } from "./message-projection.ts";
import { OrderedAssistantBody } from "./presentation/ordered-body.tsx";

type ContentProps = {
	message: Message;
	scope: Scope;
	/** Legacy caller position props no longer drive a transport-page UI. */
	offset?: number;
	onOffsetChange?: (offset: number | undefined) => void;
	streaming?: boolean;
	streamId?: string;
	searchAnchor?: SearchHistoryWindow;
	onHydratedText?: (text: string | undefined) => void;
	renderActivities?: (contentIndexes?: readonly number[]) => ReactNode;
};

export function MessageContent(props: ContentProps) {
	const { message, scope, streaming, streamId } = props;
	const prior = useRef<
		{ identity: string; text: string; streaming: boolean; workspaceId: string; conversationId: string } | undefined
	>(undefined);
	useLayoutEffect(() => {
		if (streaming !== undefined && streamId && message.role === "assistant")
			prior.current = {
				identity: streamId,
				streaming,
				text: message.text,
				workspaceId: scope.workspaceId,
				conversationId: scope.conversationId,
			};
	}, [streaming, streamId, message.role, message.text, scope.workspaceId, scope.conversationId]);
	if (message.truncated && streaming === undefined) {
		const previous = prior.current;
		const matchingPrevious =
			previous &&
			previous.identity === streamId &&
			previous.workspaceId === scope.workspaceId &&
			previous.conversationId === scope.conversationId &&
			previous.text.startsWith(message.text) &&
			previous.text.length <= message.textLength;
		const initialSource = matchingPrevious ? previous.text : message.text;
		return (
			<RetainedMessageContent
				key={JSON.stringify([scope.workspaceId, scope.conversationId, message.id, message.textLength])}
				{...props}
				initialSource={initialSource}
				initialFromStream={!!matchingPrevious && previous.streaming}
			/>
		);
	}
	return <DocumentBody {...props} source={message.text} complete={streaming === undefined && !message.truncated} />;
}

function DocumentBody({
	message,
	source,
	complete,
	streaming,
	streamId,
	searchAnchor,
	renderActivities,
}: ContentProps & { source: string; complete: boolean }) {
	const root = useRef<HTMLDivElement>(null);
	const target = searchAnchor?.target.messageId === message.id ? searchAnchor : undefined;
	const match = target ? `${target.matchStart}:${target.matchEnd}` : undefined;
	useLayoutEffect(() => {
		if (!complete || !target || !root.current || source.length !== message.textLength) return;
		const container = root.current;
		let element: HTMLElement | undefined;
		const frame = requestAnimationFrame(() => {
			if (!container.isConnected) return;
			element = findDocumentSearchBlock(container, target.matchStart, target.matchEnd);
			element.dataset.searchMatch = "";
			// The transcript scroll owner alone may move the viewport.
			element.dispatchEvent(new Event("message-search-ready", { bubbles: true }));
		});
		return () => {
			cancelAnimationFrame(frame);
			if (element) delete element.dataset.searchMatch;
		};
	}, [complete, source, target, message.textLength]);
	return (
		<div
			ref={root}
			data-assistant-message-body={message.role === "assistant" ? "" : undefined}
			data-message-document-complete={complete}
		>
			{message.role === "assistant" ? (
				<OrderedAssistantBody
					message={message}
					source={source}
					streaming={streaming}
					streamId={streamId}
					canonical={complete}
					renderActivities={renderActivities}
					trackSourceRanges={!!target}
				/>
			) : (
				<UserMessageContent source={source} revealTarget={complete ? match : undefined} />
			)}
		</div>
	);
}

function RetainedMessageContent(props: ContentProps & { initialSource: string; initialFromStream: boolean }) {
	const { message, scope, initialSource, onHydratedText, searchAnchor } = props;
	const client = useAppClient();
	const { t, locale } = usePreferences();
	const labels = messageContentLabels(locale);
	const root = useRef<HTMLDivElement>(null);
	const retry = useRef<() => void>(() => {});
	const [state, setState] = useState<DocumentSnapshot>({
		source: initialSource,
		loadedUnits: 0,
		complete: false,
		loading: false,
		failed: false,
		pressure: false,
		limited: false,
	});
	const read = useCallback(
		(offset: number, signal: AbortSignal) =>
			readMessagePage(
				client,
				{ workspaceId: scope.workspaceId, conversationId: scope.conversationId },
				message.id,
				message.textLength,
				offset,
				signal,
			),
		[client, scope.workspaceId, scope.conversationId, message.id, message.textLength],
	);
	const search = searchAnchor?.target.messageId === message.id;
	useEffect(() => {
		const lease = messageDocumentPool(client).acquire(
			JSON.stringify([scope.workspaceId, scope.conversationId, message.id, message.textLength]),
			message.textLength,
			read,
			initialSource,
		);
		const projection = new MessageProjection(lease.getSnapshot(), setState, () =>
			selectionIntersects(root.current, document.getSelection()),
		);
		const unsubscribe = lease.subscribe(() => projection.update(lease.getSnapshot(), false));
		projection.update(lease.getSnapshot(), false);
		retry.current = lease.retry;
		const element = root.current;
		const bounds = element?.getBoundingClientRect();
		let visible = !bounds || (bounds.bottom >= -800 && bounds.top <= window.innerHeight + 800);
		const activate = () =>
			lease.setActive(
				(search || visible) &&
					document.visibilityState !== "hidden" &&
					!selectionIntersects(root.current, document.getSelection()),
				document.visibilityState === "hidden" || !(search || visible),
			);
		const selection = () => {
			projection.flush();
			activate();
		};
		const observer =
			typeof IntersectionObserver === "undefined"
				? undefined
				: new IntersectionObserver(
						(entries) => {
							for (const entry of entries) if (entry.target === element) visible = entry.isIntersecting;
							activate();
						},
						{ rootMargin: "800px" },
					);
		if (element) observer?.observe(element);
		document.addEventListener("visibilitychange", activate);
		document.addEventListener("selectionchange", selection);
		activate();
		return () => {
			retry.current = () => {};
			observer?.disconnect();
			document.removeEventListener("visibilitychange", activate);
			document.removeEventListener("selectionchange", selection);
			unsubscribe();
			projection.dispose();
			lease.release();
		};
	}, [client, read, scope.workspaceId, scope.conversationId, message.id, message.textLength, initialSource, search]);
	useEffect(() => {
		onHydratedText?.(state.complete ? state.source : undefined);
		return () => onHydratedText?.(undefined);
	}, [state.complete, state.source, onHydratedText]);
	return (
		<div ref={root} aria-busy={!state.complete && state.loading}>
			<DocumentBody
				{...props}
				source={state.source}
				complete={state.complete}
				streaming={
					props.initialFromStream && !state.complete && state.loadedUnits < initialSource.length ? true : undefined
				}
			/>
			{state.failed && (
				<div className="message-document-error" data-markdown-copy="exclude">
					<span role="alert">{labels.unavailable}</span>
					<Button size="sm" variant="ghost" onClick={() => retry.current()}>
						{t("history.retry")}
					</Button>
				</div>
			)}
			{state.pressure && (
				<output className="small-copy" data-markdown-copy="exclude">
					{state.limited ? labels.limit : labels.capacity}
				</output>
			)}
			{state.loading && (
				<output className="sr-only" data-markdown-copy="exclude">
					{labels.loading}
				</output>
			)}
		</div>
	);
}
