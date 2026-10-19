import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { app, utilityProcess } from "electron";

// Deliberately no BrowserWindow, renderer bridge, arbitrary commands or file paths.
app.whenReady().then(() => {
	console.log(JSON.stringify({ stage: "electron-ready", electron: process.versions.electron, node: process.versions.node }));
	const withRuntime = process.argv.includes("--runtime");
	const entry = withRuntime ? "./utility-runtime.mjs" : "./utility.mjs";
	const child = utilityProcess.fork(fileURLToPath(new URL(entry, import.meta.url)), [], {
		execArgv: ["--conditions=source", "--experimental-strip-types"],
	});
	let received = false;
	const timeout = setTimeout(() => {
		child.kill();
		app.exit(2);
	}, 15000);
	child.once("message", (message) => {
		try {
			assert.deepEqual(message, {
				version: 1,
				kind: withRuntime ? "runtime-result" : "sqlite-result",
				...(withRuntime ? { workspace: "probe" } : {}),
				electron: process.versions.electron,
				node: process.versions.node,
				value: 42,
			});
			received = true;
			console.log(JSON.stringify({ stage: withRuntime ? "utility-runtime-verified" : "utility-sqlite-verified", ...message }));
			child.postMessage("probe-received");
		} catch (error) {
			console.error(error);
			child.kill();
		}
	});
	child.once("exit", (code) => {
		clearTimeout(timeout);
		app.exit(received && code === 0 ? 0 : 1);
	});
}).catch((error) => {
	console.error(error);
	app.exit(1);
});
