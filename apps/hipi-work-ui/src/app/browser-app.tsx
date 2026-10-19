import type { AppClient } from "@hipi/work-runtime/contracts";
import { createHttpCredentialBridge } from "@hipi/work-runtime/credential-http-client";
import { createHttpFileClient } from "@hipi/work-runtime/files/http-client";
import type { FileClient } from "@hipi/work-runtime/files/protocol";
import { createHttpClient } from "@hipi/work-runtime/http-client";
import { createHttpPreviewClient } from "@hipi/work-runtime/previews/http-client";
import type { PreviewClient } from "@hipi/work-runtime/previews/protocol";
import { useEffect, useId, useRef, useState } from "react";
import { Button } from "../components/ui/button.tsx";
import { Input } from "../components/ui/input.tsx";
import { AppearanceSettings } from "../features/settings/index.ts";
import { Workbench } from "../features/workbench/workbench.tsx";
import { AppClientProvider } from "./client-provider.tsx";
import {
	acquireStoreLease,
	type ConnectionFailure,
	connectionFailure,
	type StoreLease,
	verifyConnection,
} from "./connection.ts";
import { type CredentialClient, createCredentialClient } from "./credential-client.ts";
import { usePreferences } from "./preferences.tsx";

/** Browser composition only. An Electron host can inject an IPC AppClient into the same provider. */
export function BrowserApp() {
	const urlId = useId();
	const tokenId = useId();
	const { t, toggleLocale, toggleTheme } = usePreferences();
	const [connection, setConnection] = useState<{
		client: AppClient;
		files: FileClient;
		previews: PreviewClient;
		credentials: CredentialClient;
		lease: StoreLease;
	} | null>(null);
	const [url, setUrl] = useState("");
	const [token, setToken] = useState("");
	const [failure, setFailure] = useState<ConnectionFailure | null>(null);
	const [connecting, setConnecting] = useState(false);
	const attempt = useRef<AbortController | null>(null);
	const releaseLease = useRef<(() => void) | null>(null);
	useEffect(
		() => () => {
			attempt.current?.abort();
			releaseLease.current?.();
		},
		[],
	);
	const connect = async () => {
		if (attempt.current) return;
		let candidate: AppClient;
		try {
			if (!token.trim()) throw new Error("Missing token");
			candidate = createHttpClient({ url: url.trim(), token: token.trim() });
		} catch {
			setFailure("invalid");
			return;
		}
		const controller = new AbortController();
		attempt.current = controller;
		setConnecting(true);
		setFailure(null);
		try {
			const storeId = await verifyConnection(
				candidate,
				AbortSignal.any([controller.signal, AbortSignal.timeout(10000)]),
			);
			if (controller.signal.aborted || attempt.current !== controller) return;
			const lease = await acquireStoreLease(storeId, navigator.locks);
			if (controller.signal.aborted || attempt.current !== controller) {
				lease.release();
				return;
			}
			releaseLease.current = lease.release;
			setToken("");
			setConnection({
				client: candidate,
				files: createHttpFileClient({ url: url.trim(), token: token.trim(), storeId }),
				previews: createHttpPreviewClient({ url: url.trim(), token: token.trim(), storeId }),
				credentials: createCredentialClient(
					createHttpCredentialBridge({ url: url.trim(), token: token.trim() }),
					"memory",
				),
				lease,
			});
		} catch (error) {
			if (!controller.signal.aborted && attempt.current === controller) setFailure(connectionFailure(error));
		} finally {
			if (attempt.current === controller) {
				attempt.current = null;
				if (!controller.signal.aborted) setConnecting(false);
			}
		}
	};
	if (connection)
		return (
			<AppClientProvider
				client={connection.client}
				files={connection.files}
				previews={connection.previews}
				credentials={connection.credentials}
				lease={connection.lease}
			>
				<Workbench
					disconnect={() => {
						setConnection(null);
						releaseLease.current?.();
						releaseLease.current = null;
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
				<div className="brand">
					<div className="brand-mark" aria-hidden="true">
						H
					</div>
					<span>
						Hipi <strong>Work</strong>
					</span>
				</div>
				<p className="eyebrow">{t("app.phase")}</p>
				<h1>{t("connection.title")}</h1>
				<p className="small-copy">{t("connection.description")}</p>
				<form
					className="grid gap-4"
					onSubmit={(event) => {
						event.preventDefault();
						void connect();
					}}
				>
					<label className="field" htmlFor={urlId}>
						{t("connection.url")}
						<Input
							id={urlId}
							name="runtime-url"
							type="url"
							required
							disabled={connecting}
							value={url}
							placeholder={t("connection.urlPlaceholder")}
							onChange={(event) => setUrl(event.target.value)}
							autoComplete="off"
							spellCheck={false}
						/>
					</label>
					<label className="field" htmlFor={tokenId}>
						{t("connection.token")}
						<Input
							id={tokenId}
							name="runtime-token"
							type="password"
							required
							disabled={connecting}
							value={token}
							onChange={(event) => setToken(event.target.value)}
							autoComplete="off"
							spellCheck={false}
						/>
					</label>
					{failure && (
						<p role="alert" className="error-text">
							{t(`connection.${failure}`)}
						</p>
					)}
					<Button type="submit" disabled={connecting} aria-busy={connecting}>
						{t(connecting ? "connection.connecting" : "connection.connect")}
					</Button>
				</form>
				<p className="small-copy">
					{t("connection.origin")}: {window.location.origin}
				</p>
				<p className="small-copy">{t("connection.originHint")}</p>
				<p className="model-label">{t("app.model")}</p>
				<p className="small-copy">{t("app.modelNote")}</p>
			</section>
		</main>
	);
}
