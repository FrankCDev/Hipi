import assert from "node:assert/strict";
import test from "node:test";
import { runInNewContext } from "node:vm";
import { defaultRoleEntry } from "./manifest.mjs";
import { seedSidebarDocument } from "./startup-lifecycle.mjs";

const seed = {
	workspaceIds: ["sidebar-chats", "sidebar-project-a", "sidebar-project-b"],
	defaultWorkspaceId: "sidebar-chats",
	handshake: { storeId: "fixture-store", protocolVersion: 9 },
};
const url = "hipi-work://app/index.html";
const key = "hipi.work.local.v1.fixture-store.value.default-chat-workspace";
const raw = JSON.stringify(defaultRoleEntry(seed));

function fixture({ blocked = false, wrongStore = false, missingRole = false, reloadError, cleanupError } = {}) {
	const storage = new Map();
	let source;
	let frameReads = 0;
	let newDocument = false;
	let observedAtMount;
	const calls = [];
	const cdp = {
		request: async (method, params = {}) => {
			calls.push(method);
			if (method === "Page.enable") return {};
			if (method === "Page.getFrameTree") {
				frameReads++;
				return { frameTree: { frame: { id: "owned", loaderId: newDocument ? "new" : "old", url } } };
			}
			if (method === "Page.addScriptToEvaluateOnNewDocument") {
				assert.equal(storage.size, 0, "The old Workbench must never observe late injected role evidence");
				source = params.source;
				return { identifier: "fixture-initializer" };
			}
			if (method === "Page.reload") {
				assert.deepEqual(params, { loaderId: "old" });
				if (reloadError) throw reloadError;
				if (!blocked) {
					newDocument = true;
					const window = {};
					window.top = window;
					if (!missingRole)
						runInNewContext(source, {
							window,
							location: { href: url },
							localStorage: { setItem: (k, v) => storage.set(k, v) },
						});
					observedAtMount = storage.get(key);
				}
				return {};
			}
			if (method === "Page.removeScriptToEvaluateOnNewDocument") {
				assert.deepEqual(params, { identifier: "fixture-initializer" });
				if (cleanupError) throw cleanupError;
				return {};
			}
			assert.equal(method, "Runtime.evaluate");
			if (params.expression.includes('"method":"handshake"'))
				return {
					result: {
						value: { ok: true, result: wrongStore ? { ...seed.handshake, storeId: "other" } : seed.handshake },
					},
				};
			assert.ok(newDocument, "No old-document DOM can satisfy the startup condition");
			return { result: { value: storage.get(key) === raw } };
		},
	};
	return {
		cdp,
		calls,
		get source() {
			return source;
		},
		get observedAtMount() {
			return observedAtMount;
		},
		get frameReads() {
			return frameReads;
		},
	};
}
async function boundedWait(check, label) {
	for (let index = 0; index < 3; index++) if (await check()) return;
	throw new Error(`Timed out: ${label}`);
}

test("fixture seeds only the fresh document before Workbench can read the role", async () => {
	const f = fixture();
	const evidence = {};
	await seedSidebarDocument(f.cdp, seed, evidence, boundedWait);
	assert.equal(f.observedAtMount, raw);
	assert.deepEqual(evidence, {
		before: { frameId: "owned", loaderId: "old" },
		initializerRegistered: true,
		reloadRequested: true,
		after: { frameId: "owned", loaderId: "new" },
		documentReady: true,
		initializerRemoved: true,
	});
	assert.equal(f.calls.filter((method) => method === "Page.reload").length, 1);
	assert.equal(f.calls.at(-1), "Page.removeScriptToEvaluateOnNewDocument");
	for (const scope of ["subframe", "external"]) {
		const window = {};
		window.top = scope === "subframe" ? {} : window;
		runInNewContext(f.source, {
			window,
			location: { href: scope === "external" ? "https://example.com" : url },
			localStorage: { setItem: () => assert.fail("Initializer must not seed any other frame or URL") },
		});
	}
});

test("acknowledged reload with unchanged loader cannot qualify or retry", async () => {
	const f = fixture({ blocked: true });
	const evidence = {};
	await assert.rejects(seedSidebarDocument(f.cdp, seed, evidence, boundedWait), /new document with role initializer/);
	assert.equal(evidence.documentReady, undefined);
	assert.equal(evidence.initializerRemoved, true);
	assert.equal(f.calls.filter((method) => method === "Page.reload").length, 1);
	assert.equal(f.frameReads, 4);
});

test("new loader without restored role cannot qualify", async () => {
	const f = fixture({ missingRole: true });
	const evidence = {};
	await assert.rejects(seedSidebarDocument(f.cdp, seed, evidence, boundedWait), /restores the seeded role/);
	assert.equal(evidence.documentReady, undefined);
	assert.equal(evidence.initializerRemoved, true);
});

test("wrong store stops before initializer installation or reload", async () => {
	const f = fixture({ wrongStore: true });
	await assert.rejects(seedSidebarDocument(f.cdp, seed, {}, boundedWait), /exact seeded runtime/);
	assert.equal(f.calls.includes("Page.reload"), false);
	assert.equal(f.calls.includes("Page.addScriptToEvaluateOnNewDocument"), false);
});

test("reload failure still removes initializer and retains original error if cleanup also fails", async () => {
	for (const cleanupError of [undefined, new Error("cleanup")]) {
		const original = new Error("reload");
		const f = fixture({ reloadError: original, cleanupError });
		const evidence = {};
		await assert.rejects(seedSidebarDocument(f.cdp, seed, evidence, boundedWait), (error) => error === original);
		assert.equal(f.calls.at(-1), "Page.removeScriptToEvaluateOnNewDocument");
		assert.equal(evidence.initializerRemoved, !cleanupError);
	}
});
