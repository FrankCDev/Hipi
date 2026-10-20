import {
	type AppClient,
	AppError,
	type ErrorCode,
	type ObservationStatus,
	type Scope,
	type Snapshot,
	type Subscription,
} from "@hipi/work-runtime/contracts";

export type ObservationConnection = {
	connection: "connecting" | "connected" | "stale";
	errorCode: ErrorCode | null;
	showConnectionNotice: boolean;
};

export const OBSERVATION_RECOVERY_DELAYS_MS = [250, 500, 1000, 2000, 4000] as const;
export const OBSERVATION_RECOVERY_GRACE_MS = 1000;
export const OBSERVATION_STABLE_CONNECTION_MS = 30000;
type Failure = { code: ErrorCode | null; retryable: boolean };
type Attempt = {
	controller: AbortController;
	subscription?: Subscription;
	release?: Promise<void>;
};

/** Rebuilds read-only projections only. A finite recovery budget cannot replay or resume accepted work. */
export function observeConversation(
	client: AppClient,
	scope: Scope,
	onSnapshot: (snapshot: Snapshot) => void,
	onConnection: (state: ObservationConnection) => void,
): Subscription {
	let disposed = false;
	let active: Attempt | undefined;
	let finishAttempt: (() => void) | undefined;
	let storeId: string | undefined;
	let epoch: string | undefined;
	let connectedOnce = false;
	let recovering = false;
	let retries = 0;
	let state: ObservationConnection = { connection: "connecting", errorCode: null, showConnectionNotice: true };
	let retryTimer: ReturnType<typeof setTimeout> | undefined;
	let graceTimer: ReturnType<typeof setTimeout> | undefined;
	let stableTimer: ReturnType<typeof setTimeout> | undefined;
	let finishBackoff: (() => void) | undefined;
	const publish = (next: ObservationConnection) => {
		state = next;
		if (!disposed) onConnection(next);
	};
	const clearGrace = () => {
		clearTimeout(graceTimer);
		graceTimer = undefined;
	};
	const release = (attempt: Attempt) => {
		attempt.controller.abort();
		if (attempt.subscription) attempt.release ??= attempt.subscription.dispose();
		return attempt.release;
	};
	const unavailable = (failure: Failure) => {
		if (disposed) return;
		if (!failure.retryable || retries === OBSERVATION_RECOVERY_DELAYS_MS.length) {
			clearGrace();
			publish({ connection: "stale", errorCode: failure.code, showConnectionNotice: true });
			return;
		}
		if (!recovering) {
			recovering = true;
			publish({ connection: "connecting", errorCode: null, showConnectionNotice: !connectedOnce });
			if (connectedOnce)
				graceTimer = setTimeout(() => {
					if (!disposed && state.connection === "connecting") publish({ ...state, showConnectionNotice: true });
				}, OBSERVATION_RECOVERY_GRACE_MS);
		}
	};
	const run = async () => {
		publish(state);
		while (!disposed) {
			const attempt: Attempt = { controller: new AbortController() };
			active = attempt;
			let failure: Failure | undefined;
			let finish: () => void = () => {};
			const ended = new Promise<void>((resolve) => {
				finish = resolve;
			});
			const fail = (value: Failure) => {
				if (failure || disposed || active !== attempt) return;
				failure = value;
				clearTimeout(stableTimer);
				attempt.controller.abort();
				finish();
				unavailable(value);
			};
			finishAttempt = finish;
			let ready = false;
			let version = -1;
			try {
				const identity = await client.call("handshake", {}, attempt.controller.signal);
				if (disposed || attempt.controller.signal.aborted) return;
				if (storeId && identity.storeId !== storeId) throw new AppError("STORE_MISMATCH");
				storeId = identity.storeId;
				const snapshot = await client.call("snapshot", scope, attempt.controller.signal);
				if (disposed || attempt.controller.signal.aborted) return;
				if (snapshot.workspaceId !== scope.workspaceId || snapshot.conversationId !== scope.conversationId)
					throw new AppError("INVALID_REQUEST");
				// A replacement runtime's read is not authoritative for the old view until its epoch is checked.
				if (!connectedOnce) onSnapshot(snapshot);
				attempt.subscription = await client.observe(
					scope,
					(frame) => {
						if (disposed || attempt.controller.signal.aborted || active !== attempt) return;
						if (
							frame.snapshot.workspaceId !== scope.workspaceId ||
							frame.snapshot.conversationId !== scope.conversationId
						) {
							fail({ code: "INVALID_REQUEST", retryable: false });
							return;
						}
						if (epoch && frame.epoch !== epoch) {
							// A new workspace/runtime incarnation requires explicit reconciliation, not silent rebinding.
							fail({ code: "CLOSED", retryable: false });
							return;
						}
						if (frame.version <= version) return;
						epoch = frame.epoch;
						version = frame.version;
						onSnapshot(frame.snapshot);
						if (!ready) {
							ready = true;
							connectedOnce = true;
							recovering = false;
							clearGrace();
							publish({ connection: "connected", errorCode: null, showConnectionNotice: false });
							// Healthy intervals renew the budget; rapidly flapping connections cannot reset it.
							stableTimer = setTimeout(() => {
								if (!disposed && active === attempt && !attempt.controller.signal.aborted) retries = 0;
								stableTimer = undefined;
							}, OBSERVATION_STABLE_CONNECTION_MS);
						}
					},
					attempt.controller.signal,
					(status: ObservationStatus) => {
						if (attempt.controller.signal.aborted || status.state !== "closed") return;
						fail({
							code: status.code ?? null,
							retryable:
								status.reason !== "disposed" &&
								(status.code === "CLOSED" ||
									(status.code === undefined && (status.reason === "disconnected" || status.reason === "expired"))),
						});
					},
				);
				if (!disposed) await ended;
			} catch (error) {
				fail({
					code: error instanceof AppError ? error.code : null,
					retryable: error instanceof AppError && error.code === "CLOSED",
				});
			} finally {
				try {
					await release(attempt);
				} catch {
					failure = { code: "CLOSED", retryable: false };
					unavailable(failure);
				}
				if (active === attempt) active = undefined;
				finishAttempt = undefined;
			}
			if (disposed || !failure?.retryable) return;
			const delay = OBSERVATION_RECOVERY_DELAYS_MS[retries++];
			if (delay === undefined) return;
			await new Promise<void>((resolve) => {
				finishBackoff = resolve;
				retryTimer = setTimeout(resolve, delay);
			});
			retryTimer = undefined;
			finishBackoff = undefined;
		}
	};
	void run().catch(() => unavailable({ code: null, retryable: false }));
	return {
		async dispose() {
			if (disposed) return;
			// Set terminal ownership before abort callbacks or delayed results can update the view.
			disposed = true;
			finishAttempt?.();
			clearTimeout(retryTimer);
			clearTimeout(stableTimer);
			clearGrace();
			finishBackoff?.();
			if (active) await release(active);
		},
	};
}
