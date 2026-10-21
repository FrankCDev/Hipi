import assert from "node:assert/strict";
import { mkdtempSync, realpathSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { DEVELOPMENT_ORIGIN, prepareDevelopment } from "../../src/development/launch.ts";

test("development is explicit, unpackaged, isolated and exact-origin only", () => {
	const root = realpathSync(mkdtempSync(join(tmpdir(), "hipi-dev-test-")));
	const paths = new Map<string, string>([["appData", root]]);
	const app = {
		isPackaged: false,
		getPath: (name: string) => paths.get(name) ?? "missing",
		setPath: (name: string, path: string) => {
			paths.set(name, path);
		},
	};
	try {
		assert.throws(() => prepareDevelopment(app, [], undefined));
		assert.throws(() => prepareDevelopment({ ...app, isPackaged: true }, [], "a".repeat(64)));
		assert.throws(() => prepareDevelopment(app, ["--smoke-data-root=/tmp"], "a".repeat(64)));
		const result = prepareDevelopment(app, [], "a".repeat(64));
		assert.equal(result.page, `${DEVELOPMENT_ORIGIN}/?desktop=${"a".repeat(64)}`);
		assert.equal(paths.get("userData"), join(root, "Hipi Work Development", "profile"));
		assert.equal(paths.get("logs"), join(root, "Hipi Work Development", "logs"));
		assert.deepEqual(prepareDevelopment(app, [], "a".repeat(64)), result);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});
test("development rejects redirected profile roots", () => {
	const root = realpathSync(mkdtempSync(join(tmpdir(), "hipi-dev-test-")));
	const target = realpathSync(mkdtempSync(join(tmpdir(), "hipi-dev-target-")));
	try {
		symlinkSync(target, join(root, "Hipi Work Development"), process.platform === "win32" ? "junction" : "dir");
		assert.throws(() =>
			prepareDevelopment(
				{ isPackaged: false, getPath: () => root, setPath: () => assert.fail("must not set") },
				[],
				"a".repeat(64),
			),
		);
	} finally {
		rmSync(root, { recursive: true, force: true });
		rmSync(target, { recursive: true, force: true });
	}
});
