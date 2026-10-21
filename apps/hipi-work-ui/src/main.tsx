import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { createAppearanceClient } from "./app/appearance-client.ts";
import { AppearanceProvider } from "./app/appearance-provider.tsx";
import { BrowserApp } from "./app/browser-app.tsx";
import { DesktopApp } from "./app/desktop-app.tsx";
import { createExternalLinkClient } from "./app/external-link-client.ts";
import { ExternalLinkProvider } from "./app/external-link-provider.tsx";
import { PreferencesProvider } from "./app/preferences.tsx";
import "./theme.css";
import "./app/theme/native-appearance.css";

const root = document.getElementById("root");
if (!root) throw new Error("Missing application root");
const appearance = createAppearanceClient(window.hipiWorkAppearance);
const externalLinks = createExternalLinkClient(window.hipiWorkDesktop ? window.hipiWorkExternalLinks : undefined);
createRoot(root).render(
	<StrictMode>
		<PreferencesProvider>
			<AppearanceProvider client={appearance}>
				<ExternalLinkProvider client={externalLinks}>
					{window.hipiWorkDesktop ? (
						<DesktopApp
							bridge={window.hipiWorkDesktop}
							credentialBridge={window.hipiWorkCredentials}
							fileBridge={window.hipiWorkFiles}
							previewBridge={window.hipiWorkPreviews}
						/>
					) : (
						<BrowserApp />
					)}
				</ExternalLinkProvider>
			</AppearanceProvider>
		</PreferencesProvider>
	</StrictMode>,
);
