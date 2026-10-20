import assert from "node:assert/strict";
import { test } from "node:test";
import { ComposerKeyboard, DEFAULT_EDITOR_KEYBINDINGS } from "../../../src/features/workbench/composer/keyboard.ts";
import { composerTextareaSize } from "../../../src/features/workbench/composer/textarea.ts";

const enter = {
	key: "Enter",
	ctrlKey: false,
	metaKey: false,
	altKey: false,
	shiftKey: false,
	isComposing: false,
	keyCode: 13,
	repeat: false,
	timeStamp: 1000,
};

test("Enter submits, existing Ctrl/Meta shortcuts submit, Shift always preserves native newline", () => {
	const keyboard = new ComposerKeyboard();
	for (const modifiers of [{}, { ctrlKey: true }, { metaKey: true }, { ctrlKey: true, metaKey: true }]) {
		assert.equal(keyboard.keyDown({ ...enter, ...modifiers }), "submit");
		assert.equal(keyboard.keyDown({ ...enter, ...modifiers, shiftKey: true }), "native");
	}
	assert.equal(keyboard.keyDown({ ...enter, altKey: true }), "native");
	assert.equal(keyboard.keyDown({ ...enter, key: "a" }), "native");
});

test("bindings can replace defaults without changing input safety", () => {
	const keyboard = new ComposerKeyboard();
	assert.equal(keyboard.keyDown(enter, { submit: [] }), "native");
	assert.equal(DEFAULT_EDITOR_KEYBINDINGS.submit.length, 4);
});

test("composition and keyCode 229 remain entirely owned by the IME", () => {
	const keyboard = new ComposerKeyboard();
	assert.equal(keyboard.keyDown({ ...enter, isComposing: true }), "native");
	assert.equal(keyboard.keyDown({ ...enter, keyCode: 229 }), "native");
	keyboard.compositionStart();
	assert.equal(keyboard.keyDown(enter), "native");
	keyboard.compositionEnd(1000);
	assert.equal(keyboard.keyDown({ ...enter, timeStamp: 1001 }), "prevent");
	keyboard.keyUp();
	assert.equal(keyboard.keyDown({ ...enter, timeStamp: 1002 }), "submit");
});

test("Safari post-composition Enter cannot submit; missing keyup cannot disable sending permanently", () => {
	const keyboard = new ComposerKeyboard();
	keyboard.compositionEnd(1000);
	assert.equal(keyboard.keyDown({ ...enter, timeStamp: 1099 }), "prevent");
	assert.equal(keyboard.keyDown({ ...enter, timeStamp: 1100 }), "submit");
	keyboard.compositionStart();
	keyboard.reset();
	assert.equal(keyboard.keyDown(enter), "submit");
});

test("holding a send key never repeatedly submits or inserts accidental newlines", () => {
	const keyboard = new ComposerKeyboard();
	assert.equal(keyboard.keyDown(enter), "submit");
	assert.equal(keyboard.keyDown({ ...enter, repeat: true }), "prevent");
	assert.equal(keyboard.keyDown({ ...enter, shiftKey: true, repeat: true }), "native");
});

test("Work textarea starts at two rows, grows to eight, and shrinks after clearing or restoring a short draft", () => {
	assert.deepEqual(composerTextareaSize(24, 24, 0, 0), { height: 48, overflowY: "hidden" });
	assert.deepEqual(composerTextareaSize(120, 24, 0, 0), { height: 120, overflowY: "hidden" });
	assert.deepEqual(composerTextareaSize(192, 24, 0, 0), { height: 192, overflowY: "hidden" });
	assert.deepEqual(composerTextareaSize(360, 24, 0, 0), { height: 192, overflowY: "auto" });
	assert.deepEqual(composerTextareaSize(24, 24, 0, 0), { height: 48, overflowY: "hidden" });
	assert.deepEqual(composerTextareaSize(40, 20, 16, 2), { height: 58, overflowY: "hidden" });
	assert.deepEqual(composerTextareaSize(20, 20, 4, 0), { height: 44, overflowY: "hidden" });
	assert.deepEqual(composerTextareaSize(300, 20, 16, 2), { height: 178, overflowY: "auto" });
});
