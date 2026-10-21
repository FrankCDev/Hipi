import { MAX_RICH_TEXT_UNITS } from "./policy.ts";

export const STREAM_DISPLAY_INTERVAL_MS = 50;
const ARRIVAL_INTERVAL_FLOOR_SECONDS = 10;
export type StreamingText = { source: string; streaming: boolean; identity: string };

/** One latest source, displayed prefix and scheduled publication; never a token queue. */
export class StreamingTextBuffer {
	private target: StreamingText;
	private displayed: StreamingText;
	private reset = false;
	private disposed = false;
	private timer: ReturnType<typeof setTimeout> | undefined;
	private frame: number | undefined;
	private bufferedLength: number;
	private lastTargetLength: number;
	private rate = 1;
	private lastArrival: number | undefined;
	private lastDrain: number | undefined;
	private drainCarry = 0;
	private readonly publish: (value: StreamingText) => void;
	private readonly blocked: () => boolean;
	private readonly reducedMotion: () => boolean;
	private readonly now: () => number;

	constructor(
		initial: StreamingText,
		publish: (value: StreamingText) => void,
		blocked: () => boolean,
		reducedMotion: () => boolean,
		/** Monotonic milliseconds; injectable so timer tests advance the same clock. */
		now: () => number = () => performance.now(),
	) {
		this.target = initial;
		this.displayed = initial;
		this.publish = publish;
		this.blocked = blocked;
		this.reducedMotion = reducedMotion;
		this.now = now;
		this.bufferedLength = initial.source.length;
		this.lastTargetLength = initial.source.length;
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
			this.advance();
		}
	}

	/** Selection release and terminal source publish the newest source, never a stale buffered prefix. */
	flush() {
		this.cancelSchedule();
		if (this.disposed || this.blocked()) return;
		this.reset = false;
		this.bufferedLength = this.target.source.length;
		this.lastTargetLength = this.target.source.length;
		this.rate = 1;
		this.lastArrival = undefined;
		this.lastDrain = undefined;
		this.drainCarry = 0;
		this.set(this.target);
	}

	private schedule() {
		if (this.timer !== undefined || this.blocked() || this.bufferedLength === this.target.source.length) return;
		this.timer = setTimeout(() => {
			this.timer = undefined;
			this.advance();
		}, STREAM_DISPLAY_INTERVAL_MS);
	}

	private advance() {
		if (this.disposed || this.blocked()) return;
		if (!this.target.streaming || this.reset || this.reducedMotion()) {
			this.flush();
			return;
		}
		const now = this.now() / 1000;
		const arrived = this.target.source.length - this.lastTargetLength;
		this.lastTargetLength = this.target.source.length;
		if (arrived > 0) {
			this.rate =
				this.lastArrival === undefined
					? arrived
					: Math.max(
							1,
							0.1 * (arrived / Math.max(now - this.lastArrival, ARRIVAL_INTERVAL_FLOOR_SECONDS)) + 0.9 * this.rate,
						);
			this.lastArrival = now;
		}
		const elapsed = this.lastDrain === undefined ? 0 : Math.max(0, now - this.lastDrain);
		this.lastDrain = now;
		const remaining = this.target.source.length - this.bufferedLength;
		// Match the adaptive backlog recurrence. Once floating-point arithmetic reaches
		// its fixed point, all remaining iterations are identical, even after a long pause.
		for (let step = 0; remaining > 0 && step < (elapsed + this.drainCarry) / 0.05; step++) {
			const previousRate = this.rate;
			if (remaining < this.rate * 1.5) this.rate = (remaining + this.rate * 1.5) / 2;
			if (remaining > this.rate / 1.2) this.rate = (remaining + this.rate / 1.2) / 2;
			if (this.rate === previousRate) break;
		}
		this.rate = Math.max(1, this.rate);
		const available = elapsed * this.rate + this.drainCarry;
		const drained = Math.floor(available);
		this.drainCarry = available - drained;
		let end = Math.min(this.target.source.length, this.bufferedLength + drained);
		const unit = this.target.source.charCodeAt(end);
		const previous = this.target.source.charCodeAt(end - 1);
		if (unit >= 0xdc00 && unit <= 0xdfff && previous >= 0xd800 && previous <= 0xdbff) end++;
		this.bufferedLength = end;
		if (end === this.target.source.length) {
			this.lastDrain = undefined;
			this.drainCarry = 0;
		}
		if (this.displayed.source.length !== end || this.displayed.streaming !== this.target.streaming) {
			if (typeof requestAnimationFrame === "function") {
				this.frame ??= requestAnimationFrame(() => {
					this.frame = undefined;
					this.publishBuffered();
				});
			} else this.publishBuffered();
		}
		this.schedule();
	}

	private publishBuffered() {
		if (!this.disposed && !this.blocked())
			this.set({ ...this.target, source: this.target.source.slice(0, this.bufferedLength) });
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
