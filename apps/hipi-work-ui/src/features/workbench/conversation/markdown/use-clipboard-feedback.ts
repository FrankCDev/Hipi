import { useCallback, useEffect, useRef, useState } from "react";
import { ClipboardFeedback, type ClipboardStatus, type ClipboardWriter, writeClipboard } from "./clipboard-feedback.ts";

export function useClipboardFeedback(write: ClipboardWriter = writeClipboard) {
	const [status, setStatus] = useState<ClipboardStatus>("idle");
	const owner = useRef<ClipboardFeedback | null>(null);
	useEffect(() => {
		const feedback = new ClipboardFeedback(setStatus, write);
		owner.current = feedback;
		return () => {
			feedback.dispose();
			owner.current = null;
		};
	}, [write]);
	const copy = useCallback((text: string) => owner.current?.copy(text), []);
	return { status, copy };
}
