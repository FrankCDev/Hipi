import { exerciseFileWorkbench, validateFileWorkbenchEvidence } from "./gui-file-workbench.mjs";
import { seedFileWorkbench, verifyColdFileWorkbench } from "./gui-file-workbench-fixture.mjs";
import { runPackagedGui } from "./smoke-packaged-gui.mjs";

await runPackagedGui({
	scenario: "file-workbench",
	prepare: seedFileWorkbench,
	run: exerciseFileWorkbench,
	verify: verifyColdFileWorkbench,
	validate: validateFileWorkbenchEvidence,
});
