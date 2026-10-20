import type { Snapshot } from "@hipi/work-runtime/contracts";
import { useEffect, useRef, useState } from "react";
import { usePreferences } from "../../app/preferences.tsx";
import { ResponseAnnouncer } from "./response-announcement.ts";

export function ResponseAnnouncement({ snapshot, error = false }: { snapshot: Snapshot | undefined; error?: boolean }) {
	const { t } = usePreferences();
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
		owner.current?.update(snapshot, error, { started, complete, interrupted });
	}, [snapshot, error, started, complete, interrupted]);
	return (
		<output className="sr-only" aria-live="polite" aria-atomic="true">
			{text}
		</output>
	);
}
