import { lstat, mkdir, realpath, stat } from "node:fs/promises";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { Models } from "@earendil-works/pi-ai";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { AppError, type Conversation, type Params } from "./contracts.ts";
import type { PresentationFailpoint } from "./conversation-presentation.ts";
import { WorkRuntime } from "./core.ts";
import {
	assertConfigurableModels,
	builtInProviderCatalog,
	builtInProviderModels,
	configureCustomProviders,
} from "./model-provider.ts";
import { PiWorkspace, type PiWorkspaceOptions, WorkspaceShutdownFailed } from "./pi-workspace.ts";
import { registerRuntimeProjectFolders } from "./project-folders.ts";
import { checkDatabasePath, StoreCatalog } from "./store-catalog.ts";

export { createRuntimeProjectFolders } from "./project-folders.ts";

// Keep a strong reference until process exit if startup teardown cannot prove the writer stopped.
const retainedOwners = new Set<DatabaseSync>();
const retainedCatalogs = new Set<StoreCatalog>();

export type RuntimeOptions = Pick<
	PiWorkspaceOptions,
	"failpoint" | "onError" | "resume" | "model" | "credentials" | "agentFiles"
> & {
	models: Models;
	onDiagnostic?: (diagnostic: { category: "storage"; phase: "storage-open" }) => void;
	catalogFailpoint?: (point: "after_reserve" | "after_directory" | "after_storage" | "before_ready") => Promise<void>;
	presentationFailpoint?: (point: PresentationFailpoint) => void | Promise<void>;
};
/**
 * Local filesystem adapter. A dedicated SQLite lock transaction guards the actual workspace directory.
 * The OS releases its lock on process death; no PID file, timeout takeover, or stale-lock deletion.
 * Network filesystems, cross-platform lock behavior and power-loss durability are not qualified.
 */
export async function openRuntime(directory: string, options: RuntimeOptions): Promise<WorkRuntime> {
	let root: string;
	let catalog: StoreCatalog;
	try {
		await mkdir(directory, { recursive: true, mode: 0o700 });
		root = await realpath(directory);
		catalog = await StoreCatalog.open(root, options.presentationFailpoint);
	} catch (error) {
		try {
			options.onDiagnostic?.({ category: "storage", phase: "storage-open" });
		} catch {
			/* Diagnostics cannot replace the original failure. */
		}
		throw error;
	}
	let unsafe = false;
	try {
		configureCustomProviders(options.models, catalog.listCustomProviders().providers);
	} catch (error) {
		await catalog.close();
		throw error;
	}
	const runtime = new WorkRuntime({
		storeId: catalog.storeId,
		refreshConversationSearch: (input, signal) => catalog.refreshConversationSearch(input, signal),
		searchConversations: (input, signal) => catalog.searchConversations(input, signal),
		getHistoryAroundMatch: (input, signal) => catalog.getHistoryAroundMatch(input, signal),
		getConversationPresentation: (input) => catalog.getConversationPresentation(input),
		listPinnedConversations: (input) => catalog.listPinnedConversations(input),
		setConversationPinned: (input) => catalog.setConversationPinned(input),
		getPresentationCommandResult: (input) => catalog.getPresentationCommandResult(input),
		listCustomProviders: async () => catalog.listCustomProviders(),
		listBuiltInProviders: async () => builtInProviderCatalog(),
		getBuiltInProviderModels: async ({ vendorId }) => builtInProviderModels(vendorId),
		saveCustomProvider: async (input) => {
			assertConfigurableModels(options.models);
			const otherModels = options.models.getModels().filter((model) => model.provider !== input.provider);
			if (otherModels.length + input.models.length > 512) throw new AppError("CAPACITY_EXCEEDED");
			const result = catalog.saveCustomProvider(input);
			// Re-read current committed state: an old replay result must never resurrect a removed recipient.
			configureCustomProviders(options.models, catalog.listCustomProviders().providers);
			return result;
		},
		removeCustomProvider: async (input) => {
			assertConfigurableModels(options.models);
			const result = catalog.removeCustomProvider(input);
			configureCustomProviders(options.models, catalog.listCustomProviders().providers);
			return result;
		},
		previewToolPack: (input) => catalog.previewToolPack(input),
		listToolPacks: (input) => catalog.listToolPacks(input),
		getToolPackSource: (input) => catalog.getToolPackSource(input),
		listToolPackBindings: (input) => catalog.listToolPackBindings(input),
		listActiveToolPackBindings: (input) => catalog.listActiveToolPackBindings(input),
		getToolPackCommandResult: (input) => catalog.getToolPackCommandResult(input),
		getToolActivities: (input) => catalog.getToolActivities(input),
		getToolActivityText: (input) => catalog.getToolActivityText(input),
		listModels: async () => ({
			models: options.models
				.getModels()
				.map((model) => ({ provider: model.provider, modelId: model.id, name: model.name })),
			providers: await Promise.all(
				options.models.getProviders().map(async (provider) => ({
					provider: provider.id,
					name: provider.name,
					credentialState: options.credentials
						? await options.credentials.status(provider.id).catch(() => "unavailable" as const)
						: ("configured" as const),
				})),
			),
		}),
		getAgentCommandResult: (input) => catalog.getAgentCommandResult(input),
		getWorkspace: async (input) => catalog.getWorkspace(input),
		getConversation: (input) => catalog.getConversation(input),
		getConversationCommandResult: (input) => catalog.getConversationCommandResult(input),
		listWorkspaces: (input) => catalog.listWorkspaces(input),
		listConversations: (input) => catalog.listConversations(input),
		close: async () => {
			if (unsafe) throw new AppError("WORKSPACE_BUSY");
			configureCustomProviders(options.models, []);
			await catalog.close();
		},
		openWorkspace: async (workspaceId, name, openOptions) => {
			// An unclosed writer pins this owner until process exit; never accumulate more writers.
			if (unsafe) throw new AppError("WORKSPACE_BUSY");
			const requested = join(root, workspaceId);
			if (name !== undefined && !catalog.registered(workspaceId)) {
				catalog.reserve({ workspaceId, name });
				await options.catalogFailpoint?.("after_reserve");
				await mkdir(requested, { recursive: true, mode: 0o700 });
				await options.catalogFailpoint?.("after_directory");
			}
			try {
				if (!(await lstat(requested)).isDirectory()) throw new AppError("NOT_FOUND");
			} catch (error) {
				if (error instanceof AppError) throw error;
				throw new AppError("NOT_FOUND");
			}
			const path = await realpath(requested);
			// No workspace symlink escapes from the trusted application data root.
			if (path !== requested) throw new AppError("INVALID_REQUEST");
			await checkDatabasePath(join(path, "owner.sqlite"));
			await checkDatabasePath(join(path, "workspace.sqlite"));
			const lock = new DatabaseSync(join(path, "owner.sqlite"));
			try {
				lock.exec("PRAGMA busy_timeout=0; BEGIN EXCLUSIVE");
			} catch {
				lock.close();
				throw new AppError("WORKSPACE_BUSY");
			}
			try {
				const storagePath = join(path, "workspace.sqlite");
				if (name === undefined || catalog.registered(workspaceId)) {
					try {
						await stat(storagePath);
					} catch {
						throw new AppError("NOT_FOUND");
					}
				}
				// Request WAL commit synchronization before PI can acknowledge durable work or authorize effects.
				const storage = await openNodeSqliteStorage(storagePath, { synchronous: "FULL" });
				try {
					await options.catalogFailpoint?.("after_storage");
				} catch (error) {
					try {
						await storage.close(BACKGROUND_CONTEXT);
					} catch (failure) {
						throw new WorkspaceShutdownFailed(failure);
					}
					throw error;
				}
				const port = await PiWorkspace.open(storage, {
					...options,
					// Cache reopening is read-only even when test startup explicitly requested resume.
					resume: openOptions?.resume === false ? false : options.resume,
					workspaceId,
					name: catalog.registered(workspaceId) ? undefined : name,
					models: options.models,
				});
				try {
					if (name !== undefined && name !== port.workspace.name) throw new AppError("IDEMPOTENCY_CONFLICT");
					catalog.reserve(port.workspace);
					await options.catalogFailpoint?.("before_ready");
					catalog.ready(port.workspace);
				} catch (error) {
					try {
						await port.close();
					} catch (failure) {
						throw new WorkspaceShutdownFailed(failure);
					}
					throw error;
				}
				let closed = false;
				let closing: Promise<void> | undefined;
				// Keep pre-Restore fencing inside the same ordered lifecycle transition as Archive.
				// This queue owns no execution and does not alter PI's immutable command payloads.
				let archiveTransition: Promise<unknown> = Promise.resolve();
				const changeArchive = (
					method: "archiveConversation" | "restoreConversation",
					input: Params<"archiveConversation">,
				) => {
					const operation = archiveTransition.then(async () => {
						catalog.invalidateConversationSearch(input);
						if (method === "restoreConversation")
							catalog.recordConversationArchive(await port.getConversation(input));
						let result: Conversation;
						try {
							result = await port[method](input);
						} catch (error) {
							catalog.invalidateConversationSearch(input);
							// PI may have committed before an interrupted reply. Inspect, never replay.
							if (method === "archiveConversation") {
								try {
									const receipt = await port.getConversationCommandResult(input);
									if (
										receipt?.method === "archiveConversation" &&
										receipt.result.conversationId === input.conversationId
									)
										catalog.recordConversationArchive(receipt.result);
								} catch {
									// Preserve the original unknown outcome; reads and pre-Restore repair the fence.
								}
							}
							throw error;
						}
						catalog.invalidateConversationSearch(input);
						if (method === "archiveConversation") await catalog.finishConversationArchive(result);
						catalog.recordSearchConversation(result);
						return result;
					});
					archiveTransition = operation.catch(() => undefined);
					return operation;
				};
				return {
					installToolPack: (input) => port.installToolPack(input),
					setToolPackEnabled: (input) => port.setToolPackEnabled(input),
					uninstallToolPack: (input) => port.uninstallToolPack(input),
					bindToolPack: (input) => port.bindToolPack(input),
					revokeToolPackBinding: (input) => port.revokeToolPackBinding(input),
					authorizeRetainedToolPack: (input) => port.authorizeRetainedToolPack(input),
					workspace: port.workspace,
					canEvict: () => port.canEvict(),
					createConversation: async (input) => {
						const result = await port.createConversation(input);
						catalog.recordSearchConversation(result);
						return result;
					},
					getConversation: (input) => port.getConversation(input),
					renameConversation: async (input) => {
						catalog.invalidateConversationSearch(input);
						try {
							const result = await port.renameConversation(input);
							catalog.invalidateConversationSearch(input);
							catalog.recordSearchConversation(result);
							return result;
						} catch (error) {
							catalog.invalidateConversationSearch(input);
							throw error;
						}
					},
					archiveConversation: (input) => changeArchive("archiveConversation", input),
					restoreConversation: (input) => changeArchive("restoreConversation", input),
					getConversationCommandResult: (input) => port.getConversationCommandResult(input),
					listActiveAgentContexts: (input) => port.listActiveAgentContexts(input),
					listPendingToolApprovals: (input) => port.listPendingToolApprovals(input),
					getAgentCommandResult: (input) => port.getAgentCommandResult(input),

					getConversationModel: (scope) => port.getConversationModel(scope),
					continueWorkspace: () => port.continueWorkspace(),
					cancelExecution: (scope) => port.cancelExecution(scope),
					submit: (input) => port.submit(input),
					getReceipt: (requestId) => port.getReceipt(requestId),
					snapshot: (scope) => port.snapshot(scope),
					getHistory: (input) => port.getHistory(input),
					getMessageText: (input) => port.getMessageText(input),
					authorizeAgentContext: (input) => port.authorizeAgentContext(input),
					authorizeRetainedContext: (input) => port.authorizeRetainedContext(input),
					revokeAgentContext: (input) => port.revokeAgentContext(input),
					listAgentContexts: (input) => port.listAgentContexts(input),
					listToolApprovals: (input) => port.listToolApprovals(input),
					decideToolApproval: (input) => port.decideToolApproval(input),
					getFileOperation: (input) => port.getFileOperation(input),
					observe: (scope, listener, signal, onStatus) => port.observe(scope, listener, signal, onStatus),
					close: async () => {
						if (closed) return;
						closing ??= (async () => {
							// Keep ownership if shutdown fails: never unlock a possibly live writer.
							await port.close();
							lock.close();
							closed = true;
						})();
						try {
							await closing;
						} catch (error) {
							closing = undefined;
							throw error;
						}
					},
				};
			} catch (error) {
				if (error instanceof WorkspaceShutdownFailed) {
					retainedOwners.add(lock);
					retainedCatalogs.add(catalog);
					unsafe = true;
				} else lock.close();
				throw error;
			}
		},
	});
	registerRuntimeProjectFolders(runtime, catalog);
	return runtime;
}
