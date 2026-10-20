import { type RefObject, useLayoutEffect, useRef, useState } from "react";
import { prefersReducedMotion, selectionIntersects } from "../message-projection.ts";
import { type StreamingText, StreamingTextBuffer } from "./streaming-text-buffer.ts";

export function useStreamingText(value: StreamingText, root: RefObject<HTMLElement | null>) {
	const { source, streaming, identity } = value;
	const initial = useRef(value);
	const [display, setDisplay] = useState(value);
	const owner = useRef<StreamingTextBuffer | null>(null);
	useLayoutEffect(() => {
		const buffer = new StreamingTextBuffer(
			initial.current,
			setDisplay,
			() => selectionIntersects(root.current, document.getSelection()),
			prefersReducedMotion,
		);
		owner.current = buffer;
		const flush = () => buffer.flush();
		const motion = window.matchMedia?.("(prefers-reduced-motion: reduce)");
		const observer = new MutationObserver(() => {
			if (prefersReducedMotion()) buffer.flush();
		});
		observer.observe(document.documentElement, { attributes: true, attributeFilter: ["data-reduced-motion"] });
		motion?.addEventListener("change", flush);
		document.addEventListener("selectionchange", flush);
		return () => {
			buffer.dispose();
			owner.current = null;
			observer.disconnect();
			motion?.removeEventListener("change", flush);
			document.removeEventListener("selectionchange", flush);
		};
	}, [root]);
	useLayoutEffect(() => {
		owner.current?.update({ source, streaming, identity });
	}, [source, streaming, identity]);
	return display;
}
