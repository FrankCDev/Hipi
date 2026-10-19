import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { createHttpClient } from "../src/transport-http-client.ts";

test(
	"documented acceptance-host command serves real persisted work and shuts down cleanly",
	{ timeout: 15000 },
	async () => {
		const directory = await mkdtemp(join(tmpdir(), "hipi-host-"));
		const origin = "http://127.0.0.1:5173";
		const child = spawn(
			process.execPath,
			[
				"--conditions=source",
				fileURLToPath(new URL("../src/dev-server.ts", import.meta.url)),
				"--provider",
				"deterministic",
				"--origin",
				origin,
				"--data",
				directory,
			],
			{ stdio: ["ignore", "pipe", "pipe"] },
		);
		const exited = once(child, "exit");
		const ready = Promise.withResolvers<{ url: string; token: string }>();
		let output = "";
		const timer = setTimeout(() => ready.reject(new Error("Acceptance host did not become ready")), 5000);
		child.stdout.on("data", (chunk: Buffer) => {
			output += chunk.toString("utf8");
			const match = /API: (http:\/\/127\.0\.0\.1:\d+)\nToken: ([a-f0-9]+)\n/.exec(output);
			if (match) {
				assert.ok(output.includes(`Allowed UI Origin: ${origin}`));
				output = "";
				clearTimeout(timer);
				ready.resolve({ url: match[1], token: match[2] });
			}
		});
		child.once("error", () => ready.reject(new Error("Acceptance host failed to start")));
		try {
			const client = createHttpClient({ ...(await ready.promise), origin });
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
			child.kill("SIGTERM");
			const [code] = await exited;
			assert.equal(code, 0);
		} finally {
			clearTimeout(timer);
			if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
			await exited;
			await rm(directory, { recursive: true, force: true });
		}
	},
);
