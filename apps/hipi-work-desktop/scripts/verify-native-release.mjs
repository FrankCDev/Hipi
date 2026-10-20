import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { lstat, mkdir, mkdtemp, readdir, readlink, realpath, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, posix, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { artifactDigest } from "./release-artifacts.mjs";

// Reuse the exact locked ZIP reader already owned by the runtime's document
// boundary. No second archive implementation or new dependency is introduced.
const runtimeRequire = createRequire(new URL("../../../packages/work-runtime/package.json", import.meta.url));
const zipReader = runtimeRequire("yauzl");

export function nativeCommand(binary, args) {
	const result = spawnSync(binary, args, {
		encoding: "utf8",
		timeout: 120_000,
		maxBuffer: 2 * 1024 * 1024,
		env: Object.fromEntries(
			Object.entries(process.env).filter(([key]) =>
				/^(?:PATH|SYSTEMROOT|WINDIR|HOME|USERPROFILE|TMP|TEMP|TMPDIR)$/i.test(key),
			),
		),
	});
	// Avoid forwarding raw command diagnostics, which may contain private
	// keychain paths. The caller records the failed verification step only.
	if (result.error || result.status !== 0)
		throw new Error(`Native release verification failed: ${posix.basename(binary.replaceAll("\\", "/"))}`);
	return { stdout: result.stdout, stderr: result.stderr };
}

export async function nativePayload(directory, prefix = "", root) {
	assert.ok((await lstat(directory)).isDirectory(), "Native package root must be a real directory");
	root ??= await realpath(directory);
	const records = [];
	for (const entry of await readdir(directory, { withFileTypes: true })) {
		const file = prefix ? `${prefix}/${entry.name}` : entry.name;
		const location = join(directory, entry.name);
		const info = await lstat(location);
		if (info.isDirectory()) {
			records.push({ file, type: "directory", mode: info.mode & 0o7777 });
			records.push(...(await nativePayload(location, file, root)));
		} else if (info.isSymbolicLink()) {
			const target = await readlink(location);
			const resolved = posix.normalize(posix.join(posix.dirname(file), target));
			assert.ok(
				!target.startsWith("/") && !target.includes("\\") && resolved !== ".." && !resolved.startsWith("../"),
				"Native symlink escapes the application",
			);
			// Lexical normalization alone misses multi-hop links followed by "..".
			// realpath also rejects dangling and cyclic framework links.
			const actual = relative(root, await realpath(location));
			assert.ok(
				actual !== ".." && !actual.startsWith(`..${posix.sep}`) && !actual.startsWith("..\\") && !isAbsolute(actual),
				"Native symlink resolves outside the application",
			);
			const bytes = Buffer.from(target);
			records.push({
				file,
				type: "symlink",
				mode: info.mode & 0o7777,
				bytes: bytes.length,
				sha256: createHash("sha256").update(bytes).digest("hex"),
			});
		} else {
			assert.ok(info.isFile() && info.nlink === 1, "Unexpected native package entry");
			const hash = createHash("sha256");
			let bytes = 0;
			for await (const chunk of createReadStream(location)) {
				bytes += chunk.length;
				hash.update(chunk);
			}
			assert.equal(bytes, info.size, "Native payload changed while reading");
			records.push({ file, type: "file", mode: info.mode & 0o7777, bytes, sha256: hash.digest("hex") });
		}
	}
	return records.sort((a, b) => a.file.localeCompare(b.file));
}

export async function verifyZipPayload(archive, expected, { unixModes = false } = {}) {
	const records = new Map(expected.map((item) => [item.file, item]));
	assert.equal(records.size, expected.length, "Duplicate expected archive path");
	const seen = new Set();
	const zip = await new Promise((resolve, reject) =>
		zipReader.open(
			archive,
			{
				lazyEntries: true,
				strictFileNames: true,
				validateEntrySizes: true,
			},
			(error, value) => (error ? reject(error) : resolve(value)),
		),
	);
	await new Promise((resolve, reject) => {
		const fail = (error) => {
			zip.close();
			reject(error);
		};
		zip.once("error", fail);
		zip.once("end", () => {
			try {
				for (const item of expected) {
					// Windows ZIPs may imply nonempty parents. Empty directories,
					// and every directory with verified Unix modes, must be explicit.
					const required =
						item.type !== "directory" || unixModes || !expected.some((child) => child.file.startsWith(`${item.file}/`));
					if (required) assert.ok(seen.has(item.file), "ZIP payload is incomplete");
				}
				resolve();
			} catch (error) {
				fail(error);
			}
		});
		zip.on("entry", (entry) => {
			(async () => {
				const name = entry.fileName.replace(/\/$/, "");
				assert.ok(
					name &&
						!name.includes("\\") &&
						!name.startsWith("/") &&
						!name.split("/").some((part) => part === ".." || part === "." || !part),
					"Unsafe ZIP path",
				);
				assert.equal(seen.has(name), false, "Duplicate ZIP entry");
				seen.add(name);
				const expectedEntry = records.get(name);
				assert.ok(expectedEntry, "Unexpected ZIP entry");
				assert.equal(entry.isEncrypted(), false, "Encrypted ZIP entry");
				const mode = entry.externalFileAttributes >>> 16;
				const type = mode & 0o170000;
				const directory = entry.fileName.endsWith("/");
				if (expectedEntry.type === "directory") {
					assert.ok(directory && entry.uncompressedSize === 0, "Invalid ZIP directory");
					assert.ok(type === 0 || type === 0o040000, "ZIP directory type mismatch");
					if (unixModes) assert.equal(mode & 0o7777, expectedEntry.mode, "ZIP directory mode mismatch");
				} else {
					assert.equal(directory, false);
					assert.equal(entry.uncompressedSize, expectedEntry.bytes, "ZIP entry size mismatch");
					if (expectedEntry.type === "symlink") assert.equal(type, 0o120000, "ZIP symlink type mismatch");
					else assert.ok(type === 0 || type === 0o100000, "ZIP file type mismatch");
					if (unixModes) assert.equal(mode & 0o7777, expectedEntry.mode, "ZIP mode mismatch");
					const stream = await new Promise((resolveStream, rejectStream) =>
						zip.openReadStream(entry, (error, value) => (error ? rejectStream(error) : resolveStream(value))),
					);
					const hash = createHash("sha256");
					let bytes = 0;
					for await (const chunk of stream) {
						bytes += chunk.length;
						assert.ok(bytes <= expectedEntry.bytes, "ZIP payload exceeds expected size");
						hash.update(chunk);
					}
					assert.equal(bytes, expectedEntry.bytes);
					assert.equal(hash.digest("hex"), expectedEntry.sha256, "ZIP payload digest mismatch");
				}
				zip.readEntry();
			})().catch(fail);
		});
		zip.readEntry();
	});
}

export function verifyMacSignature(app, policy, run = nativeCommand) {
	assert.equal(
		run("/usr/libexec/PlistBuddy", [
			"-c",
			"Print :CFBundleShortVersionString",
			join(app, "Contents/Info.plist"),
		]).stdout.trim(),
		policy.version,
		"macOS bundle version mismatch",
	);
	run("/usr/bin/codesign", ["--verify", "--deep", "--strict", "--verbose=2", app]);
	const signature = run("/usr/bin/codesign", ["--display", "--verbose=4", app]).stderr;
	assert.ok(signature.split(/\r?\n/).includes("Identifier=org.hipi.work"), "Incorrect macOS application identity");
	assert.ok(signature.split(/\r?\n/).includes(`TeamIdentifier=${policy.teamId}`), "Incorrect macOS signing team");
	assert.ok(
		signature.split(/\r?\n/).includes(`Authority=Developer ID Application: ${policy.identity}`),
		"Incorrect macOS signing identity",
	);
	assert.match(signature, /flags=.*\bruntime\b/, "Hardened runtime was not signed");
	assert.match(signature, /^Timestamp=.+$/m, "A secure macOS signing timestamp is required");
	run("/usr/bin/xcrun", ["stapler", "validate", app]);
	const assessment = run("/usr/sbin/spctl", ["--assess", "--verbose=2", "--type", "execute", app]);
	assert.match(
		`${assessment.stdout}\n${assessment.stderr}`,
		/source=Notarized Developer ID/,
		"Notarized Developer ID assessment required",
	);
	return { signing: "verified", notarization: "verified", teamId: policy.teamId, identity: policy.identity };
}

export function verifyWindowsSignature(file, policy, run = nativeCommand, environment = process.env, version) {
	assert.ok(environment.SystemRoot || environment.SYSTEMROOT, "Windows SystemRoot is required");
	const powershell = join(
		environment.SystemRoot ?? environment.SYSTEMROOT,
		"System32/WindowsPowerShell/v1.0/powershell.exe",
	);
	const script = join(dirname(fileURLToPath(import.meta.url)), "verify-windows-signature.ps1");
	const result = JSON.parse(
		run(powershell, [
			"-NoProfile",
			"-NonInteractive",
			"-File",
			script,
			"-Target",
			file,
			"-Thumbprint",
			policy.certificateSha1,
			"-Publisher",
			policy.publisher,
			...(version ? ["-Version", version] : []),
		]).stdout,
	);
	assert.deepEqual(
		result,
		{
			status: "Valid",
			thumbprint: policy.certificateSha1,
			publisher: policy.publisher,
			timestamped: true,
			version: version ?? null,
		},
		"Windows signature identity, timestamp or version mismatch",
	);
	return { signing: "verified", certificateSha1: policy.certificateSha1, publisher: policy.publisher };
}

export async function verifyNativeArtifacts(output, artifacts, policy, run = nativeCommand) {
	// Compare the final serialized ZIP to the actual signed tree. This binds all
	// app bytes (including signatures and symlink semantics) without extracting
	// untrusted archive paths or executing installers.
	const platformKey = policy.platform === "darwin" ? "mac" : "win";
	const unpacked = `${platformKey}${policy.architecture === "x64" ? "" : `-${policy.architecture}`}${policy.platform === "darwin" ? "" : "-unpacked"}`;
	const directory = join(output, unpacked);
	const app = policy.platform === "darwin" ? join(directory, "Hipi Work.app") : directory;
	const tree = await nativePayload(app);
	const zip = artifacts.find((item) => item.file.endsWith(".zip"));
	assert.ok(zip, "Expected final ZIP");
	let native;
	if (policy.platform === "darwin") {
		native = verifyMacSignature(app, policy, run);
		const rootMode = (await lstat(app)).mode & 0o7777;
		await verifyZipPayload(
			join(output, zip.file),
			[
				{ file: "Hipi Work.app", type: "directory", mode: rootMode },
				...tree.map((item) => ({ ...item, file: `Hipi Work.app/${item.file}` })),
			],
			{ unixModes: true },
		);
		const dmg = artifacts.find((item) => item.file.endsWith(".dmg"));
		assert.ok(dmg);
		const image = join(output, dmg.file);
		run("/usr/bin/hdiutil", ["verify", image]);
		const temporary = await mkdtemp(join(tmpdir(), "hipi-release-image-"));
		const mountpoint = join(temporary, "mount");
		await mkdir(mountpoint);
		let attached = false;
		try {
			// A failed attach can have an uncertain outcome. Attempt detachment
			// before any cleanup even when hdiutil returns failure.
			attached = true;
			run("/usr/bin/hdiutil", ["attach", "-readonly", "-nobrowse", "-noautoopen", "-mountpoint", mountpoint, image]);
			assert.deepEqual(
				await nativePayload(join(mountpoint, "Hipi Work.app")),
				tree,
				"DMG contains different application bytes",
			);
			verifyMacSignature(join(mountpoint, "Hipi Work.app"), policy, run);
		} finally {
			// Never recursively clean up an image whose detach failed.
			if (attached) run("/usr/bin/hdiutil", ["detach", mountpoint]);
			await rm(temporary, { recursive: true });
		}
	} else {
		assert.equal(policy.platform, "win32");
		assert.ok(
			tree.some((item) => item.file === "Hipi Work.exe"),
			"Windows application executable missing",
		);
		for (const item of tree.filter((item) => item.file.toLowerCase().endsWith(".exe"))) {
			assert.equal(item.type, "file", "Windows executable must be regular");
			native = verifyWindowsSignature(
				join(app, item.file),
				policy,
				run,
				process.env,
				item.file === "Hipi Work.exe" ? policy.version : undefined,
			);
		}
		const installer = artifacts.find((item) => item.file.endsWith(".exe"));
		assert.ok(installer);
		verifyWindowsSignature(join(output, installer.file), policy, run, process.env, policy.version);
		await verifyZipPayload(join(output, zip.file), tree);
	}
	assert.deepEqual(await nativePayload(app), tree, "Signed tree changed during verification");
	for (const artifact of artifacts)
		assert.deepEqual(
			await artifactDigest(join(output, artifact.file)),
			{ bytes: artifact.bytes, sha256: artifact.sha256 },
			"Artifact changed during native verification",
		);
	return native;
}
