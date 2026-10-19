import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createHttpClient } from "../src/transport-http-client.ts";
import { startDevHost } from "./helpers/dev-host.ts";

test(
	"documented acceptance-host command serves real persisted work and shuts down cleanly",
	{ timeout: 15000 },
	async () => {
		const directory = await mkdtemp(join(tmpdir(), "hipi-host-"));
		const origin = "http://127.0.0.1:5173";
		const host = await startDevHost({ directory, provider: "deterministic", origin });
		try {
			const client = createHttpClient({ ...host.connection, origin });
			assert.ok(host.output.includes(`Allowed UI Origin: ${origin}`));
			await client.call("createWorkspace", { workspaceId: "acceptance", name: "Acceptance" });
			const conversation = await client.call("createConversation", {
				requestId: "create-1",
				workspaceId: "acceptance",
				title: "Real host",
			});
			await client.call("submit", {
				workspaceId: "acceptance",
				conversationId: conversation.conversationId,
				requestId: "original",
				text: "Verify acceptance host",
			});
			const deadline = Date.now() + 8000;
			while (Date.now() < deadline) {
				const receipt = await client.call("getReceipt", { workspaceId: "acceptance", requestId: "original" });
				if (receipt?.execution === "done") {
					assert.match(receipt.answer ?? "", /deterministic test answer/);
					break;
				}
				await new Promise((resolve) => setTimeout(resolve, 25));
			}
			assert.equal(
				(await client.call("getReceipt", { workspaceId: "acceptance", requestId: "original" }))?.execution,
				"done",
			);
			await host.close();
			const reopened = await startDevHost({ directory, provider: "deterministic", origin });
			try {
				const reader = createHttpClient({ ...reopened.connection, origin });
				assert.equal(
					(await reader.call("getReceipt", { workspaceId: "acceptance", requestId: "original" }))?.execution,
					"done",
				);
			} finally {
				await reopened.close();
			}
		} finally {
			await host.close();
			await rm(directory, { recursive: true, force: true });
		}
	},
);

test(
	"dev host ignores malformed parent IPC and drains repeated shutdown requests once",
	{ timeout: 15000 },
	async () => {
		const directory = await mkdtemp(join(tmpdir(), "hipi-host-ipc-"));
		const origin = "http://127.0.0.1:5173";
		const host = await startDevHost({ directory, provider: "deterministic", origin });
		try {
			const client = createHttpClient({ ...host.connection, origin });
			const identity = await client.call("handshake", {});
			for (const message of [
				{ type: "unknown" },
				{ type: "hipi.dev-host.shutdown", extra: true },
				["hipi.dev-host.shutdown"],
				"hipi.dev-host.shutdown",
			])
				await new Promise<void>((resolve, reject) =>
					host.child.send(message, (error) => (error ? reject(error) : resolve())),
				);
			assert.deepEqual(await client.call("handshake", {}), identity);
			await new Promise<void>((resolve, reject) =>
				host.child.send({ type: "hipi.dev-host.shutdown" }, (error) => (error ? reject(error) : resolve())),
			);
			await host.close();
			const reopened = await startDevHost({ directory, provider: "deterministic", origin });
			try {
				assert.deepEqual(
					await createHttpClient({ ...reopened.connection, origin }).call("handshake", {}),
					identity,
				);
			} finally {
				await reopened.close();
			}
		} finally {
			await host.close();
			await rm(directory, { recursive: true, force: true });
		}
	},
);

test("parent IPC disconnection drains the host and leaves its store reopenable", { timeout: 15000 }, async () => {
	const directory = await mkdtemp(join(tmpdir(), "hipi-host-disconnect-"));
	const origin = "http://127.0.0.1:5173";
	const host = await startDevHost({ directory, provider: "deterministic", origin });
	try {
		const identity = await createHttpClient({ ...host.connection, origin }).call("handshake", {});
		host.child.disconnect();
		await host.close();
		const reopened = await startDevHost({ directory, provider: "deterministic", origin });
		try {
			assert.deepEqual(await createHttpClient({ ...reopened.connection, origin }).call("handshake", {}), identity);
		} finally {
			await reopened.close();
		}
	} finally {
		await host.close();
		await rm(directory, { recursive: true, force: true });
	}
});

test("a real host resource close failure never reports a clean process exit", { timeout: 15000 }, async () => {
	const directory = await mkdtemp(join(tmpdir(), "hipi-host-close-failure-"));
	const origin = "http://127.0.0.1:5173";
	const host = await startDevHost({
		directory,
		provider: "deterministic",
		origin,
		preload: new URL("./helpers/dev-host-close-failure.ts", import.meta.url),
	});
	try {
		await assert.rejects(host.close(), /Graceful shutdown must complete every owned resource close/);
		assert.equal(host.child.exitCode, 1);
		const reopened = await startDevHost({ directory, provider: "deterministic", origin });
		await reopened.close();
	} finally {
		await host.close().catch(() => {});
		await rm(directory, { recursive: true, force: true });
	}
});
