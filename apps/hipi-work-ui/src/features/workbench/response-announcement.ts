import type { Snapshot } from "@hipi/work-runtime/contracts";

export const RESPONSE_ANNOUNCEMENT_MS = 5000;
export const RESPONSE_ANNOUNCEMENT_UNITS = 512;
export type ResponseAnnouncementLabels = { started: string; complete: string; interrupted: string };

/** One run-scoped source and timer, independent of virtual row mounting and display animation. */
export class ResponseAnnouncer {
	private scope = "";
	private active = false;
	private baselineTail: string | undefined;
	private baselineAssistantIds = new Set<string>();
	private source = "";
	private announced = 0;
	private timer: ReturnType<typeof setTimeout> | undefined;
	private disposed = false;
	private readonly publish: (text: string) => void;
	private labels: ResponseAnnouncementLabels;

	constructor(publish: (text: string) => void, labels: ResponseAnnouncementLabels) {
		this.publish = publish;
		this.labels = labels;
	}

	update(snapshot: Snapshot | undefined, error: boolean, labels = this.labels) {
		if (this.disposed) return;
		this.labels = labels;
		const scope = snapshot ? JSON.stringify([snapshot.workspaceId, snapshot.conversationId]) : "";
		if (scope !== this.scope) {
			clearTimeout(this.timer);
			this.timer = undefined;
			this.scope = scope;
			this.active = false;
			this.baselineAssistantIds.clear();
			this.source = "";
			this.announced = 0;
			this.publish("");
		}
		if (!snapshot) return;
		if (snapshot.running && !this.active) {
			this.active = true;
			this.baselineTail = snapshot.messages.at(-1)?.id;
			this.baselineAssistantIds = new Set(
				snapshot.messages.filter((message) => message.role === "assistant").map((message) => message.id),
			);
			this.announced = 0;
			this.publish(labels.started);
		}
		if (!this.active) return;
		if (snapshot.running || snapshot.partial) {
			if (!snapshot.partial.startsWith(this.source)) this.announced = 0;
			this.source = snapshot.partial;
		}
		if (snapshot.running && !error) {
			this.schedule();
			return;
		}
		clearTimeout(this.timer);
		this.timer = undefined;
		if (error) return;
		// Stopping, an error, a pause, and history pagination are not proof of a completed answer.
		const baseline = snapshot.messages.findIndex((message) => message.id === this.baselineTail);
		const last = snapshot.messages.at(-1);
		if (
			snapshot.running ||
			baseline < 0 ||
			baseline >= snapshot.messages.length - 1 ||
			last?.role !== "assistant" ||
			this.baselineAssistantIds.has(last.id)
		)
			return;
		this.active = false;
		this.baselineAssistantIds.clear();
		if (!last.text.startsWith(this.source)) this.announced = 0;
		this.source = last.text;
		const delta = this.delta();
		this.publish(`${last.interrupted ? labels.interrupted : labels.complete}${delta ? ` ${delta}` : ""}`);
	}

	private schedule() {
		if (this.timer !== undefined) return;
		this.timer = setTimeout(() => {
			this.timer = undefined;
			const delta = this.delta();
			if (delta) this.publish(delta);
			if (this.active) this.schedule();
		}, RESPONSE_ANNOUNCEMENT_MS);
	}

	private delta() {
		let start = Math.max(this.announced, this.source.length - RESPONSE_ANNOUNCEMENT_UNITS);
		const unit = this.source.charCodeAt(start);
		const previous = this.source.charCodeAt(start - 1);
		if (unit >= 0xdc00 && unit <= 0xdfff && previous >= 0xd800 && previous <= 0xdbff) start++;
		const delta = this.source.slice(start);
		this.announced = this.source.length;
		return delta;
	}

	dispose() {
		this.disposed = true;
		this.baselineAssistantIds.clear();
		clearTimeout(this.timer);
		this.timer = undefined;
	}
}
