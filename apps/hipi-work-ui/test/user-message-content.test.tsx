import assert from "node:assert/strict";
import type * as React from "react";
import { isValidElement } from "react";
import { beforeEach, test, vi } from "vitest";
import { Button } from "../src/components/ui/button.tsx";
import { MessageMarkdown } from "../src/features/workbench/message-markdown.tsx";
import {
	constrainClippedControls,
	USER_MESSAGE_COLLAPSED_UNITS,
	UserMessageContent,
} from "../src/features/workbench/user-message-content.tsx";

const hooks = vi.hoisted(() => ({ cells: [] as unknown[], cursor: 0 }));
vi.mock("react", async () => {
	const actual = await vi.importActual<typeof React>("react");
	return {
		...actual,
		useLayoutEffect: () => {},
		useRef: <T,>(initial: T) => ({ current: initial }),
		useState: <T,>(initial: T) => {
			const index = hooks.cursor++;
			if (!(index in hooks.cells)) hooks.cells[index] = initial;
			return [
				hooks.cells[index],
				(next: T | ((current: T) => T)) => {
					hooks.cells[index] = typeof next === "function" ? (next as (value: T) => T)(hooks.cells[index] as T) : next;
				},
			];
		},
	};
});
vi.mock("../src/app/preferences.tsx", () => ({ usePreferences: () => ({ t: (key: string) => key, locale: "en" }) }));
beforeEach(() => {
	hooks.cells = [];
	hooks.cursor = 0;
});
function children<C extends React.ElementType>(
	node: React.ReactNode,
	type: C,
): React.ReactElement<React.ComponentProps<C>>[] {
	if (Array.isArray(node)) return node.flatMap((item) => children(item, type));
	if (!isValidElement<{ children?: React.ReactNode }>(node)) return [];
	const nested = children(node.props.children, type);
	return node.type === type ? [node as React.ReactElement<React.ComponentProps<C>>, ...nested] : nested;
}
test("long user source bounds initial rich rendering and explicit expansion restores the same full source", () => {
	const source = "first\n".repeat(2500);
	const render = () => {
		hooks.cursor = 0;
		return UserMessageContent({ source });
	};
	let view = render();
	assert.equal(children(view, MessageMarkdown)[0]?.props.source, source.slice(0, USER_MESSAGE_COLLAPSED_UNITS));
	assert.equal(children(view, MessageMarkdown)[0]?.props.tone, "user");
	let toggle = children(view, Button)[0];
	assert.ok(toggle?.props.onClick);
	assert.equal(toggle.props["aria-expanded"], false);
	Reflect.apply(toggle.props.onClick, undefined, []);
	view = render();
	assert.equal(children(view, MessageMarkdown)[0]?.props.source, source);
	toggle = children(view, Button)[0];
	assert.equal(toggle?.props["aria-expanded"], true);
	assert.ok(toggle?.props.onClick);
	Reflect.apply(toggle.props.onClick, undefined, []);
	assert.equal(children(render(), MessageMarkdown)[0]?.props.source.length, USER_MESSAGE_COLLAPSED_UNITS);
});
test("short source adds no unnecessary expand action before a measured overflow", () => {
	const view = UserMessageContent({ source: "A short goal" });
	assert.equal(children(view, Button).length, 0);
	assert.equal(children(view, MessageMarkdown)[0]?.props.source, "A short goal");
});
test("clipped controls become inert and hidden, visible controls and original attributes restore exactly", () => {
	const control = (bottom: number, inert = false, hidden: string | null = null) => {
		const attributes = new Map<string, string>();
		if (hidden !== null) attributes.set("aria-hidden", hidden);
		return {
			inert,
			getBoundingClientRect: () => ({ bottom }),
			getAttribute: (key: string) => attributes.get(key) ?? null,
			setAttribute: (key: string, value: string) => {
				attributes.set(key, value);
			},
			removeAttribute: (key: string) => {
				attributes.delete(key);
			},
		};
	};
	const visible = control(80);
	const hidden = control(120);
	const alreadyHidden = control(140, true, "true");
	const root = { querySelectorAll: () => [visible, hidden, alreadyHidden] } as unknown as HTMLElement;
	const restore = constrainClippedControls(root, 100);
	assert.equal(visible.inert, false);
	assert.equal(visible.getAttribute("aria-hidden"), null);
	assert.equal(hidden.inert, true);
	assert.equal(hidden.getAttribute("aria-hidden"), "true");
	restore();
	assert.equal(hidden.inert, false);
	assert.equal(hidden.getAttribute("aria-hidden"), null);
	assert.equal(alreadyHidden.inert, true);
	assert.equal(alreadyHidden.getAttribute("aria-hidden"), "true");
});
