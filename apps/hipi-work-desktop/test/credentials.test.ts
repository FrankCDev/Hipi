import assert from "node:assert/strict";
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { mkdtemp, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { credentialRequest, MAX_CREDENTIAL_PROVIDERS } from "../src/credentials/protocol.ts";
import { CredentialRpc, credentialReply } from "../src/credentials/rpc.ts";
import { type CredentialStatusStage, CredentialStore } from "../src/credentials/store.ts";
import { decode, encode } from "../src/ipc/protocol.ts";

const customA = "custom_5e00d2f1-1301-4b56-bd5e-d32eff18d67a";
const customB = "custom_9fef7182-ecf4-46ad-81f5-a71cbba81541";

// Synthetic local crypto proves adapter boundaries, not OS keychain behavior.
// Filesystem integration uses the real host platform; only backend-policy tests override it.
function syntheticStorage(backend = "gnome_libsecret") {
	const key = randomBytes(32);
	return {
		isEncryptionAvailable: () => true,
		getSelectedStorageBackend: () => backend,
		encryptString(value: string) {
			const iv = randomBytes(12);
			const cipher = createCipheriv("aes-256-gcm", key, iv);
			const encrypted = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
			return Buffer.concat([iv, cipher.getAuthTag(), encrypted]);
		},
		decryptString(value: Buffer) {
			const decipher = createDecipheriv("aes-256-gcm", key, value.subarray(0, 12));
			decipher.setAuthTag(value.subarray(12, 28));
			return Buffer.concat([decipher.update(value.subarray(28)), decipher.final()]).toString("utf8");
		},
	};
}
test("encrypted store serializes set/remove/read and never persists a plaintext sentinel", async () => {
	const dir = await mkdtemp(join(tmpdir(), "hipi-credentials-"));
	try {
		const path = join(dir, "providers.enc");
		const crypto = syntheticStorage();
		const store = new CredentialStore(path, crypto);
		assert.equal(await store.status("openai"), "missing");
		await Promise.all([
			store.set("openai", "synthetic-secret-one"),
			store.remove("openai"),
			store.set("openai", "synthetic-secret-two"),
		]);
		assert.equal(await store.get("openai"), "synthetic-secret-two");
		assert.equal(await store.status("openai"), "configured");
		assert.equal((await readFile(path)).includes(Buffer.from("synthetic-secret")), false);
		const reopened = new CredentialStore(path, crypto);
		assert.equal(await reopened.get("openai"), "synthetic-secret-two");
		await reopened.remove("openai");
		assert.equal(await reopened.status("openai"), "missing");
		assert.equal(await reopened.get("openai"), undefined);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});
test("legacy encrypted credentials migrate only on write and preserve each custom identity across restart", async () => {
	const dir = await mkdtemp(join(tmpdir(), "hipi-credentials-"));
	try {
		const path = join(dir, "providers.enc");
		const crypto = syntheticStorage();
		const legacy = crypto.encryptString(JSON.stringify({ version: 1, openai: "synthetic-legacy-secret" }));
		await writeFile(path, legacy);
		const store = new CredentialStore(path, crypto);
		assert.equal(await store.get("openai"), "synthetic-legacy-secret");
		assert.equal(await store.status(customA), "missing");
		assert.deepEqual(await readFile(path), legacy, "reading must not migrate or replace the existing file");
		await Promise.all([
			store.set(customA, "synthetic-profile-a"),
			store.set(customB, "synthetic-profile-b"),
			store.set(customA, "synthetic-profile-a-updated"),
		]);
		const encrypted = await readFile(path);
		assert.equal(encrypted.includes(Buffer.from("synthetic")), false);
		assert.deepEqual(JSON.parse(crypto.decryptString(encrypted)), {
			version: 2,
			providers: {
				openai: "synthetic-legacy-secret",
				[customA]: "synthetic-profile-a-updated",
				[customB]: "synthetic-profile-b",
			},
		});
		const reopened = new CredentialStore(path, crypto);
		assert.equal(await reopened.get("openai"), "synthetic-legacy-secret");
		assert.equal(await reopened.get(customA), "synthetic-profile-a-updated");
		assert.equal(await reopened.get(customB), "synthetic-profile-b");
		await reopened.remove(customA);
		assert.equal(await reopened.status(customA), "missing");
		assert.equal(await reopened.get(customA), undefined);
		assert.equal(await reopened.get("openai"), "synthetic-legacy-secret");
		assert.equal(await reopened.get(customB), "synthetic-profile-b");
		await reopened.remove("openai");
		assert.equal(await reopened.status("openai"), "missing");
		assert.equal(await reopened.get(customB), "synthetic-profile-b");
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});
test("legacy removal migrates an empty map without reviving deleted credentials", async () => {
	const dir = await mkdtemp(join(tmpdir(), "hipi-credentials-"));
	try {
		const path = join(dir, "providers.enc");
		const crypto = syntheticStorage();
		await writeFile(path, crypto.encryptString('{"version":1,"openai":"synthetic-old"}'));
		await new CredentialStore(path, crypto).remove("openai");
		assert.deepEqual(JSON.parse(crypto.decryptString(await readFile(path))), { version: 2, providers: {} });
		assert.equal(await new CredentialStore(path, crypto).status("openai"), "missing");
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});
test("Linux unavailable and weak or unknown backends fail closed without a file", async () => {
	const dir = await mkdtemp(join(tmpdir(), "hipi-credentials-"));
	try {
		for (const backend of ["basic_text", "unknown", "unrecognized"]) {
			const store = new CredentialStore(join(dir, "providers.enc"), syntheticStorage(backend), "linux");
			assert.equal(await store.status("openai"), "unavailable");
			await assert.rejects(store.set("openai", "synthetic-secret"));
			await assert.rejects(store.get("openai"));
			assert.equal(await store.status(customA), "unavailable");
			await assert.rejects(store.set(customA, "synthetic-secret"));
			await assert.rejects(store.get(customA));
			await assert.rejects(store.remove(customA));
		}
		const storage = syntheticStorage();
		storage.isEncryptionAvailable = () => false;
		assert.equal(await new CredentialStore(join(dir, "providers.enc"), storage).status("openai"), "unavailable");
		assert.deepEqual(await readdir(dir), []);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});
test("status diagnostics report only fixed boundaries and cannot change credential outcomes", async () => {
	const dir = await mkdtemp(join(tmpdir(), "hipi-credentials-"));
	try {
		const path = join(dir, "providers.enc");
		const storage = syntheticStorage();
		const stages: CredentialStatusStage[] = [];
		const store = new CredentialStore(path, storage, process.platform, rename, (stage) => {
			stages.push(stage);
			throw new Error("synthetic-observer-failure");
		});
		const complete = [
			"status-enter",
			"availability-enter",
			"availability-return",
			"file-read-enter",
			"file-read-return",
			"status-return",
		];
		assert.equal(await store.status("openai"), "missing");
		assert.deepEqual(stages, complete);
		stages.length = 0;
		await store.set("openai", "synthetic-secret");
		assert.deepEqual(stages, [], "set must not emit status diagnostics");
		assert.equal(await store.status("openai"), "configured");
		assert.deepEqual(stages, complete);
		stages.length = 0;
		await writeFile(path, "damaged");
		assert.equal(await store.status("openai"), "locked");
		assert.deepEqual(stages, complete);
		assert.equal(await readFile(path, "utf8"), "damaged");
		stages.length = 0;
		storage.isEncryptionAvailable = () => false;
		assert.equal(await store.status("openai"), "unavailable");
		assert.deepEqual(stages, ["status-enter", "availability-enter", "availability-return", "status-return"]);
		stages.length = 0;
		assert.throws(() => store.status("not-a-provider"));
		assert.deepEqual(stages, []);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});
test("corrupt, oversized, and undecryptable files stay intact on set and remove", async () => {
	const dir = await mkdtemp(join(tmpdir(), "hipi-credentials-"));
	try {
		const path = join(dir, "providers.enc");
		const crypto = syntheticStorage();
		for (const bytes of [
			Buffer.from("damaged"),
			Buffer.alloc(32769),
			crypto.encryptString('{"version":999}'),
			syntheticStorage().encryptString('{"version":1}'),
			crypto.encryptString('{"version":2,"providers":{"__proto__":"synthetic-invalid"}}'),
			crypto.encryptString('{"version":2,"providers":{"constructor":"synthetic-invalid"}}'),
			crypto.encryptString('{"version":2,"providers":{"custom_bad\\n":"synthetic-invalid"}}'),
			crypto.encryptString('{"version":2,"providers":{"custom_good":"invalid\\u0000secret"}}'),
			crypto.encryptString('{"version":2,"providers":[]}'),
			crypto.encryptString('{"version":2,"providers":{},"unexpected":"value"}'),
			crypto.encryptString(
				JSON.stringify({
					version: 2,
					providers: Object.fromEntries(
						Array.from({ length: MAX_CREDENTIAL_PROVIDERS + 1 }, (_, index) => [`custom_${index}`, "synthetic-key"]),
					),
				}),
			),
		]) {
			await writeFile(path, bytes);
			const store = new CredentialStore(path, crypto);
			assert.equal(await store.status("openai"), "locked");
			await assert.rejects(store.set("openai", "synthetic-secret"));
			await assert.rejects(store.remove("openai"));
			assert.equal(await store.status(customA), "locked");
			await assert.rejects(store.get(customA));
			await assert.rejects(store.set(customA, "synthetic-secret"));
			await assert.rejects(store.remove(customA));
			assert.deepEqual(await readFile(path), bytes);
		}
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});
test("failed atomic replacement preserves original and cleans temporary files", async () => {
	const dir = await mkdtemp(join(tmpdir(), "hipi-credentials-"));
	try {
		const path = join(dir, "providers.enc");
		const crypto = syntheticStorage();
		const store = new CredentialStore(path, crypto);
		await store.set("openai", "synthetic-old");
		await store.set(customA, "synthetic-profile-a");
		await store.set(customB, "synthetic-profile-b");
		const bytes = await readFile(path);
		const broken = new CredentialStore(path, crypto, process.platform, async () => {
			throw new Error("synthetic-secret-sensitive-path");
		});
		await assert.rejects(broken.set("openai", "synthetic-new"), (error: Error) => !error.message.includes("synthetic"));
		await assert.rejects(broken.set(customA, "synthetic-replacement"));
		await assert.rejects(broken.remove(customB));
		assert.deepEqual(await readFile(path), bytes);
		assert.deepEqual(await readdir(dir), ["providers.enc"]);
		assert.equal(await store.get("openai"), "synthetic-old");
		assert.equal(await store.get(customA), "synthetic-profile-a");
		assert.equal(await store.get(customB), "synthetic-profile-b");
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});
test("failed migration and encryption preserve legacy credentials without exposing exception text", async () => {
	const dir = await mkdtemp(join(tmpdir(), "hipi-credentials-"));
	try {
		const path = join(dir, "providers.enc");
		const crypto = syntheticStorage();
		const legacy = crypto.encryptString('{"version":1,"openai":"synthetic-legacy"}');
		await writeFile(path, legacy);
		const failedMigration = new CredentialStore(path, crypto, process.platform, async () => {
			throw new Error("synthetic-private-path");
		});
		await assert.rejects(failedMigration.set(customA, "synthetic-new"), { code: "INTERNAL", message: "INTERNAL" });
		assert.deepEqual(await readFile(path), legacy);
		const failedEncryption = new CredentialStore(path, {
			...crypto,
			encryptString() {
				throw new Error("synthetic-secret-must-not-escape");
			},
		});
		await assert.rejects(failedEncryption.set(customA, "synthetic-new"), { code: "INTERNAL", message: "INTERNAL" });
		await assert.rejects(failedEncryption.remove("openai"), { code: "INTERNAL", message: "INTERNAL" });
		assert.deepEqual(await readFile(path), legacy);
		assert.deepEqual(await readdir(dir), ["providers.enc"]);
		assert.equal(await new CredentialStore(path, crypto).get("openai"), "synthetic-legacy");
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});
test("credential count and encrypted size limits preserve the current complete map", async () => {
	const dir = await mkdtemp(join(tmpdir(), "hipi-credentials-"));
	try {
		const crypto = syntheticStorage();
		const countPath = join(dir, "count.enc");
		const countStore = new CredentialStore(countPath, crypto);
		for (let index = 0; index < MAX_CREDENTIAL_PROVIDERS; index++)
			await countStore.set(`custom_${index}`, "synthetic-key");
		const full = await readFile(countPath);
		await assert.rejects(countStore.set(customA, "synthetic-overflow"), { code: "CAPACITY_EXCEEDED" });
		assert.deepEqual(await readFile(countPath), full);
		await countStore.set("custom_0", "synthetic-updated-at-capacity");
		assert.equal(await countStore.get("custom_0"), "synthetic-updated-at-capacity");
		await countStore.remove("custom_1");
		await countStore.set(customA, "synthetic-new-after-remove");
		assert.equal(await countStore.get(customA), "synthetic-new-after-remove");

		const sizePath = join(dir, "size.enc");
		const sizeStore = new CredentialStore(sizePath, crypto);
		for (let index = 0; index < 7; index++) await sizeStore.set(`custom_${index}`, "x".repeat(4096));
		const beforeOverflow = await readFile(sizePath);
		await assert.rejects(sizeStore.set(customB, "y".repeat(4096)), { code: "CAPACITY_EXCEEDED" });
		assert.deepEqual(await readFile(sizePath), beforeOverflow);
		assert.equal(await sizeStore.status(customB), "missing");
		assert.equal(await sizeStore.get("custom_0"), "x".repeat(4096));
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});
test("renderer credential capability rejects read, unknown fields, and invalid secrets", () => {
	assert.deepEqual(credentialRequest({ version: 1, operation: "status", provider: "openai" }), {
		version: 1,
		operation: "status",
		provider: "openai",
	});
	for (const value of [
		{ operation: "get", provider: "openai" },
		{ operation: "status", provider: "openai", secret: "x" },
		{ operation: "set", provider: "other", secret: "x" },
		{ operation: "set", provider: "openai", secret: "x\n" },
		{ operation: "set", provider: "openai", secret: "x".repeat(4097) },
		...["__proto__", "constructor", "prototype", "custom_", "custom_bad\n", `custom_${"x".repeat(65)}`].map(
			(provider) => ({
				operation: "status",
				provider,
			}),
		),
	])
		assert.throws(() => credentialRequest({ version: 1, ...value }));
});
test("private credential RPC routes custom identity reads without falling back to another key", async () => {
	const sent: string[] = [];
	const rpc = new CredentialRpc("current", (raw) => sent.push(raw));
	const secrets = new Map([
		["openai", "synthetic-official"],
		[customA, "synthetic-profile-a"],
	]);
	try {
		for (const provider of ["openai", customA, customB]) {
			const pending = rpc.get(provider);
			const request = sent.at(-1);
			assert.equal(decode(request).provider, provider);
			rpc.receive(
				await credentialReply(request, "current", {
					get: async (identity) => secrets.get(identity),
					status: async (identity) => (secrets.has(identity) ? "configured" : "missing"),
				}),
			);
			assert.equal(await pending, secrets.get(provider));
		}
	} finally {
		rpc.close();
	}
});
test("private credential RPC rejects stale generation, bounds requests, and redacts errors", async () => {
	const sent: string[] = [];
	const rpc = new CredentialRpc("current", (raw) => sent.push(raw));
	const pending = rpc.get("openai");
	const id = decode(sent[0]).id;
	rpc.receive(encode({ generation: "old", kind: "credentialResult", id, ok: true, value: "wrong-secret" }));
	rpc.receive(
		await credentialReply(sent[0], "current", {
			get: async () => "synthetic-secret",
			status: async () => "configured",
		}),
	);
	assert.equal(await pending, "synthetic-secret");
	await assert.rejects(
		credentialReply(sent[0], "other", { get: async () => undefined, status: async () => "missing" }),
	);
	const failure = await credentialReply(sent[0], "current", {
		get: async () => {
			throw new Error("synthetic-secret");
		},
		status: async () => "locked",
	});
	assert.equal(failure.includes("synthetic-secret"), false);
	const waits = Array.from({ length: 16 }, () => rpc.get("openai"));
	await assert.rejects(rpc.get("openai"), { code: "CAPACITY_EXCEEDED" });
	const settled = Promise.allSettled(waits);
	rpc.close();
	assert.equal(
		(await settled).every((value) => value.status === "rejected"),
		true,
	);
});
