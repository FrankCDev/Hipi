/** Offline maintenance entry point. It never constructs a model or execution runtime. */
import { AppError } from "./contracts.ts";
import { openRecoveryArchive } from "./maintenance/archive.ts";
import { backupStore } from "./maintenance/backup.ts";
import { parseStoreCommand, STORE_HELP, type StoreCommand } from "./maintenance/cli-options.ts";
import { MaintenanceError } from "./maintenance/contracts.ts";
import { restoreStore } from "./maintenance/restore.ts";
import { verifyBackup } from "./maintenance/verify.ts";

async function execute(command: Exclude<StoreCommand, { command: "help" }>, signal: AbortSignal): Promise<unknown> {
	if (command.command === "backup") {
		const result = await backupStore({ source: command.source, destination: command.destination, signal });
		return {
			directory: result.directory,
			backupId: result.manifest.backupId,
			workspaceCount: result.workspaceCount,
			bytes: result.bytes,
			manifestDigest: result.manifestDigest,
			durability: result.durability,
		};
	}
	if (command.command === "verify") {
		const result = await verifyBackup({ directory: command.backup });
		return {
			verified: true,
			backupId: result.manifest.backupId,
			workspaceCount: result.manifest.workspaces.length,
			bytes: result.manifest.files.reduce((total, file) => total + file.bytes, 0),
			manifestDigest: result.manifestDigest,
		};
	}
	if (command.command === "restore")
		return restoreStore({ source: command.backup, destination: command.destination, signal });
	const archive = await openRecoveryArchive({ directory: command.archive });
	try {
		if (signal.aborted) throw new MaintenanceError("CANCELLED");
		const storeId = archive.info.storeId;
		switch (command.command) {
			case "inspect":
				return archive.info;
			case "workspaces":
				return await archive.listWorkspaces({ storeId, ...(command.cursor ? { cursor: command.cursor } : {}) });
			case "conversations":
				return await archive.listConversations({
					storeId,
					workspaceId: command.workspace,
					...(command.cursor ? { cursor: command.cursor } : {}),
				});
			case "history":
				return await archive.getHistory({
					storeId,
					workspaceId: command.workspace,
					conversationId: command.conversation,
					...(command.cursor ? { cursor: command.cursor } : {}),
				});
			case "text":
				return await archive.getMessageText({
					storeId,
					workspaceId: command.workspace,
					conversationId: command.conversation,
					messageId: command.message,
					offset: command.offset,
				});
			case "activities":
				return await archive.getToolActivities({
					storeId,
					workspaceId: command.workspace,
					conversationId: command.conversation,
					...(command.cursor ? { cursor: command.cursor } : {}),
				});
			case "activity-text":
				return await archive.getToolActivityText({
					storeId,
					workspaceId: command.workspace,
					conversationId: command.conversation,
					activityId: command.activity,
					...(command.cursor ? { cursor: command.cursor } : {}),
				});
			case "export-history":
				return await archive.exportHistory({
					storeId,
					workspaceId: command.workspace,
					conversationId: command.conversation,
					destination: command.output,
				});
		}
	} finally {
		await archive.close();
	}
}

let command: StoreCommand | undefined;
try {
	command = parseStoreCommand(process.argv.slice(2));
} catch {
	process.stderr.write("Invalid arguments; no operation started. Use --help.\n");
	process.exitCode = 2;
}
if (command?.command === "help") process.stdout.write(STORE_HELP);
else if (command) {
	const controller = new AbortController();
	const stop = () => controller.abort();
	process.once("SIGINT", stop);
	process.once("SIGTERM", stop);
	try {
		const result = await execute(command, controller.signal);
		process.stdout.write(`${JSON.stringify({ ok: true, command: command.command, result })}\n`);
	} catch (error) {
		const detail =
			error instanceof MaintenanceError
				? { code: error.code, operationId: error.operationId, phase: error.phase }
				: { code: error instanceof AppError ? error.code : "INTERNAL" };
		process.stderr.write(`${JSON.stringify({ ok: false, command: command.command, error: detail })}\n`);
		process.exitCode = 1;
	} finally {
		process.removeListener("SIGINT", stop);
		process.removeListener("SIGTERM", stop);
	}
}
