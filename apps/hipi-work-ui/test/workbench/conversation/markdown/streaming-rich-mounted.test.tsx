// @vitest-environment jsdom
import assert from "node:assert/strict";
import { LIMITS } from "@hipi/work-runtime/contracts";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { test, vi } from "vitest";
import { PreferencesProvider } from "../../../../src/app/preferences.tsx";
import { MessageMarkdown } from "../../../../src/features/workbench/conversation/markdown/markdown.tsx";

test("ordinary long paragraphs and open fences retain settled Markdown through streaming and completion", async () => {
	vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
	vi.stubGlobal("matchMedia", () => ({ matches: true, addEventListener() {}, removeEventListener() {} }));
	try {
		for (const fence of [false, true]) {
			const host = document.createElement("div");
			const root = createRoot(host);
			const prefix = "## 这是什么项目\n\n**项目说明**\n\n";
			const tail = fence
				? `\`\`\`typescript\n${"const value = '<&>';\n".repeat(500)}`
				: `**普通说明** ${"这是正常项目说明，不应显示原始 Markdown。".repeat(500)}`;
			const source = `${prefix}${tail}`.slice(0, LIMITS.partialPreview);
			const render = async (value: string, streaming = true) =>
				act(async () =>
					root.render(
						<PreferencesProvider>
							<MessageMarkdown source={value} streaming={streaming} streamId="same-output" />
						</PreferencesProvider>,
					),
				);
			await render(source.slice(0, 400));
			const heading = host.querySelector("h2");
			assert.ok(heading);
			for (const size of [2049, 3364, source.length]) {
				await render(source.slice(0, size));
				assert.equal(host.querySelector("h2"), heading);
				assert.equal(host.querySelector(".original-text"), null);
				assert.ok(host.querySelector("strong"));
				if (fence) {
					assert.ok(host.querySelector("code"));
					assert.equal(host.querySelector('[aria-label="复制代码"]'), null);
				}
			}
			await render(fence ? `${source}\n\`\`\`` : source, false);
			assert.equal(host.querySelector("h2"), heading);
			assert.equal(host.querySelector(".original-text"), null);
			if (fence) assert.ok(host.querySelector('[aria-label="复制代码"]'));
			await act(async () => root.unmount());
		}
	} finally {
		vi.unstubAllGlobals();
	}
});
