// @vitest-environment jsdom
import assert from "node:assert/strict";
import { act, type ComponentProps, StrictMode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, test, vi } from "vitest";
import { PreferencesProvider } from "../../../../src/app/preferences.tsx";
import { defaultConfig } from "../../../../src/app/theme/config.ts";
import { themeStorageKey } from "../../../../src/app/theme/store.ts";
import { MessageMarkdown } from "../../../../src/features/workbench/conversation/markdown/markdown.tsx";
import { revealWords } from "../../../../src/features/workbench/conversation/markdown/text-reveal.tsx";

let root: Root;
let host: HTMLDivElement;
let reduced = false;
const motionListeners = new Set<() => void>();
beforeEach(() => {
	vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
	vi.useFakeTimers();
	vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => setTimeout(() => callback(0), 0));
	vi.stubGlobal("cancelAnimationFrame", clearTimeout);
	reduced = false;
	motionListeners.clear();
	vi.stubGlobal("matchMedia", (query: string) => ({
		get matches() {
			return query.includes("prefers-reduced-motion") && reduced;
		},
		addEventListener: (_type: string, listener: () => void) => {
			if (query.includes("prefers-reduced-motion")) motionListeners.add(listener);
		},
		removeEventListener: (_type: string, listener: () => void) => {
			motionListeners.delete(listener);
		},
	}));
	Object.defineProperty(document, "hidden", { configurable: true, value: false });
	localStorage.setItem(themeStorageKey, JSON.stringify({ ...defaultConfig(), reducedMotion: "system" }));
	host = document.createElement("div");
	document.body.append(host);
	root = createRoot(host);
});
afterEach(async () => {
	await act(async () => root.unmount());
	assert.equal(motionListeners.size, 0, "all motion subscriptions leave with their renderer owner");
	host.remove();
	document.getSelection()?.removeAllRanges();
	localStorage.clear();
	delete document.documentElement.dataset.reducedMotion;
	vi.useRealTimers();
	vi.unstubAllGlobals();
	vi.restoreAllMocks();
});
async function render(source: string, options: Partial<ComponentProps<typeof MessageMarkdown>> = {}) {
	await act(async () =>
		root.render(
			<StrictMode>
				<PreferencesProvider>
					<MessageMarkdown source={source} streaming streamId="first" {...options} />
				</PreferencesProvider>
			</StrictMode>,
		),
	);
}
async function arrive(source: string) {
	await render(source);
	await act(async () => vi.advanceTimersByTimeAsync(400));
}
function word(text: string) {
	const result = [...host.querySelectorAll("span")].find((span) => span.textContent === text);
	assert.ok(result, `Missing word ${JSON.stringify(text)}`);
	return result;
}
async function finish(target: HTMLElement) {
	await act(async () => {
		target.dispatchEvent(new Event("animationend", { bubbles: true }));
		// React detects jsdom's prefixed CSS surface without a native AnimationEvent.
		target.dispatchEvent(new Event("webkitAnimationEnd", { bubbles: true }));
	});
}

test("new words reveal without restarting or clearing existing word animations across chunks", async () => {
	await render("First wor");
	const first = word("First ");
	const growing = word("wor");
	assert.equal(first.className, "markdown-word-reveal");
	await arrive("First word second");
	assert.equal(word("First "), first);
	assert.equal(word("word "), growing);
	assert.equal(first.className, "markdown-word-reveal");
	assert.equal(growing.className, "markdown-word-reveal");
	assert.equal(word("second").className, "markdown-word-reveal");
	await finish(first);
	await finish(growing);
	await arrive("First word second third");
	assert.equal(word("First "), first);
	assert.equal(first.className, "");
	assert.equal(word("word ").className, "");
	assert.equal(word("third").className, "markdown-word-reveal");
});

test("completion flushes canonical source immediately and does not remount revealed spans", async () => {
	await render("First **bold");
	const first = word("First ");
	const bold = word("bold");
	await render("First **bold** final", { streaming: false });
	assert.equal(host.querySelector("p")?.textContent, "First bold final");
	assert.equal(word("First "), first);
	assert.equal(word("bold"), bold);
	assert.equal(host.querySelector(".markdown-word-reveal"), null);
	await act(async () => vi.advanceTimersByTimeAsync(2000));
	assert.equal(host.querySelector(".markdown-word-reveal"), null);
});

test("setext restructuring preserves old visible text without replay, while new leaves reveal", async () => {
	await render("Old heading");
	await arrive("Old heading\n---\n\nNew paragraph");
	assert.equal(host.querySelector("h2")?.textContent, "Old heading");
	assert.equal(host.querySelector("h2 .markdown-word-reveal"), null);
	assert.equal(word("New ").className, "markdown-word-reveal");
	assert.equal(word("paragraph").className, "markdown-word-reveal");
});

test("entity and escape decoded offsets never become raw-source reveal offsets", async () => {
	await render("A &amp; B \\*literal\\* next");
	const before = [...host.querySelectorAll("span")];
	for (const span of before) await finish(span);
	await arrive("A &amp; B \\*literal\\* next added");
	assert.equal(host.querySelector("p")?.textContent, "A & B *literal* next added");
	for (const span of before) {
		assert.ok(span.isConnected);
		assert.equal(span.className, "");
	}
	assert.equal(word("added").className, "markdown-word-reveal");
	await render("A &amp; B \\*literal\\* next added", { streaming: false });
	assert.equal(host.querySelector(".markdown-word-reveal"), null);
});

test("CJK, emoji, punctuation and whitespace are lossless across partial-word growth", async () => {
	for (const text of ["中文连续输出，下一句。", "  hello\tworld\n", "你好 👨‍👩‍👧‍👦！ café", "can't stop", " \t "]) {
		assert.equal(
			revealWords(text)
				.map((part) => part.text)
				.join(""),
			text,
		);
	}
	await render("中文 ");
	const old = word("中文");
	await finish(old);
	await arrive("中文 连续输出，下一句。 😀");
	assert.equal(host.querySelector("p")?.textContent, "中文 连续输出，下一句。 😀");
	assert.ok(old.isConnected);
	assert.equal(old.className, "");
});

test("open fenced code keeps its DOM identity as tokens arrive and the fence closes", async () => {
	await render("Intro.\n\n```unknown\nlet a");
	const code = host.querySelector("pre code");
	const card = host.querySelector(".markdown-code-block");
	assert.ok(code && card);
	await arrive("Intro.\n\n```unknown\nlet a = 1;\n");
	assert.equal(host.querySelector("pre code"), code);
	await arrive("Intro.\n\n```unknown\nlet a = 1;\n```\n\nAfter");
	assert.equal(host.querySelector("pre code"), code);
	assert.equal(host.querySelector(".markdown-code-block"), card);
	assert.equal(card.querySelector(".markdown-word-reveal"), null);
	await render("Intro.\n\n```unknown\nlet a = 1;\n```\n\nAfter", { streaming: false });
	assert.equal(host.querySelector("pre code"), code);
});

test("selection freezes displayed words through terminal flush and owner switch", async () => {
	await render("Selected text");
	const selected = word("Selected ");
	const range = document.createRange();
	range.selectNodeContents(selected);
	document.getSelection()?.addRange(range);
	await render("New owner final", { streamId: "second", streaming: false });
	await act(async () => vi.advanceTimersByTimeAsync(2000));
	assert.equal(host.querySelector("p")?.textContent, "Selected text");
	assert.equal(word("Selected "), selected);
	await act(async () => {
		document.getSelection()?.removeAllRanges();
		document.dispatchEvent(new Event("selectionchange"));
	});
	assert.equal(host.querySelector("p")?.textContent, "New owner final");
	assert.equal(host.querySelector(".markdown-word-reveal"), null);
});

test("a different stream owns a fresh timeline and unmount cancels pending buffer work", async () => {
	await render("Same words");
	const old = word("Same ");
	await finish(old);
	await render("Same words", { streamId: "second" });
	assert.notEqual(word("Same "), old);
	assert.equal(word("Same ").className, "markdown-word-reveal");
	await render("Queued source", { streamId: "second" });
	await act(async () => root.render(null));
	await act(async () => vi.advanceTimersByTimeAsync(2000));
	assert.equal(host.textContent, "");
});

test("page visibility settles decoration without replaying old words on return", async () => {
	await render("Visible words");
	const old = word("Visible ");
	assert.equal(old.className, "markdown-word-reveal");
	await act(async () => {
		Object.defineProperty(document, "hidden", { configurable: true, value: true });
		document.dispatchEvent(new Event("visibilitychange"));
	});
	assert.equal(old.className, "");
	await arrive("Visible words hidden");
	await act(async () => {
		Object.defineProperty(document, "hidden", { configurable: true, value: false });
		document.dispatchEvent(new Event("visibilitychange"));
	});
	assert.equal(host.querySelector(".markdown-word-reveal"), null);
	await arrive("Visible words hidden fresh");
	assert.equal(word("fresh").className, "markdown-word-reveal");
});

test("live reduced-motion change settles words and static/user renderers never decorate", async () => {
	await render("Motion words");
	await act(async () => {
		reduced = true;
		for (const listener of [...motionListeners]) listener();
	});
	assert.equal(host.querySelector(".markdown-word-reveal"), null);
	await arrive("Motion words new");
	assert.equal(host.querySelector(".markdown-word-reveal"), null);
	await render("Static **bold**", { streamId: "static", streaming: false });
	assert.equal(host.querySelector("strong")?.innerHTML, "bold");
	await render("User **bold**", { streamId: "user", tone: "user" });
	assert.equal(host.querySelector("strong")?.innerHTML, "bold");
});

test("explicit motion preferences override the system without changing text or inline code", async () => {
	reduced = true;
	localStorage.setItem(themeStorageKey, JSON.stringify({ ...defaultConfig(), reducedMotion: "off" }));
	await render("Explicit off `inline code`");
	assert.equal(word("Explicit ").className, "markdown-word-reveal");
	assert.equal(host.querySelector("code")?.innerHTML, "inline code");
	await act(async () => root.render(null));
	reduced = false;
	localStorage.setItem(themeStorageKey, JSON.stringify({ ...defaultConfig(), reducedMotion: "on" }));
	await render("Explicit on `inline code`");
	assert.equal(host.querySelectorAll(".markdown-word-reveal").length, 0);
	assert.equal(host.querySelector("code")?.innerHTML, "inline code");
});
