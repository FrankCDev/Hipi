import { Worker } from "node:worker_threads";
import {
	DOCUMENT_LIMITS,
	type DocumentFormat,
	type DocumentPreview,
	DocumentPreviewError,
	type DocumentPreviewErrorCode,
	isDocumentFormat,
	isDocumentPreviewErrorCode,
	validateDocumentPreview,
} from "./contracts.ts";

interface Job {
	format: DocumentFormat;
	bytes: Uint8Array<ArrayBuffer>;
	size: number;
	signal?: AbortSignal;
	abort: () => void;
	resolve: (preview: DocumentPreview) => void;
	reject: (error: DocumentPreviewError) => void;
}

interface Running {
	job: Job;
	stop: (error?: DocumentPreviewError, preview?: DocumentPreview) => void;
	done: Promise<void>;
}

export interface DocumentParserPoolOptions {
	/** Packaged hosts supply their separately bundled Node worker entry. */
	workerUrl?: URL;
}

/** Owns workers, timers, queue and private input snapshots. Not an OS permission sandbox. */
export class DocumentParserPool {
	private readonly workerUrl: URL;
	private readonly queue: Job[] = [];
	private readonly running = new Set<Running>();
	private closed = false;
	private terminationFailed = false;
	private retainedBytes = 0;

	constructor(options: DocumentParserPoolOptions = {}) {
		this.workerUrl = options.workerUrl ?? new URL("./parser-worker.ts", import.meta.url);
	}

	get status(): Readonly<{ active: number; queued: number; retainedBytes: number; closed: boolean }> {
		return {
			active: this.running.size,
			queued: this.queue.length,
			retainedBytes: this.retainedBytes,
			closed: this.closed,
		};
	}

	parse(format: DocumentFormat, bytes: Uint8Array, signal?: AbortSignal): Promise<DocumentPreview> {
		let code: DocumentPreviewErrorCode | undefined;
		if (this.closed) code = "PARSER_CLOSED";
		else if (signal?.aborted) code = "ABORTED";
		else if (!isDocumentFormat(format) || !(bytes instanceof Uint8Array) || bytes.byteLength === 0)
			code = "INVALID_DOCUMENT";
		else if (bytes.byteLength > DOCUMENT_LIMITS.inputBytes) code = "DOCUMENT_LIMIT";
		else if (
			(this.running.size >= DOCUMENT_LIMITS.concurrency && this.queue.length >= DOCUMENT_LIMITS.queue) ||
			this.retainedBytes + bytes.byteLength > 32 * 1024 * 1024
		)
			code = "PARSER_BUSY";
		if (code) return Promise.reject(new DocumentPreviewError(code));
		// Copy only after admission. Caller mutations cannot race preflight versus parsing.
		const snapshot = Uint8Array.from(bytes);
		this.retainedBytes += snapshot.byteLength;
		return new Promise<DocumentPreview>((resolve, reject) => {
			const job: Job = {
				format,
				bytes: snapshot,
				size: snapshot.byteLength,
				signal,
				resolve,
				reject,
				abort: () => {
					const queued = this.queue.indexOf(job);
					if (queued >= 0) {
						this.queue.splice(queued, 1);
						this.release(job);
						reject(new DocumentPreviewError("ABORTED"));
					} else {
						for (const running of this.running)
							if (running.job === job) running.stop(new DocumentPreviewError("ABORTED"));
					}
				},
			};
			signal?.addEventListener("abort", job.abort, { once: true });
			this.queue.push(job);
			this.drain();
		});
	}

	async close(): Promise<void> {
		this.closed = true;
		for (const job of this.queue.splice(0)) {
			this.release(job);
			job.reject(new DocumentPreviewError("PARSER_CLOSED"));
		}
		const active = [...this.running];
		for (const running of active) running.stop(new DocumentPreviewError("PARSER_CLOSED"));
		await Promise.all(active.map((running) => running.done));
		if (this.terminationFailed) throw new DocumentPreviewError("INVALID_DOCUMENT");
	}

	private release(job: Job): void {
		job.signal?.removeEventListener("abort", job.abort);
		this.retainedBytes -= job.size;
		job.bytes = new Uint8Array();
	}

	private drain(): void {
		while (!this.closed && this.running.size < DOCUMENT_LIMITS.concurrency && this.queue.length > 0) {
			const job = this.queue.shift();
			if (job) this.start(job);
		}
	}

	private start(job: Job): void {
		let worker: Worker;
		try {
			worker = new Worker(this.workerUrl, {
				resourceLimits: { maxOldGenerationSizeMb: 128, maxYoungGenerationSizeMb: 16, stackSizeMb: 4 },
				stdout: true,
				stderr: true,
				env: {},
			});
		} catch {
			this.release(job);
			job.reject(new DocumentPreviewError("INVALID_DOCUMENT"));
			return;
		}
		// Discard library output; file contents and paths must not enter host logs.
		worker.stdout?.resume();
		worker.stderr?.resume();
		let finished = false;
		let complete = () => {};
		const done = new Promise<void>((resolve) => {
			complete = resolve;
		});
		const timer = setTimeout(
			() => running.stop(new DocumentPreviewError("PARSER_TIMEOUT")),
			DOCUMENT_LIMITS.timeoutMs,
		);
		const running: Running = {
			job,
			done,
			stop: (error, preview) => {
				if (finished) return;
				finished = true;
				clearTimeout(timer);
				job.signal?.removeEventListener("abort", job.abort);
				// Keep the slot occupied until termination: cancellation cannot exceed concurrency.
				void worker.terminate().then(
					() => finish(),
					() => {
						// No evidence of exit: fail closed and retain this occupied slot.
						this.closed = true;
						this.terminationFailed = true;
						for (const pending of this.queue.splice(0)) {
							this.release(pending);
							pending.reject(new DocumentPreviewError("PARSER_CLOSED"));
						}
						for (const active of this.running)
							if (active !== running) active.stop(new DocumentPreviewError("PARSER_CLOSED"));
						job.reject(new DocumentPreviewError("INVALID_DOCUMENT"));
						worker.once("exit", finish);
						complete();
					},
				);
				const finish = () => {
					worker.removeAllListeners();
					this.release(job);
					this.running.delete(running);
					if (error) job.reject(error);
					else if (preview) job.resolve(preview);
					else job.reject(new DocumentPreviewError("INVALID_DOCUMENT"));
					complete();
					this.drain();
				};
			},
		};
		this.running.add(running);
		worker.once("error", () => running.stop(new DocumentPreviewError("INVALID_DOCUMENT")));
		worker.once("exit", () => running.stop(new DocumentPreviewError("INVALID_DOCUMENT")));
		worker.once("message", (message: unknown) => {
			try {
				if (typeof message !== "object" || message === null || !("ok" in message))
					throw new DocumentPreviewError("INVALID_DOCUMENT");
				if (message.ok === true && "preview" in message)
					running.stop(undefined, validateDocumentPreview(message.preview));
				else if (message.ok === false && "code" in message && isDocumentPreviewErrorCode(message.code))
					running.stop(new DocumentPreviewError(message.code));
				else running.stop(new DocumentPreviewError("INVALID_DOCUMENT"));
			} catch {
				running.stop(new DocumentPreviewError("INVALID_DOCUMENT"));
			}
		});
		try {
			worker.postMessage({ format: job.format, bytes: job.bytes }, [job.bytes.buffer]);
		} catch {
			running.stop(new DocumentPreviewError("INVALID_DOCUMENT"));
		}
	}
}
