// @vitest-environment jsdom
import assert from "node:assert/strict";
import type { AppClient, ToolActivity } from "@hipi/work-runtime/contracts";
import { act, useState } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, test, vi } from "vitest";
import { ThemeProvider } from "../../../src/app/theme/provider.tsx";
import { ActivitySession } from "../../../src/features/tool-activities/activity-session.ts";
import { InlineActivityCard } from "../../../src/features/tool-activities/inline-activity-card.tsx";
import { ActivityDisclosure } from "../../../src/features/tool-activities/turn-activity-presentation.tsx";
import {
	bindDisclosureAnchoring,
	ConversationScrollIntent,
} from "../../../src/features/workbench/conversation/scroll-intent.ts";

const observers = new Set<LayoutObserver>();
class LayoutObserver {
	readonly targets = new Set<Element>();
	private readonly callback: ResizeObserverCallback;
	constructor(callback: ResizeObserverCallback) {
		this.callback = callback;
		observers.add(this);
	}
	observe(target: Element) {
		this.targets.add(target);
	}
	unobserve(target: Element) {
		this.targets.delete(target);
	}
	disconnect() {
		this.targets.clear();
		observers.delete(this);
	}
	deliver() {
		this.callback([], this);
	}
}
const cleanups: (() => Promise<void>)[] = [];
beforeEach(() => {
	vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
	vi.spyOn(window, "scrollTo").mockImplementation(() => {});
	vi.stubGlobal("ResizeObserver", LayoutObserver);
	vi.stubGlobal(
		"IntersectionObserver",
		class {
			observe() {}
			unobserve() {}
			disconnect() {}
		},
	);
});
afterEach(async () => {
	for (const cleanup of cleanups.splice(0)) await cleanup();
	observers.clear();
	vi.unstubAllGlobals();
	vi.restoreAllMocks();
});
async function mount({ reduced = false, near = false, previous = true, individual = false } = {}) {
	vi.stubGlobal("matchMedia", () => ({ matches: reduced, addEventListener() {}, removeEventListener() {} }));
	const host = document.createElement("div");
	document.body.append(host);
	const root = createRoot(host);
	const client: AppClient = {
		call: async () => {
			throw new Error("No output is available in this metadata-only fixture");
		},
		observe: async () => ({ dispose: async () => {} }),
	};
	const session = new ActivitySession(client, { workspaceId: "w", conversationId: "c" });
	const activity: ToolActivity = {
		activityId: "task:1",
		taskId: "1",
		callId: "call",
		toolName: "generic_tool",
		source: "task",
		inherited: false,
		phase: "terminal",
		outcome: "completed",
		toolResult: "unavailable",
		abortRequested: false,
		receiptIds: [],
		textAvailable: false,
		outputTruncated: false,
	};
	let docTop = 400.125;
	let offset = near ? 990 : 100;
	let end = 1000;
	let time = 0;
	let blocked = false;
	let id = 0;
	let moves = 0;
	const frames = new Map<number, (time: number) => void>();
	const controller = new ConversationScrollIntent({
		offset: () => offset,
		end: () => end,
		move: (value) => {
			offset = value;
			moves++;
		},
		finish: () => {
			offset = end;
		},
		cancel: () => {},
		follow: () => {},
		nearEnd: () => {},
		reducedMotion: () => reduced,
		now: () => time,
		frame: (callback) => {
			frames.set(++id, callback);
			return id;
		},
		cancelFrame: (key) => {
			frames.delete(key);
		},
	});
	controller.setFollow(previous);
	function Disclosure() {
		const [expanded, setExpanded] = useState(false);
		return (
			<ThemeProvider>
				<div data-turn-key="turn">
					{individual ? (
						<InlineActivityCard
							activity={activity}
							session={session}
							state={session.snapshot()}
							locale="en"
							disabled={false}
						/>
					) : (
						<ActivityDisclosure
							title="Read file"
							count={1}
							expanded={expanded}
							onToggle={() => {
								docTop += expanded ? -12.125 : 20.25;
								setExpanded(!expanded);
							}}
						>
							<div>Retained output</div>
						</ActivityDisclosure>
					)}
				</div>
			</ThemeProvider>
		);
	}
	await act(async () => root.render(<Disclosure />));
	const header = host.querySelector<HTMLButtonElement>(
		individual ? ".inline-tool-result-toggle" : ".activity-disclosure-toggle",
	);
	assert.ok(header);
	const moveIndividual = () => {
		docTop += header.getAttribute("aria-expanded") === "true" ? -12.125 : 20.25;
	};
	if (individual) header.addEventListener("click", moveIndividual);
	Object.defineProperty(host, "offsetHeight", { value: 500 });
	vi.spyOn(host, "getBoundingClientRect").mockImplementation(() => new DOMRect(0, 0, 1000, 1000));
	vi.spyOn(header, "getBoundingClientRect").mockImplementation(() => new DOMRect(0, (docTop - offset) * 2, 100, 40));
	header.focus();
	const unbind = bindDisclosureAnchoring(host, controller, () => blocked);
	cleanups.push(async () => {
		unbind();
		controller.dispose();
		await act(async () => root.unmount());
		header.removeEventListener("click", moveIndividual);
		session.dispose();
		host.remove();
	});
	return {
		host,
		header,
		controller,
		unbind,
		get offset() {
			return offset;
		},
		get moves() {
			return moves;
		},
		get pending() {
			return frames.size;
		},
		block() {
			blocked = true;
		},
		grow(value: number) {
			docTop += value;
		},
		growEnd() {
			end += 1000;
		},
		async click() {
			await act(async () => header.click());
		},
		async frame(at: number) {
			time = at;
			await act(async () => {
				const batch = [...frames.values()];
				frames.clear();
				for (const callback of batch) callback(at);
			});
		},
		async resize() {
			await act(async () => {
				for (const observer of observers)
					if ([...observer.targets].some((target) => target.hasAttribute("data-turn-key"))) observer.deliver();
			});
		},
	};
}
test("real disclosure preserves fractional zoom-adjusted header across click, async resize and collapse, including reduced motion", async () => {
	for (const individual of [false, true])
		for (const reduced of [false, true]) {
			const view = await mount({ reduced, individual });
			await view.click();
			assert.equal(view.header.getAttribute("aria-expanded"), "true");
			await view.resize();
			assert.equal(view.offset, 120.25);
			await view.frame(16);
			assert.equal(view.moves, 1, "frame must not double the ResizeObserver compensation");
			view.grow(7.125);
			await view.frame(220);
			assert.equal(view.offset, 127.375, "reduced motion still retains late passive stability");
			assert.equal(document.activeElement, view.header);
			await view.frame(350);
			assert.equal(view.controller.holdingHeader, false);
			await view.click();
			assert.equal(view.header.getAttribute("aria-expanded"), "false");
			await view.resize();
			assert.equal(view.offset, 115.25);
			view.unbind();
			assert.equal(view.pending, 0);
		}
});
test("real disclosure releases ownership for explicit input, selection, removal and scope cleanup", async () => {
	for (const kind of [
		"wheel",
		"touchmove",
		"pointerdown",
		"keydown",
		"selection",
		"removed",
		"scope",
		"jump",
	] as const) {
		const view = await mount();
		await view.click();
		if (kind === "selection") view.block();
		else if (kind === "removed") view.header.remove();
		else if (kind === "scope") view.unbind();
		else if (kind === "jump") view.controller.jump();
		else view.host.dispatchEvent(new Event(kind, { bubbles: true }));
		await view.frame(16);
		assert.equal(view.controller.holdingHeader, false, kind);
		const anchorObservers = [...observers].filter((observer) =>
			[...observer.targets].some((target) => target.hasAttribute("data-turn-key")),
		);
		assert.equal(anchorObservers.length, 0, kind);
		view.unbind();
		view.controller.dispose();
	}
});
test("real disclosure restores only a prior bottom-follow intention after its passive window", async () => {
	for (const previous of [false, true])
		for (const stillNear of [false, true]) {
			const view = await mount({ near: true, previous });
			await view.click();
			// No compensating move is needed for this stable header; only body height changes.
			view.grow(-20.25);
			if (!stillNear) view.growEnd();
			await view.frame(350);
			assert.equal(view.controller.follows, previous && stillNear);
		}
});
