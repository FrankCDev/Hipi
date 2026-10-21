import createDOMPurify from "dompurify";
import type { ClipboardPayload } from "./clipboard-writer.ts";

const tags = [
	"p",
	"br",
	"hr",
	"h1",
	"h2",
	"h3",
	"h4",
	"h5",
	"h6",
	"blockquote",
	"ul",
	"ol",
	"li",
	"strong",
	"em",
	"del",
	"pre",
	"code",
	"table",
	"thead",
	"tbody",
	"tr",
	"th",
	"td",
	"input",
];
const blocks = new Set(["P", "H1", "H2", "H3", "H4", "H5", "H6", "BLOCKQUOTE"]);

/** Product semantics only. DOMPurify, not this formatter, owns the HTML security boundary. */
function plain(node: Node): string {
	if (node.nodeType === 3) return node.textContent ?? "";
	const children = () => Array.from(node.childNodes, plain).join("");
	if (!(node instanceof Element)) return children();
	if (node.tagName === "PRE") return `\n${node.textContent ?? ""}\n`;
	if (node.tagName === "BR" || node.tagName === "HR") return "\n";
	if (node.tagName === "INPUT") return node.hasAttribute("checked") ? "[x]" : "[ ]";
	if (node.tagName === "TABLE") return `\n${Array.from(node.querySelectorAll("tr"), plain).join("")}\n`;
	if (node.tagName === "TR") return `${Array.from(node.children, (cell) => plain(cell).trim()).join("\t")}\n`;
	if (node.tagName === "UL" || node.tagName === "OL") {
		let index = Number(node.getAttribute("start") ?? 1);
		return `\n${Array.from(node.children, (item) => {
			if (item.hasAttribute("value")) index = Number(item.getAttribute("value"));
			const marker = node.tagName === "OL" ? `${index++}. ` : "- ";
			return marker + Array.from(item.childNodes, plain).join("").trim().replace(/\n/g, "\n  ");
		}).join("\n")}\n`;
	}
	return blocks.has(node.tagName) ? `\n${children()}\n` : children();
}

export function assistantCopyPayload(root: HTMLElement | null, source: string): ClipboardPayload {
	// Paged/original/error-boundary rendering is not the complete Markdown document.
	if (!root || root.querySelector(".original-text")) return { plain: source };
	const view = root.ownerDocument.defaultView;
	if (!view) return { plain: source };
	const purifier = createDOMPurify(view);
	if (!purifier.isSupported) return { plain: source };
	const clone = root.cloneNode(true) as HTMLElement;
	for (const hidden of clone.querySelectorAll(
		'[data-markdown-copy="exclude"], .sr-only, [aria-hidden="true"], [hidden], script, style, template, svg, button:not([role="checkbox"]), textarea, select',
	))
		hidden.remove();
	for (const marker of clone.querySelectorAll('[role="checkbox"]')) {
		const input = root.ownerDocument.createElement("input");
		input.type = "checkbox";
		input.disabled = true;
		if (marker.getAttribute("aria-checked") === "true") input.setAttribute("checked", "");
		marker.replaceWith(input);
	}
	// Flatten presentation wrappers, preserving highlighted code and revealed text verbatim.
	for (const wrapper of clone.querySelectorAll("div, section, span")) wrapper.replaceWith(...wrapper.childNodes);
	const fragment = purifier.sanitize(clone, {
		RETURN_DOM_FRAGMENT: true,
		ALLOWED_TAGS: tags,
		ALLOWED_ATTR: ["start", "value", "colspan", "rowspan", "type", "checked", "disabled"],
		ALLOW_DATA_ATTR: false,
		ALLOW_ARIA_ATTR: false,
	});
	const container = root.ownerDocument.createElement("div");
	container.append(fragment);
	return { plain: plain(container).trim(), html: container.innerHTML };
}
