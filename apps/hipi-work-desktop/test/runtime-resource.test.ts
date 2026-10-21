import assert from "node:assert/strict";
import { join } from "node:path";
import { test } from "node:test";
import { runtimeResource } from "../src/runtime/resource.ts";

test("utility entry relocates ASAR only; parser stays adjacent to unpacked runtime", () => {
	for (const root of [
		"/Applications/Hipi Work 中文.app/Contents/Resources/app.asar/dist",
		"C:\\Program Files\\Hipi Work 中文\\resources\\app.asar\\dist",
	]) {
		assert.equal(runtimeResource(root), join(root.replace("app.asar", "app.asar.unpacked"), "runtime.mjs"));
	}
	for (const root of [
		"/workspace/Hipi Work/dist",
		"/workspace/app.asar-example/dist",
		"/resources/app.asar.unpacked/dist",
	]) {
		assert.equal(runtimeResource(root), join(root, "runtime.mjs"));
	}
});
