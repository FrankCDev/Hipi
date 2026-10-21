import type { RunResultObservation } from "@hipi/work-runtime/contracts";

export type RunActivity = {
	id: string;
	key: string;
	members: readonly string[];
	expanded: boolean;
	running: boolean;
	admittedAtMs?: number;
	result?: RunResultObservation;
};
