import assert from "node:assert/strict";

// Physical directory capacity is 100 active conversations, including the pinned control.
export const virtualizationWorkspaceIds = Object.freeze(
	Array.from({ length: 7 }, (_, index) => `virtual-recent-work-${index}`),
);
export function virtualizationRoleEntry(seed) {
	assert.deepEqual(seed.workspaceIds, virtualizationWorkspaceIds);
	assert.equal(seed.defaultWorkspaceId, virtualizationWorkspaceIds[0]);
	assert.match(seed.handshake.storeId, /^[a-zA-Z0-9_-]{1,128}$/);
	return {
		version: 1,
		storeId: seed.handshake.storeId,
		kind: "value",
		key: "default-chat-workspace",
		value: JSON.stringify({ version: 1, role: "default-chat-workspace", workspaceId: seed.defaultWorkspaceId }),
	};
}
