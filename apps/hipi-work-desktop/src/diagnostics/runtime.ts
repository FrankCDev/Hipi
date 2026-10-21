import { AppError } from "@hipi/work-runtime/contracts";
import { encode, exact, identifier } from "../ipc/protocol.ts";

export const RUNTIME_DIAGNOSTICS = [
	{ category: "startup", phase: "runtime-open" },
	{ category: "startup", phase: "file-services-open" },
	{ category: "storage", phase: "storage-open" },
	{ category: "close", phase: "file-services-close" },
	{ category: "close", phase: "subscriptions-close" },
	{ category: "close", phase: "runtime-close" },
	{ category: "operation", phase: "dispatch" },
	{ category: "operation", phase: "unknown" },
] as const;
export type RuntimeDiagnostic = (typeof RUNTIME_DIAGNOSTICS)[number];

export function runtimeDiagnostic(value: Record<string, unknown>): RuntimeDiagnostic {
	exact(value, ["version", "generation", "kind", "category", "phase"]);
	identifier(value.generation);
	if (value.version !== 1 || value.kind !== "diagnostic") throw new AppError("INVALID_REQUEST");
	const allowed = RUNTIME_DIAGNOSTICS.find((item) => item.category === value.category && item.phase === value.phase);
	if (!allowed) throw new AppError("INVALID_REQUEST");
	return allowed;
}

/** No exception or arbitrary context can enter this transport. Reporting must not change ownership. */
export function runtimeDiagnosticReporter(generation: string, post: (raw: string) => void) {
	return (diagnostic: RuntimeDiagnostic): void => {
		const allowed = RUNTIME_DIAGNOSTICS.find(
			(item) => item.category === diagnostic.category && item.phase === diagnostic.phase,
		);
		if (!allowed) return;
		try {
			post(encode({ version: 1, generation, kind: "diagnostic", category: allowed.category, phase: allowed.phase }));
		} catch {
			/* The host may have exited. Diagnostics never authorize cleanup or replacement. */
		}
	};
}

/** The caller names the actual catch boundary; unknown inner failures are not inferred from text. */
export async function diagnoseRuntimeOperation<T>(
	operation: () => Promise<T>,
	diagnostic: RuntimeDiagnostic,
	report: (diagnostic: RuntimeDiagnostic) => void,
): Promise<T> {
	try {
		return await operation();
	} catch (error) {
		try {
			report(diagnostic);
		} catch {
			/* An observer cannot replace the original operation failure. */
		}
		throw error;
	}
}
