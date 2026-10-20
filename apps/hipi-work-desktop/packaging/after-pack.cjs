const { copyFile, chmod } = require("node:fs/promises");
const path = require("node:path");
const verifyPack = require("./verify-pack.cjs");
const { verifyLinuxSandboxFiles } = require("./verify-linux-sandbox.cjs");

module.exports = async function afterPack(context) {
	await verifyPack(context);
	if (context.electronPlatformName !== "linux") return;
	verifyLinuxSandboxFiles(context.appOutDir);
	// builder 26.15.3 generates its launcher, then copies appOutDir over it.
	// Final archive verification is mandatory: fail if this integration changes.
	const destination = path.join(context.appOutDir, "AppRun");
	await copyFile(path.join(__dirname, "AppRun"), destination);
	await chmod(destination, 0o755);
};
