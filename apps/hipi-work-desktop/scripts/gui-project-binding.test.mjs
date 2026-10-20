import assert from "node:assert/strict";
import { realpathSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { chooseOwnedFileFolder } from "./gui-file-picker.mjs";
import { fileFixture, ownedFileDirectory } from "./gui-file-workbench-fixture.mjs";
import {
	assertBindingEvidence,
	bindingProjectIdentity,
	bindingProjectTitle,
	bindingReadOnlyBuffer,
} from "./gui-project-binding.mjs";

test("read-only binding proof needs one actual rendered named buffer with exact settled file lines", () => {
	const lines = fileFixture.external
		.split("\n")
		.map((textContent, index) => ({ textContent, getAttribute: () => String(index + 1) }));
	let editable = false;
	const shadow = { querySelector: () => (editable ? {} : null), querySelectorAll: () => lines };
	const hosts = [{ shadowRoot: shadow }];
	const tabs = [{ getAttribute: () => fileFixture.textName }];
	const document = {
		querySelectorAll: (selector) => (selector.includes("diffs-container") ? hosts : tabs),
		querySelector: () => ({ textContent: "Matches confirmed version Read only" }),
	};
	assert.equal(bindingReadOnlyBuffer(document, fileFixture.textName, fileFixture.external), true);
	editable = true;
	assert.equal(bindingReadOnlyBuffer(document, fileFixture.textName, fileFixture.external), false);
	editable = false;
	assert.equal(bindingReadOnlyBuffer(document, "other.txt", fileFixture.external), false);
	assert.equal(bindingReadOnlyBuffer(document, fileFixture.textName, "unrelated"), false);
	hosts.push(hosts[0]);
	assert.equal(bindingReadOnlyBuffer(document, fileFixture.textName, fileFixture.external), false);
	hosts.length = 0;
	assert.equal(bindingReadOnlyBuffer(document, fileFixture.textName, fileFixture.external), false);
});

test("new binding identity requires both original projects and exactly one selected, empty canonical addition", () => {
	const before = [fileFixture.workspaceId, fileFixture.otherWorkspaceId];
	const rows = [
		...before.map((id) => ({ id })),
		{ id: "native-created", title: bindingProjectTitle, current: true, conversations: 0 },
	];
	assert.equal(bindingProjectIdentity(rows, before), "native-created");
	for (const patch of [{ id: "" }, { id: before[0] }, { title: "other" }, { current: false }, { conversations: 1 }])
		assert.equal(bindingProjectIdentity([...rows.slice(0, 2), { ...rows[2], ...patch }], before), null);
	assert.equal(bindingProjectIdentity([...rows, { id: "unexpected" }], before), null);
	assert.equal(bindingProjectIdentity(rows.slice(1), before), null);
	assert.equal(bindingProjectIdentity([{ id: "replacement" }, ...rows.slice(1)], before), null);
});

test("binding completion requires actual cancellation, native selection, readonly restart and revocation on the same project", () => {
	const first = {
		workspaceId: "native-created",
		noModelGrant: "native_not_run; empty conversation UI is not authoritative grant evidence",
		cancelNoCreate: true,
		nativeChosen: true,
		readOnlyRoot: true,
		noConversationCreated: true,
		restoredOriginal: true,
	};
	const reopened = {
		workspaceId: first.workspaceId,
		noModelGrant: "native_not_run; empty conversation UI is not authoritative grant evidence",
		persistedWithoutPicker: true,
		readOnlyRoot: true,
		noConversationCreated: true,
		unbound: true,
		tabsRevoked: true,
	};
	assertBindingEvidence(first, reopened);
	for (const key of Object.keys(first).filter((key) => key !== "workspaceId"))
		assert.throws(() => assertBindingEvidence({ ...first, [key]: false }, reopened));
	for (const key of Object.keys(reopened).filter((key) => key !== "workspaceId"))
		assert.throws(() => assertBindingEvidence(first, { ...reopened, [key]: false }));
	assert.throws(() => assertBindingEvidence(first, { ...reopened, workspaceId: "replacement" }));
	for (const workspaceId of [fileFixture.workspaceId, fileFixture.otherWorkspaceId])
		assert.throws(() => assertBindingEvidence({ ...first, workspaceId }, { ...reopened, workspaceId }));
});

// Small original diagnostic XWD, not an actual native-chooser acceptance screenshot.
function diagnosticXwd() {
	const bytes = Buffer.alloc(105);
	const fields = [101, 7, 2, 24, 1, 1, 0, 0, 32, 0, 32, 32, 4, 4, 0xff0000, 0xff00, 0xff, 8, 256, 0, 1, 1, 0, 0, 0];
	for (const [index, value] of fields.entries()) bytes.writeUInt32BE(value, index * 4);
	return bytes;
}

test(
	"project Cancel sends one focused Escape, never types or clicks, and rejects foreign titles/focus",
	{ skip: process.platform !== "linux" },
	async () => {
		const root = realpathSync(await mkdtemp(join(realpathSync(tmpdir()), "Hipi GUI profile-")));
		try {
			await ownedFileDirectory(root, { create: true });
			for (const mismatch of [null, "title", "focus"]) {
				let closed = false;
				const inputs = [];
				const captures = [];
				const promise = chooseOwnedFileFolder(
					{ ownedProfileRoot: root, pid: 100, display: ":432", xvfbPid: 200, binary: "/owned/app" },
					{
						purpose: "project",
						action: "cancel",
						identity: async () => ({ app: "100", xvfb: "200" }),
						run: async (binary, args) => {
							if (binary === "xwd") return { stdout: diagnosticXwd() };
							assert.equal(binary, "xdotool");
							if (args[0] === "search") {
								assert.equal(args.at(-1), "^(Choose project folder|选择项目文件夹)$");
								if (closed) throw Object.assign(new Error("closed"), { code: 1 });
								return { stdout: "900\n" };
							}
							if (args[0] === "getwindowpid") return { stdout: "100\n" };
							if (args[0] === "getwindowname")
								return {
									stdout:
										mismatch === "title" ? "Allow Hipi Work to read and edit this folder\n" : "Choose project folder\n",
								};
							if (args[0] === "getwindowfocus") return { stdout: mismatch === "focus" ? "901\n" : "900\n" };
							if (["key", "type", "click", "mousemove"].includes(args[0])) {
								inputs.push(args);
								assert.deepEqual(args, ["key", "--clearmodifiers", "Escape"]);
								closed = true;
							}
							return { stdout: "" };
						},
						observe: async (stage) => captures.push(stage),
					},
				);
				if (mismatch) {
					await assert.rejects(promise);
					assert.deepEqual(inputs, []);
					assert.deepEqual(captures, []);
				} else {
					assert.equal((await promise).cancelled, true);
					assert.deepEqual(inputs, [["key", "--clearmodifiers", "Escape"]]);
					assert.deepEqual(captures, ["before-input"]);
				}
			}
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	},
);
