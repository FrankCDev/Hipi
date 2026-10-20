import type { Scope, Snapshot } from "@hipi/work-runtime/contracts";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useMemo, useRef, useState } from "react";
import { useAppClient } from "../../app/client-provider.tsx";
import { type ObservationConnection, observeConversation } from "./observation-session.ts";

export type ConnectionState = "connecting" | "connected" | "stale" | "paused";
/** Query owns only replaceable projections. Every reconnect reads authoritative history. */
export function useObservation(input: Scope) {
	const scope = useMemo(
		() => ({ workspaceId: input.workspaceId, conversationId: input.conversationId }),
		[input.workspaceId, input.conversationId],
	);
	const client = useAppClient();
	const cache = useQueryClient();
	const [generation, setGeneration] = useState(0);
	const activeGeneration = useRef(0);
	const [paused, setPaused] = useState(false);
	const [state, setState] = useState<ObservationConnection>({
		connection: "connecting",
		errorCode: null,
		showConnectionNotice: true,
	});
	const key = ["snapshot", scope.workspaceId, scope.conversationId];
	const query = useQuery({
		queryKey: key,
		queryFn: ({ signal }) => client.call("snapshot", scope, signal),
		enabled: false,
	});
	useEffect(() => {
		activeGeneration.current = generation;
		if (paused) return;
		const queryKey = ["snapshot", scope.workspaceId, scope.conversationId];
		const subscription = observeConversation(
			client,
			scope,
			(snapshot) => {
				if (activeGeneration.current === generation) cache.setQueryData<Snapshot>(queryKey, snapshot);
			},
			(next) => {
				if (activeGeneration.current === generation) setState(next);
			},
		);
		return () => {
			void subscription.dispose().catch(() => undefined);
		};
	}, [client, cache, scope, generation, paused]);
	return {
		snapshot: query.data,
		connection: paused ? ("paused" as const) : state.connection,
		error: !paused && state.connection === "stale",
		errorCode: paused ? null : state.errorCode,
		showConnectionNotice: paused || state.showConnectionNotice,
		pause: () => setPaused(true),
		reconnect: () => {
			setPaused(false);
			setGeneration((value) => value + 1);
		},
	};
}
