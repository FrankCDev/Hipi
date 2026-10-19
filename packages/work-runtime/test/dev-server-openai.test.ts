import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { createHttpCredentialBridge } from "../src/credential-http-client.ts";
import { createHttpClient } from "../src/transport-http-client.ts";

const origin = "http://127.0.0.1:5173";
const sentinel = "fictional-memory-key-not-for-network-use";
async function start(directory: string) {
	const child = spawn(
		process.execPath,
		[
			"--conditions=source",
			fileURLToPath(new URL("../src/dev-server.ts", import.meta.url)),
			"--provider",
			"openai",
			"--origin",
			origin,
			"--data",
			directory,
		],
		{
			stdio: ["ignore", "pipe", "pipe"],
			env: { ...process.env, OPENAI_API_KEY: "fictional-ambient-key-must-be-ignored" },
		},
	);
	const exited = once(child, "exit");
	const ready = Promise.withResolvers<{ url: string; token: string }>();
	let output = "";
	let logs = "";
	const timer = setTimeout(() => {
		child.kill("SIGKILL");
		ready.reject(new Error("Host startup timeout"));
	}, 5000);
	child.stdout.on("data", (chunk: Buffer) => {
		output += chunk.toString("utf8");
		const match = /API: (http:\/\/127\.0\.0\.1:\d+)\nToken: ([a-f0-9]+)\n/.exec(output);
		if (match) {
			clearTimeout(timer);
			ready.resolve({ url: match[1], token: match[2] });
		}
	});
	child.stderr.on("data", (chunk: Buffer) => {
		logs += chunk.toString("utf8");
	});
	child.once("error", () => {
		clearTimeout(timer);
		ready.reject(new Error("Host startup failed"));
	});
	const connection = await ready.promise;
	return {
		connection,
		output,
		logs: () => logs,
		async close() {
			child.kill("SIGTERM");
			const [code] = await exited;
			assert.equal(code, 0);
		},
	};
}

test(
	"explicit OpenAI devhost ignores ambient keys, never persists keys, and clears keys on restart",
	{ timeout: 15000 },
	async () => {
		const directory = await mkdtemp(join(tmpdir(), "hipi-openai-host-"));
		try {
			const first = await start(directory);
			try {
				assert.match(first.output, /memory-only.*cleared on host restart/);
				assert.match(first.output, /without automatic execution resume/);
				const bridge = createHttpCredentialBridge({ ...first.connection, origin });
				const client = createHttpClient({ ...first.connection, origin });
				assert.deepEqual(await bridge.request({ version: 1, operation: "status", provider: "openai" }), {
					ok: true,
					state: "missing",
				});
				const models = await client.call("listModels", {});
				assert.ok(models.models.length > 0);
				assert.equal(
					models.providers.find((provider) => provider.provider === "openai")?.credentialState,
					"missing",
				);
				assert.deepEqual(
					await bridge.request({ version: 1, operation: "set", provider: "openai", secret: sentinel }),
					{ ok: true, state: "configured" },
				);
				assert.ok(!first.logs().includes(sentinel));
			} finally {
				await first.close();
			}
			for (const file of await readdir(directory)) {
				assert.ok(!(await readFile(join(directory, file))).includes(Buffer.from(sentinel)));
			}
			const second = await start(directory);
			try {
				assert.deepEqual(
					await createHttpCredentialBridge({ ...second.connection, origin }).request({
						version: 1,
						operation: "status",
						provider: "openai",
					}),
					{ ok: true, state: "missing" },
				);
			} finally {
				await second.close();
			}
		} finally {
			await rm(directory, { recursive: true, force: true });
		}
	},
);
