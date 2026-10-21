import type { Message, Scope, SearchHistoryWindow, Snapshot } from "@hipi/work-runtime/contracts";
import { type Range, useVirtualizer } from "@tanstack/react-virtual";
import {
	type CSSProperties,
	memo,
	type ReactNode,
	type RefObject,
	useCallback,
	useEffect,
	useLayoutEffect,
	useMemo,
	useRef,
	useState,
} from "react";
import { usePreferences } from "../../../app/preferences.tsx";
import { BrandMark } from "../../../components/brand-mark.tsx";
import { ActionTooltip } from "../../../components/ui/action-tooltip.tsx";
import { Button } from "../../../components/ui/button.tsx";
import { Icon } from "../../../components/ui/icon.tsx";
import { InlineApproval } from "../../agent-permissions/inline-approval.tsx";
import {
	InlineLiveActivities,
	InlineMessageActivities,
	useActivityTranscriptProjection,
} from "../../tool-activities/activity-transcript.tsx";
import type { ConversationFailure } from "./failure.ts";
import { AssistantClipboardCopy } from "./markdown/assistant-clipboard-copy.tsx";
import { ClipboardCopy } from "./markdown/clipboard-copy.tsx";
import { MessageMeasurementPolicy } from "./message-measurement-policy.ts";
import { MessageProjection, prefersReducedMotion, selectionIntersects } from "./message-projection.ts";
import { MessageContent } from "./message-text-reader.tsx";
import { ConversationReadingPositions } from "./reading-position.ts";
import { ResponseAnnouncement } from "./response-announcement.tsx";
import { responsePhase } from "./response-phase.ts";
import { ResponseStatus } from "./response-status.tsx";
import {
	bindDisclosureAnchoring,
	CONVERSATION_END_THRESHOLD,
	CONVERSATION_HISTORY_THRESHOLD,
	ConversationScrollIntent,
	isScrollbarPointer,
	nativeScrollDirection,
	TOUCH_INTENT_THRESHOLD,
} from "./scroll-intent.ts";
import { projectTranscript, TRANSCRIPT_OVERSCAN, type TranscriptRow, transcriptEstimate } from "./transcript.ts";
import { ConversationTurnFailure } from "./turn-failure.tsx";
import { useMessageCopyText } from "./use-message-copy-text.ts";
import { virtualMessageRange } from "./virtual-message-range.ts";
import "./conversation-block-spacing.css";

export const HISTORY_LOAD_THRESHOLD = CONVERSATION_HISTORY_THRESHOLD;
type DisplaySnapshot = Snapshot & { requestFailure?: ConversationFailure };

export function ConversationMessages({
	snapshot: sourceSnapshot,
	responseActive,
	error,
	onNearTop,
	historyStatus,
	scope,
	footerRef,
	readingPositions,
	failure,
	onOpenModelSettings,
	searchAnchor,
	onJumpLatest,
}: {
	snapshot: Snapshot | undefined;
	responseActive?: boolean;
	error: boolean;
	onNearTop: (nearTop: boolean) => void;
	historyStatus?: ReactNode;
	scope?: Scope;
	footerRef?: RefObject<HTMLElement | null>;
	readingPositions?: ConversationReadingPositions;
	failure?: ConversationFailure;
	onOpenModelSettings?: (returnFocus: HTMLElement) => void;
	searchAnchor?: SearchHistoryWindow;
	onJumpLatest?: () => void;
}) {
	const { t } = usePreferences();
	const incoming: DisplaySnapshot | undefined = useMemo(
		() => sourceSnapshot && { ...sourceSnapshot, requestFailure: failure },
		[sourceSnapshot, failure],
	);
	const messages = useRef<HTMLElement>(null);
	const scrollIntent = useRef<ConversationScrollIntent | null>(null);
	const [measurementPolicy] = useState(
		() =>
			new MessageMeasurementPolicy(
				() => !!scrollIntent.current?.holdingHeader || selectionIntersects(messages.current, document.getSelection()),
			),
	);
	const [snapshot, setSnapshot] = useState(incoming);
	useActivityTranscriptProjection(snapshot, responseActive !== false && !!snapshot?.running);
	const [positions] = useState(() => readingPositions ?? new ConversationReadingPositions());
	const [savedPosition] = useState(() => {
		const boundScope = scope ?? incoming;
		return boundScope && !searchAnchor ? positions.read(boundScope) : undefined;
	});
	const pendingRestore = useRef(savedPosition?.following === false ? savedPosition : undefined);
	const restorationFrames = useRef<number[]>([]);
	const interruptReading = useRef<(direction: number) => void>(() => {});
	const projection = useRef<MessageProjection<DisplaySnapshot | undefined> | null>(null);
	const [nearEnd, setNearEnd] = useState(true);
	const [followIntent, setFollowIntent] = useState(searchAnchor ? false : (savedPosition?.following ?? true));
	const [initialSearchAnchor] = useState(searchAnchor);
	const [footerHeight, setFooterHeight] = useState(0);
	const [displayPaused, setDisplayPaused] = useState(false);
	const [selectionRange, setSelectionRange] = useState<number[] | null>(null);
	const [selectionEndpoints, setSelectionEndpoints] = useState<number[]>([]);
	const [focusedKey, setFocusedKey] = useState<string>();
	// Only small reading positions survive row eviction; full text chunks belong to mounted readers.
	const [originalOffsets, setOriginalOffsets] = useState<ReadonlyMap<string, number>>(new Map());
	const initialized = useRef(false);
	const published = useRef(incoming);
	const followFinal = useRef(false);
	const previousRows = useRef<readonly TranscriptRow[]>([]);
	const rows = useMemo(() => projectTranscript(snapshot, previousRows.current, snapshot?.requestFailure), [snapshot]);
	useLayoutEffect(() => {
		previousRows.current = rows;
	}, [rows]);
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
		estimateSize: (index) => savedPosition?.heights.get(rows[index]?.key ?? "") ?? transcriptEstimate(rows[index]),
		measureElement: measurementPolicy.measureElement,
		getItemKey,
		rangeExtractor,
		anchorTo: selectionRange ? "start" : "end",
		followOnAppend: !searchAnchor && followIntent && selectionRange === null,
		// Core also follows size changes when anchorTo=end. A negative threshold
		// disables that path without disabling stable-key prepend anchoring.
		scrollEndThreshold: !searchAnchor && followIntent && selectionRange === null ? CONVERSATION_END_THRESHOLD : -1,
		overscan: TRANSCRIPT_OVERSCAN,
		// CSS spacing belongs to each measured row, so theme changes and reflow
		// use the same measurement/scroll compensation as message content.
		gap: 0,
		paddingEnd: footerRef ? footerHeight + 16 : 32,
		onChange: (instance) => {
			setNearEnd(instance.isAtEnd(CONVERSATION_END_THRESHOLD));
		},
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
		const node = messages.current;
		if (!node) return;
		const controller = new ConversationScrollIntent({
			offset: () => node.scrollTop,
			end: () => Math.max(0, node.scrollHeight - node.clientHeight),
			move: (offset) => virtualizer.scrollToOffset(offset, { behavior: "auto" }),
			finish: () => {
				virtualizer.scrollToEnd();
				const active = document.activeElement;
				if (active?.matches(".jump-latest") && node.parentElement?.contains(active))
					node.focus({ preventScroll: true });
			},
			cancel: () => virtualizer.cancelScroll(),
			follow: (following) => {
				const follow = following && !initialSearchAnchor;
				setFollowIntent(follow);
				// Stop growth immediately, even before React processes this gesture.
				virtualizer.setOptions({
					...virtualizer.options,
					followOnAppend: follow,
					scrollEndThreshold: follow ? CONVERSATION_END_THRESHOLD : -1,
				});
			},
			nearEnd: setNearEnd,
			reducedMotion: () => {
				const preference = document.documentElement.dataset.reducedMotion;
				return preference ? preference === "on" : window.matchMedia("(prefers-reduced-motion: reduce)").matches;
			},
			frame: (callback) => requestAnimationFrame(callback),
			cancelFrame: (frame) => cancelAnimationFrame(frame),
			now: () => performance.now(),
		});
		controller.setFollow(initialSearchAnchor ? false : (savedPosition?.following ?? true));
		scrollIntent.current = controller;
		const unbindDisclosure = bindDisclosureAnchoring(node, controller, () =>
			selectionIntersects(node, document.getSelection()),
		);
		const intent = (direction: number) => {
			pendingRestore.current = undefined;
			for (const frame of restorationFrames.current) cancelAnimationFrame(frame);
			restorationFrames.current = [];
			initialized.current = true;
			followFinal.current = false;
			controller.userIntent(direction);
		};
		interruptReading.current = intent;
		const wheel = (event: WheelEvent) => {
			if (event.deltaY && Math.abs(event.deltaY) >= Math.abs(event.deltaX)) intent(event.deltaY);
		};
		const keyboard = (event: KeyboardEvent) => {
			const interactive =
				event.target instanceof Element &&
				!!event.target.closest(
					"input, textarea, select, button, a, summary, [contenteditable]:not([contenteditable='false']), [role='textbox'], [role='combobox'], [role='slider'], [role='listbox']",
				);
			const direction = nativeScrollDirection(event, interactive);
			if (direction !== null) intent(direction);
		};
		let touchY: number | undefined;
		const touchStart = (event: TouchEvent) => {
			touchY = event.touches[0]?.clientY;
		};
		const touchMove = (event: TouchEvent) => {
			const y = event.touches[0]?.clientY;
			if (y !== undefined && touchY !== undefined && Math.abs(y - touchY) >= TOUCH_INTENT_THRESHOLD) {
				intent(touchY - y);
				touchY = y;
			}
		};
		let scrollbarY: number | undefined;
		const pointerDown = (event: PointerEvent) => {
			if (
				event.target !== node ||
				!isScrollbarPointer(event.clientX, node.getBoundingClientRect(), node.clientLeft, node.clientWidth)
			)
				return;
			scrollbarY = event.clientY;
			intent(0);
		};
		const pointerMove = (event: PointerEvent) => {
			if (scrollbarY === undefined) return;
			intent(event.clientY - scrollbarY);
			scrollbarY = event.clientY;
		};
		const pointerUp = () => {
			scrollbarY = undefined;
		};
		node.addEventListener("wheel", wheel, { passive: true });
		node.addEventListener("keydown", keyboard);
		node.addEventListener("touchstart", touchStart, { passive: true });
		node.addEventListener("touchmove", touchMove, { passive: true });
		node.addEventListener("pointerdown", pointerDown);
		window.addEventListener("pointermove", pointerMove, { passive: true });
		window.addEventListener("pointerup", pointerUp);
		window.addEventListener("pointercancel", pointerUp);
		return () => {
			interruptReading.current = () => {};
			unbindDisclosure();
			controller.dispose();
			scrollIntent.current = null;
			for (const frame of restorationFrames.current) cancelAnimationFrame(frame);
			restorationFrames.current = [];
			if (initialSearchAnchor) initialized.current = false;
			node.removeEventListener("wheel", wheel);
			node.removeEventListener("keydown", keyboard);
			node.removeEventListener("touchstart", touchStart);
			node.removeEventListener("touchmove", touchMove);
			node.removeEventListener("pointerdown", pointerDown);
			window.removeEventListener("pointermove", pointerMove);
			window.removeEventListener("pointerup", pointerUp);
			window.removeEventListener("pointercancel", pointerUp);
		};
	}, [savedPosition, virtualizer, initialSearchAnchor]);
	useEffect(() => {
		const footer = footerRef?.current;
		if (!footer) return;
		let frame: number | undefined;
		const measure = () => {
			const following =
				!initialSearchAnchor &&
				scrollIntent.current?.follows &&
				!selectionIntersects(messages.current, document.getSelection());
			setFooterHeight(footer.getBoundingClientRect().height);
			if (following) {
				if (frame !== undefined) cancelAnimationFrame(frame);
				frame = requestAnimationFrame(() => {
					frame = undefined;
					if (!initialSearchAnchor && scrollIntent.current?.follows) virtualizer.scrollToEnd();
				});
			}
		};
		measure();
		const observer = new ResizeObserver(measure);
		observer.observe(footer);
		return () => {
			observer.disconnect();
			if (frame !== undefined) cancelAnimationFrame(frame);
		};
	}, [footerRef, virtualizer, initialSearchAnchor]);
	useLayoutEffect(() => {
		const controller = new MessageProjection<DisplaySnapshot | undefined>(
			undefined,
			(value) => {
				// A final can change the stream row without increasing row count,
				// including the distinct-key fallback when continuity is unproven.
				// Capture bottom intent before new estimates can move it beyond the threshold.
				followFinal.current =
					!!published.current?.running &&
					!value?.running &&
					!!scrollIntent.current?.follows &&
					virtualizer.isAtEnd(CONVERSATION_END_THRESHOLD);
				published.current = value;
				setSnapshot(value);
			},
			() => selectionIntersects(messages.current, document.getSelection()),
			setDisplayPaused,
			prefersReducedMotion,
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
			if (selected) {
				interruptReading.current(0);
				onNearTop(false);
			}
			controller.flush();
		};
		document.addEventListener("selectionchange", selectionChanged);
		return () => {
			controller.dispose();
			projection.current = null;
			document.removeEventListener("selectionchange", selectionChanged);
		};
	}, [virtualizer, onNearTop]);
	useLayoutEffect(() => {
		projection.current?.update(incoming, incoming?.running ?? false);
	}, [incoming]);
	useLayoutEffect(() => {
		if (!snapshot) return;
		if (initialSearchAnchor && !initialized.current) {
			const index = rows.findIndex((row) => row.message?.id === initialSearchAnchor.target.messageId);
			if (index < 0) return;
			initialized.current = true;
			virtualizer.scrollToIndex(index, { align: "center" });
			restorationFrames.current.push(
				requestAnimationFrame(() => {
					restorationFrames.current.push(
						requestAnimationFrame(() => {
							messages.current?.querySelector("[data-search-match]")?.scrollIntoView({ block: "center" });
						}),
					);
				}),
			);
			return;
		}
		const restore = pendingRestore.current;
		if (restore) {
			const index = rows.findIndex((row) => row.key === restore.key);
			if (index < 0 && snapshot.historyCursor) {
				// A previous reading position can precede the latest snapshot. Keep
				// the existing serial/cursor-fenced history owner in charge of reads.
				onNearTop(true);
				return;
			}
			pendingRestore.current = undefined;
			initialized.current = true;
			onNearTop(false);
			if (index >= 0) {
				virtualizer.scrollToIndex(index, { align: "start" });
				const settle = () => {
					const currentIndex = previousRows.current.findIndex((row) => row.key === restore.key);
					const target = virtualizer.getOffsetForIndex(currentIndex, "start");
					if (target) virtualizer.scrollToOffset(Math.max(0, target[0] - restore.pixel));
				};
				const frame = requestAnimationFrame(() => {
					settle();
					restorationFrames.current.push(requestAnimationFrame(settle));
				});
				restorationFrames.current.push(frame);
			} else virtualizer.scrollToOffset(0);
			return;
		}
		if (initialized.current && !followFinal.current) return;
		initialized.current = true;
		followFinal.current = false;
		virtualizer.scrollToEnd();
	}, [snapshot, virtualizer, rows, onNearTop, initialSearchAnchor]);
	const readingScope = scope ?? incoming;
	const readingState = useRef({ scope: readingScope, rows });
	useLayoutEffect(() => {
		readingState.current = { scope: readingScope, rows };
	});
	useLayoutEffect(() => {
		const node = messages.current;
		return () => {
			// A locator-backed window must not be restored by walking normal history.
			if (initialSearchAnchor) return;
			const { scope: boundScope, rows: retained } = readingState.current;
			if (!node || !boundScope || !initialized.current || pendingRestore.current) return;
			const offset = virtualizer.scrollOffset ?? node.scrollTop;
			const anchor = virtualizer.getVirtualItems().find((item) => item.end > offset);
			if (!anchor || !retained.some((row) => row.key === anchor.key)) return;
			positions.save(
				boundScope,
				{
					key: String(anchor.key),
					pixel: anchor.start - offset,
					following: virtualizer.options.scrollEndThreshold >= 0,
				},
				virtualizer.takeSnapshot(),
			);
		};
	}, [virtualizer, positions, initialSearchAnchor]);
	// Re-evaluate after prepend anchoring and dynamic measurement, rather than draining
	// history from the old scroll offset before React has committed the new page.
	useEffect(() => {
		if (!snapshot) return;
		const frame = requestAnimationFrame(() => {
			const node = messages.current;
			onNearTop(!!pendingRestore.current || (!!node && !selectionRange && node.scrollTop <= HISTORY_LOAD_THRESHOLD));
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
					!!pendingRestore.current ||
						(initialized.current &&
							!selectionIntersects(node, document.getSelection()) &&
							node.scrollTop <= HISTORY_LOAD_THRESHOLD),
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
		<div
			className="message-stage"
			style={{ "--thread-scroll-padding-bottom": `${footerRef ? footerHeight + 16 : 32}px` } as CSSProperties}
		>
			<section
				className="message-scroll"
				ref={messages}
				// biome-ignore lint/a11y/noNoninteractiveTabindex: The scroll region must support keyboard scrolling.
				tabIndex={0}
				aria-label={t("nav.conversations")}
				data-following={followIntent}
				data-reading-mode={searchAnchor ? "search" : "live"}
				onScroll={(event) => {
					if (!initialized.current) return;
					const node = event.currentTarget;
					scrollIntent.current?.scrolled();
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
									data-message-id={row.message?.id}
									data-turn-key={row.key}
									data-transcript-kind={row.kind}
									data-transcript-last={item.index === rows.length - 1}
									className="virtual-message-row"
									style={{ transform: `translateY(${item.start}px)` }}
								>
									{row.kind === "request-failure" ? (
										<ConversationTurnFailure failure={row.failure} onOpenModelSettings={onOpenModelSettings} />
									) : (
										<TranscriptMessage
											row={row}
											scope={snapshot}
											stream={row.message ? undefined : snapshot}
											responseActive={responseActive}
											offset={originalOffsets.get(row.key)}
											onOffsetChange={setOriginalOffsets}
											searchAnchor={row.message?.id === searchAnchor?.target.messageId ? searchAnchor : undefined}
										/>
									)}
								</div>
							);
						})}
				</div>
			</section>
			{historyStatus}
			<ResponseAnnouncement snapshot={snapshot} error={error} failure={snapshot?.requestFailure} />
			{displayPaused && <output className="message-pending small-copy">{t("markdown.pending")}</output>}
			{(searchAnchor || !nearEnd) && (
				<ActionTooltip label={t("work.jumpLatest")} disabled={selectionRange !== null}>
					<Button
						className="jump-latest bg-popover rounded-full"
						variant="outline"
						size="sm"
						aria-label={t("work.jumpLatest")}
						style={{ bottom: footerHeight + 24 }}
						disabled={selectionRange !== null}
						onClick={() => {
							scrollIntent.current?.cancelHeader();
							if (onJumpLatest) onJumpLatest();
							else scrollIntent.current?.jump();
						}}
					>
						<Icon name="arrowDown" size={16} />
					</Button>
				</ActionTooltip>
			)}
		</div>
	);
}

const TranscriptMessage = memo(
	function TranscriptMessage({
		row,
		scope,
		stream,
		responseActive,
		offset,
		onOffsetChange,
		searchAnchor,
	}: {
		row: Exclude<TranscriptRow, { kind: "request-failure" }>;
		scope: Scope;
		stream?: Snapshot;
		responseActive?: boolean;
		offset: number | undefined;
		onOffsetChange: (update: (current: ReadonlyMap<string, number>) => ReadonlyMap<string, number>) => void;
		searchAnchor?: SearchHistoryWindow;
	}) {
		const { t } = usePreferences();
		const article = useRef<HTMLElement>(null);
		const CopyAction = row.message?.role === "assistant" ? AssistantClipboardCopy : ClipboardCopy;
		const message: Message = row.message ?? {
			id: row.key,
			role: "assistant",
			text: stream?.partial ?? "",
			textLength: stream?.partialLength ?? 0,
			truncated: stream?.partialTruncated ?? false,
		};
		const copySource = useMessageCopyText(scope, message);
		const active = !!stream?.running && responseActive !== false;
		const phase = stream ? responsePhase(stream, active) : undefined;
		if (stream && !stream.partial) {
			if (!active && !stream.execution?.tools.total) return null;
			return (
				<article className="message message-assistant" data-content-search-unit-key={row.key} aria-busy={active}>
					<div className="message-content">
						{phase && <ResponseStatus phase={phase} />}
						<InlineLiveActivities snapshot={stream} active={active} />
						<InlineApproval snapshot={stream} active={active} />
					</div>
				</article>
			);
		}
		return (
			<article
				ref={article}
				className={`message message-${message.role}`}
				data-has-message-text={message.text.length > 0}
				data-content-search-unit-key={row.key}
				aria-busy={stream ? active : undefined}
			>
				<div className="message-content">
					<h4 className="sr-only">{t(message.role === "user" ? "work.you" : "work.assistant")}</h4>
					<MessageContent
						message={message}
						onHydratedText={copySource.accept}
						scope={scope}
						offset={offset}
						streaming={stream?.running}
						streamId={row.key}
						searchAnchor={searchAnchor}
						onOffsetChange={(nextOffset) => {
							onOffsetChange((current) => {
								const next = new Map(current);
								if (nextOffset === undefined) next.delete(row.key);
								else next.set(row.key, nextOffset);
								return next;
							});
						}}
					/>
					{phase && <ResponseStatus phase={phase} />}
					{stream && <InlineLiveActivities snapshot={stream} active={active} />}
					{stream && <InlineApproval snapshot={stream} active={active} />}
					{!stream && message.role === "assistant" && (
						<InlineMessageActivities messageId={message.id} toolCalls={message.toolCalls} />
					)}
					{message.interrupted && <span className="status-pill">{t("work.interrupted")}</span>}
					{!stream && copySource.text && (
						<div className="message-actions">
							<CopyAction
								article={article}
								key={row.key}
								text={copySource.text}
								label={t("common.copy")}
								iconOnly
								className="message-copy"
								errorClassName="error-text"
							/>
						</div>
					)}
				</div>
			</article>
		);
	},
	(before, after) =>
		before.row === after.row &&
		before.stream === after.stream &&
		before.responseActive === after.responseActive &&
		before.scope.workspaceId === after.scope.workspaceId &&
		before.scope.conversationId === after.scope.conversationId &&
		before.offset === after.offset &&
		before.searchAnchor === after.searchAnchor &&
		before.onOffsetChange === after.onOffsetChange,
);

export function StreamingMessage({ snapshot, responseActive }: { snapshot: Snapshot; responseActive?: boolean }) {
	return (
		<TranscriptMessage
			row={{ key: snapshot.partialId ?? "partial-output", kind: "assistant-stream" }}
			scope={snapshot}
			stream={snapshot}
			responseActive={responseActive}
			offset={undefined}
			onOffsetChange={() => {}}
		/>
	);
}
