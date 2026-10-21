import { writeClipboard } from "./clipboard-writer.ts";

export { writeClipboard } from "./clipboard-writer.ts";

export const COPY_FEEDBACK_MS = 1500;
export const COPY_TIMEOUT_MS = 10_000;
export type ClipboardWriter = (text: string, signal?: AbortSignal) => Promise<void>;
export type ClipboardStatus = "idle" | "copying" | "copied" | "failed";

/** One clipboard attempt and one feedback timer; an expired write may still finish in the OS. */
export class ClipboardFeedback {
	private generation = 0;
	private disposed = false;
	private timer: ReturnType<typeof setTimeout> | undefined;
	private status: ClipboardStatus = "idle";
	private readonly publish: (status: ClipboardStatus) => void;
	private readonly write: ClipboardWriter;
	private attempt: AbortController | undefined;

	constructor(publish: (status: ClipboardStatus) => void, write: ClipboardWriter = writeClipboard) {
		this.publish = publish;
		this.write = write;
	}

	copy(text: string) {
		if (this.disposed || this.status === "copying") return;
		clearTimeout(this.timer);
		this.attempt?.abort();
		const attempt = new AbortController();
		this.attempt = attempt;
		const generation = ++this.generation;
		this.set("copying");
		this.timer = setTimeout(() => {
			this.generation++;
			attempt.abort();
			this.set("failed");
		}, COPY_TIMEOUT_MS);
		void this.write(text, attempt.signal).then(
			() => {
				if (this.disposed || generation !== this.generation) return;
				clearTimeout(this.timer);
				this.set("copied");
				this.timer = setTimeout(() => this.set("idle"), COPY_FEEDBACK_MS);
			},
			() => {
				if (this.disposed || generation !== this.generation) return;
				clearTimeout(this.timer);
				this.set("failed");
			},
		);
	}

	dispose() {
		this.disposed = true;
		this.attempt?.abort();
		this.generation++;
		clearTimeout(this.timer);
	}

	private set(status: ClipboardStatus) {
		if (this.disposed) return;
		this.status = status;
		this.publish(status);
	}
}
