import { AppError } from "../src/contracts.ts";

async function denied(): Promise<never> {
	throw new AppError("UNAUTHORIZED");
}
/** Existing fixtures explicitly deny features outside their scenario. */
export const deniedFeatureReads = {
	listCustomProviders: denied,
	saveCustomProvider: denied,
	removeCustomProvider: denied,
	listBuiltInProviders: denied,
	getBuiltInProviderModels: denied,
	previewToolPack: denied,
	listToolPacks: denied,
	getToolPackSource: denied,
	listToolPackBindings: denied,
	listActiveToolPackBindings: denied,
	getToolPackCommandResult: denied,
	getToolActivities: denied,
	getToolActivityText: denied,
};
export const deniedFeatureMutations = {
	installToolPack: denied,
	setToolPackEnabled: denied,
	uninstallToolPack: denied,
	bindToolPack: denied,
	revokeToolPackBinding: denied,
	authorizeRetainedToolPack: denied,
};
