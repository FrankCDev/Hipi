import assert from "node:assert/strict";
import { realpathSync } from "node:fs";
import { mkdir, mkdtemp, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { crc32, inflateSync } from "node:zlib";
import { createFileAuthority } from "@hipi/work-runtime/files/node";
import { createRuntimePreviewHost } from "@hipi/work-runtime/previews/host";
import { createPreviewClient } from "@hipi/work-runtime/previews/protocol";
import { smokeProfile } from "../src/smoke-profile.ts";
import { chooseOwnedFileFolder } from "./gui-file-picker.mjs";
import { maxPickerImageBytes, pickerOpenTarget, pickerXwdToPng } from "./gui-file-picker-image.mjs";
import { createPreviewFixtureFiles, previewFixture } from "./gui-file-preview-fixtures.mjs";
import { assertPdfPaint, documentPreviewState, pdfPreviewPaint } from "./gui-file-previews.mjs";
import {
	assertFileWorkbenchLayout,
	dispatchFileDrag,
	fileCodePresentation,
	fileDragPlan,
	fileShadowTarget,
	fileSplitNodes,
	fileSplitterGeometry,
	fileTreeListing,
	fileWorkbenchState,
	validateFileWorkbenchEvidence,
} from "./gui-file-workbench.mjs";
import {
	changeOwnedFixture,
	fileFixture,
	ownedFileDirectory,
	readOwnedFixture,
	seedFileWorkbench,
	verifyColdFileWorkbench,
} from "./gui-file-workbench-fixture.mjs";
import { filePanelCleanupState } from "./gui-work-experience.mjs";
import { assertScenarioWorkspaceDatabases } from "./smoke-packaged-gui.mjs";

async function profile() {
	return realpathSync(await mkdtemp(join(realpathSync(tmpdir()), "Hipi GUI profile-")));
}

test("seeded file fixture passes the real native launch boundary without expanding its root allowlist", async () => {
	const root = await profile();
	try {
		await seedFileWorkbench({ ownedProfileRoot: root, assertAllOwnedProcessesExited: async () => {} });
		// Seed stage has only A/B. The third project must come from the actual native Create journey.
		assert.deepEqual(
			(await readdir(join(root, "profile", "deterministic-store"), { withFileTypes: true }))
				.filter((entry) => entry.isDirectory())
				.map((entry) => entry.name)
				.sort(),
			[fileFixture.workspaceId, fileFixture.otherWorkspaceId].sort(),
		);
		await assert.rejects(
			assertScenarioWorkspaceDatabases(join(root, "profile", "deterministic-store"), "file-workbench"),
			/workspace count/,
		);
		const args = [`--smoke-data-root=${root}`];
		const paths = smokeProfile(args, "deterministic");
		assert.equal(await ownedFileDirectory(root), join(paths.userData, fileFixture.folder));
		assert.equal((await readOwnedFixture(root)).toString("utf8"), fileFixture.initial);
		assert.deepEqual(smokeProfile(args, "deterministic"), paths, "Cold reopen must accept the same seeded profile");
		await mkdir(join(root, fileFixture.folder));
		assert.throws(() => smokeProfile(args, "deterministic"), /Unexpected smoke profile contents/);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("synthetic fixture exercises real file CAS and all preview transports without model or grant bypass", async () => {
	const root = await profile();
	let authority;
	let previews;
	try {
		let processChecks = 0;
		const seed = await seedFileWorkbench({
			ownedProfileRoot: root,
			assertAllOwnedProcessesExited: async () => {
				processChecks++;
			},
		});
		assert.equal(processChecks, 1);
		assert.equal(seed.grantsPreseeded, false);
		assert.equal(seed.otherWorkspaceId, fileFixture.otherWorkspaceId);
		assert.ok(!JSON.stringify(seed).includes(root), "Evidence must not serialize private absolute paths");
		authority = createFileAuthority({
			securityMode: "cooperative-local-files",
			async assertWorkspaceAccess(principal, workspaceId) {
				assert.equal(principal, "test-owner");
				assert.equal(workspaceId, fileFixture.workspaceId);
			},
		});
		const files = authority.forPrincipal("test-owner");
		assert.deepEqual(await files.listRoots(fileFixture.workspaceId), []);
		const granted = await authority.grantRoot({
			principalId: "test-owner",
			workspaceId: fileFixture.workspaceId,
			absolutePath: await ownedFileDirectory(root),
			writable: true,
		});
		const target = { workspaceId: fileFixture.workspaceId, rootId: granted.rootId, path: fileFixture.textName };
		const initial = await files.readText(target);
		assert.equal(initial.text, fileFixture.initial);
		const saved = await files.saveText(target, fileFixture.saved, initial.revision);
		const secondTarget = { ...target, path: fileFixture.secondName };
		const secondInitial = await files.readText(secondTarget);
		assert.equal(secondInitial.text, fileFixture.secondInitial);
		const secondSaved = await files.saveText(secondTarget, fileFixture.secondSaved, secondInitial.revision);
		await files.saveText(secondTarget, fileFixture.secondClosed, secondSaved.revision);
		assert.equal((await readOwnedFixture(root)).toString("utf8"), fileFixture.saved);
		await changeOwnedFixture(root);
		await assert.rejects(files.saveText(target, fileFixture.draft, saved.revision), { code: "VERSION_CONFLICT" });
		assert.equal((await readOwnedFixture(root)).toString("utf8"), fileFixture.external);
		previews = createRuntimePreviewHost({ authority, principalId: "test-owner", storeId: "file-test-store" });
		const client = createPreviewClient({
			storeId: "file-test-store",
			request: (request, signal) => previews.handler.execute(request, signal),
		});
		const csv = await client.open({ ...target, path: fileFixture.csvName });
		const page = await client.readPage(csv.id, 0);
		assert.equal(page.content.kind, "spreadsheet");
		assert.deepEqual(
			page.content.sheets[0].rows.map((row) => row.map((cell) => cell.display)),
			[
				["label", "value"],
				["中文", "42"],
				["fixture", "read-only"],
			],
		);
		await client.close(csv.id);
		const docx = await client.open({ ...target, path: previewFixture.docxName });
		const word = await client.readPage(docx.id, 0);
		assert.equal(word.content.kind, "document");
		assert.equal(word.content.text, previewFixture.docxText);
		assert.deepEqual(word.content.limitations, ["plain-text-only", "layout-images-and-embedded-content-omitted"]);
		await client.close(docx.id);
		const xlsx = await client.open({ ...target, path: previewFixture.xlsxName });
		assert.equal(xlsx.summary.pages, 2);
		const first = await client.readPage(xlsx.id, 0);
		assert.equal(first.content.sheets[0].name, previewFixture.sheetName);
		assert.deepEqual(
			first.content.sheets[0].rows.map((row) => row.map((cell) => cell.display)),
			[
				["label", "value"],
				["中文", "42"],
				["cached formula", "999"],
			],
		);
		assert.equal(first.content.sheets[0].rows[2][1].value, 999, "Saved formula value must not be recalculated");
		const second = await client.readPage(xlsx.id, 1);
		assert.equal(second.content.sheets[0].name, previewFixture.secondSheetName);
		assert.deepEqual(
			second.content.sheets[0].rows.map((row) => row.map((cell) => cell.display)),
			[
				["second", "page"],
				["fixture", "unchanged"],
			],
		);
		assert.deepEqual(await client.readPage(xlsx.id, 0), first);
		await client.close(xlsx.id);
		const pdf = await client.open({ ...target, path: previewFixture.pdfName });
		assert.equal(pdf.kind, "pdf");
		assert.equal(pdf.summary.pages, 0, "PDF.js discovers pages in the renderer; transport is not render evidence");
		assert.deepEqual(
			Buffer.from((await client.readBytes(pdf.id, 0)).base64, "base64"),
			await readOwnedFixture(root, previewFixture.pdfName),
		);
		await client.close(pdf.id);
		await assert.rejects(client.open({ ...target, path: previewFixture.unsupportedName }), {
			code: "BLOCKED_RESOURCE",
		});
		// A denied preview must not poison subsequent supported preview operations.
		const image = await client.open({ ...target, path: fileFixture.imageName });
		assert.equal(image.kind, "png");
		assert.deepEqual(
			Buffer.from((await client.readBytes(image.id, 0)).base64, "base64"),
			await readOwnedFixture(root, fileFixture.imageName),
		);
		await client.close(image.id);
		authority.revokeRoot(granted.rootId);
		await assert.rejects(files.readText(target), { code: "UNAUTHORIZED" });
		const cold = await verifyColdFileWorkbench({
			ownedProfileRoot: root,
			gui: {
				conflictDraftPreserved: true,
				savedBytesVerified: true,
				backgroundAutosave: true,
				conditionalCloseSaved: true,
			},
			assertAllOwnedProcessesExited: async () => {
				processChecks++;
			},
		});
		assert.equal(cold.externalEditPreserved, true);
		assert.equal(processChecks, 2);
	} finally {
		await previews?.close();
		await authority?.close();
		await rm(root, { recursive: true, force: true });
	}
});

test("fixture rejects foreign roots, duplicate seed and unexpected prior content", async () => {
	const root = await profile();
	try {
		await assert.rejects(ownedFileDirectory(tmpdir()), /temporary child|profile/);
		const directory = await ownedFileDirectory(root, { create: true });
		await assert.rejects(ownedFileDirectory(root, { create: true }), { code: "EEXIST" });
		await writeFile(join(directory, fileFixture.textName), "unrelated owned content");
		await assert.rejects(changeOwnedFixture(root));
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("fixture rejects a redirected userData parent before creating any synthetic files", async () => {
	const root = await profile();
	const target = await profile();
	try {
		await symlink(target, join(root, "profile"), process.platform === "win32" ? "junction" : "dir");
		await assert.rejects(ownedFileDirectory(root, { create: true }), /escaped owned profile/);
		assert.deepEqual(await readdir(target), []);
	} finally {
		await rm(root, { recursive: true, force: true });
		await rm(target, { recursive: true, force: true });
	}
});

test(
	"fixture rejects symlink resources without needing privileged Windows symlink setup",
	{ skip: process.platform === "win32" },
	async () => {
		const root = await profile();
		try {
			const directory = await ownedFileDirectory(root, { create: true });
			const source = join(root, "source");
			await writeFile(source, fileFixture.saved);
			await symlink(source, join(directory, fileFixture.textName));
			await assert.rejects(readOwnedFixture(root));
			await assert.rejects(changeOwnedFixture(root));
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	},
);

async function pickerHarness(run, identity = async () => ({ app: "100", xvfb: "200" }), options = {}) {
	const { rawNative = false, ...pickerOptions } = options;
	const ownedProfileRoot = await profile();
	await ownedFileDirectory(ownedProfileRoot, { create: true });
	let clock = 0;
	try {
		return await chooseOwnedFileFolder(
			{ ownedProfileRoot, pid: 100, xvfbPid: 200, display: ":432", binary: "/owned/app" },
			{
				run: (binary, args, commandOptions) => {
					if (!rawNative && (binary === "xwd" || ["getwindowgeometry", "getmouselocation"].includes(args[0])))
						return pickerNativeReply(binary, args);
					return run(binary, args, commandOptions);
				},
				identity,
				pause: async (ms) => {
					clock += ms;
				},
				now: () => clock,
				...pickerOptions,
			},
		);
	} finally {
		await rm(ownedProfileRoot, { recursive: true, force: true });
	}
}

function syntheticXwd(order = 0, colors = 0) {
	const name = Buffer.from("Synthetic chooser\0");
	const header = 100 + name.length;
	const bytes = Buffer.alloc(header + colors * 12 + 8);
	const fields = [
		header,
		7,
		2,
		24,
		2,
		1,
		0,
		order,
		32,
		order,
		32,
		32,
		8,
		4,
		0xff0000,
		0xff00,
		0xff,
		8,
		256,
		colors,
		2,
		1,
		0,
		0,
		0,
	];
	for (const [index, value] of fields.entries()) bytes.writeUInt32BE(value, index * 4);
	name.copy(bytes, 100);
	for (const [index, pixel] of [0xff0000, 0x00ff00].entries()) {
		const offset = header + colors * 12 + index * 4;
		if (order === 0) bytes.writeUInt32LE(pixel, offset);
		else bytes.writeUInt32BE(pixel, offset);
	}
	return bytes;
}

function syntheticChooserXwd() {
	const source = syntheticXwd();
	const header = source.readUInt32BE(0);
	const bytes = Buffer.alloc(header + 1124 * 822 * 4, 255);
	source.copy(bytes, 0, 0, header);
	for (const [field, value] of [
		[4, 1124],
		[5, 822],
		[12, 1124 * 4],
		[20, 1124],
		[21, 822],
	])
		bytes.writeUInt32BE(value, field * 4);
	// Synthetic plain field plus the four observed border-color strips. No copied screenshot.
	for (const [left, top, right, bottom, color] of [
		[1040, 782, 1110, 783, 0xcdc7c2],
		[1040, 815, 1110, 816, 0xbfb8b1],
		[1032, 790, 1033, 808, 0xcdc7c2],
		[1117, 790, 1118, 808, 0xcdc7c2],
	])
		for (let y = top; y < bottom; y++)
			for (let x = left; x < right; x++) bytes.writeUInt32LE(color, header + (y * 1124 + x) * 4);
	return bytes;
}

function pickerNativeReply(binary, args) {
	if (binary === "xwd") return { stdout: syntheticChooserXwd() };
	if (args[0] === "getwindowgeometry") return { stdout: "WINDOW=900\nX=10\nY=20\nWIDTH=1124\nHEIGHT=822\nSCREEN=0\n" };
	if (args[0] === "getmouselocation") return { stdout: "X=1085\nY=819\nSCREEN=0\nWINDOW=900\n" };
	return { stdout: "" };
}

test("native Open target requires reviewed dimensions and border pixels but ignores text and caret", () => {
	const bytes = syntheticChooserXwd();
	assert.deepEqual(pickerOpenTarget(bytes), { x: 1075, y: 799, width: 1124, height: 822 });
	const header = bytes.readUInt32BE(0);
	bytes.writeUInt32LE(0, header + (799 * 1124 + 1075) * 4);
	assert.equal(pickerOpenTarget(bytes).x, 1075, "Text/highlight center is excluded from the fingerprint");
	bytes.writeUInt32LE(0, header + (782 * 1124 + 1040) * 4);
	assert.throws(() => pickerOpenTarget(bytes), /Open-button presentation/);
	assert.throws(() => pickerOpenTarget(syntheticXwd()), /chooser width/);
	const bordered = syntheticChooserXwd();
	bordered.writeUInt32BE(1, 24 * 4);
	assert.throws(() => pickerOpenTarget(bordered), /coordinate translation/);
});

test("native chooser diagnostic PNG preserves exact bounded XWD pixels without window metadata", () => {
	for (const order of [0, 1])
		for (const colors of [0, 256]) {
			const png = pickerXwdToPng(syntheticXwd(order, colors));
			assert.deepEqual([...png.subarray(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10]);
			assert.ok(!png.includes(Buffer.from("Synthetic chooser")));
			const chunks = [];
			for (let offset = 8; offset < png.length; ) {
				const length = png.readUInt32BE(offset);
				const type = png.toString("ascii", offset + 4, offset + 8);
				const data = png.subarray(offset + 8, offset + 8 + length);
				assert.equal(png.readUInt32BE(offset + 8 + length), crc32(png.subarray(offset + 4, offset + 8 + length)));
				chunks.push(type);
				if (type === "IHDR") assert.deepEqual([...data], [0, 0, 0, 2, 0, 0, 0, 1, 8, 2, 0, 0, 0]);
				if (type === "IDAT") assert.deepEqual([...inflateSync(data)], [0, 255, 0, 0, 0, 255, 0]);
				offset += 12 + length;
			}
			assert.deepEqual(chunks, ["IHDR", "IDAT", "IEND"]);
		}
});

test("native chooser encoder rejects unsupported headers, dimensions, masks and truncated or excess data", () => {
	for (const [index, value] of [
		[0, 99],
		[0, 4097],
		[1, 8],
		[2, 1],
		[3, 32],
		[4, 0],
		[4, 1601],
		[5, 0],
		[5, 1001],
		[6, 1],
		[7, 2],
		[8, 8],
		[9, 2],
		[10, 8],
		[11, 24],
		[12, 4],
		[13, 5],
		[14, 255],
		[15, 255],
		[16, 0xff00],
		[17, 16],
		[18, 257],
		[19, 257],
		[20, 3],
		[21, 2],
	]) {
		const bytes = syntheticXwd();
		bytes.writeUInt32BE(value, index * 4);
		assert.throws(() => pickerXwdToPng(bytes), `Reject unsupported header field ${index}`);
	}
	const unterminated = syntheticXwd();
	unterminated[unterminated.readUInt32BE(0) - 1] = 65;
	for (const bytes of [
		unterminated,
		Buffer.alloc(99),
		Buffer.alloc(maxPickerImageBytes + 1),
		syntheticXwd().subarray(0, -1),
		Buffer.concat([syntheticXwd(), Buffer.of(0)]),
	])
		assert.throws(() => pickerXwdToPng(bytes));
});

test(
	"native chooser capture uses only the revalidated focused window and retains all three bounded stages",
	{ skip: process.platform !== "linux" },
	async () => {
		const calls = [];
		const observations = [];
		let inputs = 0;
		await assert.rejects(
			pickerHarness(
				async (binary, args, options) => {
					assert.deepEqual(Object.keys(options.env).sort(), ["DISPLAY", "PATH"]);
					assert.equal(options.env.DISPLAY, ":432");
					assert.equal(options.shell, undefined);
					if (binary === "xwd") {
						assert.deepEqual(args, ["-silent", "-nobdrs", "-id", "900"]);
						assert.equal(options.maxBuffer, maxPickerImageBytes);
						assert.equal(options.timeout, 5000);
						assert.equal(options.encoding, "buffer");
						assert.deepEqual(calls.slice(-4), ["search", "getwindowpid", "getwindowname", "getwindowfocus"]);
						return { stdout: syntheticChooserXwd() };
					}
					assert.equal(binary, "xdotool");
					calls.push(args[0]);
					if (args[0] === "search" || args[0] === "getwindowfocus") return { stdout: "900\n" };
					if (args[0] === "getwindowpid") return { stdout: "100\n" };
					if (args[0] === "getwindowname") return { stdout: "Allow Hipi Work to read and edit this folder\n" };
					if (["key", "type", "mousemove", "click"].includes(args[0])) inputs++;
					return pickerNativeReply(binary, args);
				},
				undefined,
				{
					rawNative: true,
					observe: async (stage, png) => {
						assert.deepEqual(png, pickerXwdToPng(syntheticChooserXwd()));
						observations.push([stage, inputs]);
					},
				},
			),
			/Native folder picker did not close after single reviewed Open activation/,
		);
		assert.deepEqual(observations, [
			["before-input", 0],
			["after-type", 3],
			["bounded-failure", 5],
		]);
	},
);

test(
	"native chooser capture rejects changed PID, title, focus or session without capture or input",
	{ skip: process.platform !== "linux" },
	async () => {
		for (const failure of ["pid", "title", "focus", "session", "changed-after-capture"]) {
			let captures = 0;
			let observations = 0;
			let focusChecked = false;
			let inputs = 0;
			await assert.rejects(
				pickerHarness(
					async (binary, args) => {
						if (binary === "xwd") {
							captures++;
							return { stdout: syntheticXwd() };
						}
						if (["key", "type"].includes(args[0])) inputs++;
						if (args[0] === "search") return { stdout: "900\n" };
						if (args[0] === "getwindowpid") return { stdout: failure === "pid" ? "101\n" : "100\n" };
						if (args[0] === "getwindowname")
							return { stdout: failure === "title" ? "Unrelated\n" : "Allow Hipi Work to read and edit this folder\n" };
						if (args[0] === "getwindowfocus") {
							focusChecked = true;
							return { stdout: failure === "focus" || captures > 0 ? "901\n" : "900\n" };
						}
						return { stdout: "" };
					},
					async () => ({ app: failure === "session" && focusChecked ? "101" : "100", xvfb: "200" }),
					{
						rawNative: true,
						observe: async () => {
							observations++;
						},
					},
				),
			);
			assert.equal(captures, failure === "changed-after-capture" ? 1 : 0);
			assert.equal(observations, 0);
			assert.equal(inputs, 0);
		}
	},
);

test(
	"native candidate targets only exact owned picker and types only the validated fixture path",
	{ skip: process.platform !== "linux" },
	async () => {
		const calls = [];
		let closed = false;
		const result = await pickerHarness(async (binary, args, options) => {
			assert.equal(binary, "xdotool");
			assert.equal(options.env.DISPLAY, ":432");
			assert.deepEqual(Object.keys(options.env).sort(), ["DISPLAY", "PATH"]);
			assert.equal(options.shell, undefined);
			calls.push(args);
			if (args[0] === "search") {
				assert.ok(args.includes("--all"), "PID and title must both match, not either one");
				if (closed) throw Object.assign(new Error("no match"), { code: 1 });
				return { stdout: "900\n" };
			}
			if (args[0] === "getwindowpid") return { stdout: "100\n" };
			if (args[0] === "getwindowname") return { stdout: "Allow Hipi Work to read and edit this folder\n" };
			if (args[0] === "getwindowfocus") return { stdout: "900\n" };
			if (["key", "type", "mousemove", "click"].includes(args[0])) {
				if (args[0] !== "mousemove")
					assert.ok(!args.includes("--window"), "Use focused XTEST, not GTK-rejected XSendEvent");
				assert.deepEqual(
					calls.slice(-5, -1).map((call) => call[0]),
					["search", "getwindowpid", "getwindowname", "getwindowfocus"],
					"Revalidate the exact native target and focus immediately before every input",
				);
			}
			if (args[0] === "type") {
				assert.match(args.at(-1), /Hipi GUI profile-[A-Za-z0-9]+\/profile\/workbench-files$/);
			}
			if (args[0] === "mousemove") assert.deepEqual(args, ["mousemove", "--sync", "--window", "900", "1075", "799"]);
			if (args[0] === "click") {
				assert.deepEqual(args, ["click", "--clearmodifiers", "1"]);
				closed = true;
			}
			return { stdout: "" };
		});
		assert.equal(result.nativePicker, true);
		assert.equal(calls.filter((args) => args[0] === "type").length, 1);
		assert.equal(calls.filter((args) => args.at(-1) === "Return").length, 0);
		assert.equal(calls.filter((args) => args[0] === "click").length, 1);
	},
);

test(
	"native candidate stops on PID, title or focus change before every keyboard or pointer input",
	{ skip: process.platform !== "linux" },
	async () => {
		for (const mismatch of ["pid", "title", "focus"]) {
			for (const completedInputs of [0, 1, 2, 3, 4]) {
				let inputs = 0;
				await assert.rejects(
					pickerHarness(async (_binary, args) => {
						const changed = inputs >= completedInputs;
						if (args[0] === "search") return { stdout: "900\n" };
						if (args[0] === "getwindowpid") return { stdout: mismatch === "pid" && changed ? "101\n" : "100\n" };
						if (args[0] === "getwindowname")
							return {
								stdout:
									mismatch === "title" && changed
										? "Unrelated window\n"
										: "Allow Hipi Work to read and edit this folder\n",
							};
						if (args[0] === "getwindowfocus") return { stdout: mismatch === "focus" && changed ? "901\n" : "900\n" };
						if (["key", "type", "mousemove", "click"].includes(args[0])) inputs++;
						return { stdout: "" };
					}),
				);
				assert.equal(inputs, completedInputs, "Never input into another window or refocus after losing the picker");
			}
		}
	},
);

test(
	"native candidate allows exactly one Open click and no Return fallback when the picker stays open",
	{ skip: process.platform !== "linux" },
	async () => {
		let confirmations = 0;
		await assert.rejects(
			pickerHarness(async (_binary, args) => {
				if (args[0] === "search" || args[0] === "getwindowfocus") return { stdout: "900\n" };
				if (args[0] === "getwindowpid") return { stdout: "100\n" };
				if (args[0] === "getwindowname") return { stdout: "Allow Hipi Work to read and edit this folder\n" };
				assert.notEqual(args.at(-1), "Return");
				if (args[0] === "click") confirmations++;
				return { stdout: "" };
			}),
			/Native folder picker did not close after single reviewed Open activation/,
		);
		assert.equal(confirmations, 1);
	},
);

test(
	"native Open refuses geometry, border or translated pointer mismatch without clicking",
	{ skip: process.platform !== "linux" },
	async () => {
		for (const mismatch of [
			"width",
			"height",
			"screen",
			"outside",
			"duplicate",
			"malformed",
			"moved",
			"pointer-window",
			"pointer-position",
			"border",
		]) {
			let geometries = 0;
			let moves = 0;
			let clicks = 0;
			await assert.rejects(
				pickerHarness(
					async (binary, args) => {
						if (binary === "xwd") {
							const bytes = syntheticChooserXwd();
							if (mismatch === "border") bytes.writeUInt32LE(0, bytes.readUInt32BE(0) + (782 * 1124 + 1040) * 4);
							return { stdout: bytes };
						}
						if (args[0] === "search" || args[0] === "getwindowfocus") return { stdout: "900\n" };
						if (args[0] === "getwindowpid") return { stdout: "100\n" };
						if (args[0] === "getwindowname") return { stdout: "Allow Hipi Work to read and edit this folder\n" };
						if (args[0] === "mousemove") moves++;
						if (args[0] === "click") clicks++;
						let { stdout } = pickerNativeReply(binary, args);
						if (args[0] === "getwindowgeometry") {
							geometries++;
							if (mismatch === "width") stdout = stdout.replace("WIDTH=1124", "WIDTH=1125");
							if (mismatch === "height") stdout = stdout.replace("HEIGHT=822", "HEIGHT=823");
							if (mismatch === "screen") stdout = stdout.replace("SCREEN=0", "SCREEN=1");
							if (mismatch === "outside") stdout = stdout.replace("X=10", "X=1000");
							if (mismatch === "duplicate") stdout += "WINDOW=900\n";
							if (mismatch === "malformed") stdout += "COMMAND=unexpected\n";
							if (mismatch === "moved" && geometries === 2) stdout = stdout.replace("X=10", "X=11");
						}
						if (args[0] === "getmouselocation") {
							if (mismatch === "pointer-window") stdout = stdout.replace("WINDOW=900", "WINDOW=901");
							if (mismatch === "pointer-position") stdout = stdout.replace("X=1085", "X=1075");
						}
						return { stdout };
					},
					undefined,
					{ rawNative: true },
				),
			);
			assert.equal(moves, ["moved", "pointer-window", "pointer-position"].includes(mismatch) ? 1 : 0, mismatch);
			assert.equal(clicks, 0, mismatch);
		}
	},
);

test(
	"native Open rechecks app and Xvfb identity after the successful pointer probe",
	{ skip: process.platform !== "linux" },
	async () => {
		for (const changed of ["app", "xvfb"]) {
			let pointerChecked = false;
			let clicks = 0;
			await assert.rejects(
				pickerHarness(
					async (binary, args) => {
						if (args[0] === "search" || args[0] === "getwindowfocus") return { stdout: "900\n" };
						if (args[0] === "getwindowpid") return { stdout: "100\n" };
						if (args[0] === "getwindowname") return { stdout: "Allow Hipi Work to read and edit this folder\n" };
						if (args[0] === "getmouselocation") pointerChecked = true;
						if (args[0] === "click") clicks++;
						return pickerNativeReply(binary, args);
					},
					async () => ({
						app: pointerChecked && changed === "app" ? "101" : "100",
						xvfb: pointerChecked && changed === "xvfb" ? "201" : "200",
					}),
					{ rawNative: true },
				),
				/Owned native session changed/,
			);
			assert.equal(pointerChecked, true);
			assert.equal(clicks, 0);
		}
	},
);

test(
	"native candidate fails closed on ambiguity, wrong PID/title/focus or changing session",
	{ skip: process.platform !== "linux" },
	async () => {
		for (const failure of ["ambiguous", "pid", "title", "focus", "session"]) {
			let identities = 0;
			let typed = false;
			await assert.rejects(
				pickerHarness(
					async (_binary, args) => {
						if (args[0] === "type") typed = true;
						if (args[0] === "search") return { stdout: failure === "ambiguous" ? "900\n901\n" : "900\n" };
						if (args[0] === "getwindowpid") return { stdout: failure === "pid" ? "101\n" : "100\n" };
						if (args[0] === "getwindowname")
							return {
								stdout:
									failure === "title" ? "Unrelated application\n" : "Allow Hipi Work to read and edit this folder\n",
							};
						if (args[0] === "getwindowfocus") return { stdout: failure === "focus" ? "901\n" : "900\n" };
						return { stdout: "" };
					},
					async () => ({ app: failure === "session" && ++identities > 1 ? "999" : "100", xvfb: "200" }),
				),
			);
			assert.equal(typed, false, `Input must not occur after ${failure} mismatch`);
		}
	},
);

test(
	"missing picker has a bounded deadline, no fallback desktop or input",
	{ skip: process.platform !== "linux" },
	async () => {
		let searches = 0;
		await assert.rejects(
			pickerHarness(async (_binary, args) => {
				assert.equal(args[0], "search");
				searches++;
				throw Object.assign(new Error("no matching picker"), { code: 1 });
			}),
			/did not appear/,
		);
		assert.equal(searches, 200);
	},
);

test("file evidence refuses ambiguous presentation surfaces", () => {
	for (const count of [0, 2]) {
		assert.equal(fileWorkbenchState({ querySelectorAll: () => Array.from({ length: count }, () => ({})) }), null);
		assert.equal(documentPreviewState({ querySelectorAll: () => Array.from({ length: count }, () => ({})) }), null);
		assert.equal(pdfPreviewPaint({ querySelectorAll: () => Array.from({ length: count }, () => ({})) }), null);
	}
});

test("file observations require the exact active tab and its uniquely labelled panel", () => {
	const attributes = { title: "notes.txt", "aria-controls": "file-tab-content-file-1", "aria-selected": "true" };
	const tab = { id: "file-tab-file-1", getAttribute: (key) => attributes[key], querySelector: () => null };
	let panelLabel = tab.id;
	const panel = {
		id: attributes["aria-controls"],
		getAttribute: () => panelLabel,
		querySelectorAll: () => [],
	};
	const tabs = [tab];
	const panels = [panel];
	let status = "Matches confirmed version";
	let dirty = false;
	const root = {
		textContent: "",
		querySelectorAll: (selector) =>
			selector === '.file-tabs [role="tab"]' ? tabs : selector === '.file-tab-panel[role="tabpanel"]' ? panels : [],
		querySelector: (selector) =>
			selector === ".file-document-status > span"
				? { textContent: status, getAttribute: () => (dirty ? "true" : null) }
				: selector === ".file-editor-status > span"
					? { textContent: dirty ? "Changes save automatically" : "Saved" }
					: null,
	};
	const document = { querySelectorAll: () => [root] };
	assert.equal(fileWorkbenchState(document).activeId, tab.id);
	assert.equal(fileWorkbenchState(document).path, "notes.txt");
	assert.equal(fileWorkbenchState(document).clean, true);
	dirty = true;
	status = "Unsaved changes";
	assert.equal(fileWorkbenchState(document).dirty, true);
	assert.equal(fileWorkbenchState(document).clean, false);
	assert.equal(fileWorkbenchState(document).autosavePending, true);
	status = "Saving file…";
	assert.equal(fileWorkbenchState(document).saving, true);
	attributes["aria-selected"] = "false";
	assert.equal(fileWorkbenchState(document), null);
	attributes["aria-selected"] = "true";
	panelLabel = "another-tab";
	assert.equal(fileWorkbenchState(document), null);
	panelLabel = tab.id;
	panel.id = "another-panel";
	assert.equal(fileWorkbenchState(document), null);
	panel.id = attributes["aria-controls"];
	tabs.push(tab);
	assert.equal(fileWorkbenchState(document), null);
	tabs.pop();
	panels.push(panel);
	assert.equal(fileWorkbenchState(document), null);
});

test("Pierre observations read exact rendered lines only from the selected named editor", () => {
	const lines = fileFixture.initial.split("\n").map((textContent, index) => ({
		textContent,
		getAttribute: () => String(index + 1),
	}));
	let name = fileFixture.textName;
	const inputs = [{ getAttribute: () => name }];
	const host = {
		shadowRoot: {
			querySelectorAll: (selector) => (selector === "[data-content] > [data-line]" ? lines : inputs),
		},
	};
	const hosts = [host];
	const panel = {
		querySelectorAll: (selector) => (selector.includes(".pierre-code") ? hosts : []),
	};
	assert.deepEqual(fileCodePresentation(panel, name), {
		editor: fileFixture.initial,
		left: null,
		right: null,
		readOnlyDiff: false,
	});
	name = "other.txt";
	assert.equal(fileCodePresentation(panel, fileFixture.textName).editor, null);
	name = fileFixture.textName;
	lines.reverse();
	assert.equal(fileCodePresentation(panel, name).editor, null, "Missing/virtualized lines cannot be inferred");
	lines.reverse();
	hosts.push(host);
	assert.equal(fileCodePresentation(panel, name).editor, null);
	hosts.pop();
	inputs.push(inputs[0]);
	assert.equal(fileCodePresentation(panel, name).editor, null);
	assert.equal(fileCodePresentation(undefined, name).editor, null);
});

test("Pierre diff evidence requires both exact readonly split columns, never gutters or editable content", () => {
	const column = (text) => ({
		querySelectorAll: (selector) =>
			selector === "[data-content] > [data-line]"
				? text.split("\n").map((textContent, index) => ({
						textContent,
						getAttribute: () => String(index + 1),
					}))
				: [],
	});
	const deletions = [column(fileFixture.initial)];
	const additions = [column(fileFixture.saved)];
	const editables = [];
	const host = {
		shadowRoot: {
			querySelectorAll: (selector) =>
				selector === "[data-code][data-deletions]"
					? deletions
					: selector === "[data-code][data-additions]"
						? additions
						: editables,
		},
	};
	const panel = { querySelectorAll: (selector) => (selector.includes(".pierre-diff") ? [host] : []) };
	assert.deepEqual(fileCodePresentation(panel, fileFixture.textName), {
		editor: null,
		left: fileFixture.initial,
		right: fileFixture.saved,
		readOnlyDiff: true,
	});
	editables.push({});
	assert.equal(fileCodePresentation(panel, fileFixture.textName).readOnlyDiff, false);
	editables.pop();
	additions.push(additions[0]);
	assert.equal(fileCodePresentation(panel, fileFixture.textName).readOnlyDiff, false);
	additions.length = 0;
	assert.equal(fileCodePresentation(panel, fileFixture.textName).left, null);
});

function shadowFixture(kind) {
	const attributes = {
		"aria-label": fileFixture.textName,
		"aria-disabled": "false",
		contenteditable: "true",
		title: fileFixture.textName,
		"aria-controls": "file-tab-content-file-1",
		"aria-labelledby": "file-tab-file-1",
	};
	const row = {
		dataset: { path: fileFixture.textName, itemPath: fileFixture.textName, hipiKind: "file" },
		getAttribute: (key) => attributes[key],
		getBoundingClientRect: () => ({ x: 20, y: 40, width: 80, height: 28 }),
		scrollIntoView: () => {},
		contains: (node) => node === row,
	};
	const rows = [row];
	const trees = [{ getAttribute: () => fileFixture.folder }];
	const shadow = {
		activeElement: row,
		elementFromPoint: () => row,
		querySelectorAll: (selector) => (selector === '[role="tree"]' ? trees : rows),
	};
	const host = { shadowRoot: shadow };
	const hosts = [host];
	const tabs = [{ id: "file-tab-file-1", getAttribute: (key) => attributes[key] }];
	const panels = [
		{
			id: attributes["aria-controls"],
			getAttribute: (key) => attributes[key],
			querySelectorAll: () => hosts,
		},
	];
	const root = {
		querySelectorAll: (selector) =>
			selector.includes('role="tab"') ? tabs : selector.includes('role="tabpanel"') ? panels : hosts,
	};
	const roots = [root];
	const document = { activeElement: host, querySelectorAll: () => roots, elementFromPoint: () => host };
	return { document, host, hosts, shadow, rows, roots, panels, attributes, row, kind };
}

test("Pierre listing requires one shadow tree with distinct enabled exact runtime/model paths", () => {
	const fixture = shadowFixture("tree");
	assert.deepEqual(fileTreeListing(fixture.document), { label: fileFixture.folder, paths: [fileFixture.textName] });
	fixture.row.dataset.itemPath = "different.txt";
	assert.equal(fileTreeListing(fixture.document), null);
	fixture.row.dataset.itemPath = fileFixture.textName;
	fixture.attributes["aria-disabled"] = "true";
	assert.equal(fileTreeListing(fixture.document), null);
	fixture.attributes["aria-disabled"] = "false";
	fixture.row.dataset.hipiKind = "blocked";
	assert.equal(fileTreeListing(fixture.document), null);
	fixture.row.dataset.hipiKind = "file";
	fixture.rows.push(fixture.row);
	assert.equal(fileTreeListing(fixture.document), null);
	fixture.rows.pop();
	fixture.hosts.push(fixture.host);
	assert.equal(fileTreeListing(fixture.document), null);
});

test("shadow pointer targets reject ambiguous, disabled, obscured or mismatched fixture surfaces", () => {
	for (const kind of ["tree", "editor"])
		for (const mismatch of ["host", "row", "outer-hit", "inner-hit", "path", "disabled", "size", "number"]) {
			const fixture = shadowFixture(kind);
			assert.deepEqual(fileShadowTarget(fixture.document, kind, fileFixture.textName), {
				x: 60,
				y: 54,
				focused: true,
			});
			if (mismatch === "host") fixture.hosts.push(fixture.host);
			if (mismatch === "row") fixture.rows.push(fixture.row);
			if (mismatch === "outer-hit") fixture.document.elementFromPoint = () => ({});
			if (mismatch === "inner-hit") fixture.shadow.elementFromPoint = () => ({});
			if (mismatch === "path") {
				fixture.row.dataset.itemPath = "other.txt";
				fixture.attributes["aria-label"] = "other.txt";
			}
			if (mismatch === "disabled") {
				fixture.attributes["aria-disabled"] = "true";
				fixture.attributes.contenteditable = "false";
			}
			if (mismatch === "size") fixture.row.getBoundingClientRect = () => ({ x: 20, y: 40, width: 0, height: 28 });
			if (mismatch === "number")
				fixture.row.getBoundingClientRect = () => ({ x: Number.NaN, y: 40, width: 80, height: 28 });
			assert.equal(fileShadowTarget(fixture.document, kind, fileFixture.textName), null, `${kind}: ${mismatch}`);
		}
});

test("shadow editor input requires exact tab/panel correspondence and both focus boundaries", () => {
	for (const mismatch of ["path", "panel", "label", "focus-outer", "focus-inner"]) {
		const fixture = shadowFixture("editor");
		if (mismatch === "path") fixture.attributes.title = "other.txt";
		if (mismatch === "panel") fixture.panels[0].id = "other-panel";
		if (mismatch === "label") fixture.attributes["aria-labelledby"] = "other-tab";
		if (mismatch === "focus-outer") fixture.document.activeElement = {};
		if (mismatch === "focus-inner") fixture.shadow.activeElement = {};
		const target = fileShadowTarget(fixture.document, "editor", fileFixture.textName);
		if (mismatch.startsWith("focus")) assert.equal(target.focused, false);
		else assert.equal(target, null);
	}
});

test("IDE geometry rejects stacked, reversed, missing or collapsed tree/editor surfaces", () => {
	const geometry = { editorWidth: 360, treeWidth: 240, editorRight: 900, treeLeft: 901, editorTop: 110, treeTop: 110 };
	assertFileWorkbenchLayout(geometry);
	for (const value of [
		null,
		{ ...geometry, treeLeft: 500 },
		{ ...geometry, treeTop: 500 },
		{ ...geometry, treeWidth: 0 },
		{ ...geometry, editorWidth: 0 },
		{ ...geometry, editorRight: Number.NaN },
	])
		assert.throws(() => assertFileWorkbenchLayout(value));
});

const splitGeometry = {
	x: 760.5,
	y: 400,
	width: 640,
	min: 320,
	max: 787,
	areaLeft: 260,
	areaRight: 1400,
	areaWidth: 1140,
	viewportWidth: 1400,
	viewportHeight: 900,
};

test("file drag paths use measured splitter widths and bounded renderer coordinates", () => {
	for (const requested of [80, 640, splitGeometry.areaWidth - 80]) {
		const plan = fileDragPlan(splitGeometry, requested);
		assert.equal(plan.moves.length, 4);
		assert.deepEqual(plan.start, { x: 760.5, y: 400 });
		assert.deepEqual(plan.moves.at(-1), { x: splitGeometry.x + splitGeometry.width - requested, y: 400 });
	}
	const full = { ...splitGeometry, x: 260.5, width: 1139, max: 1139 };
	assert.equal(fileDragPlan(full, 640).moves.at(-1).x, 759.5);
	const tree = { ...splitGeometry, x: 1159.5, width: 240, min: 200, max: 384 };
	assert.equal(fileDragPlan(tree, 50).moves.at(-1).x, 1349.5);
	for (const requested of [0, -1, 1140, Number.NaN, Infinity])
		assert.throws(() => fileDragPlan(splitGeometry, requested));
	for (const value of [
		null,
		{ ...splitGeometry, x: Number.NaN },
		{ ...splitGeometry, width: 200 },
		{ ...splitGeometry, max: 600 },
		{ ...splitGeometry, areaRight: 1390 },
		{ ...splitGeometry, viewportWidth: 1000 },
		{ ...splitGeometry, y: 901 },
		{ ...splitGeometry, x: 200 },
	])
		assert.throws(() => fileDragPlan(value, 80));
});

test("splitter measurement refuses hidden, ambiguous, obscured or wrongly labelled handles", () => {
	const attributes = {
		"aria-orientation": "vertical",
		"aria-valuenow": "640",
		"aria-valuemin": "320",
		"aria-valuemax": "787",
	};
	const handle = {
		getAttribute: (key) => attributes[key],
		getBoundingClientRect: () => ({ x: 760, y: 100, width: 1, height: 600 }),
		contains: (node) => node === handle,
	};
	const area = { getBoundingClientRect: () => ({ left: 260, right: 1400, width: 1140 }) };
	const dock = { hidden: false, inert: false };
	const handles = [handle];
	const document = {
		documentElement: { clientWidth: 1400, clientHeight: 900 },
		elementFromPoint: () => handle,
		querySelectorAll: (selector) =>
			selector === ".work-area"
				? [area]
				: selector === ".file-panel-dock"
					? [dock]
					: selector.includes('[aria-label="File panel width"]')
						? handles
						: [],
	};
	assert.deepEqual(fileSplitterGeometry(document, "dock"), splitGeometry);
	assert.equal(fileSplitterGeometry(document, "tree"), null);
	assert.equal(fileSplitterGeometry(document, "unrelated"), null);
	dock.hidden = true;
	assert.equal(fileSplitterGeometry(document, "dock"), null);
	dock.hidden = false;
	dock.inert = true;
	assert.equal(fileSplitterGeometry(document, "dock"), null);
	dock.inert = false;
	handles.push(handle);
	assert.equal(fileSplitterGeometry(document, "dock"), null);
	handles.pop();
	document.elementFromPoint = () => ({});
	assert.equal(fileSplitterGeometry(document, "dock"), null);
	document.elementFromPoint = () => handle;
	attributes["aria-orientation"] = "horizontal";
	assert.equal(fileSplitterGeometry(document, "dock"), null);
});

test("file drag sends one native press, four held moves and one release without simulated DOM mode changes", async () => {
	const plan = fileDragPlan(splitGeometry, splitGeometry.areaWidth - 80);
	const calls = [];
	await dispatchFileDrag(
		{
			request: async (method, args) => {
				assert.equal(method, "Input.dispatchMouseEvent");
				calls.push(args);
			},
		},
		plan,
	);
	assert.deepEqual(
		calls.map((call) => [call.type, call.buttons]),
		[
			["mouseMoved", 0],
			["mousePressed", 1],
			...Array.from({ length: 4 }, () => ["mouseMoved", 1]),
			["mouseReleased", 0],
		],
	);
	assert.deepEqual(
		calls.slice(2, 6).map(({ x, y }) => ({ x, y })),
		plan.moves,
	);
	assert.equal(calls.at(-1).x, plan.moves.at(-1).x);
});

test("interrupted file drag releases at its last confirmed point without retrying the move", async () => {
	const plan = fileDragPlan(splitGeometry, 80);
	const calls = [];
	await assert.rejects(
		dispatchFileDrag(
			{
				request: async (_method, args) => {
					calls.push(args);
					if (calls.length === 4) throw new Error("synthetic pointer transport failure");
				},
			},
			plan,
		),
		/synthetic pointer transport failure/,
	);
	assert.equal(calls.length, 5);
	assert.equal(calls.at(-1).type, "mouseReleased");
	assert.equal(calls.at(-1).x, plan.moves[0].x);
});

test("split identity records exact canonical shells and permits only hidden vendor row recycling", () => {
	const nodes = Array.from({ length: 9 }, () => ({ isConnected: true }));
	const input = { isConnected: true };
	const inputs = [input];
	nodes.at(-1).shadowRoot = { querySelectorAll: () => inputs };
	const selectors = [];
	let duplicate = false;
	const document = {
		querySelectorAll: (selector) => {
			if (!selectors.includes(selector)) selectors.push(selector);
			const node = nodes[selectors.indexOf(selector)];
			return duplicate ? [node, node] : [node];
		},
	};
	assert.deepEqual(fileSplitNodes(document), [...nodes, input]);
	assert.deepEqual(fileSplitNodes(document, false), nodes);
	inputs.length = 0;
	assert.equal(fileSplitNodes(document), null, "Visible full/split transitions require the actual retained input");
	assert.deepEqual(fileSplitNodes(document, false), nodes, "Hidden virtual rows are not owner replacement");
	nodes[3].isConnected = false;
	assert.equal(fileSplitNodes(document, false), null, "Conversation composer cannot be replaced while hidden");
	nodes[3].isConnected = true;
	duplicate = true;
	assert.equal(fileSplitNodes(document, false), null);
});

test("baseline cleanup skips only absent or strictly hidden/inert docks, never an obstructed visible close button", () => {
	const attributes = { "aria-hidden": "false" };
	let visible = true;
	let covered = false;
	const button = {
		disabled: false,
		getClientRects: () => (visible ? [{}] : []),
		getBoundingClientRect: () => ({ x: 100, y: 20, width: visible ? 20 : 0, height: visible ? 20 : 0 }),
		contains: (value) => value === button,
	};
	const dock = {
		hidden: false,
		inert: false,
		getAttribute: (key) => attributes[key],
		getClientRects: () => (visible ? [{}] : []),
		contains: (value) => value === button,
	};
	const docks = [dock];
	const buttons = [button];
	const dialogs = [];
	const document = {
		querySelectorAll: (selector) =>
			selector === ".file-panel-dock" ? docks : selector === ".file-panel-close" ? buttons : dialogs,
		elementFromPoint: () => (covered ? {} : button),
	};
	assert.equal(filePanelCleanupState(document), "visible");
	covered = true;
	assert.equal(filePanelCleanupState(document), null, "Obstruction must not be mistaken for an already closed dock");
	covered = false;
	button.disabled = true;
	assert.equal(filePanelCleanupState(document), null);
	button.disabled = false;
	visible = false;
	assert.equal(filePanelCleanupState(document), null, "Zero geometry without hidden/inert semantics is not accepted");
	dock.hidden = true;
	dock.inert = true;
	assert.equal(filePanelCleanupState(document), null);
	attributes["aria-hidden"] = "true";
	assert.equal(filePanelCleanupState(document), "hidden");
	visible = true;
	assert.equal(filePanelCleanupState(document), null, "A hidden dock must actually have no visible rectangle");
	visible = false;
	dialogs.push({});
	assert.equal(filePanelCleanupState(document), null);
	dialogs.pop();
	buttons.push(button);
	assert.equal(filePanelCleanupState(document), null);
	buttons.length = 0;
	assert.equal(filePanelCleanupState(document), null);
	docks.length = 0;
	assert.equal(filePanelCleanupState(document), "absent");
});

test("original preview fixtures are byte-deterministic, bounded, and PDF xref entries point at real objects", () => {
	const files = createPreviewFixtureFiles();
	assert.deepEqual(files, createPreviewFixtureFiles());
	assert.equal(new Set(files.map(([name]) => name)).size, 4);
	for (const [, bytes] of files) assert.ok(bytes.length > 0 && bytes.length < 65536);
	const pdf = files.find(([name]) => name === previewFixture.pdfName)[1].toString("ascii");
	const xref = Number(pdf.match(/startxref\n(\d+)\n%%EOF\n$/)[1]);
	assert.ok(pdf.slice(xref).startsWith("xref\n0 6\n"));
	const entries = pdf.slice(xref).split("\n").slice(3, 8);
	for (const [index, entry] of entries.entries())
		assert.ok(pdf.slice(Number(entry.slice(0, 10))).startsWith(`${index + 1} 0 obj\n`));
	assert.ok(!/\/JavaScript|\/OpenAction|\/URI|\/EmbeddedFile/.test(pdf));
});

test("PDF evidence requires actual text paint, rectangle, background and exact rendered zoom", () => {
	const paint = {
		zoom: 1,
		width: 400,
		height: 300,
		blue: [0, 0, 255, 255],
		white: [255, 255, 255, 255],
		darkTextPixels: 101,
	};
	assertPdfPaint(paint, 1);
	for (const change of [
		{ darkTextPixels: 0 },
		{ blue: [255, 255, 255, 255] },
		{ white: [0, 0, 0, 255] },
		{ width: 600 },
		{ zoom: 1.5 },
	])
		assert.throws(() => assertPdfPaint({ ...paint, ...change }, 1));
	assertPdfPaint({ ...paint, zoom: 1.5, width: 600, height: 450 }, 1.5);
});

test("PDF canvas observation waits for completed, unique rendering and measures the scaled text region", () => {
	for (const zoom of [1, 1.5]) {
		const width = 400 * zoom;
		const height = 300 * zoom;
		const data = new Uint8ClampedArray(width * height * 4).fill(255);
		data.set([0, 0, 255, 255], (Math.floor(175 * zoom) * width + Math.floor(80 * zoom)) * 4);
		const start = (Math.floor(60 * zoom) * width + Math.floor(40 * zoom)) * 4;
		for (let index = 0; index < 101; index++) data.set([0, 0, 0, 255], start + index * 4);
		const canvas = {
			width,
			height,
			getAttribute: (name) => (name === "role" ? "img" : "PDF page 1"),
			getContext: () => ({ getImageData: () => ({ data }) }),
		};
		let busy = "false";
		const nodes = {
			".file-preview-surface": [{ getAttribute: () => busy }],
			canvas: [canvas],
			".file-actions select": [{ value: String(zoom), disabled: false }],
		};
		const document = { querySelectorAll: () => [{ querySelectorAll: (selector) => nodes[selector] }] };
		const paint = pdfPreviewPaint(document);
		assertPdfPaint(paint, zoom);
		assert.equal(paint.darkTextPixels, 101);
		busy = "true";
		assert.equal(pdfPreviewPaint(document), null);
		busy = "false";
		nodes.canvas.push(canvas);
		assert.equal(pdfPreviewPaint(document), null);
	}
});

test("completion gate requires every first-run, native-picker and cold-restart observation", () => {
	const first = Object.fromEntries(
		[
			"listedAndOpened",
			"editorTreeSplit",
			"dockDragFull",
			"dockDragRestore",
			"dockDragCollapseRestore",
			"treeDragCollapseRestore",
			"conversationShellRetained",
			"splitterDraftPreserved",
			"savedBytesVerified",
			"autosaveObserved",
			"backgroundAutosave",
			"retainedTabIdentity",
			"workspaceTabRetention",
			"conditionalCloseSaved",
			"initialBaselineSurvivesSave",
			"conflictDraftPreserved",
			"conflictDidNotOverwriteDisk",
			"conflictRetryBlocked",
			"explicitDiscardGuard",
			"dirtyPanelPreservation",
			"narrowModalPreservation",
			"csvPreview",
			"docxPreview",
			"xlsxPreview",
			"xlsxSavedValues",
			"xlsxPagination",
			"pdfPreview",
			"pdfZoom",
			"pdfReopenResetsZoom",
			"dirtyPreviewRetained",
			"unsupportedPreviewRejected",
			"pngPreview",
			"previewHandleRenewed",
		].map((key) => [key, true]),
	);
	first.nativePicker = { nativePicker: true, ownedDisplay: true, ownedPid: true, syntheticFolderOnly: true };
	first.projectBinding = {
		workspaceId: "third-native-project",
		noModelGrant: "native_not_run; empty conversation UI is not authoritative grant evidence",
		cancelNoCreate: true,
		nativeChosen: true,
		readOnlyRoot: true,
		noConversationCreated: true,
		restoredOriginal: true,
	};
	const reopened = {
		reopened: true,
		freshlyAuthorized: true,
		coldSavedContent: true,
		coldTabsEmpty: true,
		rootRevoked: true,
		projectBinding: {
			workspaceId: "third-native-project",
			noModelGrant: "native_not_run; empty conversation UI is not authoritative grant evidence",
			persistedWithoutPicker: true,
			readOnlyRoot: true,
			noConversationCreated: true,
			unbound: true,
			tabsRevoked: true,
		},
	};
	validateFileWorkbenchEvidence({ first, reopened });
	for (const key of Object.keys(first))
		assert.throws(() => validateFileWorkbenchEvidence({ first: { ...first, [key]: false }, reopened }));
	for (const key of Object.keys(reopened))
		assert.throws(() => validateFileWorkbenchEvidence({ first, reopened: { ...reopened, [key]: false } }));
});
