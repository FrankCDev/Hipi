import { lstatSync, realpathSync } from "node:fs";
import { join } from "node:path";
import type { DeterministicResponseFixture } from "@hipi/work-runtime/testing";
import { smokeProfile } from "./smoke-profile.ts";

const response = "--smoke-response=baseline-stream";
const scenario = "--smoke-scenario=baseline";
const isFixtureArgument = (argument: string) =>
	["--smoke-data-root", "--smoke-response", "--smoke-scenario"].some(
		(name) => argument === name || argument.startsWith(`${name}=`),
	);

/** The utility independently checks the same dedicated profile boundary as its parent. */
export function runtimeSmokeFixture(
	directory: string,
	provider: "production" | "deterministic",
	arguments_: readonly string[],
): DeterministicResponseFixture | undefined {
	if (arguments_.length === 0) return undefined;
	if (
		provider !== "deterministic" ||
		arguments_.length !== 3 ||
		!arguments_.includes(response) ||
		!arguments_.includes(scenario) ||
		arguments_.some((argument) => !isFixtureArgument(argument))
	)
		throw new Error("Invalid isolated baseline response fixture");
	const paths = smokeProfile(arguments_, provider);
	if (!paths || directory !== join(paths.userData, "deterministic-store"))
		throw new Error("Baseline response fixture requires its validated deterministic store");
	try {
		const stat = lstatSync(directory);
		if (!stat.isDirectory() || stat.isSymbolicLink() || realpathSync(directory) !== directory)
			throw new Error("Unsafe baseline response fixture store");
	} catch (error) {
		// The first launch has not created its store yet; the private parent was verified above.
		if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
	}
	return "baseline-stream";
}

/** Normal and other smoke launches keep the original utility arguments and response. */
export function smokeRuntimeArguments(
	directory: string,
	generation: string,
	provider: "production" | "deterministic",
	arguments_: readonly string[],
): string[] {
	const base = [directory, generation, provider];
	if (!arguments_.some((argument) => argument === "--smoke-response" || argument.startsWith("--smoke-response=")))
		return base;
	const selected = arguments_.filter(isFixtureArgument);
	runtimeSmokeFixture(directory, provider, selected);
	return [...base, ...selected];
}
