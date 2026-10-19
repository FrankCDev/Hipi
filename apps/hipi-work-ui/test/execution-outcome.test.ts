import assert from "node:assert/strict";
import { test } from "node:test";
import { executionOutcome } from "../src/features/workbench/execution-outcome.ts";

test("failed execution remains explainable without displaying arbitrary diagnostic strings", () => {
	assert.match(executionOutcome("model_error", "zh-CN"), /会话授权/);
	assert.match(executionOutcome("aborted", "en"), /not rolled back/);
	assert.match(executionOutcome("reset", "zh-CN"), /重置/);
	assert.match(executionOutcome("no_model", "en"), /model settings/);
	for (const reason of [undefined, "FAKE_SECRET_SENTINEL /private/path", "<script>anything</script>"])
		assert.equal(executionOutcome(reason, "en"), executionOutcome(undefined, "en"));
});
