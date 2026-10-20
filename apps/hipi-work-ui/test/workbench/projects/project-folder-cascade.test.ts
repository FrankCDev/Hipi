import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { compile, optimize } from "@tailwindcss/node";

async function compiledStyles() {
	const themeUrl = new URL("../../../src/theme.css", import.meta.url);
	const theme = await readFile(themeUrl, "utf8");
	const folder = await readFile(
		new URL("../../../src/features/workbench/projects/folder.css", import.meta.url),
		"utf8",
	);
	const consent = await readFile(
		new URL("../../../src/features/workbench/composer/project-consent.css", import.meta.url),
		"utf8",
	);
	const failure = await readFile(
		new URL("../../../src/features/workbench/conversation/turn-failure.css", import.meta.url),
		"utf8",
	);
	const compiler = await compile(theme, {
		base: fileURLToPath(new URL(".", themeUrl)),
		onDependency: () => {},
	});
	return { theme, folder: `${folder}\n${consent}\n${failure}`, compiled: compiler.build([]) };
}

test("project folder, consent and failure custom properties resolve to the application's own tokens", async () => {
	const { theme, folder, compiled } = await compiledStyles();
	const declared = new Set(Array.from(theme.matchAll(/(--[\w-]+)\s*:/g), (match) => match[1]));
	for (const match of folder.matchAll(/var\((--[\w-]+)\)/g)) {
		assert.ok(declared.has(match[1]), `Undeclared project context token: ${match[1]}`);
	}
	for (const styles of [`${compiled}\n${folder}`, `${folder}\n${compiled}`]) {
		assert.ok(optimize(styles, { minify: true }).code.length > 0);
	}
});

// Opt-in native CSSOM acceptance, not a screenshot or a simulated CSS resolver.
// The executable must support its normal sandbox. Never disable it for this test.
const chromium = process.env.HIPI_TEST_CHROMIUM;
test(
	"native cascade keeps folder summaries neutral in either stylesheet order and both themes",
	{ skip: chromium ? false : "Set HIPI_TEST_CHROMIUM to a sandbox-capable Chromium executable" },
	async () => {
		assert.ok(chromium);
		const { folder, compiled } = await compiledStyles();
		const directory = await mkdtemp(join(tmpdir(), "hipi-folder-cascade-"));
		try {
			for (const [index, styles] of [`${compiled}\n${folder}`, `${folder}\n${compiled}`].entries()) {
				// Map only :hover to a fixture attribute to exercise the real cascade
				// deterministically; native pointer event delivery is a separate check.
				const css = optimize(styles, { minify: true }).code.replaceAll(":hover", "[data-css-hover]");
				const html = `<!doctype html><html><head><style>${css}</style></head><body>
<div class="welcome-action"><button class="project-folder-summary">
<strong>Project folder</strong><span class="project-folder-secondary">Not connected</span>
</button></div><div class="project-folder-identity"><span>Folder identity</span></div>
<section class="prepared-project-consent"><div class="context-project-folder"><span>Consent detail</span></div></section>
<button class="prepared-project-permissions" data-staged="true">Permission staged</button>
<span class="prepared-context-note">Context note</span><div class="conversation-turn-failure">Failure detail</div>
<div id="surface"></div><div id="canvas"></div><div id="text"></div><div id="muted"></div><div id="line"></div><div id="brand-soft"></div>
<pre id="result"></pre><script>
const summary = document.querySelector(".project-folder-summary");
const secondary = document.querySelector(".project-folder-secondary");
const identity = document.querySelector(".project-folder-identity");
const failures = [];
for (const theme of ["light", "dark"]) {
 document.documentElement.dataset.theme = theme;
 for (const name of ["surface", "canvas", "text", "muted", "line", "brand-soft"]) {
  document.getElementById(name).style.color = "var(--" + name + ")";
 }
 const token = name => getComputedStyle(document.getElementById(name)).color;
 const check = (label, actual, expected) => {
  if (actual !== expected) failures.push(theme + ":" + label + ":" + actual + "!=" + expected);
 };
 check("rest surface", getComputedStyle(summary).backgroundColor, token("surface"));
 check("foreground", getComputedStyle(summary).color, token("text"));
 check("secondary", getComputedStyle(secondary).color, token("muted"));
 check("border", getComputedStyle(summary).borderTopColor, token("line"));
 check("border width", getComputedStyle(summary).borderTopWidth, "1px");
 check("radius", getComputedStyle(summary).borderTopLeftRadius, "14px");
 check("identity surface", getComputedStyle(identity).backgroundColor, token("canvas"));
 const style = selector => getComputedStyle(document.querySelector(selector));
 check("consent border", style(".context-project-folder").borderTopColor, token("line"));
 check("consent detail", style(".context-project-folder > span").color, token("muted"));
 check("staged foreground", style(".prepared-project-permissions").color, token("text"));
 check("staged surface", style(".prepared-project-permissions").backgroundColor, token("brand-soft"));
 check("context note", style(".prepared-context-note").color, token("muted"));
 check("failure detail", style(".conversation-turn-failure").color, token("muted"));
 summary.setAttribute("data-css-hover", "");
 check("hover surface", getComputedStyle(summary).backgroundColor, token("canvas"));
 summary.removeAttribute("data-css-hover");
}
// Prove the exact former ownership bug changes actual computed output.
const broken = document.createElement("style");
broken.textContent = ".welcome-action > button { background: var(--brand); color: var(--on-brand); }";
document.head.appendChild(broken);
if (getComputedStyle(summary).backgroundColor === getComputedStyle(document.getElementById("surface")).color) {
 failures.push("counterfactual did not reproduce the broad parent selector regression");
}
document.getElementById("result").textContent = failures.length ? JSON.stringify(failures) : "PASS";
</script></body></html>`;
				const fixture = join(directory, `fixture-${index}.html`);
				await writeFile(fixture, html);
				const { stdout } = await promisify(execFile)(
					chromium,
					[
						"--headless",
						`--user-data-dir=${join(directory, `profile-${index}`)}`,
						"--dump-dom",
						pathToFileURL(fixture).href,
					],
					{ timeout: 30_000, maxBuffer: 8 * 1024 * 1024 },
				);
				assert.match(stdout, /<pre id="result">PASS<\/pre>/);
			}
		} finally {
			await rm(directory, { recursive: true, force: true });
		}
	},
);
