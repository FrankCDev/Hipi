import type { Message, Scope } from "@hipi/work-runtime/contracts";
import { useCallback, useLayoutEffect, useRef, useState } from "react";

/** Only a complete body accepted by this message's reader can enable completion copy. */
export function useMessageCopyText(scope: Scope, message: Message) {
	const identity = JSON.stringify([
		scope.workspaceId,
		scope.conversationId,
		message.id,
		message.textLength,
		message.text,
	]);
	const current = useRef(identity);
	const [hydrated, setHydrated] = useState<{ identity: string; text: string | undefined }>();
	useLayoutEffect(() => {
		current.current = identity;
	}, [identity]);
	const accept = useCallback(
		(text: string | undefined) => {
			if (current.current !== identity) return;
			setHydrated({ identity, text: text?.length === message.textLength ? text : undefined });
		},
		[identity, message.textLength],
	);
	return {
		text: message.truncated ? (hydrated?.identity === identity ? hydrated.text : undefined) : message.text,
		accept,
	};
}
