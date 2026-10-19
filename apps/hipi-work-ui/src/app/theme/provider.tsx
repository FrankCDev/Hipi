import { createContext, type ReactNode, useCallback, useContext, useEffect, useState } from "react";
import { applyTheme } from "./application.ts";
import type { ThemeConfig } from "./config.ts";
import { ThemeStore } from "./store.ts";

function browserStore() {
	try {
		return new ThemeStore(window.localStorage);
	} catch {
		return new ThemeStore();
	}
}
function useThemeController() {
	const [store] = useState(browserStore);
	const [config, setConfig] = useState(() => store.current);
	const [status, setStatus] = useState(store.status);
	const cancel = useCallback(() => {
		store.cancel();
		setConfig(store.current);
	}, [store]);
	useEffect(() => {
		return applyTheme(config, document.documentElement, window.matchMedia?.("(prefers-color-scheme: dark)"));
	}, [config]);
	return {
		config,
		status,
		original: store.rejectedOriginal,
		preview(value: unknown) {
			const parsed = store.setPreview(value);
			if (parsed.ok) setConfig(store.current);
			return parsed;
		},
		cancel,
		save() {
			const result = store.save();
			setStatus(result);
			setConfig(store.current);
			return result;
		},
		update(value: ThemeConfig) {
			const result = store.setPreview(value);
			if (result.ok) {
				setStatus(store.save());
				setConfig(store.current);
			}
		},
		export: () => store.export(),
	};
}
const Context = createContext<ReturnType<typeof useThemeController> | null>(null);
export function ThemeProvider({ children }: { children: ReactNode }) {
	return <Context.Provider value={useThemeController()}>{children}</Context.Provider>;
}
export function useThemeSettings() {
	const value = useContext(Context);
	if (!value) throw new Error("ThemeProvider is required");
	return value;
}
