import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";
import { assertCanonicalReads, assertHistoryYield } from "./message-browser-assertions.mjs";

// Component acceptance, not the real runtime E2E in verify-browser.mjs.
// No dependency install, browser download, production build or sandbox override.
const require = createRequire(import.meta.url);
const appRoot = fileURLToPath(new URL("../", import.meta.url));
const fixtureRoot = join(appRoot, "test/browser");
const output = process.env.HIPI_EVIDENCE_DIR || join(tmpdir(), "hipi-message-browser-evidence");
const transformOnly = process.argv.includes("--transform-only");
const tolerance = 3; // CSS pixels; recorded geometry is retained even on failure.
const checks = [];
const measurements = [];
const errors = [];
let vite;
let browser;
let page;
let failure;
let stage = "setup";
await mkdir(output, { recursive: true });

try {
	if (!transformOnly) {
		stage = "browser-launch";
		const { chromium } = require(process.env.HIPI_PLAYWRIGHT_PATH || "playwright");
		browser = await chromium.launch({
			executablePath: process.env.HIPI_CHROMIUM_PATH || "/usr/bin/chromium",
			headless: true,
			chromiumSandbox: true,
		});
	}
	stage = "setup";
	vite = await createServer({
		root: fixtureRoot,
		configFile: join(appRoot, "vite.config.ts"),
		...(transformOnly ? { optimizeDeps: { noDiscovery: true, include: [] } } : {}),
		server: { host: "127.0.0.1", port: 0, strictPort: false },
	});
	await vite.listen();
	const address = vite.httpServer.address();
	assert(address && typeof address === "object");
	const origin = `http://127.0.0.1:${address.port}`;
	if (transformOnly) {
		stage = "transform";
		// Dev transforms only. This does not execute React, measure layout or count as a browser pass.
		for (const path of [
			"/fixture.tsx",
			"/fixture.css",
			"/@fs" + join(appRoot, "src/theme.css"),
			...[
				"conversation/history.tsx",
				"conversation/messages.tsx",
				"conversation/message-text-reader.tsx",
				"conversation/markdown/markdown.tsx",
			].map((name) => "/@fs" + join(appRoot, "src/features/workbench", name)),
		]) {
			const result = await vite.transformRequest(path);
			assert(result?.code.length, `Empty Vite dev transform: ${path}`);
			checks.push(`Dev transform: ${path}`);
		}
	} else {
		page = await browser.newPage({ viewport: { width: 1200, height: 800 }, deviceScaleFactor: 1 });
		page.setDefaultTimeout(10000);
		page.on("pageerror", (error) => errors.push(error.message));
		page.on("console", (message) => {
			if (message.type() === "error") errors.push(message.text());
		});
		await page.addInitScript(() => {
			window.addEventListener("unhandledrejection", (event) => {
				console.error(`Unhandled rejection: ${String(event.reason)}`);
			});
		});
		// The fixture must never cause external requests or contact a runtime/model.
		await page.route("**/*", async (route) => {
			if (new URL(route.request().url()).origin !== origin) {
				errors.push(`Unexpected external request: ${route.request().url()}`);
				await route.abort();
			} else await route.continue();
		});
		const rows = page.locator("[data-message-key]");
		const scroller = page.locator(".message-scroll");
		const row = (key) => page.locator(`[data-message-key="${key}"]`);
		const stats = () => page.evaluate(() => window.messageFixture.stats());
		const release = () => page.evaluate(() => window.messageFixture.release());
		// One 80 ms projection cadence plus ResizeObserver/virtualizer settling. Assertions
		// still poll for observable state; this is not a claim about frame-time performance.
		const settle = async () => {
			await page.waitForTimeout(240);
			await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
		};
		const open = async (query = "") => {
			await page.goto(origin + query);
			await page.waitForFunction(() => !!window.messageFixture);
			await row("message:m-383").waitFor();
			await settle();
		};
		const bottomGap = () => scroller.evaluate((node) => node.scrollHeight - node.scrollTop - node.clientHeight);
		const scrollTo = async (value) => {
			await scroller.evaluate((node, position) => {
				node.scrollTop = position === "end" ? node.scrollHeight : position;
			}, value);
			await settle();
		};
		const anchor = () =>
			scroller.evaluate((node) => {
				const box = node.getBoundingClientRect();
				const candidates = [...node.querySelectorAll("[data-message-key]")];
				const element =
					candidates.find((item) => {
						const rect = item.getBoundingClientRect();
						return rect.top >= box.top && rect.top < box.bottom - 40;
					}) ??
					candidates.find((item) => {
						const rect = item.getBoundingClientRect();
						return rect.bottom > box.top && rect.top < box.bottom;
					});
				if (!element) throw new Error("No visible anchor");
				return { key: element.getAttribute("data-message-key"), top: element.getBoundingClientRect().top - box.top };
			});
		const assertAnchor = async (before, label) => {
			await settle();
			const after = await row(before.key).evaluate((node) => {
				const region = node.closest(".message-scroll");
				if (!region) throw new Error("Missing scroll region");
				return node.getBoundingClientRect().top - region.getBoundingClientRect().top;
			});
			const delta = after - before.top;
			measurements.push({ label, key: before.key, before: before.top, after, delta, tolerance });
			assert(Math.abs(delta) <= tolerance, `${label}: ${before.key} moved ${delta} CSS px`);
		};
		const assertBounded = async (max = 48) => {
			const keys = await rows.evaluateAll((nodes) => nodes.map((node) => node.getAttribute("data-message-key")));
			assert.equal(new Set(keys).size, keys.length, "Duplicate mounted message ID");
			assert(keys.length > 0 && keys.length <= max, `Mounted ${keys.length} rows; test ceiling ${max}`);
			measurements.push({ label: "mounted rows", count: keys.length, ceiling: max });
		};

		stage = "top-prepend";
		await open();
		assert((await bottomGap()) <= tolerance, "Initial view must follow bottom");
		assert.equal((await stats()).calls.length, 0, "No history drain while reading latest");
		// Four overlapping pages make 156 retained rows, substantially more than the viewport.
		for (let pageNumber = 0; pageNumber < 4; pageNumber++) {
			await scrollTo(100);
			await page.waitForFunction((count) => window.messageFixture.stats().calls.length === count, pageNumber + 1);
			const before = await anchor();
			await scroller.evaluate((node) => {
				for (let i = 0; i < 20; i++) node.dispatchEvent(new Event("scroll"));
			});
			await settle();
			assert.equal(
				(await stats()).calls.length,
				pageNumber + 1,
				"Repeated near-top events duplicated a pending request",
			);
			await release();
			await assertAnchor(before, `prepend page ${pageNumber + 1}`);
			assert.equal(
				(await stats()).calls.length,
				pageNumber + 1,
				"Prepend drained additional pages without another top visit",
			);
			const retainedStart = 352 - 31 * (pageNumber + 1);
			// The repeated boundary remains at exactly index 31, not 32.
			const boundaryKey = `message:m-${retainedStart + 31}`;
			assert.equal(await row(boundaryKey).getAttribute("data-index"), "31");
			await assertBounded();
		}
		assert.equal((await stats()).maxActive, 1);
		await scrollTo("end");
		assert.equal(await row("message:m-383").getAttribute("data-index"), "155", "History overlap was not deduplicated");
		checks.push(
			"Four top-auto overlapping pages preserve the visible stable-key anchor, deduplicate and bound requests/DOM",
		);

		stage = "stream-follow";
		for (const step of [1, 3, 5, 12]) {
			await page.evaluate((value) => window.messageFixture.stream(value), step);
			await row("partial-output").waitFor();
			await settle();
			assert((await bottomGap()) <= tolerance, `Streaming step ${step} lost bottom intent`);
			if (step === 3) assert((await row("partial-output").locator(".markdown-body pre code").count()) > 0);
		}
		const streamIndex = await row("partial-output").getAttribute("data-index");
		await page.evaluate(() => window.messageFixture.stream(12, true));
		await row("message:stream-final").waitFor();
		await settle();
		assert.equal(await row("message:stream-final").getAttribute("data-index"), streamIndex);
		assert.equal(await row("partial-output").count(), 0);
		assert((await bottomGap()) <= tolerance, "Same-count final replacement lost bottom intent");
		checks.push(
			"Growing incomplete Markdown/code, rich-text fallback and partial→final same-row-count replacement follow bottom",
		);

		stage = "stream-reading";
		await open();
		await scrollTo(1800);
		const reading = await anchor();
		for (const step of [1, 4, 9]) {
			await page.evaluate((value) => window.messageFixture.stream(value), step);
			await assertAnchor(reading, `non-bottom stream ${step}`);
			assert((await bottomGap()) > 500, "Streaming dragged the reader to bottom");
		}
		await page.evaluate(() => window.messageFixture.stream(9, true));
		await assertAnchor(reading, "non-bottom final replacement");
		await assertBounded();
		checks.push("Streaming and final commit preserve the reader's visible anchor away from bottom");

		stage = "dynamic-height";
		await open("?original=1");
		await row("message:m-381").evaluate((node) => {
			const region = node.closest(".message-scroll");
			region.scrollTop += node.getBoundingClientRect().top - region.getBoundingClientRect().top + 1;
		});
		await settle();
		const originalAnchor = await anchor();
		const truncated = row("message:m-380");
		const expectedOriginal = Array.from(
			{ length: 480 },
			(_, i) => `Original line ${i}: ${"abcdef0123456789 ".repeat(5)}`,
		).join("\n");
		for (let chunk = 0; chunk < Math.ceil(expectedOriginal.length / 32768); chunk++) {
			await page.waitForFunction(
				(count) =>
					window.messageFixture.stats().calls.filter((call) => call.method === "getMessageText").length === count,
				chunk + 1,
			);
			const read = (await stats()).calls.filter((call) => call.method === "getMessageText").at(-1);
			assert.equal(read.offset, chunk * 32768);
			await release();
			await assertAnchor(originalAnchor, `automatic canonical chunk ${chunk}`);
		}
		const canonical = truncated.locator('[data-message-document-complete="true"] .markdown-body');
		await canonical.waitFor();
		assertCanonicalReads((await stats()).calls, await canonical.textContent(), expectedOriginal, 32768);
		assert.equal(await truncated.locator(".original-text").count(), 0);
		assert.equal(
			(await stats()).calls.filter((call) => call.method === "getMessageText").length,
			Math.ceil(expectedOriginal.length / 32768),
		);
		checks.push(
			"Automatic canonical chunks grow rich content above a visible anchor without replacing its text or moving the reader",
		);

		// The real long-user disclosure is presentation-only, not a transport reader.
		await open("?fold=1");
		await row("message:m-381").evaluate((node) => {
			const region = node.closest(".message-scroll");
			region.scrollTop += node.getBoundingClientRect().top - region.getBoundingClientRect().top + 1;
		});
		await settle();
		const foldAnchor = await anchor();
		const fold = row("message:m-379").locator(".user-message-expand");
		await fold.evaluate((node) => node.click());
		await assertAnchor(foldAnchor, "long user content expansion above anchor");
		assert.equal(await fold.getAttribute("aria-expanded"), "true");
		assert((await row("message:m-379").locator(".user-message-body").textContent()).includes("Folded user line 39"));
		await fold.evaluate((node) => node.click());
		await assertAnchor(foldAnchor, "long user content collapse above anchor");
		assert.equal(await fold.getAttribute("aria-expanded"), "false");
		assert.equal((await stats()).calls.filter((call) => call.method === "getMessageText").length, 0);
		checks.push("Native long-user disclosure changes height without transport reads and preserves the visible anchor");

		stage = "resize";
		await scrollTo(1800);
		for (const width of [760, 980]) {
			const before = await anchor();
			await page.locator(".fixture-shell").evaluate((node, value) => {
				node.style.maxWidth = `${value}px`;
			}, width);
			await assertAnchor(before, `container width ${width}`);
			await assertBounded();
		}
		for (const viewport of [
			{ width: 900, height: 650 },
			{ width: 1200, height: 800 },
		]) {
			const before = await anchor();
			await page.setViewportSize(viewport);
			await assertAnchor(before, `viewport ${viewport.width}×${viewport.height}`);
			assert((await bottomGap()) > 500, "Viewport resize returned to bottom");
		}
		// CSS zoom exercises scaled layout/measurement; this is not native Electron zoom evidence.
		const beforeZoom = await anchor();
		await page.locator(".fixture-shell").evaluate((node) => {
			node.style.zoom = "1.25";
		});
		await settle();
		const zoomed = await row(beforeZoom.key).boundingBox();
		assert(zoomed && zoomed.y < 800 && zoomed.y + zoomed.height > 0, "Zoom evicted the visible reading anchor");
		assert((await bottomGap()) > 500);
		await assertBounded();
		checks.push(
			"Container width and viewport resize preserve anchor geometry; CSS zoom retains the visible reading row",
		);

		stage = "estimate-equals-measure";
		await open("?fixed=1");
		await scrollTo(1049);
		const crossing = await scroller.evaluate((node) => {
			const top = node.getBoundingClientRect().top;
			const item = [...node.querySelectorAll("[data-message-key]")].find((element) => {
				const rect = element.getBoundingClientRect();
				return rect.top < top && rect.bottom > top;
			});
			if (!item) throw new Error("Controlled row did not cross viewport top");
			const rect = item.getBoundingClientRect();
			if (rect.height !== 160) throw new Error(`Expected initial measured height 160, got ${rect.height}`);
			return { key: item.getAttribute("data-message-key"), top: rect.top - top };
		});
		await row(crossing.key).evaluate((node) => {
			node.style.height = "560px";
		});
		await assertAnchor(crossing, "initial measurement equals 160px estimate, then visible row grows");
		assert.equal(Math.round((await row(crossing.key).boundingBox()).height), 560);
		await row(crossing.key).evaluate((node) => {
			node.style.height = "160px";
		});
		await assertAnchor(crossing, "visible controlled row shrinks back to estimate");
		checks.push(
			"A 160px first measurement equal to the estimate is still treated as measured when a crossing row later grows/shrinks",
		);

		stage = "selection";
		await open();
		await scrollTo(1800);
		const selected = await page.evaluate(() => {
			const region = document.querySelector(".message-scroll");
			const bounds = region.getBoundingClientRect();
			const row = [...region.querySelectorAll("[data-message-key]")].find((node) => {
				const rect = node.getBoundingClientRect();
				return rect.top >= bounds.top && rect.top < bounds.bottom - 50;
			});
			const text = row.querySelector(".markdown-body p").firstChild;
			const range = document.createRange();
			range.setStart(text, 0);
			range.setEnd(text, Math.min(10, text.textContent.length));
			const selection = document.getSelection();
			selection.removeAllRanges();
			selection.addRange(range);
			document.dispatchEvent(new Event("selectionchange"));
			return { key: row.getAttribute("data-message-key"), text: selection.toString(), content: row.textContent };
		});
		await settle();
		const pinKeys = await rows.evaluateAll((nodes) => nodes.map((node) => node.getAttribute("data-message-key")));
		await page.evaluate(() => window.messageFixture.stream(7));
		await page.locator(".message-pending").waitFor();
		await settle();
		assert.equal(await row("partial-output").count(), 0, "Selected display accepted a pending snapshot");
		assert.equal(await row(selected.key).textContent(), selected.content);
		await scrollTo("end");
		await row("message:m-383").waitFor();
		assert.equal(await page.evaluate(() => document.getSelection().toString()), selected.text);
		for (const key of pinKeys) assert.equal(await row(key).count(), 1, `Selection pin evicted: ${key}`);
		assert(
			await row("message:m-383").evaluate((node) => {
				const r = node.getBoundingClientRect();
				return r.bottom > 0 && r.top < innerHeight;
			}),
			"Current viewport rows were starved by selection pins",
		);
		await assertBounded(pinKeys.length + 48);
		await page.evaluate(() => {
			document.getSelection().removeAllRanges();
			document.dispatchEvent(new Event("selectionchange"));
		});
		await row("partial-output").waitFor();
		await page.locator(".message-pending").waitFor({ state: "hidden" });
		await settle();
		await assertBounded();
		checks.push(
			"Selection freezes pending data, retains its pinned DOM and native text while current viewport remains rendered; clear flushes latest",
		);

		stage = "scope-late-callback";
		await open();
		await scrollTo(100);
		await page.waitForFunction(() => window.messageFixture.stats().calls.length === 1);
		await page.evaluate(() => window.messageFixture.stream(2));
		await page.locator('[data-running="true"]').waitFor();
		await page.evaluate(() => window.messageFixture.switchScope());
		await page.locator('[data-scope="fixture-b"]').waitFor();
		await settle();
		const newScopeAnchor = await anchor();
		const old = (await stats()).calls[0];
		assert(old.aborted, "Scope disposal did not abort old history request");
		await release();
		await assertAnchor(newScopeAnchor, "late old-scope history resolution");
		assert.equal(await row("message:m-383").getAttribute("data-index"), "31");
		assert.equal(await row("partial-output").count(), 0, "Old projection timer polluted new scope");
		checks.push("Scope switch aborts old read and rejects deliberately late old-scope history/projection callbacks");

		await open("?original=1");
		await page.waitForFunction(() => window.messageFixture.stats().calls.length === 1);
		await page.evaluate(() => window.messageFixture.switchScope());
		await page.locator('[data-scope="fixture-b"]').waitFor();
		await settle();
		assert((await stats()).calls[0].aborted, "Scope disposal did not abort original read");
		await release();
		await settle();
		assert(
			!(await row("message:m-380").textContent()).includes("Original line 0:"),
			"Late original response leaked into the new scope",
		);
		assert.equal(await row("message:m-380").locator('[data-message-document-complete="true"]').count(), 1);
		checks.push("Late original-text response after scope disposal is ignored");

		stage = "empty-page-bound";
		await open("?empty=1");
		await scrollTo(100);
		for (let index = 1; index <= 16; index++) {
			await page.waitForFunction((count) => window.messageFixture.stats().calls.length === count, index);
			await release();
		}
		// A sixteen-read batch yields internally, then continues while the same viewport still demands history.
		await page.waitForFunction(
			() => window.messageFixture.stats().calls.filter((call) => call.method === "getHistory").length === 17,
		);
		await settle();
		assertHistoryYield((await stats()).calls, (await stats()).maxActive);
		assert.equal(await page.getByRole("button", { name: "继续扫描", exact: true }).count(), 0);
		checks.push(
			"Empty history scan yields after sixteen reads and resumes from the visible boundary without a transport button",
		);

		await assertBounded();
		assert.deepEqual(errors, [], "Unhandled browser errors or forbidden network activity");
		await page.screenshot({ path: join(output, "message-components.png"), fullPage: true });
		stage = "complete";
	}
} catch (error) {
	failure = error instanceof Error ? error.stack : String(error);
	process.exitCode = 1;
	if (page) {
		try {
			await page.screenshot({ path: join(output, "message-components-failure.png"), fullPage: true });
		} catch {
			/* Browser termination may make evidence capture unavailable. */
		}
	}
} finally {
	const cleanupErrors = [];
	try {
		await browser?.close();
	} catch (error) {
		cleanupErrors.push({ resource: "browser", error: error instanceof Error ? error.message : String(error) });
	}
	try {
		await vite?.close();
	} catch (error) {
		cleanupErrors.push({ resource: "vite", error: error instanceof Error ? error.message : String(error) });
	}
	if (cleanupErrors.length > 0) process.exitCode = 1;
	const result = failure
		? stage === "setup" || stage === "browser-launch"
			? "BLOCKED"
			: "FAIL"
		: cleanupErrors.length > 0
			? "FAIL"
			: transformOnly
				? "TRANSFORM_ONLY_BROWSER_NOT_RUN"
				: "PASS";
	await writeFile(
		join(output, "message-verification.json"),
		JSON.stringify(
			{
				date: new Date().toISOString(),
				result,
				stage,
				tolerance,
				checks,
				measurements,
				errors,
				failure,
				cleanupErrors,
				limitations: [
					"Synthetic AppClient and deterministic snapshots; production ConversationHistory / ConversationMessages / MessageContent and styles",
					"Does not replace verify-browser.mjs real PI Durable / SQLite / HTTP end-to-end acceptance",
					"Linux Chromium only; CSS zoom and programmatic native selection are not native Electron zoom, OS mouse-drag, IME, or cross-platform evidence",
					"Offscreen overscan controls use DOM click() to trigger height changes without scrolling the anchor; this is not visible pointer-interaction E2E evidence",
					"48 mounted rows is a generous fixture regression ceiling, not a measured product performance guarantee",
				],
			},
			null,
			2,
		),
	);
	console.log(JSON.stringify({ result, stage, checks: checks.length, output, failure, cleanupErrors }));
}
