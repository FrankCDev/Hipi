import { createContext, type ReactNode, useContext, useState } from "react";
import { useStore } from "zustand";
import { createPresentationPreferences } from "./store.ts";

function browserPreferences() {
	try {
		return createPresentationPreferences(window.localStorage);
	} catch {
		return createPresentationPreferences();
	}
}
const Context = createContext<ReturnType<typeof createPresentationPreferences> | null>(null);
export function PresentationPreferencesProvider({ children }: { children: ReactNode }) {
	const [owner] = useState(browserPreferences);
	return <Context.Provider value={owner}>{children}</Context.Provider>;
}
export function useCodeBlockWordWrap() {
	const owner = useContext(Context);
	if (!owner) throw new Error("PresentationPreferencesProvider is required");
	const wrapped = useStore(owner.store, (state) => state.codeBlockWordWrap);
	return { wrapped, toggle: owner.toggleCodeBlockWordWrap };
}
