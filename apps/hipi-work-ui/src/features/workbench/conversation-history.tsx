import type { Scope, Snapshot } from "@hipi/work-runtime/contracts";
import { type RefObject, useCallback, useLayoutEffect, useRef, useState } from "react";
import { useAppClient } from "../../app/client-provider.tsx";
import { usePreferences } from "../../app/preferences.tsx";
import { Button } from "../../components/ui/button.tsx";
import type { ConversationFailure } from "./conversation-failure.ts";
import {
	ConversationHistoryController,
	type ConversationHistoryState,
	type SearchHistoryAnchor,
} from "./conversation-history-controller.ts";
import { ConversationMessages } from "./conversation-messages.tsx";
import { readingPositionsFor } from "./conversation-reading-position.ts";
import { conversationSearchLabels } from "./conversation-search-labels.ts";
import { readHistoryPage, readSearchHistoryWindow } from "./history-reads.ts";

type Props = {
	scope: Scope;
	snapshot: Snapshot | undefined;
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
	const [state, setState] = useState<ConversationHistoryState>({
		snapshot,
		loading: false,
		failed: false,
		reconciling: false,
		capacity: false,
		blocked: null,
	});
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
	const status = state.blocked || state.failed || state.loading || state.reconciling;
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
			error={error}
			onNearTop={onNearTop}
			searchAnchor={state.anchor?.window}
			onJumpLatest={state.anchor ? jumpLatest : undefined}
			historyStatus={
				status || state.anchor ? (
					<div className={state.anchor ? "search-history-status" : "history-status"}>
						{state.anchor && (
							<>
								<output>{l.anchored}</output>
								<div className="search-history-actions">
									{state.anchor.window.olderCursor && (
										<Button
											size="sm"
											variant="ghost"
											disabled={state.loading || state.capacity}
											onClick={() => controller.current?.loadAnchored("older")}
										>
											{l.older}
										</Button>
									)}
									{state.anchor.window.newerCursor && (
										<Button
											size="sm"
											variant="ghost"
											disabled={state.loading || state.capacity}
											onClick={() => controller.current?.loadAnchored("newer")}
										>
											{l.newer}
										</Button>
									)}
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
										: state.blocked === "scan-limit"
											? "history.scanLimit"
											: state.failed
												? "history.failed"
												: state.reconciling
													? "history.reconciling"
													: "common.loading",
								)}
							</output>
						)}
						{(state.failed || state.blocked === "scan-limit") && (
							<Button size="sm" variant="ghost" onClick={() => controller.current?.retry()}>
								{t(state.blocked === "scan-limit" ? "history.continueScan" : "history.retry")}
							</Button>
						)}
						{state.capacity && (
							<Button size="sm" variant="ghost" onClick={jumpLatest}>
								{t("history.releaseLatest")}
							</Button>
						)}
					</div>
				) : undefined
			}
		/>
	);
}
