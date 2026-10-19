/** Owns a single replaceable read. Abort plus generation guards handle clients that resolve after cancellation. */
export class BoundedRead<Input, Output> {
	private generation = 0;
	private request: AbortController | undefined;
	private disposed = false;
	private input: Input | undefined;
	private readonly read: (input: Input, signal: AbortSignal) => Promise<Output>;
	private readonly publish: (state: ReadState<Output>) => void;
	private state: ReadState<Output> = { loading: false, failed: false };

	constructor(
		read: (input: Input, signal: AbortSignal) => Promise<Output>,
		publish: (state: ReadState<Output>) => void,
	) {
		this.read = read;
		this.publish = publish;
	}

	async load(input: Input) {
		if (this.disposed) return;
		this.request?.abort();
		const generation = ++this.generation;
		const request = new AbortController();
		this.request = request;
		this.input = input;
		this.set({ ...this.state, loading: true, failed: false });
		try {
			const value = await this.read(input, request.signal);
			if (!this.disposed && !request.signal.aborted && generation === this.generation)
				this.set({ value, loading: false, failed: false });
		} catch {
			if (!this.disposed && !request.signal.aborted && generation === this.generation)
				this.set({ ...this.state, loading: false, failed: true });
		} finally {
			if (generation === this.generation) this.request = undefined;
		}
	}

	retry() {
		if (this.input !== undefined) void this.load(this.input);
	}

	cancel() {
		this.generation++;
		this.request?.abort();
		this.request = undefined;
		if (!this.disposed) this.set({ ...this.state, loading: false });
	}

	reset() {
		this.cancel();
		this.input = undefined;
		if (!this.disposed) this.set({ loading: false, failed: false });
	}

	dispose() {
		this.disposed = true;
		this.cancel();
	}

	private set(state: ReadState<Output>) {
		this.state = state;
		this.publish(state);
	}
}

export type ReadState<T> = { value?: T; loading: boolean; failed: boolean };
