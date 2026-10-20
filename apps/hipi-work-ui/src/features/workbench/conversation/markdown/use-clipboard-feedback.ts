import { useCallback, useEffect, useRef, useState } from "react";
import { ClipboardFeedback, type ClipboardStatus } from "./clipboard-feedback.ts";

export function useClipboardFeedback() {
	const [status, setStatus] = useState<ClipboardStatus>("idle");
	const owner = useRef<ClipboardFeedback | null>(null);
	useEffect(() => {
		const feedback = new ClipboardFeedback(setStatus);
		owner.current = feedback;
		return () => {
			feedback.dispose();
			owner.current = null;
		};
	}, []);
	const copy = useCallback((text: string) => owner.current?.copy(text), []);
	return { status, copy };
}
