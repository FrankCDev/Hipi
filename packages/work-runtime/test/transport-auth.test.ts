import assert from "node:assert/strict";
import { request } from "node:http";
import test from "node:test";
import { type ErrorCode, PROTOCOL_VERSION } from "../src/contracts.ts";
import { type AuthorizationFailure, serveLoopback } from "../src/transport-http.ts";
import { createHttpClient } from "../src/transport-http-client.ts";
import { fixtureRuntime } from "./transport-fixture.ts";

test("HTTP preflight and authenticated handshake preserve exact origin and credential checks", async () => {
	const runtime = fixtureRuntime();
	const origin = "http://127.0.0.1:5174";
	const diagnostics: { code: ErrorCode; reason?: AuthorizationFailure }[] = [];
	const server = await serveLoopback(runtime, {
		origin,
		onDiagnostic: (event) => {
			diagnostics.push(event);
		},
	});
	try {
		for (const path of ["/call", "/observe"]) {
			const response = await fetch(`${server.url}${path}`, {
				method: "OPTIONS",
				headers: {
					Origin: origin,
					"Access-Control-Request-Method": "POST",
					"Access-Control-Request-Headers": "authorization,content-type",
				},
			});
			assert.equal(response.status, 204);
			assert.equal(response.headers.get("Access-Control-Allow-Origin"), origin);
			assert.equal(response.headers.get("Access-Control-Allow-Methods"), "POST");
			assert.equal(response.headers.get("Access-Control-Allow-Headers"), "Authorization, Content-Type");
		}
		assert.deepEqual(await createHttpClient({ ...server, origin }).call("handshake", {}), {
			protocolVersion: PROTOCOL_VERSION,
			storeId: "fixture-store",
		});
		assert.deepEqual(diagnostics, []);
		for (const [headers, method, status, reason] of [
			[{ Origin: "http://127.0.0.1:5173" }, "OPTIONS", 403, "origin_mismatch"],
			[{ Origin: "http://localhost:5174" }, "OPTIONS", 403, "origin_mismatch"],
			[{}, "GET", 403, "origin_mismatch"],
			[{ Origin: origin }, "POST", 401, "missing_credentials"],
			[{ Origin: origin, Authorization: "Bearer incorrect-test-credential" }, "POST", 401, "invalid_credentials"],
		] as const) {
			const response = await fetch(`${server.url}/call`, { method, headers });
			assert.equal(response.status, status);
			assert.deepEqual(await response.json(), { error: "UNAUTHORIZED" });
			assert.equal(response.headers.get("Access-Control-Allow-Origin"), status === 403 ? null : origin);
			assert.deepEqual(diagnostics.at(-1), { code: "UNAUTHORIZED", reason });
		}
		const status = await new Promise<number | undefined>((resolve, reject) => {
			const raw = request(
				`${server.url}/call`,
				{ method: "OPTIONS", headers: { Origin: origin, Host: "untrusted.example" } },
				(response) => {
					response.resume();
					response.on("end", () => resolve(response.statusCode));
				},
			);
			raw.on("error", reject);
			raw.end();
		});
		assert.equal(status, 403);
		assert.deepEqual(diagnostics.at(-1), { code: "UNAUTHORIZED", reason: "host_mismatch" });
		// Diagnostics contain only fixed categories, never request headers or credentials.
		assert.equal(JSON.stringify(diagnostics).includes(server.token), false);
		assert.equal(JSON.stringify(diagnostics).includes("incorrect-test-credential"), false);
	} finally {
		await server.close();
		await runtime.close();
	}
});

test("each local server generates a fresh capability and rejects the previous server credential", async () => {
	const runtime = fixtureRuntime();
	const origin = "http://127.0.0.1:5173";
	const first = await serveLoopback(runtime, { origin });
	await first.close();
	const second = await serveLoopback(runtime, { origin });
	try {
		assert.equal(first.token === second.token, false);
		await assert.rejects(createHttpClient({ url: second.url, token: first.token, origin }).call("handshake", {}), {
			code: "UNAUTHORIZED",
		});
		assert.equal((await createHttpClient({ ...second, origin }).call("handshake", {})).storeId, "fixture-store");
	} finally {
		await second.close();
		await runtime.close();
	}
});
