import { MAX_ACTIVE, WAIT_MS } from "./protocol.ts";
/** Deadlines end caller waiting, not the underlying invocation's admission accounting. */
export class InvocationGate {
	#pending = 0;
	async run(operation: () => Promise<unknown>, deadline = WAIT_MS + 1000): Promise<unknown> {
		if (this.#pending >= MAX_ACTIVE) return { ok: false, error: "CAPACITY_EXCEEDED" };
		this.#pending++;
		let timer: ReturnType<typeof setTimeout> | undefined;
		const invocation = Promise.resolve()
			.then(operation)
			.catch(() => ({ ok: false, error: "CLOSED" }))
			.finally(() => {
				this.#pending--;
				if (timer) clearTimeout(timer);
			});
		return Promise.race([
			invocation,
			new Promise((resolve) => {
				timer = setTimeout(() => resolve({ ok: false, error: "CLOSED" }), deadline);
			}),
		]);
	}
	get pending() {
		return this.#pending;
	}
}
