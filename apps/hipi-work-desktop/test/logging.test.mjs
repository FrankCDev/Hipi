import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createNodeLogger } from "@hipi/work-logging";

test("desktop resolves public neutral logger and awaits accepted records", async (t) => {
	const directory = await mkdtemp(join(tmpdir(), "hipi-desktop-logging-"));
	t.after(() => rm(directory, { recursive: true, force: true }));
	const logger = createNodeLogger({ role: "main", directory });
	assert.equal(logger.record("app.start"), true);
	assert.equal(await logger.close(), "flushed");
	const record = JSON.parse((await readFile(join(directory, "desktop.log"), "utf8")).trim());
	assert.equal(record.event, "app.start");
	assert.equal(record.role, "main");
	assert.equal(record.sessionId, logger.sessionId);
});
