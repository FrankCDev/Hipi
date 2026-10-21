import assert from "node:assert/strict";
import { evaluate, until } from "../../gui-flow.mjs";
import { defaultRoleEntry } from "./manifest.mjs";

/** Fixture setup precedes a confirmed new document, never a page-initiated navigation. */
export async function seedSidebarDocument(cdp, seed, evidence, wait = until) {
	const entry = defaultRoleEntry(seed);
	const key = `hipi.work.local.v1.${seed.handshake.storeId}.value.default-chat-workspace`;
	const raw = JSON.stringify(entry);
	await cdp.request("Page.enable");
	const before = (await cdp.request("Page.getFrameTree")).frameTree.frame;
	assert.equal(before.url, "hipi-work://app/index.html");
	assert.ok(before.id && before.loaderId, "Fixture setup requires an identified application document");
	evidence.before = { frameId: before.id, loaderId: before.loaderId };
	const handshake = await evaluate(
		cdp,
		`window.hipiWorkDesktop.request(${JSON.stringify({ version: seed.handshake.protocolVersion, method: "handshake", params: {} })})`,
	);
	assert.equal(handshake?.ok, true);
	assert.deepEqual(handshake.result, seed.handshake, "Fixture writes require the exact seeded runtime");
	const { identifier } = await cdp.request("Page.addScriptToEvaluateOnNewDocument", {
		source: `if(window===window.top && location.href==='hipi-work://app/index.html'){localStorage.setItem(${JSON.stringify(key)},${JSON.stringify(raw)});}`,
	});
	assert.ok(identifier, "Fixture initialization script must have a removable identity");
	evidence.initializerRegistered = true;
	// The application intentionally denies page navigation. CDP owns this isolated
	// fixture lifecycle; do not relax the host guards or ask the page to reload itself.
	let failure;
	try {
		await cdp.request("Page.reload", { loaderId: before.loaderId });
		evidence.reloadRequested = true;
		await wait(async () => {
			const frame = (await cdp.request("Page.getFrameTree")).frameTree.frame;
			assert.equal(frame.url, before.url, "Fixture reload must remain on the application page");
			assert.equal(frame.id, before.id, "Fixture reload must retain the owned main frame");
			if (!frame.loaderId || frame.loaderId === before.loaderId) return false;
			evidence.after = { frameId: frame.id, loaderId: frame.loaderId };
			return true;
		}, "sidebar fixture new document with role initializer");
		await wait(
			() =>
				evaluate(
					cdp,
					`document.readyState==='complete' && localStorage.getItem(${JSON.stringify(key)})===${JSON.stringify(raw)} && !!document.querySelector('.navigation-list')`,
				),
			"sidebar fixture new document restores the seeded role",
		);
		evidence.documentReady = true;
	} catch (error) {
		failure = error;
	} finally {
		try {
			await cdp.request("Page.removeScriptToEvaluateOnNewDocument", { identifier });
			evidence.initializerRemoved = true;
		} catch (error) {
			evidence.initializerRemoved = false;
			failure ??= error;
		}
	}
	if (failure) throw failure;
}
