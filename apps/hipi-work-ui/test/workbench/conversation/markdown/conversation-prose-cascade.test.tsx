// @vitest-environment jsdom
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { URL as NodeURL } from "node:url";
import { renderToStaticMarkup } from "react-dom/server";
import { test } from "vitest";
import { PreferencesProvider } from "../../../../src/app/preferences.tsx";
import { MessageMarkdown } from "../../../../src/features/workbench/conversation/markdown/markdown.tsx";

test("conversation prose rhythm applies to streamed DOM without leaking into the IDE preview", () => {
	const style = document.createElement("style");
	style.textContent = readFileSync(
		new NodeURL("../../../../src/features/workbench/conversation/markdown/markdown.css", import.meta.url),
		"utf8",
	);
	document.head.append(style);
	const host = document.createElement("div");
	const markdown = (tone: "assistant" | "user") =>
		renderToStaticMarkup(
			<PreferencesProvider>
				<MessageMarkdown source={"# Heading\n\nFirst paragraph\n\nSecond paragraph\n\n- One\n- Two\n"} tone={tone} />
			</PreferencesProvider>,
		);
	host.innerHTML = `<article class="message" id="conversation">${markdown("assistant")}</article><section class="file-markdown-preview" id="preview">${markdown("assistant")}</section><article class="message" id="user">${markdown("user")}</article>`;
	document.body.append(host);
	const computed = (selector: string) => {
		const element = host.querySelector(selector);
		assert.ok(element);
		return getComputedStyle(element);
	};
	try {
		assert.notEqual(computed("#conversation h1").fontSize, computed("#preview h1").fontSize);
		assert.equal(computed("#preview h1").fontSize, "1.75em");
		assert.equal(Number.parseFloat(computed("#conversation li + li").marginBlockStart), 0);
		assert.equal(computed("#preview li + li").marginBlockStart, "0.35em");
		assert.equal(Number.parseFloat(computed("#user p + p").marginBlock), 0);
		assert.notEqual(computed("#conversation p + p").marginBlock, "0");
		assert.equal(Number.parseFloat(computed("#conversation h1").marginBlockStart), 0);
		assert.equal(Number.parseFloat(computed("#conversation .markdown-body > :last-child").marginBlockEnd), 0);
	} finally {
		host.remove();
		style.remove();
	}
});
