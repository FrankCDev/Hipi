import assert from "node:assert/strict";

export const sidebarWorkspaceIds = Object.freeze(["sidebar-chats", "sidebar-project-a", "sidebar-project-b"]);
export function defaultRoleEntry(seed) {
	assert.deepEqual(seed.workspaceIds, sidebarWorkspaceIds);
	assert.equal(seed.defaultWorkspaceId, sidebarWorkspaceIds[0]);
	assert.match(seed.handshake.storeId, /^[a-zA-Z0-9_-]{1,128}$/);
	assert.ok(Number.isSafeInteger(seed.handshake.protocolVersion) && seed.handshake.protocolVersion > 0);
	return {
		version: 1,
		storeId: seed.handshake.storeId,
		kind: "value",
		key: "default-chat-workspace",
		value: JSON.stringify({
			version: seed.handshake.protocolVersion,
			method: "createWorkspace",
			params: { workspaceId: seed.defaultWorkspaceId, name: "Chats" },
		}),
	};
}
