import { randomUUID } from "node:crypto";
import { writeSync } from "node:fs";
import { release } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createNodeLogger, type OperationalLogger } from "@hipi/work-logging";
import { AppearanceError } from "@hipi/work-runtime/appearance";
import { AppError, parseRequest } from "@hipi/work-runtime/contracts";
import { FileServiceError } from "@hipi/work-runtime/files";
import { parseFileRequest } from "@hipi/work-runtime/files/protocol";
import { PREVIEW_LIMITS, type PreviewRequest, parsePreviewResponse } from "@hipi/work-runtime/previews/protocol";
import {
	app,
	BrowserWindow,
	dialog,
	type IpcMainEvent,
	ipcMain,
	Menu,
	MenuItem,
	type MessageBoxOptions,
	nativeTheme,
	protocol,
	type SaveDialogOptions,
	safeStorage,
	session,
	utilityProcess,
} from "electron";
import {
	APPEARANCE_CHANNEL,
	APPEARANCE_UPDATED,
	decodeAppearanceRequest,
	decodeFontRequest,
	FONT_CANCEL_CHANNEL,
	FONT_CHANNEL,
} from "./appearance/protocol.ts";
import { WindowAppearanceService } from "./appearance/service.ts";
import { type CredentialCryptoStage, createCredentialCrypto } from "./credentials/crypto.ts";
import { CREDENTIAL_CHANNEL, credentialRequest } from "./credentials/protocol.ts";
import { type CredentialStatusStage, CredentialStore } from "./credentials/store.ts";
import { DevelopmentLifecycle, developmentControl } from "./development/control.ts";
import { prepareDevelopment } from "./development/launch.ts";
import { diagnosticMessages } from "./diagnostics/messages.ts";
import {
	DesktopDiagnostics,
	DiagnosticExporter,
	finishFailedStartup,
	writeDiagnosticFile,
} from "./diagnostics/service.ts";
import { chooseProjectDirectory, filePickerLabels } from "./files/messages.ts";
import { manageFileRoots, ProjectFolderSelections } from "./files/picker.ts";
import { FILE_CHANNEL, FILE_ROOT_CHANNEL } from "./files/protocol.ts";
import { FontRequests } from "./fonts/requests.ts";
import { NativeFontService } from "./fonts/service.ts";
import { CHANNEL, decode, encode, exact, identifier, MAX_ACTIVE, observation } from "./ipc/protocol.ts";
import { trustedSender } from "./ipc/sender.ts";
import { prepareDesktopLaunch } from "./launch/profile.ts";
import { smokeRuntimeArguments } from "./launch/smoke-fixture.ts";
import { PREVIEW_CANCEL_CHANNEL, PREVIEW_CHANNEL, previewInvocation } from "./previews/protocol.ts";
import type { HostConnection } from "./runtime/connection.ts";
import { runtimeResource } from "./runtime/resource.ts";
import { RuntimeSupervisor } from "./runtime/supervisor.ts";
import { hostMessages } from "./shell/messages.ts";
import { createRendererAssetHandler } from "./shell/renderer-assets.ts";
import { WindowLifecycle } from "./shell/window-lifecycle.ts";

declare const HIPI_DESKTOP_DEV: boolean;
let PAGE = "hipi-work://app/index.html";
let development: ReturnType<typeof prepareDevelopment> | undefined;
const root = dirname(fileURLToPath(import.meta.url));
protocol.registerSchemesAsPrivileged([
	{ scheme: "hipi-work", privileges: { standard: true, secure: true, supportFetchAPI: true } },
]);
const diagnostics = new DesktopDiagnostics();
const exporter = new DiagnosticExporter();
let logger: OperationalLogger | undefined;
let runtimeGeneration: string | undefined;
let supervisor: RuntimeSupervisor | undefined;
let startupWindow: BrowserWindow | undefined;
let recoveringStartup = false;
let diagnosticText = diagnosticMessages(Intl.DateTimeFormat().resolvedOptions().locale);
function showDiagnosticMessage(window: BrowserWindow | undefined, options: MessageBoxOptions) {
	return window ? dialog.showMessageBox(window, options) : dialog.showMessageBox(options);
}
function showDiagnosticSave(window: BrowserWindow | undefined, options: SaveDialogOptions) {
	return window ? dialog.showSaveDialog(window, options) : dialog.showSaveDialog(options);
}
let diagnosticNotice = false;
const exportDiagnostics = async (window?: BrowserWindow) => {
	const outcome = await exporter.export({
		snapshot: () =>
			diagnostics.serialize(
				{
					productVersion: app.getVersion(),
					electronVersion: process.versions.electron,
					nodeVersion: process.versions.node,
					platform: process.platform,
					arch: process.arch,
				},
				supervisor?.diagnosticState() ?? "idle",
			),
		preview: async (content) =>
			(
				await showDiagnosticMessage(window, {
					title: diagnosticText["diagnostics.title"],
					message: diagnosticText["diagnostics.preview"],
					detail: `${diagnosticText["diagnostics.scope"]}\n\n${content}`,
					buttons: [diagnosticText["diagnostics.save"], diagnosticText["diagnostics.cancel"]],
					defaultId: 1,
					cancelId: 1,
					noLink: true,
				})
			).response === 0,
		pick: async () => {
			const result = await showDiagnosticSave(window, {
				title: diagnosticText["diagnostics.title"],
				defaultPath: "hipi-work-diagnostics.json",
				filters: [{ name: "JSON", extensions: ["json"] }],
			});
			return result.canceled ? null : (result.filePath ?? null);
		},
		write: writeDiagnosticFile,
	});
	logger?.record("diagnostics.export", { outcome });
	if (outcome === "failed") diagnostics.record("EXPORT_FAILED");
	if (outcome === "write-unknown") diagnostics.record("EXPORT_WRITE_UNKNOWN");
	if (
		!diagnosticNotice &&
		(!window || !window.isDestroyed()) &&
		["saved", "failed", "write-unknown", "busy"].includes(outcome)
	) {
		diagnosticNotice = true;
		await showDiagnosticMessage(window, {
			title: diagnosticText["diagnostics.title"],
			message:
				diagnosticText[
					outcome === "busy"
						? "diagnostics.busy"
						: outcome === "saved"
							? "diagnostics.saved"
							: outcome === "failed"
								? "diagnostics.failed"
								: "diagnostics.unknown"
				],
		})
			.catch(() => undefined)
			.finally(() => {
				diagnosticNotice = false;
			});
	}
};

let launch: ReturnType<typeof prepareDesktopLaunch> | undefined;
try {
	if (typeof HIPI_DESKTOP_DEV !== "undefined" && HIPI_DESKTOP_DEV) {
		development = prepareDevelopment(app, process.argv, process.env.HIPI_WORK_DEV_TOKEN);
		PAGE = development.page;
	}
	launch = prepareDesktopLaunch(app, process.argv);
} catch {
	// Invalid launch arguments must not acquire a lock or initialize a default session.
	diagnostics.record("HOST_STARTUP_FAILED");
	exporter.close();
	dialog.showErrorBox("Hipi Work", hostMessages(Intl.DateTimeFormat().resolvedOptions().locale)["host.startup.failed"]);
	app.exit(1);
}
if (launch && !launch.hasLock) app.exit(0);
else if (launch)
	void start(launch.mode).catch(async () => {
		logger?.record("app.failed", { stage: "host" });
		diagnostics.record("HOST_STARTUP_FAILED");
		recoveringStartup = true;
		// The native recovery UI stays alive until actual utility exit; a failed close is not clean shutdown.
		app.on("before-quit", (event) => event.preventDefault());
		if (startupWindow && !startupWindow.isDestroyed()) startupWindow.destroy();
		await finishFailedStartup({
			stop: () => supervisor?.close() ?? Promise.resolve(false),
			review: async () => {
				try {
					await app.whenReady();
				} catch {
					dialog.showErrorBox(
						"Hipi Work",
						hostMessages(Intl.DateTimeFormat().resolvedOptions().locale)["host.startup.failed"],
					);
					return;
				}
				diagnosticText = diagnosticMessages(app.getLocale());
				const text = hostMessages(app.getLocale());
				const choice = await dialog.showMessageBox({
					type: "error",
					title: "Hipi Work",
					message: text["host.startup.failed"],
					buttons: [diagnosticText["diagnostics.menu"], diagnosticText["diagnostics.exit"]],
					defaultId: 1,
					cancelId: 1,
					noLink: true,
				});
				if (choice.response === 0) await exportDiagnostics();
			},
			exit: async () => {
				exporter.close();
				await logger?.close();
				app.exit(1);
			},
		}).catch(() => {
			dialog.showErrorBox("Hipi Work", hostMessages(app.isReady() ? app.getLocale() : "en")["host.shutdown.unknown"]);
		});
	});

async function start(mode: "production" | "deterministic") {
	let developmentLifecycle: DevelopmentLifecycle | undefined;
	let developmentPipe: ReturnType<typeof developmentControl> | undefined;
	if (typeof HIPI_DESKTOP_DEV !== "undefined" && HIPI_DESKTOP_DEV) {
		developmentLifecycle = new DevelopmentLifecycle(
			() => supervisor?.close() ?? Promise.resolve(true),
			async (clean) => {
				logger?.record("app.stop", { outcome: clean ? "clean" : "unclean" });
				await logger?.close();
				app.exit(clean ? 0 : 1);
			},
		);
		const lifecycle = developmentLifecycle;
		developmentPipe = developmentControl(() => {
			void lifecycle.quit().catch(() => {
				// An unconfirmed runtime close must never report a clean exit or release its ownership.
				logger?.record("app.failed", { stage: "runtime-close" });
			});
		});
		app.once("will-quit", developmentPipe.dispose);
	}
	await app.whenReady();
	if (developmentLifecycle?.cancelled) return;
	logger = createNodeLogger({ role: "main", directory: app.getPath("logs"), console: Boolean(development) });
	logger.record("app.start");
	const text = hostMessages(app.getLocale());
	diagnosticText = diagnosticMessages(app.getLocale());
	// start is reached only after prepareDesktopLaunch validates the isolated smoke profile.
	const credentialStages = new Set<CredentialStatusStage | CredentialCryptoStage>([
		"status-enter",
		"availability-enter",
		"availability-return",
		"file-read-enter",
		"file-read-return",
		"status-return",
		"async-ready-enter",
		"async-ready-return",
		"probe-encrypt-enter",
		"probe-encrypt-return",
		"probe-decrypt-enter",
		"probe-decrypt-return",
	]);
	const smokeDiagnostics =
		mode === "deterministic" && process.argv.some((argument) => argument.startsWith("--smoke-data-root="));
	const observeCredential = smokeDiagnostics
		? (stage: CredentialStatusStage | CredentialCryptoStage) => {
				if (!credentialStages.delete(stage)) return;
				// Flush at most twelve fixed lines. Both observers isolate write failures.
				writeSync(2, `[Hipi smoke credential-status] ${stage}\n`);
			}
		: undefined;
	const credentials = new CredentialStore(
		join(app.getPath("userData"), "credentials", "providers.enc"),
		createCredentialCrypto(safeStorage, process.platform, observeCredential),
		process.platform,
		undefined,
		observeCredential,
	);
	type LifecycleStage =
		| "quit-request"
		| "window-closed"
		| "runtime-close-enter"
		| "runtime-close-return"
		| "app-exit-enter";
	const lifecycleStages = new Set<LifecycleStage>([
		"quit-request",
		"window-closed",
		"runtime-close-enter",
		"runtime-close-return",
		"app-exit-enter",
	]);
	const observeLifecycle = (stage: LifecycleStage) => {
		if (!smokeDiagnostics || !lifecycleStages.delete(stage)) return;
		try {
			writeSync(2, `[Hipi smoke host-lifecycle] ${stage}\n`);
		} catch {
			// Diagnostic output failure must not prevent normal application shutdown.
		}
	};
	const assets = resolve(root, "renderer");
	protocol.handle("hipi-work", createRendererAssetHandler(assets));
	session.defaultSession.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
	session.defaultSession.setPermissionCheckHandler(() => false);
	supervisor = new RuntimeSupervisor(
		(generation) => {
			runtimeGeneration = generation;
			logger?.record("runtime.start", { generation });
			return utilityProcess.fork(
				runtimeResource(root),
				smokeRuntimeArguments(join(app.getPath("userData"), `${mode}-store`), generation, mode, process.argv),
				{
					serviceName: "Hipi Work runtime",
					stdio: "ignore",
				},
			);
		},
		(event) => {
			logger?.record(event === "shutdown-timeout" ? "runtime.shutdown-timeout" : "runtime.unavailable", {
				generation: runtimeGeneration,
			});
			diagnostics.record(event === "shutdown-timeout" ? "SHUTDOWN_TIMEOUT" : "RUNTIME_UNAVAILABLE");
			if (event === "shutdown-timeout") dialog.showErrorBox("Hipi Work", text["host.shutdown.unknown"]);
		},
		credentials,
		(diagnostic) => {
			diagnostics.recordRuntime(diagnostic);
			logger?.record("runtime.diagnostic", {
				stage: diagnostic.phase,
				category: diagnostic.category,
				generation: runtimeGeneration,
			});
		},
	);
	const activeSupervisor = supervisor;
	try {
		await activeSupervisor.start();
	} catch (error) {
		if (developmentLifecycle?.cancelled) return;
		throw error;
	}
	if (developmentLifecycle?.cancelled) return;
	logger.record("runtime.ready", { generation: runtimeGeneration });
	const window = new BrowserWindow({
		icon: join(root, "branding/icon.png"),
		width: 1400,
		height: 900,
		minWidth: 800,
		minHeight: 600,
		title: mode === "deterministic" ? text["host.provider.deterministic"] : "Hipi Work",
		webPreferences: {
			preload: join(root, "preload.cjs"),
			nodeIntegration: false,
			contextIsolation: true,
			sandbox: true,
			webSecurity: true,
			webviewTag: false,
			navigateOnDragDrop: false,
		},
	});
	startupWindow = window;
	// Preserve the host's existing menu and append only this explicit user action.
	const menu = Menu.getApplicationMenu() ?? new Menu();
	const help = menu.items.find((item) => item.role === "help")?.submenu;
	const diagnosticItem = new MenuItem({
		label: diagnosticText["diagnostics.menu"],
		click: () => {
			void exportDiagnostics(window).catch(() => diagnostics.record("EXPORT_FAILED"));
		},
	});
	if (help) help.append(diagnosticItem);
	else {
		const submenu = new Menu();
		submenu.append(diagnosticItem);
		menu.append(new MenuItem({ label: diagnosticText["diagnostics.help"], submenu }));
	}
	Menu.setApplicationMenu(menu);
	window.once("closed", () => {
		if (!recoveringStartup) exporter.close();
	});
	const owner = window.webContents;
	const appearance = new WindowAppearanceService(
		window,
		process.platform,
		release(),
		() => nativeTheme.prefersReducedTransparency,
		nativeTheme,
	);
	const fonts = new NativeFontService(process.platform);
	const fontRequests = new FontRequests((signal) => fonts.list(signal));
	ipcMain.handle(APPEARANCE_CHANNEL, (event, raw: unknown) => {
		if (!trustedSender(event, owner, PAGE)) return { ok: false, error: "DENIED" };
		try {
			return { ok: true, result: appearance.request(decodeAppearanceRequest(raw)) };
		} catch (error) {
			return { ok: false, error: error instanceof AppearanceError ? error.code : "FAILED" };
		}
	});
	ipcMain.handle(FONT_CHANNEL, async (event, raw: unknown) => {
		if (!trustedSender(event, owner, PAGE)) return { ok: false, error: "DENIED" };
		try {
			const id = decodeFontRequest(raw);
			const result = await fontRequests.request(id, () => !owner.isDestroyed() && trustedSender(event, owner, PAGE));
			return { ok: true, result };
		} catch (error) {
			return { ok: false, error: error instanceof AppearanceError ? error.code : "FAILED" };
		}
	});
	const cancelFontAccess = (event: IpcMainEvent, raw: unknown) => {
		if (!trustedSender(event, owner, PAGE)) return;
		try {
			fontRequests.cancel(decodeFontRequest(raw));
		} catch {
			/* A malformed cancellation cannot address an owned child. */
		}
	};
	ipcMain.on(FONT_CANCEL_CHANNEL, cancelFontAccess);
	const appearanceUpdated = () => {
		try {
			const status = appearance.refresh();
			if (!owner.isDestroyed() && owner.mainFrame.url === PAGE) owner.send(APPEARANCE_UPDATED, status);
		} catch {
			// Closed windows cannot receive appearance updates.
		}
	};
	nativeTheme.on("updated", appearanceUpdated);
	owner.once("destroyed", () => {
		fontRequests.reset();
		nativeTheme.off("updated", appearanceUpdated);
		ipcMain.removeHandler(APPEARANCE_CHANNEL);
		ipcMain.removeHandler(FONT_CHANNEL);
		ipcMain.removeListener(FONT_CANCEL_CHANNEL, cancelFontAccess);
	});
	let rendererLifetime = 0;
	const projectSelections = new ProjectFolderSelections();
	let fileCalls = 0;
	let picking = false;
	for (const channel of [FILE_CHANNEL, FILE_ROOT_CHANNEL])
		ipcMain.handle(channel, async (event, raw: unknown) => {
			if (!trustedSender(event, owner, PAGE)) return { ok: false, error: "UNAUTHORIZED" };
			if (fileCalls >= MAX_ACTIVE) return { ok: false, error: "BUSY" };
			fileCalls++;
			const lifetime = rendererLifetime;
			try {
				if (channel === FILE_CHANNEL)
					return await activeSupervisor
						.connection()
						.files.call({ operation: "request", request: parseFileRequest(decode(raw)) });
				const result = await manageFileRoots(
					decode(raw),
					() => activeSupervisor.connection().files,
					() => lifetime === rendererLifetime && !owner.isDestroyed() && trustedSender(event, owner, PAGE),
					async (writable, project, locale) => {
						if (picking) throw new FileServiceError("BUSY");
						picking = true;
						try {
							const selected = await dialog.showOpenDialog(window, {
								properties: ["openDirectory"],
								...(project ? chooseProjectDirectory(locale ?? "en") : filePickerLabels(app.getLocale(), writable)),
							});
							return selected.canceled ? null : (selected.filePaths[0] ?? null);
						} finally {
							picking = false;
						}
					},
					projectSelections,
				);
				return { ok: true, result };
			} catch (error) {
				return {
					ok: false,
					error:
						error instanceof FileServiceError
							? error.code
							: error instanceof AppError && error.code === "CLOSED"
								? "CLOSED"
								: "IO_ERROR",
				};
			} finally {
				fileCalls--;
			}
		});
	const previewCalls = new Map<string, () => void>();
	const previewHandles = new Map<string, { connection: HostConnection; storeId: string }>();
	const releasePreview = (id: string, connection: HostConnection, storeId: string) => {
		try {
			void connection.previews
				.call({ version: 1, expectedStoreId: storeId, method: "close", params: { id } })
				.result.catch(() => undefined);
		} catch {
			/* Utility shutdown owns any remaining cache. */
		}
	};
	ipcMain.handle(PREVIEW_CHANNEL, async (event, raw: unknown) => {
		if (!trustedSender(event, owner, PAGE)) return { ok: false, error: "UNAUTHORIZED" };
		let request: PreviewRequest | undefined;
		try {
			const input = previewInvocation(decode(raw));
			const id = input.id;
			request = input.request;
			if (previewCalls.size >= MAX_ACTIVE) throw new FileServiceError("BUSY");
			if (previewCalls.has(id)) throw new FileServiceError("INVALID_PATH");
			const lifetime = rendererLifetime;
			const connection = activeSupervisor.connection();
			const pending = connection.previews.call(request);
			previewCalls.set(id, pending.cancel);
			try {
				const result = parsePreviewResponse(await pending.result, request);
				if (result.ok && result.result && request.method === "open") {
					if (lifetime === rendererLifetime) {
						// Utility TTL expiry is not an event; keep renderer cleanup bookkeeping bounded too.
						while (previewHandles.size >= PREVIEW_LIMITS.handles) {
							const oldest = previewHandles.entries().next().value;
							if (!oldest) break;
							previewHandles.delete(oldest[0]);
							releasePreview(oldest[0], oldest[1].connection, oldest[1].storeId);
						}
						previewHandles.set(result.result.id, { connection, storeId: request.expectedStoreId });
					} else releasePreview(result.result.id, connection, request.expectedStoreId);
				}
				if (result.ok && request.method === "close") previewHandles.delete(request.params.id);
				if (
					lifetime !== rendererLifetime ||
					!trustedSender(event, owner, PAGE) ||
					connection !== activeSupervisor.connection()
				)
					throw new FileServiceError("CLOSED");
				return result;
			} finally {
				if (previewCalls.get(id) === pending.cancel) previewCalls.delete(id);
			}
		} catch (error) {
			return {
				...(request ? { version: 1, storeId: request.expectedStoreId, request } : {}),
				ok: false,
				error: error instanceof FileServiceError ? error.code : "CLOSED",
			};
		}
	});
	ipcMain.on(PREVIEW_CANCEL_CHANNEL, (event, raw: unknown) => {
		if (!trustedSender(event, owner, PAGE)) return;
		try {
			const value = decode(raw);
			exact(value, ["id"]);
			previewCalls.get(identifier(value.id))?.();
		} catch {
			/* Invalid cancellation cannot address another capability. */
		}
	});
	let credentialCalls = 0;
	ipcMain.handle(CREDENTIAL_CHANNEL, async (event, raw: unknown) => {
		if (!trustedSender(event, owner, PAGE)) return { ok: false, error: "UNAUTHORIZED" };
		if (credentialCalls >= MAX_ACTIVE) return { ok: false, error: "CAPACITY_EXCEEDED" };
		credentialCalls++;
		try {
			const request = credentialRequest(decode(raw));
			if (request.operation === "set") await credentials.set(request.provider, request.secret);
			if (request.operation === "remove") await credentials.remove(request.provider);
			return { ok: true, state: await credentials.status(request.provider) };
		} catch (error) {
			return { ok: false, error: error instanceof AppError ? error.code : "INTERNAL" };
		} finally {
			credentialCalls--;
		}
	});
	const calls = new Set<() => void>();
	const subscriptions = new Map<string, { ack(): void; dispose(): void }>();
	const clearRenderer = () => {
		rendererLifetime++;
		projectSelections.clear();
		fontRequests.reset();
		try {
			appearance.reset();
		} catch {
			// Renderer teardown must continue even if the OS rejects a material update.
		}
		for (const cancel of previewCalls.values()) cancel();
		previewCalls.clear();
		for (const [id, handle] of previewHandles) releasePreview(id, handle.connection, handle.storeId);
		previewHandles.clear();
		for (const cancel of calls) cancel();
		calls.clear();
		for (const entry of subscriptions.values()) entry.dispose();
		subscriptions.clear();
	};
	const send = (id: string, value: object) => {
		if (!owner.isDestroyed() && owner.mainFrame.url === PAGE) owner.send(CHANNEL, encode({ id, ...value }));
	};
	ipcMain.handle(CHANNEL, async (event, raw: unknown) => {
		const requestId = randomUUID();
		const started = performance.now();
		const generation = runtimeGeneration;
		if (!trustedSender(event, owner, PAGE)) return { ok: false, error: "UNAUTHORIZED" };
		if (calls.size >= MAX_ACTIVE) return { ok: false, error: "CAPACITY_EXCEEDED" };
		try {
			const pending = activeSupervisor.connection().call(parseRequest(decode(raw)));
			calls.add(pending.cancel);
			try {
				const result = await pending.result;
				logger?.record("ok" in result && result.ok === false ? "request.failed" : "request.completed", {
					requestId,
					generation,
					durationMs: performance.now() - started,
				});
				return result;
			} finally {
				calls.delete(pending.cancel);
			}
		} catch (error) {
			logger?.record("request.failed", {
				requestId,
				generation,
				durationMs: performance.now() - started,
				stage: "dispatch",
			});
			return { ok: false, error: error instanceof AppError ? error.code : "INTERNAL" };
		}
	});
	ipcMain.on(CHANNEL, (event, raw: unknown) => {
		if (!trustedSender(event, owner, PAGE)) return;
		let id: string | undefined;
		try {
			const message = decode(raw);
			id = identifier(message.id);
			if (message.kind === "ack" || message.kind === "cancel") {
				exact(message, ["kind", "id"]);
				const current = subscriptions.get(id);
				if (message.kind === "ack") current?.ack();
				else {
					subscriptions.delete(id);
					current?.dispose();
				}
				return;
			}
			exact(message, ["kind", "id", "input"]);
			if (message.kind !== "observe" || subscriptions.has(id)) throw new AppError("INVALID_REQUEST");
			if (subscriptions.size >= MAX_ACTIVE) throw new AppError("CAPACITY_EXCEEDED");
			const subscriptionId = id;
			subscriptions.set(
				id,
				activeSupervisor.connection().observe(observation(message.input), (value) => {
					const eventValue = value as { kind: string };
					if (eventValue.kind === "status") subscriptions.delete(subscriptionId);
					send(subscriptionId, value);
				}),
			);
		} catch (error) {
			if (id)
				send(id, {
					kind: "status",
					status: { state: "closed", reason: "error", code: error instanceof AppError ? error.code : "INTERNAL" },
				});
		}
	});
	owner.setWindowOpenHandler(() => ({ action: "deny" }));
	owner.on("will-navigate", (event) => event.preventDefault());
	owner.on("will-frame-navigate", (event) => event.preventDefault());
	owner.on("will-attach-webview", (event) => event.preventDefault());
	owner.on("did-start-navigation", (_event, _url, _inPlace, isMainFrame) => {
		if (isMainFrame) clearRenderer();
	});
	owner.on("render-process-gone", () => {
		diagnostics.record("RENDERER_GONE");
		logger?.record("renderer.gone");
		clearRenderer();
	});
	owner.once("destroyed", clearRenderer);
	app.on("second-instance", () => {
		if (!window.isDestroyed()) {
			window.restore();
			window.focus();
		}
	});
	owner.on("will-prevent-unload", (event) => {
		const choice = dialog.showMessageBoxSync(window, {
			type: "warning",
			buttons: [text["host.unsaved.discard"], text["host.unsaved.keep"]],
			defaultId: 1,
			cancelId: 1,
			noLink: true,
			message: text["host.unsaved.message"],
			detail: text["host.unsaved.detail"],
		});
		if (choice === 0) event.preventDefault();
	});
	const lifecycle = new WindowLifecycle(
		() => {
			if (!window.isDestroyed()) window.close();
		},
		() => {
			clearRenderer();
			observeLifecycle("runtime-close-enter");
			return activeSupervisor.close().then((clean) => {
				observeLifecycle("runtime-close-return");
				return clean;
			});
		},
	);
	app.on("before-quit", (event) => {
		observeLifecycle("quit-request");
		event.preventDefault();
		lifecycle.requestQuit();
	});
	window.once("closed", () => {
		observeLifecycle("window-closed");
		void lifecycle.windowClosed().then(async (clean) => {
			if (!recoveringStartup) {
				observeLifecycle("app-exit-enter");
				logger?.record("app.stop", { outcome: clean ? "clean" : "unclean" });
				await logger?.close();
				app.exit(clean ? 0 : 1);
			}
		});
	});
	app.on("window-all-closed", () => {});
	developmentLifecycle?.windowReady(() => app.quit());
	try {
		await window.loadURL(PAGE);
	} catch (error) {
		if (developmentLifecycle?.cancelled) return;
		throw error;
	}
	if (developmentLifecycle?.cancelled) return;
	logger.record("app.ready");
	startupWindow = undefined;
	if (typeof HIPI_DESKTOP_DEV !== "undefined" && HIPI_DESKTOP_DEV) {
		developmentPipe?.ready();
		owner.openDevTools({ mode: "detach" });
	}
}
