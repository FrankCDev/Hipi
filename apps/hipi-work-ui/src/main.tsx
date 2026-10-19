import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { BrowserApp } from "./app/browser-app.tsx";
import { DesktopApp } from "./app/desktop-app.tsx";
import { PreferencesProvider } from "./app/preferences.tsx";
import "./theme.css";

const root = document.getElementById("root");
if (!root) throw new Error("Missing application root");
createRoot(root).render(
	<StrictMode>
		<PreferencesProvider>
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
		</PreferencesProvider>
	</StrictMode>,
);
