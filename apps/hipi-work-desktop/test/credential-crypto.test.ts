import assert from "node:assert/strict";
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createCredentialCrypto } from "../src/credential-crypto.ts";
import { CredentialStore } from "../src/credential-store.ts";
import { InvocationGate } from "../src/invocation-gate.ts";

// Contract fixture only: native Keychain availability and ciphertext compatibility require macOS acceptance.
function nativeStorage(): Parameters<typeof createCredentialCrypto>[0] {
	const key = randomBytes(32);
	function encrypt(value: string) {
		const iv = randomBytes(12);
		const cipher = createCipheriv("aes-256-gcm", key, iv);
		const data = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
		return Buffer.concat([iv, cipher.getAuthTag(), data]);
	}
	function decrypt(value: Buffer) {
		const decipher = createDecipheriv("aes-256-gcm", key, value.subarray(0, 12));
		decipher.setAuthTag(value.subarray(12, 28));
		return Buffer.concat([decipher.update(value.subarray(28)), decipher.final()]).toString("utf8");
	}
	return {
		isEncryptionAvailable: () => true,
		getSelectedStorageBackend: () => "gnome_libsecret",
		encryptString: encrypt,
		decryptString: decrypt,
		isAsyncEncryptionAvailable: async () => true,
		encryptStringAsync: async (value) => encrypt(value),
		decryptStringAsync: async (value) => ({ result: decrypt(value), shouldReEncrypt: true }),
	};
}

test("Darwin uses only asynchronous native methods and waits without blocking the event loop", async () => {
	const native = nativeStorage();
	for (const method of [
		"isEncryptionAvailable",
		"encryptString",
		"decryptString",
		"getSelectedStorageBackend",
	] as const)
		native[method] = () => {
			throw new Error("Synchronous method must not be called on Darwin");
		};
	const ready = Promise.withResolvers<boolean>();
	native.isAsyncEncryptionAvailable = () => ready.promise;
	const stages: string[] = [];
	const crypto = createCredentialCrypto(native, "darwin", (stage) => {
		stages.push(stage);
		throw new Error("diagnostic writer failed");
	});
	let settled = false;
	const available = Promise.resolve(crypto.isEncryptionAvailable()).then((value) => {
		settled = true;
		return value;
	});
	await new Promise((resolve) => setTimeout(resolve, 0));
	assert.equal(settled, false);
	assert.deepEqual(stages, ["async-ready-enter"]);
	ready.resolve(true);
	assert.equal(await available, true);
	assert.deepEqual(stages, [
		"async-ready-enter",
		"async-ready-return",
		"probe-encrypt-enter",
		"probe-encrypt-return",
		"probe-decrypt-enter",
		"probe-decrypt-return",
	]);
	const encrypted = await crypto.encryptString("synthetic-secret");
	assert.equal(await crypto.decryptString(encrypted), "synthetic-secret");
});

test("Darwin availability fails closed on readiness failure, unusable crypto, plaintext or mismatched probe", async () => {
	for (const failure of [
		"not-ready",
		"ready-reject",
		"encrypt-reject",
		"empty",
		"plaintext",
		"decrypt-reject",
		"mismatch",
	]) {
		const native = nativeStorage();
		if (failure === "not-ready") native.isAsyncEncryptionAvailable = async () => false;
		if (failure === "ready-reject")
			native.isAsyncEncryptionAvailable = async () => {
				throw new Error("unavailable");
			};
		if (failure === "encrypt-reject")
			native.encryptStringAsync = async () => {
				throw new Error("unavailable");
			};
		if (failure === "empty") native.encryptStringAsync = async () => Buffer.alloc(0);
		if (failure === "plaintext") native.encryptStringAsync = async (value) => Buffer.from(value);
		if (failure === "decrypt-reject")
			native.decryptStringAsync = async () => {
				throw new Error("unavailable");
			};
		if (failure === "mismatch") native.decryptStringAsync = async () => ({ result: "wrong", shouldReEncrypt: false });
		assert.equal(await createCredentialCrypto(native, "darwin").isEncryptionAvailable(), false, failure);
	}
});

test("Linux and Windows retain their existing native storage adapter and weak-backend rejection", async () => {
	const native = nativeStorage();
	for (const platform of ["linux", "win32"] as const) assert.equal(createCredentialCrypto(native, platform), native);
	const directory = await mkdtemp(join(tmpdir(), "hipi-crypto-"));
	try {
		for (const backend of ["basic_text", "unknown"] as const) {
			native.getSelectedStorageBackend = () => backend;
			const store = new CredentialStore(
				join(directory, "providers.enc"),
				createCredentialCrypto(native, "linux"),
				"linux",
			);
			assert.equal(await store.status("openai"), "unavailable");
			await assert.rejects(store.set("openai", "synthetic-secret"));
		}
		assert.deepEqual(await readdir(directory), []);
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
});

test("async store reads legacy ciphertext without rewriting and preserves corrupt files", async () => {
	const directory = await mkdtemp(join(tmpdir(), "hipi-crypto-"));
	try {
		const path = join(directory, "providers.enc");
		const native = nativeStorage();
		const store = new CredentialStore(path, createCredentialCrypto(native, "darwin"), "darwin");
		assert.equal(await store.status("openai"), "missing");
		assert.deepEqual(await readdir(directory), [], "status probe never creates a credential file");
		const legacy = native.encryptString(JSON.stringify({ version: 1, openai: "synthetic-old" }));
		await writeFile(path, legacy);
		assert.equal(await store.status("openai"), "configured");
		assert.equal(await store.get("openai"), "synthetic-old");
		assert.deepEqual(await readFile(path), legacy, "rotation advice must not cause write-on-read");
		await store.set("openai", "synthetic-new");
		assert.equal(JSON.parse(native.decryptString(await readFile(path))).openai, "synthetic-new");
		await writeFile(path, "damaged");
		assert.equal(await store.status("openai"), "locked");
		await assert.rejects(store.set("openai", "synthetic-replacement"));
		await assert.rejects(store.remove("openai"));
		assert.equal(await readFile(path, "utf8"), "damaged");
		native.encryptStringAsync = async () => {
			throw new Error("key unavailable");
		};
		assert.equal(await store.status("openai"), "unavailable");
		assert.equal(await readFile(path, "utf8"), "damaged");
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
});

test("caller timeout retains async store queue and mutation admission until native operation settles", async () => {
	const directory = await mkdtemp(join(tmpdir(), "hipi-crypto-"));
	const release = Promise.withResolvers<void>();
	try {
		const path = join(directory, "providers.enc");
		const native = nativeStorage();
		const encrypt = native.encryptStringAsync;
		const entered = Promise.withResolvers<void>();
		native.encryptStringAsync = async (value) => {
			if (value.includes("synthetic-secret")) {
				entered.resolve();
				await release.promise;
			}
			return encrypt(value);
		};
		const store = new CredentialStore(path, createCredentialCrypto(native, "darwin"), "darwin");
		const gate = new InvocationGate();
		const mutation = store.set("openai", "synthetic-secret");
		const caller = gate.run(() => mutation, 5);
		await entered.promise;
		assert.deepEqual(await caller, { ok: false, error: "CLOSED" });
		assert.equal(gate.pending, 1);
		assert.deepEqual(await readdir(directory), []);
		const queued = Array.from({ length: 15 }, () => store.status("openai"));
		await assert.rejects(store.status("openai"), { code: "CAPACITY_EXCEEDED" });
		release.resolve();
		await mutation;
		assert.deepEqual(await Promise.all(queued), Array(15).fill("configured"));
		assert.equal(gate.pending, 0);
		assert.equal(await store.get("openai"), "synthetic-secret");
	} finally {
		release.resolve();
		await rm(directory, { recursive: true, force: true });
	}
});
