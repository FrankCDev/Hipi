// @vitest-environment jsdom
import assert from "node:assert/strict";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, test, vi } from "vitest";
import { PreferencesProvider } from "../../../../src/app/preferences.tsx";
import { AssistantClipboardCopy } from "../../../../src/features/workbench/conversation/markdown/assistant-clipboard-copy.tsx";
import { assistantCopyPayload } from "../../../../src/features/workbench/conversation/markdown/assistant-copy-payload.ts";
import { ClipboardCopy } from "../../../../src/features/workbench/conversation/markdown/clipboard-copy.tsx";
import {
	ClipboardFeedback,
	COPY_TIMEOUT_MS,
} from "../../../../src/features/workbench/conversation/markdown/clipboard-feedback.ts";
import { writeClipboardPayload } from "../../../../src/features/workbench/conversation/markdown/clipboard-writer.ts";
import { MessageMarkdown } from "../../../../src/features/workbench/conversation/markdown/markdown.tsx";

afterEach(() => {
	vi.useRealTimers();
	vi.unstubAllGlobals();
});
test("mounted Markdown copies semantic content, exact escaped code and tasks without controls", async () => {
	vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
	vi.stubGlobal("matchMedia", () => ({ matches: false, addEventListener() {}, removeEventListener() {} }));
	const host = document.createElement("div");
	const root = createRoot(host);
	await act(async () =>
		root.render(
			<PreferencesProvider>
				<MessageMarkdown
					source={
						"# Title\n\n**Bold**\n\n- [x] Done\n- [ ] Next\n\n```text\n  <&>\t中\n\n```\n\n| A | B |\n| - | - |\n| 1 | 2 |"
					}
				/>
			</PreferencesProvider>,
		),
	);
	const payload = assistantCopyPayload(host.querySelector(".markdown-body"), "wrong source");
	assert.ok(payload.html?.includes("<h1>Title</h1>"));
	assert.ok(payload.plain.includes("- [x] Done\n- [ ] Next"));
	assert.ok(payload.plain.includes("  <&>\t中\n\n"));
	assert.ok(payload.plain.includes("A\tB\n1\t2"));
	assert.ok(!/button|svg|class=|style=|aria-|data-/.test(payload.html ?? ""));
	assert.ok(!payload.plain.includes("复制"));
	await act(async () => root.unmount());
});
test("sanitization excludes hidden/hostile content; missing and paged roots fall back explicitly", () => {
	const root = document.createElement("div");
	root.innerHTML =
		'<p onclick="evil()"><span class="markdown-word-reveal">safe</span><script>bad</script><svg><text>bad</text></svg><span hidden>hidden</span><span class="sr-only">diagnostic</span><a href="javascript:evil()">label</a></p><div data-markdown-copy="exclude">tools</div>';
	assert.deepEqual(assistantCopyPayload(root, "fallback"), { plain: "safelabel", html: "<p>safelabel</p>" });
	assert.deepEqual(assistantCopyPayload(null, "source\n"), { plain: "source\n" });
	root.innerHTML = '<div class="original-text">page</div>';
	assert.deepEqual(assistantCopyPayload(root, "full"), { plain: "full" });
});
function clipboard(write: () => Promise<void>, writeText = vi.fn(async (_text: string) => {})) {
	vi.stubGlobal(
		"ClipboardItem",
		class {
			values: Record<string, Blob>;
			constructor(values: Record<string, Blob>) {
				this.values = values;
			}
		},
	);
	vi.stubGlobal("navigator", { clipboard: { write, writeText } });
	return writeText;
}
test("rich success, rejection and unsupported fallback never claim success when both writes fail", async () => {
	const rich = vi.fn(async () => {});
	const text = clipboard(rich);
	await writeClipboardPayload({ plain: "semantic", html: "<b>semantic</b>" });
	assert.equal(rich.mock.calls.length, 1);
	assert.equal(text.mock.calls.length, 0);
	const fallback = clipboard(async () => {
		throw new Error("denied");
	});
	await writeClipboardPayload({ plain: "semantic", html: "<b>semantic</b>" });
	assert.deepEqual(fallback.mock.calls, [["semantic"]]);
	vi.stubGlobal("ClipboardItem", undefined);
	await writeClipboardPayload({ plain: "unsupported", html: "<p>unsupported</p>" });
	assert.equal(fallback.mock.calls.length, 2);
	clipboard(
		async () => {
			throw new Error("rich");
		},
		vi.fn(async () => {
			throw new Error("text");
		}),
	);
	await assert.rejects(writeClipboardPayload({ plain: "x", html: "<p>x</p>" }));
});
test("timeout/disposal prevent late rich rejection from starting fallback", async () => {
	vi.useFakeTimers();
	for (const timeout of [true, false]) {
		let reject: (error: Error) => void = () => {};
		const fallback = clipboard(
			() =>
				new Promise<void>((_resolve, fail) => {
					reject = fail;
				}),
		);
		const statuses: string[] = [];
		const owner = new ClipboardFeedback(
			(status) => statuses.push(status),
			(text, signal) => writeClipboardPayload({ plain: text, html: "<p>x</p>" }, signal),
		);
		owner.copy("x");
		if (timeout) vi.advanceTimersByTime(COPY_TIMEOUT_MS);
		else owner.dispose();
		reject(new Error("late"));
		await Promise.resolve();
		await Promise.resolve();
		assert.equal(fallback.mock.calls.length, 0);
		assert.ok(!statuses.includes("copied"));
		owner.dispose();
	}
});

test("mounted source replacement aborts late fallback; user and code action still copy exact text", async () => {
	vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
	vi.stubGlobal("matchMedia", () => ({ matches: false, addEventListener() {}, removeEventListener() {} }));
	let reject: (error: Error) => void = () => {};
	const fallback = clipboard(
		() =>
			new Promise<void>((_resolve, fail) => {
				reject = fail;
			}),
	);
	const host = document.createElement("div");
	const root = createRoot(host);
	const article = { current: document.createElement("article") };
	article.current.innerHTML =
		'<div class="message-content"><div class="markdown-body" data-markdown-tone="assistant"><p>Old</p></div><button>tool</button></div>';
	const render = async (text: string) =>
		act(async () =>
			root.render(
				<PreferencesProvider>
					<AssistantClipboardCopy article={article} text={text} label="Copy" />
				</PreferencesProvider>,
			),
		);
	await render("Old");
	await act(async () => host.querySelector<HTMLButtonElement>("button")?.click());
	await render("New");
	await act(async () => {
		reject(new Error("late"));
		await Promise.resolve();
	});
	assert.equal(fallback.mock.calls.length, 0);
	assert.equal(host.querySelector("button")?.getAttribute("aria-label"), "Copy");
	await act(async () =>
		root.render(
			<PreferencesProvider>
				<ClipboardCopy text={"  code\t<&>\n"} label="Copy exact" />
			</PreferencesProvider>,
		),
	);
	await act(async () => host.querySelector<HTMLButtonElement>("button")?.click());
	assert.deepEqual(fallback.mock.calls, [["  code\t<&>\n"]]);
	await act(async () => root.unmount());
});

test("a newer copy action fences an older rich rejection across mounted owners", async () => {
	let reject: (error: Error) => void = () => {};
	const text = clipboard(
		() =>
			new Promise<void>((_resolve, fail) => {
				reject = fail;
			}),
	);
	const earlier = writeClipboardPayload({ plain: "old", html: "<p>old</p>" });
	const later = new ClipboardFeedback(() => {});
	later.copy("new exact\n");
	reject(new Error("late"));
	await assert.rejects(earlier, /superseded/);
	assert.deepEqual(text.mock.calls, [["new exact\n"]]);
	later.dispose();
});

test("native copy supersedes fallback without touching its data; abort removes pending listener", async () => {
	for (const tag of ["code", "p"]) {
		let reject: (error: Error) => void = () => {};
		const text = clipboard(
			() =>
				new Promise<void>((_resolve, fail) => {
					reject = fail;
				}),
		);
		const pending = writeClipboardPayload({ plain: "old", html: "<p>old</p>" });
		const target = document.createElement(tag);
		document.body.append(target);
		const event = new Event("copy", { bubbles: true, cancelable: true });
		Object.defineProperty(event, "clipboardData", {
			get() {
				assert.fail("observer must not read clipboard data");
			},
		});
		target.dispatchEvent(event);
		assert.equal(event.defaultPrevented, false);
		target.remove();
		reject(new Error("late"));
		await assert.rejects(pending, /superseded/);
		assert.equal(text.mock.calls.length, 0);
	}
	const remove = vi.spyOn(document, "removeEventListener");
	clipboard(() => new Promise<void>(() => {}));
	const controller = new AbortController();
	void writeClipboardPayload({ plain: "pending", html: "<p>pending</p>" }, controller.signal);
	controller.abort();
	assert.ok(remove.mock.calls.some(([type, , capture]) => type === "copy" && capture === true));
	remove.mockRestore();
});

test("rich writer needs no document and removes its observer on success and rejection", async () => {
	const remove = vi.spyOn(document, "removeEventListener");
	clipboard(async () => {});
	await writeClipboardPayload({ plain: "ok", html: "<p>ok</p>" });
	clipboard(async () => {
		throw new Error("rejected");
	});
	await writeClipboardPayload({ plain: "fallback", html: "<p>fallback</p>" });
	assert.equal(remove.mock.calls.filter(([type]) => type === "copy").length, 2);
	remove.mockRestore();
	vi.stubGlobal("document", undefined);
	const text = clipboard(async () => {
		throw new Error("rejected");
	});
	await writeClipboardPayload({ plain: "without document", html: "<p>without document</p>" });
	assert.deepEqual(text.mock.calls, [["without document"]]);
});

test("hydrated completed body copies its semantic root, not preview, reader controls or tools", async () => {
	vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
	vi.stubGlobal("matchMedia", () => ({ matches: false, addEventListener() {}, removeEventListener() {} }));
	const text = clipboard(async () => {});
	vi.stubGlobal("ClipboardItem", undefined);
	const host = document.createElement("div");
	const root = createRoot(host);
	const article = { current: document.createElement("article") };
	article.current.innerHTML =
		'<div class="message-content"><div data-assistant-message-body><div class="markdown-body" data-markdown-tone="assistant"><h2>Complete</h2><p><strong>final body</strong></p></div><button>Read more</button><div class="original-text">diagnostic</div></div><div>tool output</div></div>';
	await act(async () =>
		root.render(
			<PreferencesProvider>
				<AssistantClipboardCopy article={article} text={"## Complete\n\n**final body**"} label="Copy" />
			</PreferencesProvider>,
		),
	);
	await act(async () => host.querySelector<HTMLButtonElement>("button")?.click());
	assert.deepEqual(text.mock.calls, [["Complete\n\nfinal body"]]);
	await act(async () => root.unmount());
});
