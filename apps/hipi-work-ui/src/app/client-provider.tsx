import type { AppClient } from "@hipi/work-runtime/contracts";
import type { FileClient } from "@hipi/work-runtime/files/protocol";
import type { PreviewClient } from "@hipi/work-runtime/previews/protocol";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createContext, type ReactNode, useContext, useEffect, useState } from "react";
import { LocalState } from "../features/workbench/local-state.ts";
import type { StoreLease } from "./connection.ts";
import type { CredentialClient } from "./credential-client.ts";
import type { FileAuthority } from "./file-client.ts";

const FileContext = createContext<{ files?: FileClient; fileAuthority?: FileAuthority; previews?: PreviewClient }>({});
export function useFiles() {
	return useContext(FileContext);
}
const CredentialContext = createContext<CredentialClient | undefined>(undefined);
export function useCredentialClient() {
	return useContext(CredentialContext);
}
const ClientContext = createContext<AppClient | null>(null);
const LocalContext = createContext<LocalState | null>(null);
type ProviderProps = {
	client: AppClient;
	credentials?: CredentialClient;
	files?: FileClient;
	previews?: PreviewClient;
	fileAuthority?: FileAuthority;
	lease?: StoreLease;
	children: ReactNode;
};
/** Only the composition root chooses a transport. Features see this browser-safe contract. */
export function AppClientProvider(props: ProviderProps) {
	const [identity, setIdentity] = useState({ client: props.client, lease: props.lease, generation: 0 });
	if (identity.client !== props.client || identity.lease !== props.lease) {
		setIdentity({ client: props.client, lease: props.lease, generation: identity.generation + 1 });
	}
	return <ConnectionProvider key={identity.generation} {...props} />;
}
function ConnectionProvider({ client, credentials, files, previews, fileAuthority, lease, children }: ProviderProps) {
	const [local] = useState(() => new LocalState(lease?.storeId, undefined, () => lease?.active ?? true));
	const [cache] = useState(
		() =>
			new QueryClient({
				defaultOptions: {
					queries: { retry: false, refetchOnWindowFocus: false, gcTime: 300000 },
					mutations: { retry: false },
				},
			}),
	);
	useEffect(() => {
		local.activate();
		return () => {
			local.deactivate();
			void cache.cancelQueries();
			cache.clear();
		};
	}, [local, cache]);
	return (
		<ClientContext.Provider value={client}>
			<LocalContext.Provider value={local}>
				<CredentialContext.Provider value={credentials}>
					<FileContext.Provider value={{ files, fileAuthority, previews }}>
						<QueryClientProvider client={cache}>{children}</QueryClientProvider>
					</FileContext.Provider>
				</CredentialContext.Provider>
			</LocalContext.Provider>
		</ClientContext.Provider>
	);
}
export function useLocalState() {
	const local = useContext(LocalContext);
	if (!local) throw new Error("AppClientProvider is required");
	return local;
}
export function useAppClient() {
	const client = useContext(ClientContext);
	if (!client) throw new Error("AppClientProvider is required");
	return client;
}
