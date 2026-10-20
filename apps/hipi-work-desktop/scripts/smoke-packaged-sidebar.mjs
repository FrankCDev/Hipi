// Independent sidebar gate; no Settings or font qualification is a prerequisite.
import { seedSidebar, verifySidebar } from "./gui/sidebar/fixture.mjs";
import { assertSidebarAcceptance, exerciseSidebar } from "./gui/sidebar/journey.mjs";
import { runPackagedGui } from "./smoke-packaged-gui.mjs";

await runPackagedGui({
	scenario: "sidebar",
	prepare: seedSidebar,
	run: exerciseSidebar,
	verify: verifySidebar,
	validate: assertSidebarAcceptance,
});
