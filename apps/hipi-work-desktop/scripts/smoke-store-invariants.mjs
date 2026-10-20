import assert from "node:assert/strict";

// SQLite may materialize an empty WAL and its transient shared-memory index
// while opening a WAL-mode database read-only. Never delete those files to make
// a test pass, ignore nonempty WAL, or weaken any preexisting-file invariant.
export function assertOriginalStoreUnchanged(before, after) {
	const existing = new Set(before.map((item) => item.file));
	assert.deepEqual(
		after.filter((item) => existing.has(item.file)),
		before,
		"Maintenance changed or removed an original store file",
	);
	const additions = after.filter((item) => !existing.has(item.file));
	for (const item of additions) {
		const match = /^(catalog\.sqlite|[A-Za-z0-9_-]+\/workspace\.sqlite)-(wal|shm)$/.exec(item.file);
		assert.ok(match && existing.has(match[1]), `Unexpected file added to original store: ${item.file}`);
		const wal = additions.find((entry) => entry.file === `${match[1]}-wal`);
		const shm = additions.find((entry) => entry.file === `${match[1]}-shm`);
		assert.ok(wal && shm, "New SQLite sidecars must be an empty WAL and its shared-memory index pair");
		assert.equal(wal.bytes, 0, "Maintenance added business bytes to a new WAL");
		assert.equal(shm.bytes, 32768, "Unexpected new SQLite shared-memory index size");
	}
	return additions;
}
