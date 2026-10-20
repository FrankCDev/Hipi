import { MAX_RICH_TEXT_UNITS } from "./policy.ts";

export const STREAM_DISPLAY_INTERVAL_MS = 50;
export type StreamingText = { source: string; streaming: boolean; identity: string };

/** One latest source, displayed prefix and scheduled publication; never a token queue. */
export class StreamingTextBuffer {
	private target: StreamingText;
	private displayed: StreamingText;
	private reset = false;
	private disposed = false;
	private timer: ReturnType<typeof setTimeout> | undefined;
	private frame: number | undefined;
	private readonly publish: (value: StreamingText) => void;
	private readonly blocked: () => boolean;
	private readonly reducedMotion: () => boolean;

	constructor(
		initial: StreamingText,
		publish: (value: StreamingText) => void,
		blocked: () => boolean,
		reducedMotion: () => boolean,
	) {
		this.target = initial;
		this.displayed = initial;
		this.publish = publish;
		this.blocked = blocked;
		this.reducedMotion = reducedMotion;
	}

	update(value: StreamingText) {
		if (this.disposed) return;
		this.reset ||=
			value.identity !== this.target.identity ||
			!value.source.startsWith(this.target.source) ||
			(!this.target.streaming && value.streaming);
		this.target = value;
		if (!value.streaming || this.reset || this.reducedMotion() || value.source.length > MAX_RICH_TEXT_UNITS) {
			this.flush();
		} else {
			this.schedule();
		}
	}

	/** Selection release and terminal source publish the newest source, never a stale buffered prefix. */
	flush() {
		this.cancelSchedule();
		if (this.disposed || this.blocked()) return;
		this.reset = false;
		this.set(this.target);
	}

	private schedule() {
		if (this.timer !== undefined || this.frame !== undefined || this.blocked()) return;
		if (this.displayed.source === this.target.source && this.displayed.streaming === this.target.streaming) return;
		this.timer = setTimeout(() => {
			this.timer = undefined;
			if (typeof requestAnimationFrame === "function") {
				this.frame = requestAnimationFrame(() => {
					this.frame = undefined;
					this.advance();
				});
			} else this.advance();
		}, STREAM_DISPLAY_INTERVAL_MS);
	}

	private advance() {
		if (this.disposed || this.blocked()) return;
		if (!this.target.streaming || this.reset || this.reducedMotion()) {
			this.flush();
			return;
		}
		// Follow arrivals quickly while smoothing large bursts. No timing is interpreted as model throughput.
		const remaining = this.target.source.length - this.displayed.source.length;
		let end = Math.min(
			this.target.source.length,
			this.displayed.source.length + Math.max(16, Math.ceil(remaining / 2)),
		);
		const unit = this.target.source.charCodeAt(end);
		const previous = this.target.source.charCodeAt(end - 1);
		if (unit >= 0xdc00 && unit <= 0xdfff && previous >= 0xd800 && previous <= 0xdbff) end++;
		this.set({ ...this.target, source: this.target.source.slice(0, end) });
		this.schedule();
	}

	private set(value: StreamingText) {
		if (
			value.source === this.displayed.source &&
			value.streaming === this.displayed.streaming &&
			value.identity === this.displayed.identity
		)
			return;
		this.displayed = value;
		this.publish(value);
	}

	private cancelSchedule() {
		clearTimeout(this.timer);
		this.timer = undefined;
		if (this.frame !== undefined) cancelAnimationFrame(this.frame);
		this.frame = undefined;
	}

	dispose() {
		this.disposed = true;
		this.cancelSchedule();
	}
}
