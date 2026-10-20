import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { test, vi } from "vitest";
import { Dialog, DialogBody, DialogContent, DialogTitle } from "../src/components/ui/dialog.tsx";

// Only bypass the portal's document requirement: test the real Content composition/classes.
vi.mock("radix-ui", async (original) => {
	const actual = await original<typeof import("radix-ui")>();
	return { ...actual, Dialog: { ...actual.Dialog, Portal: ({ children }: { children: ReactNode }) => children } };
});

function markup(placement?: "center" | "right", scrollBody = false) {
	return renderToStaticMarkup(
		<Dialog open>
			<DialogContent scrollBody={scrollBody} placement={placement} closeLabel="Close" aria-describedby={undefined}>
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

test("long centered dialogs opt into a bounded shell with heading and Close outside the scroll body", () => {
	const html = markup("center", true);
	const panel = html.match(/<div[^>]*data-slot="dialog-content"[^>]*>/)?.[0] ?? "";
	assert.match(panel, /data-placement="center"/);
	assert.match(panel, /data-scroll-body="true"/);
	assert.match(panel, /max-h-\[calc\(100dvh-2rem\)\]/);
	assert.match(panel, /flex-col overflow-hidden/);
	assert.doesNotMatch(panel, /(?:^| )grid(?: |$)/);
	assert.match(html, /<h2[^>]*data-slot="dialog-title"[^>]*>Details<\/h2><div data-slot="dialog-body"/);
	assert.match(html, /Long body<\/p><\/div><button[^>]*data-slot="dialog-close"/);
	assert.doesNotMatch(markup(), /data-scroll-body/);
});

test("all long management panels opt in without moving descriptions or forms outside the body", () => {
	for (const file of ["workbench/model-settings.tsx"]) {
		const source = readFileSync(new URL(`../src/features/${file}`, import.meta.url), "utf8");
		assert.match(source, /<DialogContent\s+scrollBody/);
		assert.match(source, /<\/DialogTitle>\s*<DialogBody>\s*<DialogDescription/);
		assert.match(source, /<\/DialogBody>\s*<\/DialogContent>/);
		assert.doesNotMatch(source.match(/<DialogContent[^>]*>/)?.[0] ?? "", /overflow-y-auto/);
	}
	// Connection-screen appearance uses the same bounded settings surface;
	// the share-string import remains a separate subordinate dialog.
	const appearance = readFileSync(new URL("../src/features/settings/appearance-settings.tsx", import.meta.url), "utf8");
	assert.match(appearance, /<SettingsSurface/);
	assert.match(appearance, /className="settings-page-content settings-standalone"/);
	assert.match(appearance, /className="settings-import-dialog"/);
	assert.match(appearance, /maxLength=\{24000\}/);
	const packs = readFileSync(new URL("../src/features/tool-packs/tool-packs-dialog.tsx", import.meta.url), "utf8");
	assert.match(packs, /<DialogContent\s+scrollBody/);
	assert.match(packs, /<\/DialogTitle>\s*<DialogBody>\{content\}<\/DialogBody>\s*<\/DialogContent>/);
	assert.ok(packs.indexOf("<ToolPacksPanel") < packs.indexOf("<Dialog open="));
	const panel = readFileSync(new URL("../src/features/tool-packs/tool-packs-panel.tsx", import.meta.url), "utf8");
	assert.match(panel, /return children\(\s*<div className="tool-packs-panel grid gap-4">/);
	assert.match(panel, /toolPacks\.description/);
	assert.doesNotMatch(panel, /<DialogContent|<DialogBody/);
	const css = readFileSync(new URL("../src/theme.css", import.meta.url), "utf8");
	assert.doesNotMatch(css.match(/\.settings-dialog\s*\{[^}]+\}/)?.[0] ?? "", /overflow/);
});
