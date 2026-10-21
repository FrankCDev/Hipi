// Separate large-list evidence; excluded from the one-run small-sidebar AppArmor exception.

import { assertSidebarVirtualizationAcceptance, exerciseSidebarVirtualization } from "./gui/sidebar/virtualization.mjs";
import { seedSidebarVirtualization, verifySidebarVirtualization } from "./gui/sidebar/virtualization-fixture.mjs";
import { runPackagedGui } from "./smoke-packaged-gui.mjs";

await runPackagedGui({
	scenario: "sidebar-virtualization",
	prepare: seedSidebarVirtualization,
	run: exerciseSidebarVirtualization,
	verify: verifySidebarVirtualization,
	validate: assertSidebarVirtualizationAcceptance,
});
