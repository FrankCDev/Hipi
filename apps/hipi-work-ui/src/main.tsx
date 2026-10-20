import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { createAppearanceClient } from "./app/appearance-client.ts";
import { AppearanceProvider } from "./app/appearance-provider.tsx";
import { BrowserApp } from "./app/browser-app.tsx";
import { DesktopApp } from "./app/desktop-app.tsx";
import { PreferencesProvider } from "./app/preferences.tsx";
import "./theme.css";
import "./app/theme/native-appearance.css";

const root = document.getElementById("root");
if (!root) throw new Error("Missing application root");
const appearance = createAppearanceClient(window.hipiWorkAppearance);
createRoot(root).render(
	<StrictMode>
		<PreferencesProvider>
			<AppearanceProvider client={appearance}>
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
			</AppearanceProvider>
		</PreferencesProvider>
	</StrictMode>,
);
