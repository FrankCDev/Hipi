// Linux candidate: actual GTK native picker on this harness's private Xvfb only.
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { readdir, readFile, readlink, realpath } from "node:fs/promises";
import { basename } from "node:path";
import { promisify } from "node:util";
import { ownedFileDirectory } from "./gui-file-workbench-fixture.mjs";

const execute = promisify(execFile);
const titles = ["Allow Hipi Work to read and edit this folder", "允许 Hipi Work 读取和编辑此文件夹"];

function processIdentity(stat) {
	const fields = stat
		.slice(stat.lastIndexOf(") ") + 2)
		.trim()
		.split(/\s+/);
	assert.match(fields[19] ?? "", /^\d+$/);
	return fields[19];
}

/** Verify the exact app and X server that the lifecycle spawned, never an ambient DISPLAY. */
export async function nativeSessionIdentity(context) {
	assert.equal(process.platform, "linux", "Native file-picker candidate currently supports Linux only");
	const { pid, xvfbPid, display, binary, ownedProfileRoot } = context;
	for (const value of [pid, xvfbPid]) assert.ok(Number.isSafeInteger(value) && value > 1);
	assert.match(display, /^:\d+$/);
	await ownedFileDirectory(ownedProfileRoot);
	assert.equal(await realpath(`/proc/${pid}/exe`), await realpath(binary), "Native app identity changed");
	const args = (await readFile(`/proc/${pid}/cmdline`, "utf8")).split("\0");
	assert.ok(args.includes(`--smoke-data-root=${ownedProfileRoot}`));
	assert.ok(args.includes("--provider=deterministic"));
	const env = (await readFile(`/proc/${pid}/environ`, "utf8")).split("\0");
	assert.ok(env.includes(`DISPLAY=${display}`), "Native app is not on the private display");
	assert.equal(basename(await realpath(`/proc/${xvfbPid}/exe`)), "Xvfb");
	const xvfbArgs = (await readFile(`/proc/${xvfbPid}/cmdline`, "utf8")).split("\0");
	assert.ok(xvfbArgs.includes("-displayfd") && xvfbArgs.includes("-nolisten") && xvfbArgs.includes("tcp"));
	const socket = `/tmp/.X11-unix/X${display.slice(1)}`;
	const sockets = (await readFile("/proc/net/unix", "utf8"))
		.split("\n")
		.map((line) => line.trim().split(/\s+/))
		.filter((fields) => fields[7] === socket || fields[7] === `@${socket}`);
	assert.ok(sockets.length > 0, "Private Xvfb has no matching socket");
	const descriptors = await Promise.all(
		(await readdir(`/proc/${xvfbPid}/fd`)).map(async (fd) => {
			try {
				return await readlink(`/proc/${xvfbPid}/fd/${fd}`);
			} catch (error) {
				if (error.code === "ENOENT") return "";
				throw error;
			}
		}),
	);
	assert.ok(
		sockets.some((fields) => descriptors.includes(`socket:[${fields[6]}]`)),
		"Display does not belong to the spawned Xvfb",
	);
	return {
		app: processIdentity(await readFile(`/proc/${pid}/stat`, "utf8")),
		xvfb: processIdentity(await readFile(`/proc/${xvfbPid}/stat`, "utf8")),
	};
}

/** All commands target one verified native dialog, with a bounded, synthetic-only input. */
export async function chooseOwnedFileFolder(
	context,
	{
		run = execute,
		identity = nativeSessionIdentity,
		pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
		now = Date.now,
	} = {},
) {
	assert.equal(process.platform, "linux", "Native file-picker candidate currently supports Linux only");
	const directory = await ownedFileDirectory(context.ownedProfileRoot);
	assert.match(directory, /^[\x20-\x7e]+$/, "Native helper accepts only an ASCII temporary path");
	const original = await identity(context);
	const env = { PATH: process.env.PATH ?? "", DISPLAY: context.display };
	const command = async (args) => {
		assert.deepEqual(await identity(context), original, "Owned native session changed during picker input");
		return run("xdotool", args, { env, timeout: 5000, maxBuffer: 4096 });
	};
	const find = async () => {
		try {
			const { stdout } = await command([
				"search",
				"--all",
				"--onlyvisible",
				"--pid",
				String(context.pid),
				"--name",
				`^(${titles.join("|")})$`,
			]);
			const ids = stdout.trim().split(/\s+/).filter(Boolean);
			assert.ok(
				ids.every((id) => /^\d+$/.test(id)),
				"Invalid native picker identity",
			);
			assert.ok(ids.length <= 1, "Ambiguous native folder picker");
			return ids[0];
		} catch (error) {
			if (error.code === 1 && !error.killed) return undefined;
			throw error;
		}
	};
	const deadline = now() + 10000;
	let window;
	while (!window && now() < deadline) {
		window = await find();
		if (!window) await pause(50);
	}
	assert.ok(window, "Owned native folder picker did not appear");
	const assertDialog = async () => {
		assert.equal(await find(), window, "Native picker changed before input");
		assert.equal((await command(["getwindowpid", window])).stdout.trim(), String(context.pid));
		assert.ok(titles.includes((await command(["getwindowname", window])).stdout.trim()), "Native picker title changed");
	};
	await assertDialog();
	await command(["windowfocus", "--sync", window]);
	assert.equal((await command(["getwindowfocus"])).stdout.trim(), window, "Native picker focus not confirmed");
	await command(["key", "--clearmodifiers", "--window", window, "ctrl+l"]);
	await assertDialog();
	await command(["key", "--clearmodifiers", "--window", window, "ctrl+a"]);
	await command(["type", "--clearmodifiers", "--window", window, "--delay", "1", "--", directory]);
	for (let attempt = 0; attempt < 2; attempt++) {
		await assertDialog();
		await command(["key", "--clearmodifiers", "--window", window, "Return"]);
		const closedDeadline = now() + 1500;
		while (now() < closedDeadline) {
			if (!(await find())) return { nativePicker: true, ownedDisplay: true, ownedPid: true, syntheticFolderOnly: true };
			await pause(50);
		}
	}
	throw new Error("Native folder picker did not close after bounded confirmation");
}
