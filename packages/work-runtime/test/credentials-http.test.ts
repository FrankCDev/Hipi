import assert from "node:assert/strict";
import { request as httpRequest } from "node:http";
import test from "node:test";
import { AppError } from "../src/contracts.ts";
import { parseCredentialRequest } from "../src/credential-contracts.ts";
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
		for (const raw of [
			{ version: 1, operation: "get", provider: "openai" },
			{ version: 1, operation: "status", provider: "openai", secret: sentinel },
			{ version: 1, operation: "set", provider: "other", secret: sentinel },
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
