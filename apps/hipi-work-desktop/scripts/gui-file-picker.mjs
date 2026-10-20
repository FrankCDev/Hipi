// Linux candidate: actual GTK native picker on this harness's private Xvfb only.
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { readdir, readFile, readlink, realpath } from "node:fs/promises";
import { basename } from "node:path";
import { promisify } from "node:util";
import { maxPickerImageBytes, pickerOpenTarget, pickerXwdToPng } from "./gui-file-picker-image.mjs";
import { ownedFileDirectory } from "./gui-file-workbench-fixture.mjs";

const execute = promisify(execFile);
const pickerTitles = {
	files: ["Allow Hipi Work to read and edit this folder", "允许 Hipi Work 读取和编辑此文件夹"],
	project: ["Choose project folder", "选择项目文件夹"],
};

function numericOutput(stdout, keys) {
	const entries = stdout
		.trim()
		.split("\n")
		.map((line) => {
			const match = /^([A-Z]+)=(\d+)$/.exec(line);
			assert.ok(match, "Invalid native geometry output");
			const value = Number(match[2]);
			assert.ok(Number.isSafeInteger(value));
			return [match[1], value];
		});
	assert.deepEqual(entries.map(([key]) => key).sort(), [...keys].sort(), "Unexpected native geometry fields");
	return Object.fromEntries(entries);
}

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
		observe,
		purpose = "files",
		action = "choose",
	} = {},
) {
	assert.equal(process.platform, "linux", "Native file-picker candidate currently supports Linux only");
	assert.ok(Object.hasOwn(pickerTitles, purpose), "Unknown fixed picker purpose");
	assert.ok(["choose", "cancel"].includes(action), "Unknown fixed picker action");
	const titles = pickerTitles[purpose];
	assert.ok(observe === undefined || typeof observe === "function");
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
				`^(${titles.map((title) => title.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|")})$`,
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
	const assertFocused = async () => {
		await assertDialog();
		assert.equal((await command(["getwindowfocus"])).stdout.trim(), window, "Native picker focus not confirmed");
	};
	const capture = async (stage) => {
		await assertFocused();
		assert.deepEqual(await identity(context), original, "Owned native session changed before picker capture");
		// Exact chooser only: never -root, -screen, ambient DISPLAY, or interactive selection.
		const { stdout } = await run("xwd", ["-silent", "-nobdrs", "-id", window], {
			env,
			timeout: 5000,
			maxBuffer: maxPickerImageBytes,
			encoding: "buffer",
		});
		await assertFocused();
		if (observe) await observe(stage, pickerXwdToPng(stdout));
		return stdout;
	};
	const input = async (args) => {
		await assertFocused();
		// --window uses XSendEvent, which GTK can reject. A fresh xdotool invocation without
		// a window stack uses XTEST on this verified private display's focused dialog only.
		// Never recover focus here: any focus/identity change must stop before input.
		await command(args);
	};
	await capture("before-input");
	if (action === "cancel") {
		await input(["key", "--clearmodifiers", "Escape"]);
		const deadline = now() + 3000;
		while (now() < deadline) {
			if (!(await find()))
				return { nativePicker: true, ownedDisplay: true, ownedPid: true, syntheticFolderOnly: true, cancelled: true };
			await pause(50);
		}
		await capture("bounded-failure");
		throw new Error("Native folder picker did not close after single Escape");
	}
	await input(["key", "--clearmodifiers", "ctrl+l"]);
	await input(["key", "--clearmodifiers", "ctrl+a"]);
	await input(["type", "--clearmodifiers", "--delay", "1", "--", directory]);
	const target = pickerOpenTarget(await capture("after-type"));
	const geometry = async () => {
		const value = numericOutput((await command(["getwindowgeometry", "--shell", window])).stdout, [
			"WINDOW",
			"X",
			"Y",
			"WIDTH",
			"HEIGHT",
			"SCREEN",
		]);
		assert.equal(value.WINDOW, Number(window));
		assert.equal(value.SCREEN, 0);
		assert.equal(value.WIDTH, target.width);
		assert.equal(value.HEIGHT, target.height);
		assert.ok(value.X + value.WIDTH <= 1600 && value.Y + value.HEIGHT <= 1000, "Chooser leaves the private display");
		return value;
	};
	// xdotool translates geometry to root coordinates. Move is relative to the exact chooser;
	// independently verify its root position and the window under the pointer before one click.
	const before = await geometry();
	await input(["mousemove", "--sync", "--window", window, String(target.x), String(target.y)]);
	assert.deepEqual(await geometry(), before, "Native chooser moved before Open activation");
	const pointer = numericOutput((await command(["getmouselocation", "--shell"])).stdout, [
		"X",
		"Y",
		"SCREEN",
		"WINDOW",
	]);
	assert.deepEqual(
		pointer,
		{ X: before.X + target.x, Y: before.Y + target.y, SCREEN: 0, WINDOW: Number(window) },
		"Native pointer is not over the reviewed Open target",
	);
	await input(["click", "--clearmodifiers", "1"]);
	const closedDeadline = now() + 3000;
	while (now() < closedDeadline) {
		if (!(await find())) return { nativePicker: true, ownedDisplay: true, ownedPid: true, syntheticFolderOnly: true };
		await pause(50);
	}
	await capture("bounded-failure");
	throw new Error("Native folder picker did not close after single reviewed Open activation");
}
