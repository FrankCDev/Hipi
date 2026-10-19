import assert from "node:assert/strict";
import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { test, vi } from "vitest";
import { Dialog, DialogBody, DialogContent, DialogTitle } from "../src/components/ui/dialog.tsx";

// Only bypass the portal's document requirement: test the real Content composition/classes.
vi.mock("radix-ui", async (original) => {
	const actual = await original<typeof import("radix-ui")>();
	return { ...actual, Dialog: { ...actual.Dialog, Portal: ({ children }: { children: ReactNode }) => children } };
});

function markup(placement?: "center" | "right") {
	return renderToStaticMarkup(
		<Dialog open>
			<DialogContent placement={placement} closeLabel="Close" aria-describedby={undefined}>
				<DialogTitle>Details</DialogTitle>
				<DialogBody>
					<p>Long body</p>
				</DialogBody>
			</DialogContent>
		</Dialog>,
	);
}

test("right dialog excludes center translation and bounds the panel; only the body scrolls", () => {
	const html = markup("right");
	const panel = html.match(/<div[^>]*data-slot="dialog-content"[^>]*>/)?.[0] ?? "";
	assert.match(panel, /data-placement="right"/);
	assert.match(panel, /inset-y-3 right-3/);
	assert.match(panel, /flex-col overflow-hidden/);
	assert.doesNotMatch(panel, /translate-|top-\[50%\]|left-\[50%\]/);
	assert.match(html, /data-slot="dialog-body" class="[^"]*min-h-0[^"]*overflow-y-auto/);
	assert.ok(html.indexOf('data-slot="dialog-title"') < html.indexOf('data-slot="dialog-body"'));
	assert.match(html, /Long body<\/p><\/div><button[^>]*data-slot="dialog-close"/);
	assert.equal((html.match(/>Close<\/span>/g) ?? []).length, 1);
});

test("default dialog retains its centered placement", () => {
	const html = markup();
	assert.match(html, /data-placement="center"/);
	assert.match(html, /top-\[50%\] left-\[50%\]/);
	assert.match(html, /translate-x-\[-50%\] translate-y-\[-50%\]/);
});
