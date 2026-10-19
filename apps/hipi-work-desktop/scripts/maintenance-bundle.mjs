import { isBuiltin } from "node:module";

export function assertMaintenanceBundle(metadata) {
	const forbidden =
		/(?:^|\/)(?:packages\/(?:ai|agent|coding-agent)|providers?|credentials?|model-provider|runtime-model|runtime-entry|testing)(?:[/.]|$)/;
	for (const input of Object.keys(metadata.inputs)) {
		if (forbidden.test(input.replaceAll("\\", "/")))
			throw new Error("Maintenance bundle includes a model/provider/credential or execution entry");
	}
	for (const output of Object.values(metadata.outputs)) {
		for (const dependency of output.imports) {
			if (
				!dependency.external ||
				!isBuiltin(dependency.path) ||
				/^(?:node:)?(?:https?|http2|net|tls|dns|dgram|child_process)$/.test(dependency.path)
			)
				throw new Error("Maintenance bundle must resolve offline using Node builtins only");
		}
	}
}
