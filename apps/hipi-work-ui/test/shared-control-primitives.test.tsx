import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { compile } from "@tailwindcss/node";
import { Search } from "lucide-react";
import type * as Radix from "radix-ui";
import { DropdownMenu as MenuPrimitive, Select as SelectPrimitive, Tooltip as TooltipPrimitive } from "radix-ui";
import { Children, isValidElement, type ReactElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { test, vi } from "vitest";
import { Button, buttonVariants } from "../src/components/ui/button.tsx";
import {
	DropdownMenu,
	DropdownMenuCheckboxItem,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuRadioGroup,
	DropdownMenuRadioItem,
	DropdownMenuSubContent,
	DropdownMenuTrigger,
} from "../src/components/ui/dropdown-menu.tsx";
import { Icon } from "../src/components/ui/icon.tsx";
import { Input } from "../src/components/ui/input.tsx";
import { SelectContent, SelectItem, SelectTrigger } from "../src/components/ui/select.tsx";
import { Textarea } from "../src/components/ui/textarea.tsx";
import { TooltipContent, TooltipProvider, TooltipTrigger } from "../src/components/ui/tooltip.tsx";

// SSR has no portal target. Keep every Radix control/semantic implementation real.
vi.mock("radix-ui", async () => {
	const actual = await vi.importActual<typeof Radix>("radix-ui");
	const Portal = ({ children }: { children: ReactNode }) => children;
	return {
		...actual,
		DropdownMenu: { ...actual.DropdownMenu, Portal },
		Tooltip: { ...actual.Tooltip, Portal },
	};
});

function element(node: ReactNode): ReactElement<Record<string, unknown>> {
	assert.ok(isValidElement<Record<string, unknown>>(node));
	return node;
}

test("tooltips retain Radix lifecycle callbacks with delayed, arrowless, collision-aware defaults", () => {
	const provider = TooltipProvider({ children: "内容" });
	assert.equal(provider.type, TooltipPrimitive.Provider);
	assert.equal(provider.props.delayDuration, 200);
	assert.equal(TooltipProvider({ children: "内容", delayDuration: 700 }).props.delayDuration, 700);
	const onEscapeKeyDown = vi.fn();
	const overlay = TooltipContent({ children: "Long translated help", onEscapeKeyDown });
	assert.equal(overlay.type, TooltipPrimitive.Portal);
	const content = element(overlay.props.children);
	assert.equal(content.type, TooltipPrimitive.Content);
	assert.equal(content.props.sideOffset, 2);
	assert.equal(content.props.collisionPadding, 8);
	assert.equal(content.props.onEscapeKeyDown, onEscapeKeyDown);
	assert.deepEqual(Children.toArray(content.props.children as ReactNode), ["Long translated help"]);
	const override = element(TooltipContent({ sideOffset: 12, collisionPadding: 20 }).props.children);
	assert.equal(override.props.sideOffset, 12);
	assert.equal(override.props.collisionPadding, 20);
	const trigger = TooltipTrigger({ asChild: true, children: <Button aria-label="帮助" /> });
	assert.equal(trigger.type, TooltipPrimitive.Trigger);
	assert.equal(trigger.props.asChild, true);
});

test("menus retain portals, Radix focus restoration and explicit collision overrides", () => {
	const onCloseAutoFocus = vi.fn();
	const menu = DropdownMenuContent({ onCloseAutoFocus, children: "menu", className: "consumer-menu" });
	assert.equal(menu.type, MenuPrimitive.Portal);
	const content = element(menu.props.children);
	assert.equal(content.type, MenuPrimitive.Content);
	assert.equal(content.props.sideOffset, 1);
	assert.equal(content.props.collisionPadding, 6);
	assert.equal(content.props.align, "start");
	assert.equal(content.props.onCloseAutoFocus, onCloseAutoFocus);
	assert.match(String(content.props.className), /consumer-menu/);
	const overridden = element(DropdownMenuContent({ align: "end", sideOffset: 9, collisionPadding: 18 }).props.children);
	assert.equal(overridden.props.align, "end");
	assert.equal(overridden.props.sideOffset, 9);
	assert.equal(overridden.props.collisionPadding, 18);
	const sub = DropdownMenuSubContent({ children: "nested" });
	assert.equal(sub.type, MenuPrimitive.SubContent);
	assert.equal(sub.props.sideOffset, 1);
	assert.equal(sub.props.collisionPadding, 6);
});

test("selected and disabled menu choices retain Radix semantics with trailing checkmarks", () => {
	const html = renderToStaticMarkup(
		<DropdownMenu open modal={false} dir="rtl">
			<DropdownMenuTrigger asChild>
				<Button>菜单</Button>
			</DropdownMenuTrigger>
			<DropdownMenuContent>
				<DropdownMenuCheckboxItem checked>显示详情</DropdownMenuCheckboxItem>
				<DropdownMenuRadioGroup value="recent">
					<DropdownMenuRadioItem value="recent">Recent conversations</DropdownMenuRadioItem>
					<DropdownMenuRadioItem value="archived" disabled>
						已归档
					</DropdownMenuRadioItem>
				</DropdownMenuRadioGroup>
				<DropdownMenuItem variant="destructive" disabled>
					删除
				</DropdownMenuItem>
			</DropdownMenuContent>
		</DropdownMenu>,
	);
	assert.match(html, /role="menu"/);
	assert.match(html, /role="menuitemcheckbox"[^>]*aria-checked="true"/);
	assert.match(html, /role="menuitemradio"[^>]*aria-checked="true"/);
	const disabledChoice = html.match(/<div role="menuitemradio"[^>]*aria-disabled="true"[^>]*>/)?.[0];
	assert.ok(disabledChoice);
	assert.match(disabledChoice, /aria-checked="false"/);
	assert.match(html, /显示详情<span data-slot="dropdown-menu-item-indicator"/);
	assert.match(html, /Recent conversations<span data-slot="dropdown-menu-item-indicator"/);
	assert.equal((html.match(/class="lucide lucide-check"/g) ?? []).length, 2);
	assert.doesNotMatch(
		html.slice(html.indexOf('role="menu"')),
		/lucide-circle|left-2|bg-disabled|text-disabled-foreground/,
	);
	assert.match(html, /data-variant="destructive"/);
	assert.match(html, /data-\[disabled\]:opacity-50/);
	const onSelect = vi.fn();
	const onCheckedChange = vi.fn();
	assert.equal(DropdownMenuItem({ onSelect, disabled: true }).props.onSelect, onSelect);
	assert.equal(DropdownMenuCheckboxItem({ checked: true, onCheckedChange }).props.onCheckedChange, onCheckedChange);
});

test("buttons keep native actions, explicit icon sizes and per-variant interaction semantics", () => {
	const onClick = vi.fn();
	const button = Button({ onClick, disabled: true, "aria-label": "保存", variant: "destructive" });
	assert.equal(button.type, "button");
	assert.equal(button.props.type, "button");
	assert.equal(button.props.onClick, onClick);
	assert.equal(button.props.disabled, true);
	assert.equal(button.props["aria-label"], "保存");
	const html = renderToStaticMarkup(
		<Button variant="ghost" aria-pressed aria-expanded data-selected="true" data-state="open">
			<Icon name="info" size={14} />
			<Search size={20} aria-hidden />
			长操作名称
		</Button>,
	);
	assert.match(html, /aria-pressed="true"/);
	assert.match(html, /aria-expanded="true"/);
	assert.match(html, /data-selected="true"/);
	assert.match(html, /data-state="open"/);
	assert.match(html, /data-icon-size="14" width="14" height="14"/);
	assert.match(html, /style="width:14px;height:14px"/);
	assert.match(html, /width="20" height="20"/);
	assert.match(buttonVariants({ variant: "ghost" }), /disabled:opacity-40/);
	assert.match(buttonVariants({ variant: "ghost" }), /focus-visible:-outline-offset-1/);
	for (const variant of ["default", "destructive"] as const) {
		const classes = buttonVariants({ variant });
		assert.doesNotMatch(classes, /hover:bg-accent|active:bg-accent/);
		for (const state of [
			"hover",
			"active",
			"data-[state=open]",
			"aria-expanded",
			"aria-pressed",
			"data-[selected=true]",
		]) {
			assert.ok(
				classes.includes(`not-disabled:${state}:bg-${variant === "default" ? "primary" : "destructive"}-hover`),
			);
		}
	}
});

test("Select shares menu geometry while retaining listbox primitives, value/focus ownership and trailing checks", () => {
	const close = vi.fn();
	const popup = SelectContent({ onCloseAutoFocus: close, position: "popper", children: "选择字体" });
	assert.equal(popup.type, SelectPrimitive.Portal);
	const content = element(popup.props.children);
	assert.equal(content.type, SelectPrimitive.Content);
	assert.equal(content.props.position, "popper");
	assert.equal(content.props.sideOffset, 1);
	assert.equal(content.props.collisionPadding, 6);
	assert.equal(content.props.onCloseAutoFocus, close);
	assert.match(String(content.props.className), /ui-menu-surface ui-select-surface/);
	const overridden = element(SelectContent({ sideOffset: 8, collisionPadding: 12 }).props.children);
	assert.equal(overridden.props.sideOffset, 8);
	assert.equal(overridden.props.collisionPadding, 12);
	const choice = SelectItem({ value: "font", disabled: true, children: "真实字体" });
	assert.equal(choice.type, SelectPrimitive.Item);
	assert.equal(choice.props.value, "font");
	assert.equal(choice.props.disabled, true);
	assert.match(choice.props.className, /ui-menu-row/);
	assert.doesNotMatch(choice.props.className, /bg-disabled|text-disabled-foreground/);
	const [text, indicator] = Children.toArray(choice.props.children).map(element);
	assert.equal(text?.type, SelectPrimitive.ItemText);
	assert.equal(text?.props.children, "真实字体");
	assert.equal(indicator?.props["data-slot"], "select-item-indicator");
	assert.match(String(indicator?.props.className), /ms-auto/);
	const trigger = SelectTrigger({ "aria-label": "字体", disabled: true });
	assert.equal(trigger.type, SelectPrimitive.Trigger);
	assert.equal(trigger.props.disabled, true);
	assert.match(trigger.props.className, /focus-visible:outline-2/);
});

test("text fields preserve native composition/change/invalid contracts with the shared focus width", () => {
	const change = vi.fn();
	const composition = vi.fn();
	for (const control of [Input, Textarea]) {
		const field = control({
			onChange: change,
			onCompositionEnd: composition,
			disabled: true,
			"aria-invalid": true,
			"aria-label": "输入",
		});
		assert.equal(field.props.onChange, change);
		assert.equal(field.props.onCompositionEnd, composition);
		assert.equal(field.props.disabled, true);
		assert.equal(field.props["aria-invalid"], true);
		assert.match(field.props.className, /focus-visible:ring-2/);
		assert.doesNotMatch(field.props.className, /ring-\[3px\]/);
	}
});

test("shared control CSS emits scoped focus, state, sizing, theme and reduced-motion rules", async () => {
	const theme = await readFile(new URL("../src/theme.css", import.meta.url), "utf8");
	const controls = await readFile(new URL("../src/components/ui/control-primitives.css", import.meta.url), "utf8");
	const compiler = await compile(theme, {
		base: fileURLToPath(new URL("../src", import.meta.url)),
		onDependency: () => {},
	});
	const controlsCompiler = await compile(controls, {
		base: fileURLToPath(new URL("../src/components/ui", import.meta.url)),
		onDependency: () => {},
	});
	const candidates = (["default", "ghost", "destructive"] as const).flatMap((variant) =>
		buttonVariants({ variant }).split(" "),
	);
	const css = `${compiler.build(candidates)}\n${controlsCompiler.build([])}`;
	assert.match(css, /:focus-visible\s*\{[^{}]*outline-width: 2px/);
	assert.match(css, /:focus-visible\s*\{\s*outline-offset: calc\(1px \* -1\)/);
	assert.ok(/\[aria-pressed="?true"?\]\s*\{\s*background-color: var\(--brand-hover\)/.test(css));
	assert.ok(/\[data-state="?open"?\]\s*\{\s*background-color: var\(--danger-hover\)/.test(css));
	assert.match(css, /svg:not\(\[width\]\):not\(\[height\]\):not\(\[class\*='size-'\]\)/);
	assert.match(css, /border-radius: 20px;\s*corner-shape: superellipse\(1.5\)/);
	assert.match(css, /border-radius: 15px;\s*corner-shape: superellipse\(1.5\)/);
	assert.match(css, /max-width: min\(320px, var\(--radix-tooltip-content-available-width\), calc\(100vw - 16px\)\)/);
	assert.match(css, /font-size: calc\(var\(--font-ui-size\) - 1px\)/);
	assert.match(css, /--ui-tooltip-surface: var\(--raised\)/);
	assert.match(css, /prefers-reduced-motion: reduce/);
	assert.match(css, /data-reduced-motion="on"/);
});
