import type { ExtraProps } from "react-markdown";

type Element = NonNullable<ExtraProps["node"]>;
type Parent = { children: Element["children"] };
const excluded = new Set(["pre", "code", "input", "button", "textarea", "select"]);

/** Decorate the public parser's text leaves, never parse Markdown a second time. */
export function revealTextPlugin() {
	return function transform(parent: Parent) {
		parent.children = parent.children.map((child) => {
			if (child.type === "element") {
				if (!excluded.has(child.tagName)) transform(child);
				return child;
			}
			if (child.type !== "text" || child.position?.start.offset === undefined || !child.value.trim()) return child;
			return {
				type: "element",
				tagName: "span",
				properties: {},
				position: child.position,
				children: [child],
			};
		});
	};
}
