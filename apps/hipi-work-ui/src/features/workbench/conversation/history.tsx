import type { Scope, Snapshot } from "@hipi/work-runtime/contracts";
import { type RefObject, useCallback, useLayoutEffect, useRef, useState } from "react";
import { useAppClient } from "../../../app/client-provider.tsx";
import { usePreferences } from "../../../app/preferences.tsx";
import { Button } from "../../../components/ui/button.tsx";
import { conversationSearchLabels } from "../search/labels.ts";
import type { ConversationFailure } from "./failure.ts";
import type { HistoryViewport } from "./history/window.ts";
import {
	anchoredHistorySnapshot,
	ConversationHistoryController,
	type ConversationHistoryState,
	type SearchHistoryAnchor,
} from "./history-controller.ts";
import { readHistoryPage, readSearchHistoryWindow } from "./history-reads.ts";
import { ConversationMessages } from "./messages.tsx";
import { readingPositionsFor } from "./reading-position.ts";

type Props = {
	scope: Scope;
	snapshot: Snapshot | undefined;
	connected?: boolean;
	responseActive?: boolean;
	error: boolean;
	footerRef?: RefObject<HTMLElement | null>;
	failure?: ConversationFailure;
	onOpenModelSettings?: (returnFocus: HTMLElement) => void;
	searchAnchor?: SearchHistoryAnchor;
	onExitSearchAnchor?: () => void;
};

export function ConversationHistory(props: Props) {
	const client = useAppClient();
	const positions = readingPositionsFor(client);
	return (
		<ScopedHistory
			key={JSON.stringify([positions.ownerKey, props.scope.workspaceId, props.scope.conversationId])}
			{...props}
		/>
	);
}

function ScopedHistory({
	scope,
	snapshot,
	connected = true,
	responseActive,
	error,
	footerRef,
	failure,
	onOpenModelSettings,
	searchAnchor,
	onExitSearchAnchor,
}: Props) {
	const client = useAppClient();
	const positions = readingPositionsFor(client);
	const { t, locale } = usePreferences();
	const l = conversationSearchLabels(locale);
	const [state, setState] = useState<ConversationHistoryState>(() => ({
		snapshot: searchAnchor ? anchoredHistorySnapshot(scope, searchAnchor) : snapshot,
		anchor: searchAnchor,
		loading: false,
		failed: false,
		reconciling: false,
		capacity: false,
		blocked: null,
	}));
	const [displayGeneration, setDisplayGeneration] = useState(0);
	const controller = useRef<ConversationHistoryController | null>(null);
	const appliedAnchor = useRef<SearchHistoryAnchor | undefined>(undefined);
	const focusLatest = useRef(false);
	useLayoutEffect(() => {
		const boundScope = { workspaceId: scope.workspaceId, conversationId: scope.conversationId };
		const owner = new ConversationHistoryController(
			boundScope,
			(cursor, signal) => readHistoryPage(client, boundScope, cursor, signal),
			setState,
			(locator, cursor, signal) => readSearchHistoryWindow(client, boundScope, locator, signal, cursor),
		);
		controller.current = owner;
		return () => {
			owner.dispose();
			controller.current = null;
			appliedAnchor.current = undefined;
		};
	}, [client, scope.workspaceId, scope.conversationId]);
	useLayoutEffect(() => controller.current?.setConnected(connected), [connected]);
	useLayoutEffect(() => {
		if (searchAnchor === appliedAnchor.current) return;
		if (searchAnchor) controller.current?.openAnchor(searchAnchor);
		else controller.current?.resetToLatest();
		appliedAnchor.current = searchAnchor;
		setDisplayGeneration((generation) => generation + 1);
	}, [searchAnchor]);
	useLayoutEffect(() => {
		if (snapshot) controller.current?.update(snapshot);
	}, [snapshot]);
	const onNearTop = useCallback((nearTop: boolean) => controller.current?.setNearTop(nearTop), []);
	const onHistoryViewport = useCallback(
		(viewport: HistoryViewport | null) => controller.current?.setViewport(viewport),
		[],
	);
	const status = state.capacity || state.failed || state.loading || state.reconciling;
	const jumpLatest = () => {
		appliedAnchor.current = undefined;
		focusLatest.current = true;
		positions.clear(scope);
		controller.current?.resetToLatest();
		setDisplayGeneration((generation) => generation + 1);
		onExitSearchAnchor?.();
	};
	useLayoutEffect(() => {
		if (!focusLatest.current) return;
		focusLatest.current = false;
		footerRef?.current?.parentElement?.querySelector<HTMLElement>(".message-scroll")?.focus({ preventScroll: true });
	});
	return (
		<ConversationMessages
			key={displayGeneration}
			scope={scope}
			footerRef={footerRef}
			failure={state.anchor ? undefined : failure}
			onOpenModelSettings={onOpenModelSettings}
			readingPositions={positions}
			snapshot={state.snapshot}
			responseActive={responseActive}
			error={error}
			onNearTop={onNearTop}
			onHistoryViewport={onHistoryViewport}
			searchAnchor={state.anchor?.window}
			onJumpLatest={state.anchor || state.newer ? jumpLatest : undefined}
			historyStatus={
				status || state.anchor ? (
					<div className={state.anchor ? "search-history-status" : "history-status"}>
						{state.anchor && (
							<>
								<output>{l.anchored}</output>
								<div className="search-history-actions">
									<Button size="sm" variant="ghost" onClick={jumpLatest}>
										{t("work.jumpLatest")}
									</Button>
								</div>
							</>
						)}
						{status && (
							<output>
								{t(
									state.capacity
										? "history.capacity"
										: state.failed
											? "history.failed"
											: state.reconciling
												? "history.reconciling"
												: "common.loading",
								)}
							</output>
						)}
						{state.failed && (
							<Button size="sm" variant="ghost" onClick={() => controller.current?.retry()}>
								{t("history.retry")}
							</Button>
						)}
					</div>
				) : undefined
			}
		/>
	);
}
