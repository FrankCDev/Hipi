// Run with --conditions=source. Seed writes use public runtime commands before native launch.

import { assertLongHistoryAcceptance, exerciseLongHistory } from "./gui-long-history.mjs";
import { historyAnswer, seedLongHistory, verifyColdHistory } from "./gui-long-history-fixture.mjs";
import { runPackagedGui } from "./smoke-packaged-gui.mjs";

await runPackagedGui({
	scenario: "long-history",
	prepare: seedLongHistory,
	run: (context) => exerciseLongHistory({ ...context, originalText: historyAnswer(context.seed.expansionTurn) }),
	verify: verifyColdHistory,
	validate: ({ first, reopened }) => assertLongHistoryAcceptance(first, reopened),
});
