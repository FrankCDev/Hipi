import type { Scope, Snapshot } from "@hipi/work-runtime/contracts";
import { type RefObject, useCallback, useLayoutEffect, useRef, useState } from "react";
import { useAppClient } from "../../app/client-provider.tsx";
import { usePreferences } from "../../app/preferences.tsx";
import { Button } from "../../components/ui/button.tsx";
import type { ConversationFailure } from "./conversation-failure.ts";
import { ConversationHistoryController, type ConversationHistoryState } from "./conversation-history-controller.ts";
import { ConversationMessages } from "./conversation-messages.tsx";
import { readingPositionsFor } from "./conversation-reading-position.ts";
import { readHistoryPage } from "./history-reads.ts";

type Props = {
	scope: Scope;
	snapshot: Snapshot | undefined;
	error: boolean;
	footerRef?: RefObject<HTMLElement | null>;
	failure?: ConversationFailure;
	onOpenModelSettings?: (returnFocus: HTMLElement) => void;
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

function ScopedHistory({ scope, snapshot, error, footerRef, failure, onOpenModelSettings }: Props) {
	const client = useAppClient();
	const positions = readingPositionsFor(client);
	const { t } = usePreferences();
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
	useLayoutEffect(() => {
		const boundScope = { workspaceId: scope.workspaceId, conversationId: scope.conversationId };
		const owner = new ConversationHistoryController(
			boundScope,
			(cursor, signal) => readHistoryPage(client, boundScope, cursor, signal),
			setState,
		);
		controller.current = owner;
		return () => {
			owner.dispose();
			controller.current = null;
		};
	}, [client, scope.workspaceId, scope.conversationId]);
	useLayoutEffect(() => {
		if (snapshot) controller.current?.update(snapshot);
	}, [snapshot]);
	const onNearTop = useCallback((nearTop: boolean) => controller.current?.setNearTop(nearTop), []);
	const status = state.blocked || state.failed || state.loading || state.reconciling;
	return (
		<ConversationMessages
			key={displayGeneration}
			scope={scope}
			footerRef={footerRef}
			failure={failure}
			onOpenModelSettings={onOpenModelSettings}
			readingPositions={positions}
			snapshot={state.snapshot}
			error={error}
			onNearTop={onNearTop}
			historyStatus={
				status ? (
					<div className="history-status">
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
						{(state.failed || state.blocked === "scan-limit") && (
							<Button size="sm" variant="ghost" onClick={() => controller.current?.retry()}>
								{t(state.blocked === "scan-limit" ? "history.continueScan" : "history.retry")}
							</Button>
						)}
						{state.capacity && (
							<Button
								size="sm"
								variant="ghost"
								onClick={() => {
									positions.clear(scope);
									controller.current?.resetToLatest();
									setDisplayGeneration((generation) => generation + 1);
								}}
							>
								{t("history.releaseLatest")}
							</Button>
						)}
					</div>
				) : undefined
			}
		/>
	);
}
