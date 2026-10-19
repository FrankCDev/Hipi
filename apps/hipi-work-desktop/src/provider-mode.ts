/** OS launches have no custom flags; deterministic storage is always an explicit opt-in. */
export function providerMode(arguments_: readonly string[]): "production" | "deterministic" {
	const providers = arguments_.filter((argument) => argument === "--provider" || argument.startsWith("--provider="));
	if (providers.length === 0) return "production";
	if (providers.length === 1 && providers[0] === "--provider=production") return "production";
	if (providers.length === 1 && providers[0] === "--provider=deterministic") return "deterministic";
	throw new Error("Invalid provider mode");
}
