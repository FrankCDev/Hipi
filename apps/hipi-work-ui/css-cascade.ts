import type { Plugin } from "vite";

const expected = ["theme", "base", "components", "utilities"];

/** Check effective first-registration order in emitted CSS, not source import order.
 * A minifier may replace an order statement with correctly reordered blocks.
 * A later statement cannot repair a layer that an earlier block registered.
 * Strings/comments are skipped so CSS content values cannot satisfy the gate.
 */
export function assertCssLayerOrder(css: string, filename: string): boolean {
	let depth = 0;
	const registered: string[] = [];
	for (let index = 0; index < css.length; index++) {
		const character = css[index];
		if (character === "/" && css[index + 1] === "*") {
			const end = css.indexOf("*/", index + 2);
			if (end < 0) throw new Error(`${filename}: unterminated CSS comment`);
			index = end + 1;
			continue;
		}
		if (character === '"' || character === "'") {
			const quote = character;
			for (index++; index < css.length; index++) {
				if (css[index] === "\\") index++;
				else if (css[index] === quote) break;
			}
			continue;
		}
		if (character === "{") depth++;
		else if (character === "}") depth--;
		else if (character === "@" && /^@layer(?:\s|\/\*)/.test(css.slice(index))) {
			const declaration = /^@layer\s+([^{};]+)[;{]/.exec(css.slice(index));
			const names = declaration?.[1]?.split(",").map((name) => name.trim()) ?? [];
			for (const name of names) {
				if (!expected.includes(name) || registered.includes(name)) continue;
				if (depth !== 0) throw new Error(`${filename}: global layer precedence cannot depend on a nested rule`);
				registered.push(name);
			}
		}
	}
	if (!registered.length) return false;
	if (registered.length !== expected.length || registered.some((name, index) => name !== expected[index]))
		throw new Error(`${filename}: CSS layer precedence must be theme < base < components < utilities`);
	return true;
}

/** Applies to desktop and browser builds through their shared Vite config. */
export function cssCascadeGate(): Plugin {
	return {
		name: "hipi-css-cascade-order",
		enforce: "post",
		generateBundle(_options, outputs) {
			let checked = false;
			for (const output of Object.values(outputs)) {
				if (output.type !== "asset" || !output.fileName.endsWith(".css")) continue;
				const css = typeof output.source === "string" ? output.source : new TextDecoder().decode(output.source);
				checked = assertCssLayerOrder(css, output.fileName) || checked;
			}
			if (!checked) throw new Error("Renderer CSS has no explicit global cascade order");
		},
	};
}
