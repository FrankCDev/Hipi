import assert from "node:assert/strict";
import test from "node:test";
import { runInNewContext } from "node:vm";
import { click, waitForOverlayClosed } from "./gui-flow.mjs";
import {
	assertDisclosureContinuity,
	currentProject,
	projectCreationRecovered,
	projectCreationTrigger,
	projectSelector,
	projectViewportReady,
} from "./gui-project-disclosure.mjs";

test("project cancellation requires the exact opener and retained app owners without hidden workspace creation", () => {
	const trigger = { isConnected: true },
		conversation = {},
		composer = { value: "" };
	let count = 1;
	const document = {
		activeElement: trigger,
		querySelector: (selector) => (selector === ".conversation-panel" ? conversation : composer),
		querySelectorAll: () => Array.from({ length: count }, () => ({})),
	};
	const before = { trigger, conversation, composer, count: 1 };
	assert.equal(projectCreationRecovered(document, before), true);
	for (const field of ["trigger", "conversation", "composer"])
		assert.equal(projectCreationRecovered(document, { ...before, [field]: { ...before[field] } }), false);
	count = 2;
	assert.equal(projectCreationRecovered(document, before), false);
	count = 1;
	composer.value = "unexpected";
	assert.equal(projectCreationRecovered(document, before), false);
	composer.value = "";
	trigger.isConnected = false;
	assert.equal(projectCreationRecovered(document, before), false);
});

test("named project creation targets New project and restores that exact trigger after its dialog", async () => {
	const trigger = {
		disabled: false,
		getClientRects: () => [{}],
		scrollIntoView() {},
		getBoundingClientRect: () => ({ x: 10, y: 10, width: 30, height: 30 }),
		contains: (node) => node === trigger,
	};
	const document = {
		activeElement: trigger,
		querySelector: () => null,
		querySelectorAll: (selector) => {
			assert.equal(selector, '.nav-section-heading button[aria-label="New project"]');
			return [trigger];
		},
		elementFromPoint: () => trigger,
	};
	const events = [];
	const cdp = {
		async request(method, params) {
			if (method === "Runtime.evaluate")
				return {
					result: {
						value: await runInNewContext(params.expression, {
							document,
							location: { href: "hipi-work://app/index.html" },
							requestAnimationFrame: (callback) => callback(),
						}),
					},
				};
			events.push(params.type);
		},
	};
	await click(cdp, projectCreationTrigger);
	assert.deepEqual(events, ["mousePressed", "mouseReleased"]);
	await waitForOverlayClosed(cdp, projectCreationTrigger);
	document.activeElement = {};
	await assert.rejects(waitForOverlayClosed(cdp, projectCreationTrigger, undefined, 1), /focus restored: New project/);
});

test("current project distinguishes direct project navigation from a contained conversation and rejects ambiguity", () => {
	const branch = {
		dataset: { current: "false", containsCurrent: "true", workspaceId: "A" },
		querySelector: () => ({ textContent: "A" }),
	};
	let branches = [branch];
	const document = {
		querySelectorAll: (selector) => {
			assert.equal(selector, '.workspace-branch:is([data-current="true"],[data-contains-current="true"])');
			return branches;
		},
	};
	assert.equal(currentProject(document), "A");
	branch.dataset.current = "true";
	assert.equal(currentProject(document), null);
	branch.dataset.containsCurrent = "false";
	assert.equal(currentProject(document), "A");
	branches = [branch, branch];
	assert.equal(currentProject(document), null);
	branches = [];
	assert.equal(currentProject(document), null);
});

test("project resize waits for committed responsive mode and closed-drawer semantics, not just innerWidth", () => {
	const shell = { dataset: { navigationMode: "desktop", navigationOpen: "false", navigationCollapsed: "false" } };
	const sidebar = { inert: false };
	let expanded = "true";
	const document = {
		defaultView: { innerWidth: 640 },
		querySelector: (selector) =>
			({
				".work-shell": shell,
				".sidebar": sidebar,
				".navigation-toggle": { getAttribute: () => expanded },
			})[selector],
	};
	assert.equal(projectViewportReady(document, 640), false);
	shell.dataset.navigationMode = "narrow";
	assert.equal(projectViewportReady(document, 640), false);
	sidebar.inert = true;
	expanded = "false";
	assert.equal(projectViewportReady(document, 640), true);
	shell.dataset.navigationOpen = "true";
	assert.equal(projectViewportReady(document, 640), false);
	shell.dataset.navigationOpen = "false";
	document.defaultView.innerWidth = 1440;
	assert.equal(projectViewportReady(document, 1440), false);
	shell.dataset.navigationMode = "desktop";
	sidebar.inert = false;
	expanded = "true";
	assert.equal(projectViewportReady(document, 1440), true);
	shell.dataset.navigationCollapsed = "true";
	assert.equal(projectViewportReady(document, 1440), false);
});

test("project selector identifies exact names independently of selected or first project", () => {
	let names = ["B", "A"];
	const document = { querySelectorAll: () => names.map((textContent) => ({ querySelector: () => ({ textContent }) })) };
	assert.equal(projectSelector(document, "A"), ".workspace-tree > .workspace-branch:nth-child(2)");
	assert.equal(projectSelector(document, "missing"), null);
	names = ["A", "A"];
	assert.equal(projectSelector(document, "A"), null);
});

test("disclosure rejects selection, draft, message identity, mounted-node and drawer changes", () => {
	const expected = {
		selected: "A",
		draft: "keep",
		keys: ["message:user", "message:assistant"],
		navigationOpen: "true",
	};
	const valid = { ...expected, sameComposer: true, sameConversation: true };
	assert.doesNotThrow(() => assertDisclosureContinuity(valid, expected));
	for (const [key, value] of Object.entries({
		selected: "B",
		draft: "",
		keys: ["message:replayed"],
		navigationOpen: "false",
		sameComposer: false,
		sameConversation: false,
	})) {
		assert.throws(() => assertDisclosureContinuity({ ...valid, [key]: value }, expected));
	}
});
