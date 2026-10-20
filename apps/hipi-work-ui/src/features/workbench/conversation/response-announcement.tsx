import type { Snapshot } from "@hipi/work-runtime/contracts";
import { useEffect, useRef, useState } from "react";
import { usePreferences } from "../../../app/preferences.tsx";
import { type ConversationFailure, conversationFailureCopy } from "./failure.ts";
import { ResponseAnnouncer } from "./response-announcement.ts";

export function ResponseAnnouncement({
	snapshot,
	error = false,
	failure,
}: {
	snapshot: Snapshot | undefined;
	error?: boolean;
	failure?: ConversationFailure;
}) {
	const { t, locale } = usePreferences();
	const [text, setText] = useState("");
	const owner = useRef<ResponseAnnouncer | null>(null);
	const started = t("work.responseStarted");
	const complete = t("work.responseComplete");
	const interrupted = t("work.interrupted");
	const initial = useRef({ started, complete, interrupted });
	useEffect(() => {
		const announcer = new ResponseAnnouncer(setText, initial.current);
		owner.current = announcer;
		return () => {
			announcer.dispose();
			owner.current = null;
		};
	}, []);
	useEffect(() => {
		owner.current?.update(snapshot, error || !!failure, { started, complete, interrupted });
		if (failure) {
			const copy = conversationFailureCopy(failure, locale);
			owner.current?.fail(failure.key, `${copy.message} ${copy.detail}`);
		}
	}, [snapshot, error, started, complete, interrupted, failure, locale]);
	return (
		<output className="sr-only" aria-live="polite" aria-atomic="true">
			{text}
		</output>
	);
}
