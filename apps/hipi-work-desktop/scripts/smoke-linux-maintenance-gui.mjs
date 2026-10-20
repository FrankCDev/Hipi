// Opt-in Linux interoperability gate; normal baseline GUI smoke is unchanged.
import maintenance from "../packaging/linux-maintenance.cjs";
import { assertMaintenanceReopen, exerciseMaintenanceGui, maintainElectronStore } from "./gui-maintenance.mjs";
import { runPackagedGui } from "./smoke-packaged-gui.mjs";

maintenance.assertRuntimeTarget(process.platform, process.arch);
await runPackagedGui({
	run: exerciseMaintenanceGui,
	betweenRuns: maintainElectronStore,
	validate: assertMaintenanceReopen,
});
