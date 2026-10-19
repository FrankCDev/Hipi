import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";

// Isolated rendering acceptance. Synthetic bytes, real PDF.js Worker, no runtime/user files/models.
// No install, browser download, production build, or sandbox override.
const require = createRequire(import.meta.url);
const root = fileURLToPath(new URL("../", import.meta.url));
const output = process.env.HIPI_EVIDENCE_DIR || join(tmpdir(), "hipi-preview-browser-evidence");
const transformOnly = process.argv.includes("--transform-only");
const checks = [], errors = [];
let browser, vite, page, failure, stage = "setup", workers = 0;
await mkdir(output, { recursive: true });
try {
	if (!transformOnly) {
		stage = "browser-launch";
		const { chromium } = require(process.env.HIPI_PLAYWRIGHT_PATH || "playwright");
		browser = await chromium.launch({ executablePath: process.env.HIPI_CHROMIUM_PATH || "/usr/bin/chromium", headless: true, chromiumSandbox: true });
	}
	stage = "setup";
	vite = await createServer({ root: join(root, "test/preview-browser"), configFile: join(root, "vite.config.ts"), ...(transformOnly ? { optimizeDeps: { noDiscovery: true, include: [] } } : {}), server: { host: "127.0.0.1", port: 0, strictPort: false } });
	await vite.listen();
	const address = vite.httpServer.address();
	assert(address && typeof address === "object");
	const origin = `http://127.0.0.1:${address.port}`;
	if (transformOnly) {
		stage = "transform";
		for (const path of ["/fixture.tsx", ...["pdf-preview.tsx", "pdf-local-data.ts", "pdf-assets.generated.ts", "document-preview.tsx"].map(name => "/@fs" + join(root, "src/features/files", name))]) {
			assert((await vite.transformRequest(path))?.code.length, `No transformed source: ${path}`);
			checks.push(`Source transform: ${path}`);
		}
	} else {
		page = await browser.newPage({ viewport: { width: 1000, height: 900 }, deviceScaleFactor: 1 });
		page.setDefaultTimeout(15000);
		page.on("pageerror", error => errors.push(error.message));
		page.on("worker", () => { workers++; });
		await page.addInitScript(() => {
			const NativeWorker = window.Worker;
			const activeWorkers = new Set(), activeUrls = new Set();
			window.Worker = class extends NativeWorker {
				constructor(...args) { super(...args); activeWorkers.add(this); }
				terminate() { activeWorkers.delete(this); return super.terminate(); }
			};
			const create = URL.createObjectURL.bind(URL), revoke = URL.revokeObjectURL.bind(URL);
			URL.createObjectURL = blob => { const url = create(blob); activeUrls.add(url); return url; };
			URL.revokeObjectURL = url => { activeUrls.delete(url); revoke(url); };
			window.previewResources = () => ({ workers: activeWorkers.size, urls: activeUrls.size });
		});
		await page.route("**/*", async route => {
			if (new URL(route.request().url()).origin !== origin) { errors.push(`External request: ${route.request().url()}`); await route.abort(); }
			else await route.continue();
		});
		stage = "pdf";
		await page.goto(origin);
		await page.waitForFunction(() => !!window.previewFixture);
		await page.evaluate(() => window.previewFixture.open("sample.pdf"));
		await page.waitForFunction(() => document.querySelector(".file-preview-surface")?.getAttribute("aria-busy") === "false");
		assert(workers > 0, "No native PDF worker was observed");
		assert.equal((await page.evaluate(() => window.previewResources())).workers, 1);
		const pixels = () => page.locator("canvas").evaluate(canvas => {
			const values = canvas.getContext("2d").getImageData(0, 0, canvas.width, canvas.height).data;
			let painted = 0;
			for (let index = 0; index < values.length; index += 4) if (values[index + 3] > 0 && (values[index] < 240 || values[index + 1] < 240 || values[index + 2] < 240)) painted++;
			return painted;
		});
		assert(await pixels() > 500, "PDF first page was blank");
		assert((await page.evaluate(() => window.previewFixture.stats())).resources.includes("LiberationSans-Regular.ttf"));
		assert.equal(await page.evaluate(() => window.pdfInjected), undefined);
		assert.equal(await page.locator("a,iframe,object,embed,input").count(), 0);
		checks.push("Native worker, bounded canvas, local standard font, no script/link/embedded execution");
		await page.getByRole("button", { name: /Next page|下一页/ }).click();
		await page.waitForFunction(() => document.querySelector("canvas")?.getAttribute("aria-label")?.endsWith("2") && document.querySelector(".file-preview-surface")?.getAttribute("aria-busy") === "false");
		assert(await pixels() > 100, "CJK page was blank");
		assert((await page.evaluate(() => window.previewFixture.stats())).resources.includes("UniGB-UCS2-H.bcmap"));
		await page.screenshot({ path: join(output, "cjk-preview.png") });
		checks.push("CJK predefined CMap path paints; screenshot retained for glyph review, not a fidelity claim");
		await page.getByRole("combobox").selectOption("1.5");
		await page.waitForFunction(() => document.querySelector("canvas")?.width === 600 && document.querySelector(".file-preview-surface")?.getAttribute("aria-busy") === "false");
		checks.push("Page navigation and zoom use one live surface");
		stage = "image";
		await page.evaluate(() => window.previewFixture.open("sample.png"));
		await page.waitForFunction(() => document.querySelector(".file-preview-image")?.naturalWidth === 1 && window.previewResources().workers === 0);
		assert.equal((await page.evaluate(() => window.previewResources())).urls, 1);
		await page.evaluate(() => window.previewFixture.close());
		await page.waitForFunction(() => window.previewResources().urls === 0);
		assert.equal((await page.evaluate(() => window.previewFixture.stats())).handles, 0);
		checks.push("PDF switch terminates worker; image close revokes URL and handle");
		await page.evaluate(() => window.previewFixture.open("invalid.png"));
		await page.waitForFunction(() => !!window.previewFixture.stats().error && window.previewResources().urls === 0);
		assert.equal((await page.evaluate(() => window.previewFixture.stats())).handles, 0);
		checks.push("Image decode error revokes URL and handle");
		await page.evaluate(() => window.previewFixture.open("sample.png"));
		await page.waitForFunction(() => document.querySelector(".file-preview-image")?.naturalWidth === 1);
		await page.evaluate(() => window.previewFixture.revoke());
		await page.waitForFunction(() => window.previewFixture.stats().error === "UNAUTHORIZED" && window.previewResources().urls === 0);
		checks.push("External root revocation clears image on bounded authorization refresh");
		assert.deepEqual(errors, []);
	}
	stage = "complete";
} catch (error) {
	failure = error instanceof Error ? error.stack : String(error);
	process.exitCode = 1;
} finally {
	await browser?.close();
	await vite?.close();
	const result = failure ? (["setup", "browser-launch"].includes(stage) ? "BLOCKED" : "FAIL") : transformOnly ? "TRANSFORM_ONLY_BROWSER_NOT_RUN" : "PASS";
	await writeFile(join(output, "preview-verification.json"), JSON.stringify({ date: new Date().toISOString(), result, stage, checks, errors, workers, failure, limitations: ["Synthetic ports and bytes; no runtime transport/permission E2E", "CJK painted-pixel assertion does not prove correct glyphs; review screenshot", "Chromium component acceptance does not replace Windows/macOS/Linux desktop verification"] }, null, 2));
	console.log(JSON.stringify({ result, stage, checks: checks.length, output, failure }));
}
