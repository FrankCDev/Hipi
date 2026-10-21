import { readFileSync } from "node:fs";
import { setTimeout as pause } from "node:timers/promises";
import { DevelopmentLifecycle, developmentControl } from "../../src/development/control.ts";

const mode = process.argv[2];
if (mode === "fail") process.exit(7);
const lifecycle = new DevelopmentLifecycle(
	async () => {
		await pause(50);
		process.stdout.write("runtime-closed\n");
		return true;
	},
	async (clean) => {
		control.dispose();
		process.exit(clean ? 0 : 1);
	},
);
const control = developmentControl(() => {
	if (mode === "lazy-read") process.stdout.write(`${readFileSync(process.argv[3], "utf8")}\n`);
	if (mode === "hung-startup") {
		void lifecycle.quit();
		return;
	}
	setTimeout(
		() => {
			control.dispose();
			process.exit(0);
		},
		mode === "slow" ? 100 : 0,
	);
});
if (mode === "hung-startup") await new Promise(() => {});
else if (mode !== "silent") control.ready();
