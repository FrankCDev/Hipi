import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { compile, optimize } from "@tailwindcss/node";
import { assertCssLayerOrder, cssCascadeGate } from "../css-cascade.ts";

const order = "@layer theme, base, components, utilities;";

test("emitted cascade gate rejects the dependency-first regression even when Tailwind declares order later", () => {
	const broken = `@layer components{.ui-menu-row{padding:5px 8px}}${order}@layer base{*{padding:0}}`;
	assert.throws(() => assertCssLayerOrder(broken, "renderer.css"), /layer precedence/);
	assert.equal(assertCssLayerOrder(`${order}${broken}`, "renderer.css"), true);
	assert.equal(assertCssLayerOrder(".unlayered{color:red}", "renderer.css"), false);
});

test("comments, string content, nested statements and incomplete layer order cannot satisfy the artifact gate", () => {
	for (const prefix of [
		`/* ${order} */`,
		`.content::after{content:"${order}"}`,
		`@media (min-width:1px){${order}}`,
		"@layer base, components, utilities;",
		"@layer components, theme, base, utilities;",
	]) {
		assert.throws(() => assertCssLayerOrder(`${prefix}@layer components{.row{padding:5px}}`, "bad.css"));
	}
	assert.equal(
		assertCssLayerOrder(`/* comment */.content{content:"@layer \\"not real\\";"}${order}`, "good.css"),
		true,
	);
});

test("real CSS entry points retain reset < components < utilities in either dependency emission order after minification", async () => {
	const paths = ["../src/components/ui/control-primitives.css", "../src/theme.css"];
	const sources = await Promise.all(
		paths.map(async (path) => {
			const url = new URL(path, import.meta.url);
			const source = await readFile(url, "utf8");
			const compiler = await compile(source, {
				base: fileURLToPath(new URL(".", url)),
				onDependency: () => {},
			});
			return { source, css: compiler.build(["p-0", "rounded-none", "border-0"]) };
		}),
	);
	for (const ordered of [sources, [...sources].reverse()]) {
		const css = optimize(ordered.map((source) => source.css).join("\n"), { minify: true }).code;
		assert.equal(assertCssLayerOrder(css, "real-renderer.css"), true);
		assert.match(css, /\.ui-menu-row\{[^}]*padding:5px 8px/);
		assert.match(css, /\.ui-menu-surface\{[^}]*padding:4px/);
		assert.match(css, /\.ui-tooltip\{[^}]*padding:5px 12px/);
		assert.match(css, /\.p-0\{padding:0\}/);
		assert.match(css, /\.rounded-none\{border-radius:0\}/);
		assert.match(css, /prefers-reduced-motion:reduce/);
	}
	// Counterfactual uses the exact former production graph: dependencies emit
	// control styles first, then theme/reset. A later canonical order cannot fix it.
	const controls = sources[0];
	const theme = sources[1];
	assert.ok(controls && theme);
	const former = await compile(controls.source.replace('@import "../../layers.css";', ""), {
		base: fileURLToPath(new URL("../src/components/ui/", import.meta.url)),
		onDependency: () => {},
	});
	const broken = optimize(`${former.build([])}\n${theme.css}`, { minify: true }).code;
	assert.throws(() => assertCssLayerOrder(broken, "former-renderer.css"), /layer precedence/);
});

test("production Vite hook checks final CSS assets rather than trusting source or JS import order", async () => {
	const hook = cssCascadeGate().generateBundle;
	assert.equal(typeof hook, "function");
	assert.ok(typeof hook === "function");
	const invoke = (source: string) =>
		Reflect.apply(hook, {}, [{}, { css: { type: "asset", fileName: "assets/index.css", source } }, false]);
	await invoke(`${order}@layer components{.ui-menu-row{padding:5px 8px}}`);
	assert.throws(() => invoke("@layer components{.ui-menu-row{padding:5px 8px}}"), /layer precedence/);
	assert.throws(() => invoke(".ui-menu-row{padding:5px 8px}"), /no explicit global cascade order/);
});
