import { createContext, useContext } from "react";

/** Transient portals protect their actual row owner; ordinary focus is retained separately. */
export const WindowInteractionContext = createContext<
	((owner: string, held: boolean, element?: HTMLElement | null) => void) | null
>(null);
export const useWindowInteraction = () => useContext(WindowInteractionContext);
