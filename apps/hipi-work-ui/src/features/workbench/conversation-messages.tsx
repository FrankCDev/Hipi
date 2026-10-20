import type { Message, Snapshot } from "@hipi/work-runtime/contracts";
import { type Range, useVirtualizer } from "@tanstack/react-virtual";
import { type ReactNode, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { usePreferences } from "../../app/preferences.tsx";
import { BrandMark } from "../../components/brand-mark.tsx";
import { Button } from "../../components/ui/button.tsx";
import { Icon } from "../../components/ui/icon.tsx";
import { MessageMarkdown } from "./message-markdown.tsx";
import { MessageMeasurementPolicy } from "./message-measurement-policy.ts";
import { MessageProjection, selectionIntersects } from "./message-projection.ts";
import { MessageContent } from "./message-text-reader.tsx";
import { virtualMessageRange } from "./virtual-message-range.ts";

export const HISTORY_LOAD_THRESHOLD = 240;
const STREAM_ROW_KEY = "partial-output";

type MessageRow = { key: string; message: Message } | { key: typeof STREAM_ROW_KEY; message?: never };

export function ConversationMessages({
	snapshot: incoming,
	error,
	onNearTop,
	historyStatus,
}: {
	snapshot: Snapshot | undefined;
	error: boolean;
	onNearTop: (nearTop: boolean) => void;
	historyStatus?: ReactNode;
}) {
	const { t } = usePreferences();
	const messages = useRef<HTMLElement>(null);
	const [measurementPolicy] = useState(
		() => new MessageMeasurementPolicy(() => selectionIntersects(messages.current, document.getSelection())),
	);
	const [snapshot, setSnapshot] = useState(incoming);
	const projection = useRef<MessageProjection<Snapshot | undefined> | null>(null);
	const [following, setFollowing] = useState(true);
	const [displayPaused, setDisplayPaused] = useState(false);
	const [selectionRange, setSelectionRange] = useState<number[] | null>(null);
	const [selectionEndpoints, setSelectionEndpoints] = useState<number[]>([]);
	const [focusedKey, setFocusedKey] = useState<string>();
	// Only small reading positions survive row eviction; full text chunks belong to mounted readers.
	const [originalOffsets, setOriginalOffsets] = useState<ReadonlyMap<string, number>>(new Map());
	const initialized = useRef(false);
	const published = useRef(incoming);
	const followFinal = useRef(false);
	const rows = useMemo(() => {
		const result: MessageRow[] = snapshot?.messages.map((message) => ({ key: `message:${message.id}`, message })) ?? [];
		if (snapshot?.partial || snapshot?.running) result.push({ key: STREAM_ROW_KEY });
		return result;
	}, [snapshot]);
	const getItemKey = useCallback((index: number) => rows[index]?.key ?? `missing:${index}`, [rows]);
	const rangeExtractor = useCallback(
		(range: Range) =>
			virtualMessageRange(
				range,
				selectionRange,
				selectionEndpoints,
				rows.findIndex((row) => row.key === focusedKey),
			),
		[rows, focusedKey, selectionRange, selectionEndpoints],
	);
	const virtualizer = useVirtualizer<HTMLElement, HTMLDivElement>({
		count: rows.length,
		getScrollElement: () => messages.current,
		estimateSize: () => 160,
		measureElement: measurementPolicy.measureElement,
		getItemKey,
		rangeExtractor,
		anchorTo: selectionRange ? "start" : "end",
		followOnAppend: selectionRange === null,
		scrollEndThreshold: 64,
		overscan: 5,
		onChange: (instance) => setFollowing(instance.isAtEnd()),
	});
	const renderedIndexes = useRef<number[]>([]);
	useLayoutEffect(() => {
		measurementPolicy.synchronize(virtualizer);
	});
	useLayoutEffect(() => () => measurementPolicy.clear(), [measurementPolicy]);
	useLayoutEffect(() => {
		renderedIndexes.current = virtualizer.getVirtualIndexes();
	});
	useLayoutEffect(() => {
		const controller = new MessageProjection<Snapshot | undefined>(
			undefined,
			(value) => {
				// A final replaces the stream row without necessarily increasing row count.
				// Capture bottom intent before new estimates can move it beyond the threshold.
				followFinal.current = !!published.current?.running && !value?.running && virtualizer.isAtEnd();
				published.current = value;
				setSnapshot(value);
			},
			() => selectionIntersects(messages.current, document.getSelection()),
			setDisplayPaused,
		);
		projection.current = controller;
		const selectionChanged = () => {
			const selection = document.getSelection();
			const selected = selectionIntersects(messages.current, selection);
			setSelectionRange((current) => (selected ? (current ?? renderedIndexes.current) : null));
			const endpoints =
				selected && selection
					? [selection.anchorNode, selection.focusNode].flatMap((node) => {
							const element = node instanceof Element ? node : node?.parentElement;
							const row = element?.closest<HTMLElement>("[data-message-key]");
							if (!row || !messages.current?.contains(row)) return [];
							const index = Number(row.dataset.index);
							return Number.isInteger(index) ? [index] : [];
						})
					: [];
			setSelectionEndpoints(endpoints);
			if (selected) virtualizer.cancelScroll();
			controller.flush();
		};
		document.addEventListener("selectionchange", selectionChanged);
		return () => {
			controller.dispose();
			projection.current = null;
			document.removeEventListener("selectionchange", selectionChanged);
		};
	}, [virtualizer]);
	useLayoutEffect(() => {
		projection.current?.update(incoming, incoming?.running ?? false);
	}, [incoming]);
	useLayoutEffect(() => {
		if (!snapshot || (initialized.current && !followFinal.current)) return;
		initialized.current = true;
		followFinal.current = false;
		virtualizer.scrollToEnd();
	}, [snapshot, virtualizer]);
	// Re-evaluate after prepend anchoring and dynamic measurement, rather than draining
	// history from the old scroll offset before React has committed the new page.
	useEffect(() => {
		if (!snapshot) return;
		const frame = requestAnimationFrame(() => {
			const node = messages.current;
			onNearTop(!!node && !selectionRange && node.scrollTop <= HISTORY_LOAD_THRESHOLD);
		});
		return () => cancelAnimationFrame(frame);
	}, [snapshot, selectionRange, onNearTop]);
	useEffect(() => {
		const node = messages.current;
		if (!node) return;
		let frame: number | undefined;
		const observer = new ResizeObserver(() => {
			if (frame !== undefined) cancelAnimationFrame(frame);
			frame = requestAnimationFrame(() => {
				frame = undefined;
				onNearTop(
					initialized.current &&
						!selectionIntersects(node, document.getSelection()) &&
						node.scrollTop <= HISTORY_LOAD_THRESHOLD,
				);
			});
		});
		observer.observe(node);
		return () => {
			observer.disconnect();
			if (frame !== undefined) cancelAnimationFrame(frame);
		};
	}, [onNearTop]);
	return (
		<div className="message-stage">
			<section
				className="message-scroll"
				ref={messages}
				// biome-ignore lint/a11y/noNoninteractiveTabindex: The scroll region must support keyboard scrolling.
				tabIndex={0}
				aria-label={t("nav.conversations")}
				onScroll={(event) => {
					if (!initialized.current) return;
					const node = event.currentTarget;
					onNearTop(
						!selectionIntersects(node, document.getSelection()) &&
							node.scrollTop >= 0 &&
							node.scrollTop <= HISTORY_LOAD_THRESHOLD,
					);
				}}
				onFocusCapture={(event) => {
					const row = event.target.closest<HTMLElement>("[data-message-key]");
					setFocusedKey(row?.dataset.messageKey);
				}}
				onBlurCapture={(event) => {
					if (!event.currentTarget.contains(event.relatedTarget)) setFocusedKey(undefined);
				}}
			>
				{!snapshot && <output className="empty-copy">{t(error ? "work.error" : "common.loading")}</output>}
				{snapshot && rows.length === 0 && !snapshot.historyCursor && (
					<div className="conversation-empty">
						<div className="conversation-empty-mark" aria-hidden="true">
							<BrandMark size={40} />
						</div>
						<h2>{t("work.readyTitle")}</h2>
						<p>{t("work.readyBody")}</p>
					</div>
				)}
				<div className="message-stack virtual-message-stack" style={{ height: virtualizer.getTotalSize() }}>
					{snapshot &&
						virtualizer.getVirtualItems().map((item) => {
							const row = rows[item.index];
							if (!row) return null;
							return (
								<div
									key={row.key}
									ref={virtualizer.measureElement}
									data-index={item.index}
									data-message-key={row.key}
									className="virtual-message-row"
									style={{ transform: `translateY(${item.start}px)` }}
								>
									{row.message ? (
										<article className={`message message-${row.message.role}`}>
											<div className="message-avatar" aria-hidden="true">
												{row.message.role === "assistant" ? <BrandMark size={26} /> : <Icon name="chat" size={16} />}
											</div>
											<div className="message-content">
												<div className="message-author">
													{t(row.message.role === "user" ? "work.you" : "work.assistant")}
													{row.message.interrupted && <span className="status-pill">{t("work.interrupted")}</span>}
												</div>
												<MessageContent
													message={row.message}
													scope={snapshot}
													offset={originalOffsets.get(row.key)}
													onOffsetChange={(offset) => {
														setOriginalOffsets((current) => {
															const next = new Map(current);
															if (offset === undefined) next.delete(row.key);
															else next.set(row.key, offset);
															return next;
														});
													}}
												/>
											</div>
										</article>
									) : (
										<StreamingMessage snapshot={snapshot} />
									)}
								</div>
							);
						})}
				</div>
			</section>
			{historyStatus}
			{displayPaused && <output className="message-pending small-copy">{t("markdown.pending")}</output>}
			{!following && (
				<Button
					className="jump-latest bg-popover rounded-full"
					variant="outline"
					size="sm"
					disabled={selectionRange !== null}
					onClick={() => virtualizer.scrollToEnd()}
				>
					<Icon name="arrowDown" size={16} />
					{t("work.jumpLatest")}
				</Button>
			)}
		</div>
	);
}

export function StreamingMessage({ snapshot }: { snapshot: Snapshot }) {
	const { t } = usePreferences();
	return (
		<>
			{snapshot.partial && (
				<article className="message message-assistant" aria-busy={snapshot.running}>
					<div className="message-avatar" aria-hidden="true">
						<BrandMark size={26} />
					</div>
					<div className="message-content">
						<div className="message-author">
							{t("work.assistant")}
							{snapshot.running && <span className="stream-indicator" aria-hidden="true" />}
						</div>
						{snapshot.partialTruncated ? (
							<>
								<p className="small-copy">
									{t("history.partialPreview")} ({snapshot.partial.length} / {snapshot.partialLength})
								</p>
								<div className="message-text">{snapshot.partial}</div>
							</>
						) : (
							<MessageMarkdown source={snapshot.partial} streaming={snapshot.running} />
						)}
					</div>
				</article>
			)}
			{snapshot.running && (
				<output className="stream-status">
					<span className="stream-indicator" aria-hidden="true" />
					{t("work.generating")}
				</output>
			)}
		</>
	);
}
