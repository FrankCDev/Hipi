import assert from "node:assert/strict";
import { test, vi } from "vitest";
import { createCredentialClient } from "../src/app/credential-client.ts";
import { canExecuteModel } from "../src/features/workbench/model-policy.ts";

test("submission and receipt retries fail closed without ready configured authoritative model", () => {
	const model = {
		model: { provider: "openai", modelId: "gpt/test.v1" },
		credentialState: "configured",
		executionState: "ready",
	} as const;
	assert.equal(canExecuteModel(model, false), true);
	assert.equal(canExecuteModel(model, true), false);
	assert.equal(canExecuteModel(undefined, false), false);
	for (const executionState of ["running", "paused", "cancellation_pending"] as const)
		assert.equal(canExecuteModel({ ...model, executionState }, false), false);
	for (const credentialState of ["missing", "locked", "unavailable"] as const)
		assert.equal(canExecuteModel({ ...model, credentialState }, false), false);
});

test("credentials use versioned separate port, never return saved key or retry failures", async () => {
	const requests: unknown[] = [];
	const client = createCredentialClient({
		request: async (input) => {
			requests.push(input);
			return { ok: true, state: "configured" };
		},
	});
	assert.equal(
		await client.request({ operation: "set", provider: "openai", secret: "FAKE_SENTINEL_ONLY" }),
		"configured",
	);
	assert.deepEqual(requests, [{ version: 1, operation: "set", provider: "openai", secret: "FAKE_SENTINEL_ONLY" }]);
	const echo = createCredentialClient({
		request: async () => ({ ok: true, state: "configured", secret: "FAKE_SENTINEL_ONLY" }),
	});
	await assert.rejects(echo.request({ operation: "status", provider: "openai" }), /INVALID_REQUEST/);
	let calls = 0;
	const failed = createCredentialClient({
		request: async () => {
			calls++;
			throw new Error("FAKE_SENTINEL_ONLY");
		},
	});
	await assert.rejects(
		failed.request({ operation: "set", provider: "openai", secret: "FAKE_SENTINEL_ONLY" }),
		(error) => error instanceof Error && error.message === "CLOSED",
	);
	assert.equal(calls, 1);
});

test("credential input validation rejects control characters and excessive input before transport", async () => {
	let calls = 0;
	const client = createCredentialClient({
		request: async () => {
			calls++;
			return { ok: true, state: "configured" };
		},
	});
	for (const secret of ["", "fake\nkey", "fake\0key", "x".repeat(4097)])
		await assert.rejects(client.request({ operation: "set", provider: "openai", secret }), /INVALID_REQUEST/);
	assert.equal(calls, 0);
});

test("credential timeout is bounded and never automatically retried", async () => {
	vi.useFakeTimers();
	try {
		let calls = 0;
		const client = createCredentialClient({
			request: () => {
				calls++;
				return new Promise(() => {});
			},
		});
		const result = assert.rejects(client.request({ operation: "remove", provider: "openai" }), /CLOSED/);
		await vi.advanceTimersByTimeAsync(10000);
		await result;
		assert.equal(calls, 1);
	} finally {
		vi.useRealTimers();
	}
});
