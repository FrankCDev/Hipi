import assert from "node:assert/strict";
import { mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { deterministicModels } from "@hipi/work-runtime/testing";
import { runtimeSmokeFixture, smokeRuntimeArguments } from "../src/smoke-model-fixture.ts";

test("normal, long-history, and file-workbench launches retain the exact default arguments", () => {
	for (const provider of ["production", "deterministic"] as const) {
		for (const scenario of [undefined, "long-history", "file-workbench"]) {
			const args = scenario ? [`--smoke-scenario=${scenario}`, "--smoke-data-root=/not-used"] : [];
			assert.deepEqual(smokeRuntimeArguments("/store", "generation", provider, args), [
				"/store",
				"generation",
				provider,
			]);
			assert.equal(runtimeSmokeFixture("/store", provider, []), undefined);
		}
	}
});

test("only the fixed baseline fixture in a validated isolated deterministic store crosses the utility boundary", () => {
	const root = realpathSync(mkdtempSync(join(tmpdir(), "Hipi GUI profile-")));
	const directory = join(root, "profile", "deterministic-store");
	const args = [`--smoke-data-root=${root}`, "--smoke-scenario=baseline", "--smoke-response=baseline-stream"];
	try {
		const forwarded = smokeRuntimeArguments(directory, "generation", "deterministic", [
			"app",
			"--provider=deterministic",
			...args,
		]);
		assert.deepEqual(forwarded, [directory, "generation", "deterministic", ...args]);
		assert.equal(runtimeSmokeFixture(directory, "deterministic", forwarded.slice(3)), "baseline-stream");
		for (const bad of [
			args.filter((argument) => !argument.startsWith("--smoke-data-root=")),
			args.filter((argument) => !argument.startsWith("--smoke-scenario=")),
			args.map((argument) => (argument === "--smoke-scenario=baseline" ? "--smoke-scenario=file-workbench" : argument)),
			args.map((argument) => (argument === "--smoke-scenario=baseline" ? "--smoke-scenario=long-history" : argument)),
			args.map((argument) =>
				argument === "--smoke-response=baseline-stream" ? "--smoke-response=arbitrary-content" : argument,
			),
			[...args, "--smoke-response=baseline-stream"],
			[...args, "--smoke-scenario=baseline"],
			[...args, "untrusted response text"],
		])
			assert.throws(() => runtimeSmokeFixture(directory, "deterministic", bad));
		assert.throws(() => smokeRuntimeArguments(directory, "generation", "production", args));
		assert.throws(() =>
			smokeRuntimeArguments(directory, "generation", "deterministic", ["--smoke-response=baseline-stream"]),
		);
		assert.throws(() => runtimeSmokeFixture(join(root, "profile", "production-store"), "deterministic", args));
		assert.throws(() => runtimeSmokeFixture(`${directory}/../deterministic-store`, "deterministic", args));
		assert.throws(() => runtimeSmokeFixture(directory, "production", args));
		writeFileSync(join(root, "unowned"), "not a valid isolated root");
		assert.throws(() => runtimeSmokeFixture(directory, "deterministic", args));
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("production deterministic provider selection changes only the fixed opt-in response", async () => {
	for (const fixture of [undefined, "baseline-stream"] as const) {
		const models = deterministicModels(10000, fixture);
		const model = models.getModel("faux", "faux-1");
		assert.ok(model);
		const message = await models.completeSimple(model, { messages: [] });
		const text = message.content.flatMap((part) => (part.type === "text" ? [part.text] : [])).join("");
		assert.equal(
			text,
			fixture
				? "Hipi Work deterministic test answer. No model API or external tool was called.\n\nThis second paragraph keeps the response open while the first paragraph is already settled."
				: "Hipi Work deterministic test answer. No model API or external tool was called.",
		);
	}
});

test("a symlinked fixture store cannot select the isolated baseline provider", () => {
	const root = realpathSync(mkdtempSync(join(tmpdir(), "Hipi GUI profile-")));
	const target = realpathSync(mkdtempSync(join(tmpdir(), "Hipi GUI target-")));
	const directory = join(root, "profile", "deterministic-store");
	const args = [`--smoke-data-root=${root}`, "--smoke-scenario=baseline", "--smoke-response=baseline-stream"];
	try {
		runtimeSmokeFixture(directory, "deterministic", args);
		symlinkSync(target, directory, process.platform === "win32" ? "junction" : "dir");
		assert.throws(() => runtimeSmokeFixture(directory, "deterministic", args), /Unsafe/);
		assert.throws(() => smokeRuntimeArguments(directory, "generation", "deterministic", args), /Unsafe/);
	} finally {
		rmSync(root, { recursive: true, force: true });
		rmSync(target, { recursive: true, force: true });
	}
});
