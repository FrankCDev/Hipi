import assert from "node:assert/strict";
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { mkdtemp, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { credentialRequest } from "../src/credential-protocol.ts";
import { CredentialRpc, credentialReply } from "../src/credential-rpc.ts";
import { type CredentialStatusStage, CredentialStore, type SafeStoragePort } from "../src/credential-store.ts";
import { decode, encode } from "../src/protocol.ts";

// Synthetic local crypto proves adapter boundaries, not OS keychain behavior.
function syntheticStorage(backend = "gnome_libsecret"): SafeStoragePort {
	const key = randomBytes(32);
	return {
		isEncryptionAvailable: () => true,
		getSelectedStorageBackend: () => backend,
		encryptString(value) {
			const iv = randomBytes(12);
			const cipher = createCipheriv("aes-256-gcm", key, iv);
			const encrypted = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
			return Buffer.concat([iv, cipher.getAuthTag(), encrypted]);
		},
		decryptString(value) {
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
		const store = new CredentialStore(path, crypto, "linux");
		assert.equal(await store.status("openai"), "missing");
		await Promise.all([
			store.set("openai", "synthetic-secret-one"),
			store.remove("openai"),
			store.set("openai", "synthetic-secret-two"),
		]);
		assert.equal(await store.get("openai"), "synthetic-secret-two");
		assert.equal(await store.status("openai"), "configured");
		assert.equal((await readFile(path)).includes(Buffer.from("synthetic-secret")), false);
		const reopened = new CredentialStore(path, crypto, "linux");
		assert.equal(await reopened.get("openai"), "synthetic-secret-two");
		await reopened.remove("openai");
		assert.equal(await reopened.status("openai"), "missing");
		assert.equal(await reopened.get("openai"), undefined);
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
		const store = new CredentialStore(path, storage, "linux", rename, (stage) => {
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
		]) {
			await writeFile(path, bytes);
			const store = new CredentialStore(path, crypto, "linux");
			assert.equal(await store.status("openai"), "locked");
			await assert.rejects(store.set("openai", "synthetic-secret"));
			await assert.rejects(store.remove("openai"));
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
		await new CredentialStore(path, crypto, "linux").set("openai", "synthetic-old");
		const bytes = await readFile(path);
		const broken = new CredentialStore(path, crypto, "linux", async () => {
			throw new Error("synthetic-secret-sensitive-path");
		});
		await assert.rejects(broken.set("openai", "synthetic-new"), (error: Error) => !error.message.includes("synthetic"));
		assert.deepEqual(await readFile(path), bytes);
		assert.deepEqual(await readdir(dir), ["providers.enc"]);
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
	])
		assert.throws(() => credentialRequest({ version: 1, ...value }));
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
