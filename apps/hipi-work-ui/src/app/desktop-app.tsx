import type { AppClient } from "@hipi/work-runtime/contracts";
import { useEffect, useMemo, useState } from "react";
import { Button } from "../components/ui/button.tsx";
import { AppearanceSettings } from "../features/settings/index.ts";
import { Workbench } from "../features/workbench/workbench.tsx";
import { AppClientProvider } from "./client-provider.tsx";
import { acquireStoreLease, type StoreLease, verifyConnection } from "./connection.ts";
import { type CredentialBridge, createCredentialClient } from "./credential-client.ts";
import { createDesktopClient, type DesktopBridge } from "./desktop-client.ts";
import { type DesktopFileBridge, desktopFiles } from "./file-client.ts";
import { usePreferences } from "./preferences.tsx";
import { type DesktopPreviewBridge, desktopPreviews } from "./preview-client.ts";

/** Desktop composition only: features receive the same AppClient used in a browser. */
export function DesktopApp({
	bridge,
	credentialBridge,
	fileBridge,
	previewBridge,
}: {
	bridge: DesktopBridge;
	credentialBridge?: CredentialBridge;
	fileBridge?: DesktopFileBridge;
	previewBridge?: DesktopPreviewBridge;
}) {
	const credentials = useMemo(
		() => (credentialBridge ? createCredentialClient(credentialBridge) : undefined),
		[credentialBridge],
	);
	const { t, toggleLocale, toggleTheme } = usePreferences();
	const [generation, setGeneration] = useState(0);
	const [enabled, setEnabled] = useState(true);
	const [connection, setConnection] = useState<{ client: AppClient; lease: StoreLease; generation: number } | null>(
		null,
	);
	const filePorts = useMemo(
		() => (connection && fileBridge ? desktopFiles(fileBridge, connection.lease.storeId) : {}),
		[connection, fileBridge],
	);
	const [failed, setFailed] = useState(false);
	const previews = useMemo(
		() => (connection && previewBridge ? desktopPreviews(previewBridge, connection.lease.storeId) : undefined),
		[connection, previewBridge],
	);
	useEffect(() => {
		if (!enabled) return;
		const controller = new AbortController();
		let lease: StoreLease | undefined;
		const connect = async () => {
			try {
				const client = createDesktopClient(bridge);
				const storeId = await verifyConnection(client, controller.signal);
				if (controller.signal.aborted) return;
				lease = await acquireStoreLease(storeId, navigator.locks);
				if (controller.signal.aborted) {
					lease.release();
					return;
				}
				setConnection({ client, lease, generation });
			} catch {
				if (!controller.signal.aborted) setFailed(true);
			}
		};
		void connect();
		return () => {
			controller.abort();
			lease?.release();
		};
	}, [bridge, generation, enabled]);
	if (connection)
		return (
			<AppClientProvider
				key={connection.generation}
				client={connection.client}
				credentials={credentials}
				previews={previews}
				{...filePorts}
				lease={connection.lease}
			>
				<Workbench
					disconnect={() => {
						setConnection(null);
						setEnabled(false);
						connection.lease.release();
					}}
				/>
			</AppClientProvider>
		);
	return (
		<main className="connect-page">
			<div className="connect-toolbar">
				<AppearanceSettings />
				<Button variant="ghost" onClick={toggleLocale}>
					{t("settings.language")}
				</Button>
				<Button variant="ghost" onClick={toggleTheme}>
					{t("settings.theme")}
				</Button>
			</div>
			<section className="connect-card">
				<h1>Hipi Work</h1>
				<p className="eyebrow">{t("desktop.title")}</p>
				{failed ? (
					<p role="alert" className="error-text">
						{t("desktop.failed")}
					</p>
				) : (
					<output>{t(enabled ? "connection.connecting" : "desktop.disconnected")}</output>
				)}
				{(failed || !enabled) && (
					<Button
						onClick={() => {
							setFailed(false);
							setEnabled(true);
							setGeneration((value) => value + 1);
						}}
					>
						{t("connection.reconnect")}
					</Button>
				)}

				<p className="small-copy">{t("model.runtimeNote")}</p>
			</section>
		</main>
	);
}
