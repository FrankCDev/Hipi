import assert from "node:assert/strict";
import { mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createFileAuthority } from "@hipi/work-runtime/files/node";
import { createRuntimePreviewHost } from "@hipi/work-runtime/previews/host";
import { createPreviewClient } from "@hipi/work-runtime/previews/protocol";
import { chooseOwnedFileFolder } from "./gui-file-picker.mjs";
import { createPreviewFixtureFiles, previewFixture } from "./gui-file-preview-fixtures.mjs";
import { assertPdfPaint, documentPreviewState, pdfPreviewPaint } from "./gui-file-previews.mjs";
import { fileWorkbenchState, validateFileWorkbenchEvidence } from "./gui-file-workbench.mjs";
import {
	changeOwnedFixture,
	fileFixture,
	ownedFileDirectory,
	readOwnedFixture,
	seedFileWorkbench,
	verifyColdFileWorkbench,
} from "./gui-file-workbench-fixture.mjs";

async function profile() {
	return realpath(await mkdtemp(join(await realpath(tmpdir()), "Hipi GUI profile-")));
}

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
			gui: { conflictDraftPreserved: true, savedBytesVerified: true },
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

async function pickerHarness(run, identity = async () => ({ app: "100", xvfb: "200" })) {
	const ownedProfileRoot = await profile();
	await ownedFileDirectory(ownedProfileRoot, { create: true });
	let clock = 0;
	try {
		return await chooseOwnedFileFolder(
			{ ownedProfileRoot, pid: 100, xvfbPid: 200, display: ":432", binary: "/owned/app" },
			{
				run,
				identity,
				pause: async (ms) => {
					clock += ms;
				},
				now: () => clock,
			},
		);
	} finally {
		await rm(ownedProfileRoot, { recursive: true, force: true });
	}
}

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
			if (args[0] === "type") {
				assert.ok(args.includes("--window") && args.includes("900"));
				assert.match(args.at(-1), /Hipi GUI profile-[A-Za-z0-9]+\/workbench-files$/);
			}
			if (args.at(-1) === "Return") closed = true;
			return { stdout: "" };
		});
		assert.equal(result.nativePicker, true);
		assert.equal(calls.filter((args) => args[0] === "type").length, 1);
		assert.equal(calls.filter((args) => args.at(-1) === "Return").length, 1);
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
			"savedBytesVerified",
			"initialBaselineSurvivesSave",
			"conflictDraftPreserved",
			"conflictDidNotOverwriteDisk",
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
			"dirtyPreviewGuardPreserved",
			"unsupportedPreviewRejected",
			"pngPreview",
			"previewNotRestored",
		].map((key) => [key, true]),
	);
	first.nativePicker = { nativePicker: true, ownedDisplay: true, ownedPid: true, syntheticFolderOnly: true };
	const reopened = { reopened: true, freshlyAuthorized: true, coldSavedContent: true, rootRevoked: true };
	validateFileWorkbenchEvidence({ first, reopened });
	for (const key of Object.keys(first))
		assert.throws(() => validateFileWorkbenchEvidence({ first: { ...first, [key]: false }, reopened }));
	for (const key of Object.keys(reopened))
		assert.throws(() => validateFileWorkbenchEvidence({ first, reopened: { ...reopened, [key]: false } }));
});
