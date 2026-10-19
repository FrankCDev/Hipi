import { useCallback, useEffect, useRef, useState } from "react";
import { BoundedRead, type ReadState } from "./bounded-read.ts";

/** Callers provide a stable scope-bound read function. No query cache or page list is retained. */
export function useBoundedRead<Input, Output>(
	read: (input: Input, signal: AbortSignal) => Promise<Output>,
	initial?: NoInfer<Input>,
) {
	const [state, setState] = useState<ReadState<Output>>({ loading: false, failed: false });
	const current = useRef<BoundedRead<Input, Output> | null>(null);
	useEffect(() => {
		const reader = new BoundedRead(read, setState);
		current.current = reader;
		setState({ loading: false, failed: false });
		if (initial !== undefined) void reader.load(initial);
		return () => {
			reader.dispose();
			current.current = null;
		};
	}, [read, initial]);
	const load = useCallback((input: Input) => {
		void current.current?.load(input);
	}, []);
	return {
		...state,
		load,
		retry: () => current.current?.retry(),
		cancel: () => current.current?.cancel(),
		reset: () => current.current?.reset(),
	};
}
