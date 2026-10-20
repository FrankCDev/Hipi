import type { ModelCatalog } from "@hipi/work-runtime/contracts";
import type { UseQueryResult } from "@tanstack/react-query";
import { CustomProviderSettings } from "./custom-provider-settings.tsx";

export function ModelSettingsContent({
	enabled,
	catalog,
	onBusy,
}: {
	enabled: boolean;
	catalog: UseQueryResult<ModelCatalog>;
	onBusy?: (busy: boolean) => void;
}) {
	return (
		<CustomProviderSettings
			enabled={enabled}
			catalog={catalog.data}
			catalogError={catalog.isError}
			onRefresh={() => void catalog.refetch()}
			onBusy={onBusy}
		/>
	);
}
