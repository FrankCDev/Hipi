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
async function finish(target: HTMLElement, animationName = "markdown-word-reveal", pseudoElement = "") {
	await act(async () => {
		// React detects jsdom's prefixed CSS surface without a native AnimationEvent.
		for (const type of ["animationend", "webkitAnimationEnd"]) {
			const event = Object.assign(new Event(type, { bubbles: true }), { animationName, pseudoElement });
			target.dispatchEvent(event);
		}
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

test("list row and marker clocks settle independently and appended items retain earlier DOM", async () => {
	await render("- First item");
	const first = host.querySelector("li");
	assert.ok(first);
	assert.ok(first.classList.contains("markdown-structure-reveal"));
	assert.ok(first.classList.contains("markdown-marker-reveal"));
	await finish(first, "markdown-structure-reveal");
	assert.ok(!first.classList.contains("markdown-structure-reveal"));
	assert.ok(first.classList.contains("markdown-marker-reveal"), "150ms row end must not end the 700ms marker");
	await finish(word("First "));
	assert.ok(first.classList.contains("markdown-marker-reveal"), "bubbled word end is not the marker clock");
	await finish(first, "markdown-marker-reveal");
	assert.ok(first.classList.contains("markdown-marker-reveal"), "only the actual ::marker event settles the marker");
	await finish(first, "markdown-marker-reveal", "::marker");
	assert.ok(!first.classList.contains("markdown-marker-reveal"));
	await arrive("- First item\n- Second item");
	assert.equal(host.querySelector("li"), first);
	assert.equal(first.className, "");
	const second = host.querySelectorAll("li")[1];
	assert.ok(second?.classList.contains("markdown-structure-reveal"));
	assert.ok(second.classList.contains("markdown-marker-reveal"));
});

test("task marker has its own text-duration clock, not the ordinary list marker or row clock", async () => {
	await render("- [x] Done\n- [ ] Pending");
	const first = host.querySelector("li");
	const marker = first?.querySelector<HTMLElement>(".markdown-task-marker");
	assert.ok(first && marker);
	assert.ok(first.classList.contains("task-list-item"));
	assert.ok(!first.classList.contains("markdown-marker-reveal"));
	assert.ok(marker.classList.contains("markdown-task-reveal"));
	const checkbox = marker.querySelector<HTMLButtonElement>('[role="checkbox"]');
	assert.ok(checkbox);
	assert.equal(checkbox.getAttribute("aria-label"), "已勾选");
	assert.equal(checkbox.getAttribute("aria-checked"), "true");
	assert.equal(checkbox.disabled, true);
	assert.equal(checkbox.tabIndex, -1);
	await act(async () => {
		checkbox.click();
		checkbox.dispatchEvent(new KeyboardEvent("keydown", { key: " ", bubbles: true }));
	});
	assert.equal(checkbox.getAttribute("aria-checked"), "true");
	assert.equal(host.querySelectorAll('[role="checkbox"]')[1]?.getAttribute("aria-checked"), "false");
	await finish(first, "markdown-structure-reveal");
	assert.ok(marker.classList.contains("markdown-task-reveal"));
	await finish(marker, "markdown-task-reveal");
	assert.equal(marker.className, "markdown-task-marker");
	await arrive("- [x] Done\n- [ ] Pending\n- [x] Another");
	assert.equal(host.querySelector("li"), first);
	assert.equal(first.querySelector(".markdown-task-marker"), marker);
	assert.equal(marker.className, "markdown-task-marker");
	assert.ok(host.querySelectorAll(".markdown-task-marker")[2]?.classList.contains("markdown-task-reveal"));
});

test("quote, rule and table rows reveal once without remounting earlier rows during append", async () => {
	const source = "> Quote\n\n---\n\n| Header |\n| --- |\n| First |";
	await render(source);
	const original = [...host.querySelectorAll<HTMLElement>("blockquote, hr, tr")];
	assert.equal(original.length, 4);
	for (const element of original) {
		assert.ok(element.classList.contains("markdown-structure-reveal"));
		await finish(element, "markdown-structure-reveal");
	}
	await arrive(`${source}\n| Second |`);
	const current = [...host.querySelectorAll<HTMLElement>("blockquote, hr, tr")];
	assert.equal(current.length, 5);
	for (const [index, element] of original.entries()) {
		assert.equal(current[index], element);
		assert.ok(!element.classList.contains("markdown-structure-reveal"));
	}
	assert.ok(current[4]?.classList.contains("markdown-structure-reveal"));
	await render(`${source}\n| Second |`, { streaming: false });
	assert.equal(host.querySelectorAll(".markdown-structure-reveal").length, 0);
	assert.equal(host.querySelector("blockquote"), original[0]);
});

test("parser restructuring cannot replay a table made from an already visible paragraph", async () => {
	await render("| Heading |");
	await arrive("| Heading |\n| --- |\n| New row |");
	const header = host.querySelector("thead tr");
	const body = host.querySelector("tbody tr");
	assert.ok(header && body);
	assert.ok(!header.classList.contains("markdown-structure-reveal"));
	assert.ok(body.classList.contains("markdown-structure-reveal"));
	assert.equal(header.querySelectorAll(".markdown-word-reveal").length, 0);
});

test("nested list and quote growth retain code identity and selection through final flush", async () => {
	const source = "- Item\n\n  > Quote\n\n  ```unknown\n  code\n  ```";
	await render(source);
	const item = host.querySelector("li");
	const quote = host.querySelector("blockquote");
	const code = host.querySelector("pre code");
	assert.ok(item && quote && code);
	const range = document.createRange();
	range.selectNodeContents(quote);
	document.getSelection()?.addRange(range);
	await render(`${source}\n- Another`, { streaming: false });
	assert.equal(host.querySelectorAll("li").length, 1);
	assert.equal(host.querySelector("pre code"), code);
	await act(async () => {
		document.getSelection()?.removeAllRanges();
		document.dispatchEvent(new Event("selectionchange"));
	});
	assert.equal(host.querySelectorAll("li").length, 2);
	assert.equal(host.querySelector("li"), item);
	assert.equal(host.querySelector("blockquote"), quote);
	assert.equal(host.querySelector("pre code"), code);
	assert.equal(host.querySelectorAll(".markdown-structure-reveal, .markdown-marker-reveal").length, 0);
});

test("visibility and motion changes settle every structural decoration without replay", async () => {
	const source = "- Ordinary\n- [x] Task\n\n> Quote\n\n---";
	await render(source);
	assert.ok(
		host.querySelectorAll(".markdown-structure-reveal, .markdown-marker-reveal, .markdown-task-reveal").length > 0,
	);
	await act(async () => {
		Object.defineProperty(document, "hidden", { configurable: true, value: true });
		document.dispatchEvent(new Event("visibilitychange"));
	});
	assert.equal(
		host.querySelectorAll(".markdown-structure-reveal, .markdown-marker-reveal, .markdown-task-reveal").length,
		0,
	);
	await act(async () => {
		Object.defineProperty(document, "hidden", { configurable: true, value: false });
		document.dispatchEvent(new Event("visibilitychange"));
	});
	assert.equal(
		host.querySelectorAll(".markdown-structure-reveal, .markdown-marker-reveal, .markdown-task-reveal").length,
		0,
	);
	await arrive(`${source}\n\n> New quote`);
	assert.ok(host.querySelectorAll(".markdown-structure-reveal").length > 0);
	await act(async () => {
		reduced = true;
		for (const listener of [...motionListeners]) listener();
	});
	assert.equal(
		host.querySelectorAll(".markdown-structure-reveal, .markdown-marker-reveal, .markdown-task-reveal").length,
		0,
	);
});
