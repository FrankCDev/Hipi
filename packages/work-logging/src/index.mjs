import { randomUUID } from "node:crypto";
import { lstatSync, mkdirSync, unlinkSync, writeSync } from "node:fs";
import { join } from "node:path";
import pino from "pino";
import { createStream } from "rotating-file-stream";
import { contextFields, descriptions, events, LOG_LIMITS } from "./schema.mjs";

export { LOG_LIMITS } from "./schema.mjs";

/** Pino serializes records; the public rotating stream owns all file writes and rotation. */
export function createNodeLogger({ role, directory, console: consoleEnabled = false }) {
	const sessionId = randomUUID();
	let closed = false,
		failed = false,
		blocked = false,
		reported = false,
		closePromise,
		stream,
		accepted = false,
		droppedRecords = 0;
	const fallback = () => {
		if (reported) return;
		reported = true;
		try {
			writeSync(2, "[Hipi logging] LOG_WRITE_FAILED\n");
		} catch {
			/* Logging never owns application lifetime. */
		}
	};
	const fail = () => {
		failed = true;
		fallback();
	};
	if (directory) {
		try {
			mkdirSync(directory, { recursive: true, mode: 0o700 });
			if (!lstatSync(directory).isDirectory()) throw new Error("Unsafe log directory");
			for (const name of ["desktop.log", "desktop.1.log"]) {
				const path = join(directory, name);
				try {
					const stat = lstatSync(path);
					if (!stat.isFile() || stat.nlink !== 1) throw new Error("Unsafe log target");
					if (Date.now() - stat.mtimeMs > LOG_LIMITS.retentionDays * 86400000) unlinkSync(path);
				} catch (error) {
					if (error?.code !== "ENOENT") throw error;
				}
			}
			stream = createStream((index) => (index ? `desktop.${index}.log` : "desktop.log"), {
				path: directory,
				size: `${LOG_LIMITS.fileBytes}B`,
				rotate: 1,
				mode: 0o600,
				teeToStdout: false,
			});
			stream.on("error", fail);
			stream.on("warning", fail);
			stream.on("drain", () => {
				blocked = false;
			});
		} catch {
			fail();
		}
	}
	const logger = pino(
		{
			level: consoleEnabled ? "debug" : "info",
			base: { schemaVersion: 1, role: role === "main" ? "main" : "dev", pid: process.pid, sessionId },
			timestamp: pino.stdTimeFunctions.isoTime,
			formatters: { level: (label) => ({ level: label }) },
		},
		{
			write(line) {
				if (Buffer.byteLength(line) > LOG_LIMITS.recordBytes + 1) return;
				const record = JSON.parse(line);
				if (stream && record.level !== "debug") {
					blocked = !stream.write(line);
					accepted = true;
				}
				if (consoleEnabled) {
					writeSync(
						2,
						`${record.time} ${record.level.toUpperCase()} [${record.role}] ${record.event} ${JSON.stringify(record.context)}${descriptions[record.event] ? ` ${descriptions[record.event]}` : ""}${record.event === "app.start" && directory ? ` logs=${JSON.stringify(directory)}` : ""}\n`,
					);
					accepted = true;
				}
			},
		},
	);
	return {
		sessionId,
		get droppedRecords() {
			return droppedRecords;
		},
		record(event, context) {
			if (closed || failed || typeof event !== "string" || !Object.hasOwn(events, event)) return false;
			if (blocked) {
				droppedRecords = Math.min(9999, droppedRecords + 1);
				return false;
			}
			try {
				accepted = false;
				logger[events[event]]({ event, context: contextFields(context) });
				return accepted;
			} catch {
				fail();
				return false;
			}
		},
		close() {
			if (closePromise) return closePromise;
			closed = true;
			if (!stream) {
				closePromise = Promise.resolve(failed ? "failed" : "flushed");
				return closePromise;
			}
			closePromise = new Promise((resolve) => {
				let settled = false;
				const finish = (status) => {
					if (settled) return;
					settled = true;
					clearTimeout(timer);
					if (status !== "flushed") {
						fallback();
						stream.destroy();
					}
					resolve(status);
				};
				const timer = setTimeout(() => finish(failed ? "failed" : "timeout"), LOG_LIMITS.closeWaitMs);
				stream.once("finish", () => finish(failed ? "failed" : "flushed"));
				stream.once("error", () => finish("failed"));
				if (failed || stream.destroyed) finish("failed");
				else
					try {
						stream.end();
					} catch {
						fail();
						finish("failed");
					}
			});
			return closePromise;
		},
	};
}
