import { useSyncExternalStore } from "react";
import { useThemeSettings } from "./provider.tsx";

const systemMotion = () =>
	typeof window !== "undefined" && !!window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
const serverMotion = () => false;
function subscribeMotion(changed: () => void) {
	const media = window.matchMedia?.("(prefers-reduced-motion: reduce)");
	media?.addEventListener("change", changed);
	return () => media?.removeEventListener("change", changed);
}

/** Unlike an initial-only motion preference, system changes remain live. */
export function useReducedMotionPreference() {
	const { config } = useThemeSettings();
	const systemReduced = useSyncExternalStore(subscribeMotion, systemMotion, serverMotion);
	return config.reducedMotion === "on" || (config.reducedMotion === "system" && systemReduced);
}
