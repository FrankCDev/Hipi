import assert from "node:assert/strict";

/** A failed callback or exit observation cannot authorize profile deletion. */
export async function runBetweenGuiSessions(callback, context, lifecycle) {
	assert.equal(typeof callback, "function");
	lifecycle.resourcesClosed = false;
	await context.assertAllOwnedProcessesExited();
	const result = await callback(context);
	await context.assertAllOwnedProcessesExited();
	lifecycle.resourcesClosed = true;
	return result;
}
