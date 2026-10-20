import {
	AppError,
	type Conversation,
	type ErrorCode,
	type ReceiptView,
	type Submit,
} from "@hipi/work-runtime/contracts";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import { useAppClient, useLocalState } from "../../app/client-provider.tsx";
import { canExecuteModel } from "./model-policy.ts";
import { reconcileReceipt } from "./receipt-reconciliation.ts";
import { submitRequest } from "./submit-request.ts";
import { useObservation } from "./use-observation.ts";

/** Owns submission identity, draft reconciliation and request cancellation for one mounted conversation. */
export function useConversation(conversation: Conversation) {
	const client = useAppClient();
	const local = useLocalState();
	const cache = useQueryClient();
	const localKey = `${conversation.workspaceId}.${conversation.conversationId}`;
	const [draft, setDraft] = useState(() => local.read(`draft.${localKey}`) ?? "");
	const currentDraft = useRef(draft);
	const [pending, setPending] = useState(() => local.pending(localKey));
	const requestId = pending?.requestId ?? "";
	const [reconciledRequest, setReconciledRequest] = useState(() =>
		pending && local.isConfirmed(pending.requestId) ? pending.requestId : "",
	);
	const [errorCode, setErrorCode] = useState<ErrorCode | null>(null);
	const [admissionFailed, setAdmissionFailed] = useState(false);
	const composing = useRef(false);
	const submitting = useRef(false);
	const request = useRef<AbortController | null>(null);
	const observation = useObservation(conversation);
	const model = useQuery({
		queryKey: ["conversation-model", conversation.workspaceId, conversation.conversationId],
		queryFn: ({ signal }) =>
			client.call(
				"getConversationModel",
				{ workspaceId: conversation.workspaceId, conversationId: conversation.conversationId },
				signal,
			),
		refetchInterval: observation.connection === "connected" ? 2000 : false,
	});
	const connected = observation.connection === "connected";
	const observedRunning = observation.snapshot?.running;
	useEffect(() => {
		if (!connected || observedRunning === undefined) return;
		// Short executions can start and finish between periodic model queries. Re-read
		// authoritative controls on live transitions; do not derive readiness from text
		// or optimistically replace the model's richer paused/cancellation state.
		void cache.invalidateQueries({
			queryKey: ["conversation-model", conversation.workspaceId, conversation.conversationId],
			exact: true,
		});
	}, [cache, conversation.workspaceId, conversation.conversationId, connected, observedRunning]);
	const execution = useMutation({
		mutationFn: async (action: "resume" | "cancel") => {
			if (action === "resume") await client.call("continueWorkspace", { workspaceId: conversation.workspaceId });
			else
				await client.call("cancelExecution", {
					workspaceId: conversation.workspaceId,
					conversationId: conversation.conversationId,
				});
		},
		onSettled: async () => {
			await cache.invalidateQueries({ queryKey: ["conversation-model", conversation.workspaceId] });
			await cache.invalidateQueries({ queryKey: ["receipt", conversation.workspaceId] });
		},
	});
	const receipt = useQuery({
		queryKey: ["receipt", conversation.workspaceId, requestId],
		queryFn: ({ signal }) => client.call("getReceipt", { workspaceId: conversation.workspaceId, requestId }, signal),
		enabled: requestId.length > 0,
		refetchInterval: (query) =>
			observation.connection === "connected" &&
			!(query.state.error instanceof AppError && query.state.error.code === "STORE_MISMATCH") &&
			query.state.data?.execution !== "done" &&
			query.state.data?.state !== "cancelled" &&
			query.state.data?.state !== "reconciliation_required"
				? 1500
				: false,
	});
	const mutation = useMutation({
		mutationFn: async (input: Submit) => {
			setErrorCode(null);
			setAdmissionFailed(false);
			const controller = new AbortController();
			request.current = controller;
			let admitted = false;
			try {
				try {
					return await submitRequest(client, local, input, controller.signal, () => {
						admitted = true;
						setPending(input);
					});
				} catch (error) {
					if (!admitted) setAdmissionFailed(true);
					throw error;
				}
			} finally {
				if (request.current === controller) request.current = null;
			}
		},
		onSuccess: (accepted) => {
			cache.setQueryData<ReceiptView>(["receipt", conversation.workspaceId, accepted.requestId], accepted);
		},
		onError: (error) => setErrorCode(error instanceof AppError ? error.code : null),
		onSettled: () => {
			submitting.current = false;
		},
	});
	useEffect(() => {
		if (
			!pending ||
			!receipt.data ||
			receipt.data.state === "reconciliation_required" ||
			receipt.data.requestId === reconciledRequest
		)
			return;
		const next = reconcileReceipt(local, localKey, currentDraft.current, pending, receipt.data);
		if (next === null) return;
		currentDraft.current = next;
		setDraft(next);
		setReconciledRequest(receipt.data.requestId);
		setErrorCode(null);
	}, [pending, receipt.data, local, localKey, reconciledRequest]);
	useEffect(
		() => () => {
			request.current?.abort();
		},
		[],
	);
	const unconfirmed = requestId.length > 0 && !receipt.data;
	const storeMismatch =
		errorCode === "STORE_MISMATCH" ||
		observation.errorCode === "STORE_MISMATCH" ||
		(receipt.error instanceof AppError && receipt.error.code === "STORE_MISMATCH");
	const executionAllowed = canExecuteModel(model.data, model.isError) && !execution.isPending;
	const blocked =
		conversation.archivedAt !== null ||
		!executionAllowed ||
		storeMismatch ||
		mutation.isPending ||
		unconfirmed ||
		(requestId.length > 0 && receipt.data !== null && reconciledRequest !== requestId) ||
		receipt.data?.state === "reconciliation_required" ||
		observation.connection !== "connected";
	const submit = () => {
		if (draft.trim() && !blocked && !composing.current && !submitting.current) {
			// React's pending state is not synchronous; keyboard and form events can share a render.
			submitting.current = true;
			mutation.mutate({
				workspaceId: conversation.workspaceId,
				conversationId: conversation.conversationId,
				requestId: crypto.randomUUID(),
				text: draft,
			});
		}
	};
	const stopWaiting = () => {
		request.current?.abort();
		observation.pause();
	};
	return {
		workspaceId: conversation.workspaceId,
		model,
		execution,
		executionAllowed,
		draft,
		pending,
		requestId,
		receipt,
		mutation,
		errorCode,
		observation,
		blocked,
		storeMismatch,
		admissionFailed,
		storageAvailable: local.storageAvailable,
		composing,
		submit,
		stopWaiting,
		setDraft: (value: string) => {
			currentDraft.current = value;
			setDraft(value);
			local.write(`draft.${localKey}`, value);
		},
		reconnect: () => {
			observation.reconnect();
			if (requestId) void receipt.refetch();
		},
	};
}
export type ConversationController = ReturnType<typeof useConversation>;
