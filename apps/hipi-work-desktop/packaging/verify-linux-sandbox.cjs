const assert = require("node:assert/strict");
const { lstatSync } = require("node:fs");
const path = require("node:path");

const portableExecutables = Object.freeze(["hipi-work", "chrome-sandbox", "chrome_crashpad_handler"]);

function assertPortableExecutableStat(name, stat) {
	assert(stat.isFile(), `Portable Linux executable must be a regular file: ${name}`);
	assert.equal(stat.mode & 0o7777, 0o755, `Portable Linux executable must have mode 0755: ${name}`);
}

function verifyLinuxSandboxFiles(directory) {
	for (const name of portableExecutables) {
		// Inspect, never repair. These archives depend on a working namespace sandbox;
		// a privileged helper needs a separate reviewed installation contract.
		assertPortableExecutableStat(name, lstatSync(path.join(directory, name)));
	}
}

module.exports = { assertPortableExecutableStat, portableExecutables, verifyLinuxSandboxFiles };
