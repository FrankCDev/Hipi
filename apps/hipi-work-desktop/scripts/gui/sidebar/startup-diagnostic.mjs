/** Fixture-only read observer. Self-contained so the native harness can serialize it into CDP. */
export async function sidebarStartupDiagnostic(seed, bridge, storage) {
	const expectedWorkspaces = ["sidebar-chats", "sidebar-project-a", "sidebar-project-b"];
	if (
		JSON.stringify(seed?.workspaceIds) !== JSON.stringify(expectedWorkspaces) ||
		seed.defaultWorkspaceId !== expectedWorkspaces[0] ||
		!/^[a-zA-Z0-9_-]{1,128}$/.test(seed.handshake?.storeId ?? "") ||
		!Number.isSafeInteger(seed.handshake?.protocolVersion) ||
		seed.handshake.protocolVersion < 1
	)
		return { status: "invalid_fixture" };
	const request = async (method, expectedStoreId) => {
		let timer;
		try {
			return await Promise.race([
				bridge.request({
					version: seed.handshake.protocolVersion,
					method,
					params: {},
					...(expectedStoreId ? { expectedStoreId } : {}),
				}),
				new Promise((resolve) => {
					timer = setTimeout(() => resolve({ ok: false, error: "diagnostic_timeout" }), 2000);
				}),
			]);
		} catch {
			return { ok: false, error: "diagnostic_request_failed" };
		} finally {
			clearTimeout(timer);
		}
	};
	const handshake = await request("handshake");
	if (
		handshake?.ok !== true ||
		handshake.result?.storeId !== seed.handshake.storeId ||
		handshake.result?.protocolVersion !== seed.handshake.protocolVersion ||
		Object.keys(handshake.result).sort().join() !== Object.keys(seed.handshake).sort().join() ||
		Object.keys(seed.handshake).some((key) => handshake.result[key] !== seed.handshake[key])
	)
		return { status: "unverified_store", handshake };
	const local = {};
	for (const key of ["default-chat-workspace", "command.catalog"]) {
		try {
			const value = storage.getItem(`hipi.work.local.v1.${seed.handshake.storeId}.value.${key}`);
			local[key] = value === null || value.length <= 65536 ? value : { error: "oversize" };
		} catch {
			local[key] = { error: "unavailable" };
		}
	}
	const reads = {};
	for (const method of ["getProjectCatalogState", "listProjects", "listSidebarPins"])
		reads[method] = await request(method, seed.handshake.storeId);
	return { status: "verified_fixture_store", handshake, local, reads };
}
