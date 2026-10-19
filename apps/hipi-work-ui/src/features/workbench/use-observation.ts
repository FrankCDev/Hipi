import { AppError, type ErrorCode, type Scope, type Snapshot, type Subscription } from "@hipi/work-runtime/contracts";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useMemo, useRef, useState } from "react";
import { useAppClient } from "../../app/client-provider.tsx";

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
	const [connection, setConnection] = useState<ConnectionState>("connecting");
	const [error, setError] = useState(false);
	const [errorCode, setErrorCode] = useState<ErrorCode | null>(null);
	const key = ["snapshot", scope.workspaceId, scope.conversationId];
	const query = useQuery({
		queryKey: key,
		queryFn: ({ signal }) => client.call("snapshot", scope, signal),
		enabled: false,
	});
	useEffect(() => {
		activeGeneration.current = generation;
		if (paused) {
			setConnection("paused");
			return;
		}
		const controller = new AbortController();
		let subscription: Subscription | undefined;
		let epoch: string | undefined;
		let version = -1;
		setConnection("connecting");
		setError(false);
		setErrorCode(null);
		const queryKey = ["snapshot", scope.workspaceId, scope.conversationId];
		const run = async () => {
			const snapshot = await client.call("snapshot", scope, controller.signal);
			if (controller.signal.aborted) return;
			cache.setQueryData<Snapshot>(queryKey, snapshot);
			subscription = await client.observe(
				scope,
				(frame) => {
					if (
						controller.signal.aborted ||
						activeGeneration.current !== generation ||
						frame.snapshot.workspaceId !== scope.workspaceId ||
						frame.snapshot.conversationId !== scope.conversationId
					)
						return;
					if (epoch === frame.epoch && frame.version <= version) return;
					epoch = frame.epoch;
					version = frame.version;
					cache.setQueryData<Snapshot>(queryKey, frame.snapshot);
					setConnection("connected");
				},
				controller.signal,
				(status) => {
					if (controller.signal.aborted) return;
					if (status.state === "closed" && status.reason !== "disposed") {
						setConnection("stale");
						setError(true);
						setErrorCode(status.code ?? null);
					}
				},
			);
			if (controller.signal.aborted) await subscription.dispose();
		};
		void run().catch((cause: unknown) => {
			if (!controller.signal.aborted) {
				setConnection("stale");
				setError(true);
				setErrorCode(cause instanceof AppError ? cause.code : null);
			}
		});
		return () => {
			controller.abort();
			void subscription?.dispose().catch(() => undefined);
		};
	}, [client, cache, scope, generation, paused]);
	return {
		snapshot: query.data,
		connection,
		error,
		errorCode,
		pause: () => setPaused(true),
		reconnect: () => {
			setPaused(false);
			setGeneration((value) => value + 1);
		},
	};
}
