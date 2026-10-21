import type { ExternalLinkClient } from "@hipi/work-runtime/external-links";
import { createContext, type ReactNode, useContext } from "react";

const ExternalLinkContext = createContext<ExternalLinkClient | undefined>(undefined);
export function ExternalLinkProvider({ client, children }: { client: ExternalLinkClient; children: ReactNode }) {
	return <ExternalLinkContext.Provider value={client}>{children}</ExternalLinkContext.Provider>;
}
export function useExternalLinks() {
	return useContext(ExternalLinkContext);
}
