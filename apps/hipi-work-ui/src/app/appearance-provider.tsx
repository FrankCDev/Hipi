import {
	type AppearanceClient,
	AppearanceError,
	type AppearanceErrorCode,
	type AppearanceStatus,
} from "@hipi/work-runtime/appearance";
import { createContext, type ReactNode, useContext, useEffect, useState } from "react";
import { nativeSidebarTints } from "./theme/backdrop-tint.ts";
import { useThemeSettings } from "./theme/provider.tsx";

type State = {
	client?: AppearanceClient;
	status?: AppearanceStatus;
	error?: AppearanceErrorCode;
	contrastOpaque?: boolean;
};
const Context = createContext<State>({});
export function AppearanceProvider({ client, children }: { client: AppearanceClient; children: ReactNode }) {
	const { config } = useThemeSettings();
	const [state, setState] = useState<State>({ client });
	const [dark, setDark] = useState(() => window.matchMedia?.("(prefers-color-scheme: dark)").matches ?? false);
	useEffect(() => {
		let active = true;
		const media = window.matchMedia?.("(prefers-color-scheme: dark)");
		const update = () => setDark(media?.matches ?? false);
		media?.addEventListener("change", update);
		const unsubscribe = client.subscribe((status) => {
			if (!active) return;
			setState({ client, status });
			document.documentElement.dataset.nativeBackdrop = status.backdropEnabled ? "on" : "off";
		});
		return () => {
			active = false;
			media?.removeEventListener("change", update);
			unsubscribe();
			delete document.documentElement.dataset.nativeBackdrop;
		};
	}, [client]);
	const mode = config.mode === "system" ? (dark ? "dark" : "light") : config.mode;
	const background = config.appearance[mode]?.background ?? (mode === "dark" ? "#181818" : "#ffffff");
	const tint = nativeSidebarTints(config, mode);
	useEffect(() => {
		const style = document.documentElement.style;
		style.setProperty("--native-sidebar-tint", `${tint.sidebar}%`);
		style.setProperty("--native-settings-sidebar-tint", `${tint.settings}%`);
		return () => {
			style.removeProperty("--native-sidebar-tint");
			style.removeProperty("--native-settings-sidebar-tint");
		};
	}, [tint.sidebar, tint.settings]);
	useEffect(() => {
		const controller = new AbortController();
		const apply = async () => {
			try {
				const current = await client.status(controller.signal);
				const status =
					current.backdrop === "unsupported"
						? current
						: await client.setBackdrop(config.translucentSidebar, background, controller.signal);
				if (!controller.signal.aborted) {
					setState({ client, status });
					document.documentElement.dataset.nativeBackdrop = status.backdropEnabled ? "on" : "off";
				}
			} catch (error) {
				if (!controller.signal.aborted) {
					setState({ client, error: error instanceof AppearanceError ? error.code : "FAILED" });
					document.documentElement.dataset.nativeBackdrop = "off";
				}
			}
		};
		void apply();
		return () => controller.abort();
	}, [client, config.translucentSidebar, background]);
	return (
		<Context.Provider
			value={{
				...(state.client === client ? state : {}),
				client,
				contrastOpaque: tint.sidebar === 100 || tint.settings === 100,
			}}
		>
			{children}
		</Context.Provider>
	);
}
export function useAppearance() {
	return useContext(Context);
}
