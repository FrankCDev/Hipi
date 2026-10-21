export const LOG_LIMITS: Readonly<{
	fileBytes: number;
	recordBytes: number;
	retentionDays: number;
	closeWaitMs: number;
}>;
export interface LogContext {
	stage?:
		| "runtime-open"
		| "file-services-open"
		| "storage-open"
		| "file-services-close"
		| "subscriptions-close"
		| "runtime-close"
		| "dispatch"
		| "unknown"
		| "prepare"
		| "renderer"
		| "host"
		| "prerequisite";
	outcome?: "success" | "failed" | "cancelled" | "busy" | "write-unknown" | "closed" | "saved" | "clean" | "unclean";
	category?: "startup" | "storage" | "close" | "operation";
	requestId?: string;
	generation?: string;
	durationMs?: number;
	exitCode?: number;
}
export type LogEvent =
	| "app.start"
	| "app.ready"
	| "app.stop"
	| "app.failed"
	| "runtime.start"
	| "runtime.ready"
	| "runtime.unavailable"
	| "runtime.shutdown-timeout"
	| "runtime.diagnostic"
	| "renderer.gone"
	| "request.completed"
	| "request.failed"
	| "diagnostics.export"
	| "dev.start"
	| "dev.build"
	| "dev.ready"
	| "dev.restart"
	| "dev.stop"
	| "dev.failed"
	| "dev.server.ready"
	| "dev.build.started"
	| "dev.build.failed"
	| "dev.build.ready"
	| "dev.desktop.starting"
	| "dev.desktop.ready"
	| "dev.desktop.exited"
	| "dev.restart.requested"
	| "dev.shutdown.requested"
	| "dev.shutdown.waiting"
	| "dev.stopped"
	| "dev.usage.invalid"
	| "dev.models.missing"
	| "dev.electron.missing"
	| "dev.shutdown.failed"
	| "dev.server.failed"
	| "dev.desktop.failed"
	| "dev.startup.failed";
export interface OperationalLogger {
	readonly sessionId: string;
	readonly droppedRecords: number;
	record(event: LogEvent, context?: LogContext): boolean;
	close(): Promise<"flushed" | "failed" | "timeout">;
}
export function createNodeLogger(options: {
	role: "main" | "dev";
	directory?: string;
	console?: boolean;
}): OperationalLogger;
