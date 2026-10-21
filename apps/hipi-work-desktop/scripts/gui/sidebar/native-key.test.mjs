import assert from "node:assert/strict";
import test from "node:test";
import { nativeKeyEvents } from "./native-key.mjs";

test("macOS Meta+A supplies selectAll only on raw keydown", () => {
	assert.deepEqual(nativeKeyEvents("a", 4, "darwin"), [
		{ type: "rawKeyDown", key: "a", code: "KeyA", windowsVirtualKeyCode: 65, modifiers: 4, commands: ["selectAll"] },
		{ type: "keyUp", key: "a", code: "KeyA", windowsVirtualKeyCode: 65, modifiers: 4 },
	]);
});

test("macOS Backspace supplies deleteBackward only on raw keydown", () => {
	const [down, up] = nativeKeyEvents("Backspace", 0, "darwin");
	assert.deepEqual(down, {
		type: "rawKeyDown",
		key: "Backspace",
		code: "Backspace",
		windowsVirtualKeyCode: 8,
		modifiers: 0,
		commands: ["deleteBackward"],
	});
	assert.equal(up.type, "keyUp");
	assert.equal(Object.hasOwn(up, "commands"), false);
	assert.equal(Object.hasOwn(down, "text"), false);
});

for (const platform of ["linux", "win32"]) {
	test(`${platform} retains native Control+A and Backspace payloads without commands`, () => {
		for (const [value, modifiers] of [
			["a", 2],
			["a", 4],
			["Backspace", 0],
		]) {
			const events = nativeKeyEvents(value, modifiers, platform);
			assert.deepEqual(
				events.map((event) => event.type),
				["keyDown", "keyUp"],
			);
			assert.ok(events.every((event) => !Object.hasOwn(event, "commands")));
			assert.ok(events.every((event) => event.modifiers === modifiers));
		}
	});
}

test("macOS does not apply unmodified edit commands to different modifier chords", () => {
	for (const [value, modifiers] of [
		["a", 0],
		["a", 2],
		["a", 6],
		["a", 12],
		["Backspace", 1],
		["Backspace", 4],
	]) {
		assert.ok(nativeKeyEvents(value, modifiers, "darwin").every((event) => !Object.hasOwn(event, "commands")));
	}
});

test("disclosure text keys retain keydown text and keyup never inserts text", () => {
	for (const platform of ["darwin", "linux", "win32"]) {
		for (const [value, text] of [
			["Enter", "\r"],
			[" ", " "],
		]) {
			const [down, up] = nativeKeyEvents(value, 0, platform);
			assert.equal(down.type, "keyDown");
			assert.equal(down.text, text);
			assert.equal(Object.hasOwn(up, "text"), false);
			assert.equal(Object.hasOwn(down, "commands"), false);
		}
	}
});

test("navigation and ordering keys preserve modifiers without editing commands", () => {
	for (const value of ["Tab", "Escape", "ArrowUp", "ArrowDown"]) {
		const events = nativeKeyEvents(value, 1, "darwin");
		assert.deepEqual(
			events.map((event) => event.type),
			["keyDown", "keyUp"],
		);
		assert.ok(events.every((event) => event.modifiers === 1 && !Object.hasOwn(event, "commands")));
	}
});

test("unsupported native fixture keys fail before dispatch", () => {
	assert.throws(() => nativeKeyEvents("Unknown", 0, "darwin"), /Unsupported native fixture key/);
});
