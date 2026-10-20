import assert from "node:assert/strict";
import { request as httpRequest } from "node:http";
import test from "node:test";
import { AppError } from "../src/contracts.ts";
import {
	credentialProvider,
	MAX_CREDENTIAL_PROVIDERS,
	parseCredentialRequest,
	parseCredentialResponse,
} from "../src/credential-contracts.ts";
import { createHttpCredentialBridge } from "../src/credential-http-client.ts";
import { createMemoryCredentials } from "../src/memory-credentials.ts";
import { serveLoopback, type TransportRuntime } from "../src/transport-http.ts";

const runtime: TransportRuntime = {
	execute: async () => {
		throw new AppError("NOT_FOUND");
	},
	observe: async () => {
		throw new AppError("NOT_FOUND");
	},
};
const origin = "http://127.0.0.1:5173";
const sentinel = "fictional-credential-sentinel-never-a-real-key";
const customA = "custom_5e00d2f1-1301-4b56-bd5e-d32eff18d67a";
const customB = "custom_9fef7182-ecf4-46ad-81f5-a71cbba81541";

test("credential capability is isolated, validates every boundary and never echoes secrets", async () => {
	const vault = createMemoryCredentials();
	const diagnostics: unknown[] = [];
	const server = await serveLoopback(runtime, {
		origin,
		credentials: vault.management,
		onDiagnostic: (value) => {
			diagnostics.push(value);
		},
	});
	const bridge = createHttpCredentialBridge({ ...server, origin });
	const request = (operation: "status" | "remove") => bridge.request({ version: 1, operation, provider: "openai" });
	try {
		assert.deepEqual(await request("status"), { ok: true, state: "missing" });
		assert.deepEqual(await bridge.request({ version: 1, operation: "set", provider: "openai", secret: sentinel }), {
			ok: true,
			state: "configured",
		});
		assert.equal(await vault.port.get("openai"), sentinel);
		assert.deepEqual(await request("status"), { ok: true, state: "configured" });
		assert.deepEqual(await request("remove"), { ok: true, state: "missing" });
		assert.equal(await vault.port.get("openai"), undefined);
		for (const provider of [customA, customB] as const)
			assert.deepEqual(
				await bridge.request({ version: 1, operation: "set", provider, secret: `${sentinel}-${provider}` }),
				{
					ok: true,
					state: "configured",
				},
			);
		assert.deepEqual(await request("status"), { ok: true, state: "missing" });
		assert.deepEqual(await bridge.request({ version: 1, operation: "remove", provider: customA }), {
			ok: true,
			state: "missing",
		});
		assert.equal(await vault.port.get(customA), undefined);
		assert.equal(await vault.port.get(customB), `${sentinel}-${customB}`);
		assert.deepEqual(await bridge.request({ version: 1, operation: "status", provider: customB }), {
			ok: true,
			state: "configured",
		});
		for (const raw of [
			{ version: 1, operation: "get", provider: "openai" },
			{ version: 1, operation: "status", provider: "openai", secret: sentinel },
			{ version: 1, operation: "set", provider: "other", secret: sentinel },
			...[
				"__proto__",
				"constructor",
				"prototype",
				"custom_",
				"custom_\0x",
				"custom_a\n",
				`custom_${"x".repeat(65)}`,
			].map((provider) => ({ version: 1, operation: "set", provider, secret: sentinel })),
			...["", "bad\rkey", "bad\nkey", "bad\0key", "x".repeat(8193)].map((secret) => ({
				version: 1,
				operation: "set",
				provider: "openai",
				secret,
			})),
		]) {
			assert.throws(() => parseCredentialRequest(raw), AppError);
			const response = await fetch(`${server.url}/credentials`, {
				method: "POST",
				headers: { Origin: origin, Authorization: `Bearer ${server.token}`, "Content-Type": "application/json" },
				body: JSON.stringify(raw),
			});
			assert.equal(response.status, 400);
			assert.deepEqual(await response.json(), { error: "INVALID_REQUEST" });
		}
		for (const headers of [
			{ Origin: "http://evil.invalid", Authorization: `Bearer ${server.token}` },
			{ Origin: origin, Authorization: "Bearer wrong" },
		]) {
			const response = await fetch(`${server.url}/credentials`, {
				method: "POST",
				headers: { ...headers, "Content-Type": "application/json" },
				body: JSON.stringify({ version: 1, operation: "set", provider: "openai", secret: sentinel }),
			});
			assert.ok(response.status === 401 || response.status === 403);
		}
		const wrongHost = await new Promise<number | undefined>((resolve, reject) => {
			const req = httpRequest(
				`${server.url}/credentials`,
				{
					method: "POST",
					headers: {
						Host: "localhost",
						Origin: origin,
						Authorization: `Bearer ${server.token}`,
						"Content-Type": "application/json",
					},
				},
				(res) => {
					res.resume();
					res.on("end", () => resolve(res.statusCode));
				},
			);
			req.on("error", reject);
			req.end(JSON.stringify({ version: 1, operation: "status", provider: "openai" }));
		});
		assert.equal(wrongHost, 403);
		const oversized = await fetch(`${server.url}/credentials`, {
			method: "POST",
			headers: { Origin: origin, Authorization: `Bearer ${server.token}`, "Content-Type": "application/json" },
			body: JSON.stringify("x".repeat(17000)),
		});
		assert.equal(oversized.status, 413);
		assert.ok(!JSON.stringify(diagnostics).includes(sentinel));
		assert.equal(await vault.port.status("openai"), "missing");
		assert.equal(await createMemoryCredentials().port.status("openai"), "missing");
	} finally {
		await server.close();
		vault.clear();
	}
});

test("memory credentials isolate identities, enforce capacity, and clear every key without persistence", async () => {
	const vault = createMemoryCredentials();
	for (const [provider, secret] of [
		["openai", "fictional-official-key"],
		[customA, "fictional-profile-a-key"],
		[customB, "fictional-profile-b-key"],
	] as const)
		assert.deepEqual(await vault.management.execute({ version: 1, operation: "set", provider, secret }), {
			ok: true,
			state: "configured",
		});
	await vault.management.execute({ version: 1, operation: "set", provider: customA, secret: "fictional-replaced-a" });
	assert.equal(await vault.port.get("openai"), "fictional-official-key");
	assert.equal(await vault.port.get(customA), "fictional-replaced-a");
	assert.equal(await vault.port.get(customB), "fictional-profile-b-key");
	await vault.management.execute({ version: 1, operation: "remove", provider: customB });
	assert.equal(await vault.port.status(customB), "missing");
	assert.equal(await vault.port.get(customA), "fictional-replaced-a");
	assert.equal(await vault.port.status("openai"), "configured");
	for (let index = 2; index < MAX_CREDENTIAL_PROVIDERS; index++)
		await vault.management.execute({
			version: 1,
			operation: "set",
			provider: `custom_capacity-${index}`,
			secret: "fictional-capacity-key",
		});
	await assert.rejects(
		vault.management.execute({ version: 1, operation: "set", provider: customB, secret: "fictional-overflow" }),
		{ code: "CAPACITY_EXCEEDED" },
	);
	await vault.management.execute({
		version: 1,
		operation: "set",
		provider: customA,
		secret: "fictional-updated-at-capacity",
	});
	assert.equal(await vault.port.get(customA), "fictional-updated-at-capacity");
	assert.equal(await vault.port.status(customB), "missing");
	assert.equal(await createMemoryCredentials().port.status(customA), "missing");
	vault.clear();
	for (const provider of ["openai", customA, customB, "custom_capacity-2"]) {
		assert.equal(await vault.port.status(provider), "missing");
		assert.equal(await vault.port.get(provider), undefined);
	}
	await assert.rejects(vault.port.status("__proto__"), { code: "INVALID_REQUEST" });
	await assert.rejects(vault.port.get("custom_bad\n"), { code: "INVALID_REQUEST" });
});

test("credential parsers accept bounded custom IDs and reject secret-bearing responses", () => {
	for (const provider of ["openai", customA, "custom_a", `custom_${"x".repeat(64)}`])
		assert.equal(credentialProvider(provider), provider);
	for (const provider of [
		"__proto__",
		"constructor",
		"prototype",
		"custom_",
		"custom_-a",
		"custom_A",
		"custom_a/b",
		"custom_a\n",
	])
		assert.throws(() => credentialProvider(provider), { code: "INVALID_REQUEST" });
	for (const secret of ["", "space key", "\t", "\n", "\r", "\0", "\x7f", "密钥", "x".repeat(4097)])
		assert.throws(() => parseCredentialRequest({ version: 1, operation: "set", provider: customA, secret }), {
			code: "INVALID_REQUEST",
		});
	assert.throws(() => parseCredentialResponse({ ok: true, state: "configured", secret: sentinel }), {
		code: "INVALID_REQUEST",
	});
});

test("host exceptions are controlled and credential endpoint is opt-in", async () => {
	const throwing = await serveLoopback(runtime, {
		origin,
		credentials: {
			execute: async () => {
				throw new Error(sentinel);
			},
		},
	});
	try {
		assert.deepEqual(
			await createHttpCredentialBridge({ ...throwing, origin }).request({
				version: 1,
				operation: "status",
				provider: "openai",
			}),
			{ ok: false, error: "INTERNAL" },
		);
	} finally {
		await throwing.close();
	}
	const disabled = await serveLoopback(runtime, { origin });
	try {
		assert.deepEqual(
			await createHttpCredentialBridge({ ...disabled, origin }).request({
				version: 1,
				operation: "status",
				provider: "openai",
			}),
			{ ok: false, error: "NOT_FOUND" },
		);
	} finally {
		await disabled.close();
	}
});
