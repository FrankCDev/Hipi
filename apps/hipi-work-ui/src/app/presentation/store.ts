import { createStore } from "zustand/vanilla";

export const presentationStorageKey = "hipi-work.presentation.v1";
type StoragePort = Pick<Storage, "getItem" | "setItem">;
type PresentationState = {
	codeBlockWordWrap: boolean;
	storageStatus: "available" | "memory" | "invalid";
};

/** UI-only preferences never share the theme preview transaction or execution recovery storage. */
export function createPresentationPreferences(storage?: StoragePort) {
	let codeBlockWordWrap = false;
	let storageStatus: PresentationState["storageStatus"] = storage ? "available" : "memory";
	let read = false;
	try {
		const raw = storage?.getItem(presentationStorageKey);
		read = true;
		if (raw != null) {
			const value: unknown = JSON.parse(raw);
			if (
				typeof value === "object" &&
				value !== null &&
				!Array.isArray(value) &&
				Object.keys(value).length === 2 &&
				"version" in value &&
				value.version === 1 &&
				"codeBlockWordWrap" in value &&
				typeof value.codeBlockWordWrap === "boolean"
			)
				codeBlockWordWrap = value.codeBlockWordWrap;
			else storageStatus = "invalid";
		}
	} catch {
		storageStatus = read ? "invalid" : "memory";
	}
	const state = createStore<PresentationState>(() => ({ codeBlockWordWrap, storageStatus }));
	// Never overwrite a malformed/future record. A toggle still works for this app lifetime.
	const mayPersist = storageStatus !== "invalid";
	return {
		store: { getState: state.getState, getInitialState: state.getInitialState, subscribe: state.subscribe },
		toggleCodeBlockWordWrap() {
			const codeBlockWordWrap = !state.getState().codeBlockWordWrap;
			let storageStatus = state.getState().storageStatus;
			try {
				if (!storage || !mayPersist) throw new Error("Preference storage unavailable");
				storage.setItem(presentationStorageKey, JSON.stringify({ version: 1, codeBlockWordWrap }));
				storageStatus = "available";
			} catch {
				if (storageStatus !== "invalid") storageStatus = "memory";
			}
			state.setState({ codeBlockWordWrap, storageStatus });
		},
	};
}
