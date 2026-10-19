import type { AppClient, Scope, ToolActivityPage, ToolActivityTextPage } from "@hipi/work-runtime/contracts";

export type ActivityState = {
	page?: ToolActivityPage;
	cursor?: string;
	text?: ToolActivityTextPage;
	expanded?: string;
	busy: boolean;
	failed: boolean;
};
type Read = { kind: "page"; cursor?: string } | { kind: "text"; activityId: string; cursor?: string };

/** One visible page and one retained-output chunk. No transcript or raw-output cache survives disposal. */
export class ActivitySession {
	private state: ActivityState = { busy: false, failed: false };
	private listeners = new Set<() => void>();
	private request?: AbortController;
	private generation = 0;
	private active = false;
	private retryRead?: Read;
	private client: AppClient;
	private scope: Scope;
	constructor(client: AppClient, scope: Scope) {
		this.client = client;
		this.scope = { workspaceId: scope.workspaceId, conversationId: scope.conversationId };
	}
	snapshot = () => this.state;
	subscribe = (listener: () => void) => {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	};
	activate() {
		this.active = true;
	}
	private publish(state: ActivityState) {
		this.state = state;
		for (const listener of this.listeners) listener();
	}
	cancel() {
		this.generation++;
		this.request?.abort();
		this.request = undefined;
		this.publish({ ...this.state, busy: false });
	}
	collapse() {
		this.cancel();
		const pageFailed = this.state.failed && this.retryRead?.kind === "page";
		if (!pageFailed) this.retryRead = undefined;
		this.publish({ ...this.state, text: undefined, expanded: undefined, failed: pageFailed });
	}
	dispose() {
		this.active = false;
		this.cancel();
		this.retryRead = undefined;
		this.publish({ busy: false, failed: false });
	}
	page(cursor?: string) {
		return this.read({ kind: "page", cursor });
	}
	text(activityId: string, cursor?: string) {
		if (!this.state.page?.items.some((item) => item.activityId === activityId && item.textAvailable))
			return Promise.resolve();
		return this.read({ kind: "text", activityId, cursor });
	}
	retry() {
		return this.retryRead ? this.read(this.retryRead) : Promise.resolve();
	}
	private async read(read: Read) {
		if (!this.active || this.request) return;
		const controller = new AbortController();
		this.request = controller;
		const generation = ++this.generation;
		this.retryRead = read;
		this.publish({
			...this.state,
			busy: true,
			failed: false,
			...(read.kind === "text"
				? {
						expanded: read.activityId,
						text: this.state.text?.activityId === read.activityId ? this.state.text : undefined,
					}
				: {}),
		});
		// Cancelling this wait never cancels tool execution or implies rollback.
		const timeout = setTimeout(() => controller.abort(), 15000);
		let rejectAbort: () => void = () => {};
		const aborted = new Promise<never>((_resolve, reject) => {
			rejectAbort = () => reject(new Error("Read cancelled"));
			controller.signal.addEventListener("abort", rejectAbort, { once: true });
		});
		try {
			// Desktop validates before serialization; absent optional fields must not be own undefined keys.
			const cursor = read.cursor === undefined ? {} : { cursor: read.cursor };
			if (read.kind === "page") {
				const page = await Promise.race([
					this.client.call("getToolActivities", { ...this.scope, ...cursor }, controller.signal),
					aborted,
				]);
				if (!this.active || generation !== this.generation) return;
				if (controller.signal.aborted) throw new Error("Read timed out");
				this.publish({ page, cursor: read.cursor, busy: false, failed: false });
			} else {
				const text = await Promise.race([
					this.client.call(
						"getToolActivityText",
						{ ...this.scope, activityId: read.activityId, ...cursor },
						controller.signal,
					),
					aborted,
				]);
				if (!this.active || generation !== this.generation) return;
				if (controller.signal.aborted || text.activityId !== read.activityId || !text.retainedOutputOnly)
					throw new Error("Invalid retained output");
				this.publish({ ...this.state, text, busy: false, failed: false });
			}
			this.retryRead = undefined;
		} catch {
			if (this.active && generation === this.generation) this.publish({ ...this.state, busy: false, failed: true });
		} finally {
			clearTimeout(timeout);
			controller.signal.removeEventListener("abort", rejectAbort);
			if (generation === this.generation) this.request = undefined;
		}
	}
}
