import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { runInNewContext } from "node:vm";
import { transformSync } from "esbuild";
import { developmentSelfNavigation } from "../../src/development/navigation.ts";

const page = `http://127.0.0.1:5173/?desktop=${"a".repeat(64)}`;
const frame = { url: page };
const owner = { isDestroyed: () => false, mainFrame: frame };
const event = { url: page, isMainFrame: true, isSameDocument: false, frame, initiator: frame };
const main = readFileSync(new URL("../../src/main.ts", import.meta.url), "utf8");

test("only live unpackaged owned-main-frame exact-page self-navigation is permitted", () => {
	assert.equal(developmentSelfNavigation(event, owner, page, false), true);
	for (const changed of [
		{ isMainFrame: false },
		{ isSameDocument: true },
		{ frame: null },
		{ frame: undefined },
		{ frame: { url: page } },
		{ initiator: null },
		{ initiator: undefined },
		{ initiator: { url: page } },
	])
		assert.equal(developmentSelfNavigation({ ...event, ...changed }, owner, page, false), false);
	assert.equal(developmentSelfNavigation(event, owner, page, true), false);
	assert.equal(developmentSelfNavigation(event, owner, undefined, false), false);
	assert.equal(developmentSelfNavigation(event, { ...owner, isDestroyed: () => true }, page, false), false);
	assert.equal(developmentSelfNavigation(event, { ...owner, mainFrame: { url: page } }, page, false), false);
});

test("both current and destination URL must equal the launch-owned tokenized page byte for byte", () => {
	for (const url of [
		page.replace("a".repeat(64), "b".repeat(64)),
		page.replace("/?", "/index.html?"),
		`${page}#fragment`,
		page.replace("5173", "5174"),
		page.replace("127.0.0.1", "localhost"),
		"http://127.0.0.1:5173/",
		"https://example.com/",
	]) {
		assert.equal(developmentSelfNavigation({ ...event, url }, owner, page, false), false, url);
		const changedFrame = { url };
		assert.equal(
			developmentSelfNavigation(
				{ ...event, frame: changedFrame, initiator: changedFrame },
				{ ...owner, mainFrame: changedFrame },
				page,
				false,
			),
			false,
			url,
		);
	}
});

test("detached Electron frame getters fail closed", () => {
	assert.equal(
		developmentSelfNavigation(
			event,
			{
				isDestroyed: () => false,
				get mainFrame(): { url: string } {
					throw new Error("Frame detached");
				},
			},
			page,
			false,
		),
		false,
	);
});

test("both real main guards enforce the compile gate, packaged guard and exact frame policy", () => {
	const start = main.indexOf("\tconst navigationGuard =");
	const end = main.indexOf('\towner.on("will-attach-webview"', start);
	assert.ok(start >= 0 && end > start);
	for (const enabled of [false, true]) {
		for (const isPackaged of [false, true]) {
			const handlers = new Map<string, (input: typeof event & { preventDefault(): void }) => void>();
			runInNewContext(transformSync(main.slice(start, end), { loader: "ts" }).code, {
				HIPI_DESKTOP_DEV: enabled,
				development: { page },
				developmentSelfNavigation,
				app: { isPackaged },
				owner: { ...owner, on: (name: string, handler: (input: typeof event) => void) => handlers.set(name, handler) },
			});
			assert.deepEqual([...handlers.keys()], ["will-navigate", "will-frame-navigate"]);
			for (const handler of handlers.values()) {
				for (const input of [event, { ...event, url: `${page}#other` }, { ...event, isMainFrame: false }]) {
					let prevented = false;
					handler({
						...input,
						preventDefault: () => {
							prevented = true;
						},
					});
					assert.equal(prevented, !(enabled && !isPackaged && input === event));
				}
			}
		}
	}
});

test("real dirty-unload handler still defaults to keeping work and only explicit discard overrides it", () => {
	const start = main.indexOf('\towner.on("will-prevent-unload"');
	const end = main.indexOf("\tconst lifecycle = new WindowLifecycle", start);
	assert.ok(start >= 0 && end > start);
	for (const choice of [0, 1, -1]) {
		let prevented = false;
		runInNewContext(main.slice(start, end), {
			owner: {
				on: (_name: string, handler: (input: { preventDefault(): void }) => void) =>
					handler({
						preventDefault: () => {
							prevented = true;
						},
					}),
			},
			window: {},
			text: {},
			dialog: {
				showMessageBoxSync: (_window: unknown, options: { defaultId: number; cancelId: number }) => {
					assert.equal(options.defaultId, 1);
					assert.equal(options.cancelId, 1);
					return choice;
				},
			},
		});
		assert.equal(prevented, choice === 0);
	}
});
