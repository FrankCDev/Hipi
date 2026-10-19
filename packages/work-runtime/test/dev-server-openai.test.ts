import assert from "node:assert/strict";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createHttpCredentialBridge } from "../src/credential-http-client.ts";
import { createHttpClient } from "../src/transport-http-client.ts";

import { startDevHost } from "./helpers/dev-host.ts";

const origin = "http://127.0.0.1:5173";
const sentinel = "fictional-memory-key-not-for-network-use";
function start(directory: string) {
	return startDevHost({
		directory,
		provider: "openai",
		origin,
		env: { ...process.env, OPENAI_API_KEY: "fictional-ambient-key-must-be-ignored" },
	});
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
