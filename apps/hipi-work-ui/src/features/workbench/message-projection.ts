// Provisional UI cadence, not a measured performance budget.
export const MESSAGE_DISPLAY_INTERVAL_MS = 80;

/** Owns one pending projection and one timer. No token/event queue is retained. */
export class MessageProjection<T> {
	private latest: T;
	private pending = false;
	private disposed = false;
	private timer: ReturnType<typeof setTimeout> | undefined;
	private readonly publish: (value: T) => void;
	private readonly blocked: () => boolean;
	private readonly reportPaused: (paused: boolean) => void;
	private readonly reducedMotion: () => boolean;
	private paused = false;

	constructor(
		initial: T,
		publish: (value: T) => void,
		blocked: () => boolean,
		reportPaused: (paused: boolean) => void = () => {},
		reducedMotion: () => boolean = () => false,
	) {
		this.latest = initial;
		this.publish = publish;
		this.blocked = blocked;
		this.reportPaused = reportPaused;
		this.reducedMotion = reducedMotion;
	}

	update(value: T, streaming: boolean) {
		if (this.disposed) return;
		this.latest = value;
		this.pending = true;
		if (this.blocked()) this.setPaused(true);
		else if (!streaming || this.reducedMotion()) this.flush();
		else if (this.timer === undefined) {
			this.timer = setTimeout(() => this.flush(), MESSAGE_DISPLAY_INTERVAL_MS);
		}
	}

	flush() {
		clearTimeout(this.timer);
		this.timer = undefined;
		if (this.disposed || !this.pending) return;
		if (this.blocked()) {
			this.setPaused(true);
			return;
		}
		this.pending = false;
		this.setPaused(false);
		this.publish(this.latest);
	}

	private setPaused(paused: boolean) {
		if (this.paused === paused) return;
		this.paused = paused;
		this.reportPaused(paused);
	}

	dispose() {
		this.disposed = true;
		this.pending = false;
		clearTimeout(this.timer);
		this.timer = undefined;
	}
}

export function prefersReducedMotion(): boolean {
	if (typeof document === "undefined") return false;
	const preference = document.documentElement.dataset.reducedMotion;
	return preference ? preference === "on" : (window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false);
}

export function selectionIntersects(root: HTMLElement | null, selection: Selection | null): boolean {
	if (!root || !selection || selection.isCollapsed) return false;
	for (let index = 0; index < selection.rangeCount; index++) {
		if (selection.getRangeAt(index).intersectsNode(root)) return true;
	}
	return false;
}
