import assert from "node:assert/strict";
import { test } from "node:test";
import {
	CONVERSATION_END_THRESHOLD,
	CONVERSATION_HISTORY_THRESHOLD,
	CONVERSATION_JUMP_DURATION,
	ConversationScrollIntent,
	DISCLOSURE_ANCHOR_DURATION,
	isScrollbarPointer,
	nativeScrollDirection,
} from "../../../src/features/workbench/conversation/scroll-intent.ts";

function fixture() {
	let time = 0;
	let offset = 100;
	let end = 1000;
	let reduced = false;
	let id = 0;
	let cancelled = 0;
	let finished = 0;
	const frames = new Map<number, (time: number) => void>();
	const follows: boolean[] = [];
	const near: boolean[] = [];
	const controller = new ConversationScrollIntent({
		offset: () => offset,
		end: () => end,
		move: (next) => {
			offset = next;
		},
		finish: () => {
			offset = end;
			finished++;
		},
		cancel: () => {
			cancelled++;
		},
		follow: (value) => follows.push(value),
		nearEnd: (value) => near.push(value),
		reducedMotion: () => reduced,
		frame: (callback) => {
			frames.set(++id, callback);
			return id;
		},
		cancelFrame: (frame) => {
			frames.delete(frame);
		},
		now: () => time,
	});
	return {
		controller,
		follows,
		near,
		get offset() {
			return offset;
		},
		get finished() {
			return finished;
		},
		get cancelled() {
			return cancelled;
		},
		get pending() {
			return frames.size;
		},
		offsetTo(value: number) {
			offset = value;
			controller.scrolled();
		},
		endTo(value: number) {
			end = value;
		},
		reduced() {
			reduced = true;
		},
		frame(at: number) {
			time = at;
			const batch = [...frames.values()];
			frames.clear();
			for (const callback of batch) callback(time);
		},
	};
}

test("ordinary Work thresholds are 24px at the end and 64px for older history", () => {
	assert.equal(CONVERSATION_END_THRESHOLD, 24);
	assert.equal(CONVERSATION_HISTORY_THRESHOLD, 64);
});

test("upward intent stops following even inside the near-end threshold", () => {
	const model = fixture();
	model.offsetTo(990);
	model.controller.userIntent(-1);
	model.offsetTo(982);
	assert.equal(model.controller.follows, false);
	model.endTo(1004);
	model.controller.scrolled();
	assert.equal(model.controller.follows, false);
	model.controller.userIntent(1);
	model.offsetTo(1000);
	assert.equal(model.controller.follows, true);
});

test("jump uses 260ms cubic-out, follows a growing destination, and finishes exactly", () => {
	const model = fixture();
	model.controller.jump();
	assert.equal(model.controller.follows, false);
	model.frame(CONVERSATION_JUMP_DURATION / 2);
	assert.equal(model.offset, 887.5);
	model.endTo(1200);
	model.frame(CONVERSATION_JUMP_DURATION);
	assert.equal(model.offset, 1200);
	assert.equal(model.controller.follows, true);
	assert.equal(model.finished, 1);
	assert.equal(model.pending, 0);
});

test("wheel, touch, keyboard or scrollbar intent cancels the outstanding jump", () => {
	for (const direction of [-1, 0, 1]) {
		const model = fixture();
		model.controller.jump();
		model.frame(50);
		const held = model.offset;
		model.controller.userIntent(direction);
		assert.equal(model.pending, 0);
		model.frame(260);
		assert.equal(model.offset, held);
		assert.equal(model.finished, 0);
		assert.equal(model.controller.follows, false);
		assert.ok(model.cancelled >= 2);
	}
});

test("reduced motion and already near-end jumps are instant; disposal cancels work", () => {
	for (const mode of ["reduced", "near"] as const) {
		const model = fixture();
		if (mode === "reduced") model.reduced();
		else model.offsetTo(980);
		model.controller.jump();
		assert.equal(model.pending, 0);
		assert.equal(model.finished, 1);
		assert.equal(model.offset, 1000);
	}
	const model = fixture();
	model.controller.jump();
	model.controller.dispose();
	model.frame(260);
	assert.equal(model.finished, 0);
	model.controller.jump();
	assert.equal(model.pending, 0);
});

test("numerical proximity never re-enables stale downward intent", () => {
	const model = fixture();
	model.controller.userIntent(1);
	model.frame(1001);
	model.offsetTo(990);
	assert.equal(model.controller.follows, false);
});

test("neutral selection intent replaces recent downward intent and keeps following disabled", () => {
	const model = fixture();
	model.controller.userIntent(1);
	model.offsetTo(990);
	assert.equal(model.controller.follows, true);
	model.controller.userIntent(0);
	model.offsetTo(995);
	assert.equal(model.controller.follows, false);
	model.endTo(1005);
	model.controller.scrolled();
	assert.equal(model.controller.follows, false);
	model.controller.dispose();
	assert.equal(model.pending, 0);
});

test("native keyboard detection ignores controls, prevented defaults and modified shortcuts", () => {
	const key = {
		key: "PageUp",
		shiftKey: false,
		altKey: false,
		ctrlKey: false,
		metaKey: false,
		defaultPrevented: false,
	};
	assert.equal(nativeScrollDirection(key, false), -1);
	assert.equal(nativeScrollDirection({ ...key, key: "End" }, false), 1);
	assert.equal(nativeScrollDirection({ ...key, key: " ", shiftKey: true }, false), -1);
	assert.equal(nativeScrollDirection({ ...key, key: "a" }, false), null);
	assert.equal(nativeScrollDirection(key, true), null);
	for (const name of ["altKey", "ctrlKey", "metaKey", "defaultPrevented"] as const)
		assert.equal(nativeScrollDirection({ ...key, [name]: true }, false), null);
});

test("scrollbar detection handles both-edge gutters without treating content clicks as intent", () => {
	const rect = { left: 100, right: 500 };
	assert.equal(isScrollbarPointer(105, rect, 16, 368), true);
	assert.equal(isScrollbarPointer(490, rect, 16, 368), true);
	assert.equal(isScrollbarPointer(120, rect, 16, 368), false);
	assert.equal(isScrollbarPointer(99, rect, 16, 368), false);
});

test("disclosure keeps fractional header position for 350ms, including reduced motion", () => {
	for (const reduced of [false, true]) {
		const model = fixture();
		if (reduced) model.reduced();
		let top = 400.125;
		let cleaned = 0;
		model.controller.holdHeader(
			() => top - model.offset,
			() => cleaned++,
		);
		assert.equal(model.controller.holdingHeader, true);
		assert.equal(model.controller.jumping, false);
		top += 20.25;
		model.frame(16);
		assert.equal(model.offset, 120.25);
		top -= 5.125;
		model.frame(220);
		assert.equal(model.offset, 115.125);
		model.frame(DISCLOSURE_ANCHOR_DURATION);
		assert.equal(model.controller.holdingHeader, false);
		assert.equal(model.pending, 0);
		assert.equal(cleaned, 1);
		assert.equal(model.controller.follows, false);
	}
});
test("disclosure restores only previous following that still lies at the bottom", () => {
	for (const previous of [false, true])
		for (const near of [false, true]) {
			const model = fixture();
			model.offsetTo(990);
			model.controller.setFollow(previous);
			model.controller.holdHeader(
				() => 10,
				() => {},
			);
			if (!near) model.endTo(1500);
			model.frame(DISCLOSURE_ANCHOR_DURATION);
			assert.equal(model.controller.follows, previous && near);
		}
});
test("disclosure cancels on user intent, removed anchor, jump, replacement and disposal", () => {
	for (const reason of ["intent", "removed", "jump", "replacement", "dispose"] as const) {
		const model = fixture();
		let valid = true;
		let cleaned = 0;
		model.controller.holdHeader(
			() => (valid ? 50 : undefined),
			() => cleaned++,
		);
		if (reason === "intent") model.controller.userIntent(-1);
		if (reason === "removed") {
			valid = false;
			model.frame(16);
		}
		if (reason === "jump") model.controller.jump();
		if (reason === "replacement")
			model.controller.holdHeader(
				() => 20,
				() => {},
			);
		if (reason === "dispose") model.controller.dispose();
		assert.equal(cleaned, 1);
		model.controller.dispose();
		assert.equal(model.pending, 0);
	}
});
