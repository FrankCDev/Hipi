import assert from "node:assert/strict";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { FileServiceError } from "../src/files/contracts.ts";
import { createFileAuthority, type FileCommitPermit } from "../src/files/service.ts";

async function fixture() {
	const directory = await mkdtemp(join(tmpdir(), "hipi-agent-file-"));
	const authority = createFileAuthority({
		securityMode: "cooperative-local-files",
		assertWorkspaceAccess: async () => {},
	});
	const root = await authority.grantRoot({
		principalId: "alice",
		workspaceId: "workspace",
		absolutePath: directory,
		writable: true,
	});
	const target = { workspaceId: root.workspaceId, rootId: root.rootId, path: "example.txt" };
	const filename = join(directory, target.path);
	await writeFile(filename, "original");
	const agent = authority.forAgent("alice");
	const original = await agent.readText(target);
	return {
		directory,
		filename,
		authority,
		target,
		agent,
		original,
		async close() {
			await authority.close();
			await rm(directory, { recursive: true, force: true });
		},
	};
}

// This is a deterministic broker-lock fixture, not a replacement permission store.
function brokerGate() {
	let tail = Promise.resolve();
	let allowed = true;
	function locked<T>(operation: () => Promise<T>): Promise<T> {
		const current = tail.then(operation);
		tail = current.then(
			() => {},
			() => {},
		);
		return current;
	}
	const permit: FileCommitPermit = (commit) =>
		locked(async () => {
			if (!allowed) throw new FileServiceError("UNAUTHORIZED");
			return await commit();
		});
	return {
		permit,
		revoke: () =>
			locked(async () => {
				allowed = false;
			}),
	};
}

test("Agent saves require a gate; denial after preparation leaves the target and temporary directory unchanged", async () => {
	const f = await fixture();
	try {
		await assert.rejects(f.agent.saveText(f.target, "new", f.original.revision, undefined as never), {
			code: "UNAUTHORIZED",
		});
		let calls = 0;
		await assert.rejects(
			f.agent.saveText(f.target, "new", f.original.revision, async () => {
				calls++;
				assert.equal((await readdir(f.directory)).filter((name) => name.startsWith(".hipi-save-")).length, 1);
				throw new FileServiceError("UNAUTHORIZED");
			}),
			{ code: "UNAUTHORIZED" },
		);
		assert.equal(calls, 1);
		assert.equal(await readFile(f.filename, "utf8"), "original");
		assert.deepEqual(await readdir(f.directory), [f.target.path]);
	} finally {
		await f.close();
	}
});

for (const reason of ["cancel", "context revoke"] as const) {
	test(`${reason} before final gate wins over a prepared write`, async () => {
		const f = await fixture();
		const gate = brokerGate();
		const entered = Promise.withResolvers<void>();
		const proceed = Promise.withResolvers<void>();
		try {
			const saving = f.agent.saveText(f.target, "new", f.original.revision, async (commit) => {
				entered.resolve();
				await proceed.promise;
				return gate.permit(commit);
			});
			await entered.promise;
			await gate.revoke();
			proceed.resolve();
			await assert.rejects(saving, { code: "UNAUTHORIZED" });
			assert.equal(await readFile(f.filename, "utf8"), "original");
			assert.deepEqual(await readdir(f.directory), [f.target.path]);
		} finally {
			proceed.resolve();
			await f.close();
		}
	});
}

test("revocation queued after gate entry waits for rename and cannot claim rollback", async () => {
	const f = await fixture();
	const gate = brokerGate();
	const entered = Promise.withResolvers<void>();
	const proceed = Promise.withResolvers<void>();
	try {
		const saving = f.agent.saveText(f.target, "new", f.original.revision, (commit) =>
			gate.permit(async () => {
				entered.resolve();
				await proceed.promise;
				return commit();
			}),
		);
		await entered.promise;
		let revoked = false;
		const revoking = gate.revoke().then(() => {
			revoked = true;
		});
		await Promise.resolve();
		assert.equal(revoked, false);
		proceed.resolve();
		const saved = await saving;
		await revoking;
		assert.equal(saved.text, "new");
		assert.equal(await readFile(f.filename, "utf8"), "new");
		await assert.rejects(f.agent.saveText(f.target, "later", saved.revision, gate.permit), { code: "UNAUTHORIZED" });
		assert.deepEqual(await readdir(f.directory), [f.target.path]);
	} finally {
		proceed.resolve();
		await f.close();
	}
});

test("final gate rechecks ifMatch, root grant and inode lock after waiting", async () => {
	const f = await fixture();
	try {
		await assert.rejects(
			f.agent.saveText(f.target, "new", f.original.revision, async (commit) => {
				await assert.rejects(f.authority.forPrincipal("alice").saveText(f.target, "manual", f.original.revision), {
					code: "BUSY",
				});
				await writeFile(f.filename, "external edit");
				return commit();
			}),
			{ code: "VERSION_CONFLICT" },
		);
		assert.equal(await readFile(f.filename, "utf8"), "external edit");
		const current = await f.agent.readText(f.target);
		await assert.rejects(
			f.agent.saveText(f.target, "new", current.revision, async (commit) => {
				f.authority.revokeRoot(f.target.rootId);
				return commit();
			}),
			{ code: "UNAUTHORIZED" },
		);
		assert.equal(await readFile(f.filename, "utf8"), "external edit");
		assert.deepEqual(await readdir(f.directory), [f.target.path]);
	} finally {
		await f.close();
	}
});

test("lost acknowledgement after rename is unknown and retains independently observable hash evidence", async () => {
	const f = await fixture();
	try {
		await assert.rejects(
			f.agent.saveText(f.target, "new", f.original.revision, async (commit) => {
				await commit();
				throw new Error("simulated lost acknowledgement");
			}),
			{ code: "WRITE_OUTCOME_UNKNOWN" },
		);
		assert.equal(await readFile(f.filename, "utf8"), "new");
		const observed = await f.agent.readText(f.target);
		assert.notEqual(observed.revision, f.original.revision);
		assert.equal(observed.text, "new");
		assert.deepEqual(await readdir(f.directory), [f.target.path]);
	} finally {
		await f.close();
	}
});

test("a failed gate cannot retain a usable commit capability or invoke it twice", async () => {
	const f = await fixture();
	let retained: (() => Promise<unknown>) | undefined;
	try {
		await assert.rejects(
			f.agent.saveText(f.target, "new", f.original.revision, async (commit) => {
				retained = commit;
				throw new FileServiceError("UNAUTHORIZED");
			}),
			{ code: "UNAUTHORIZED" },
		);
		assert.ok(retained);
		await assert.rejects(retained(), { code: "UNAUTHORIZED" });
		await assert.rejects(
			f.agent.saveText(f.target, "new", f.original.revision, async (commit) => {
				await commit();
				return commit();
			}),
			{ code: "WRITE_OUTCOME_UNKNOWN" },
		);
		assert.equal(await readFile(f.filename, "utf8"), "new");
		assert.deepEqual(await readdir(f.directory), [f.target.path]);
	} finally {
		await f.close();
	}
});

test("synchronous Agent root check rejects stale list results, wrong scope and closed authorities", async () => {
	const f = await fixture();
	try {
		assert.equal(f.agent.assertRoot(f.target.workspaceId, f.target.rootId), undefined);
		assert.throws(() => f.agent.assertRoot("other", f.target.rootId), { code: "UNAUTHORIZED" });
		assert.throws(() => f.agent.assertRoot(f.target.workspaceId, "invented"), { code: "UNAUTHORIZED" });
		assert.throws(() => f.authority.forAgent("other").assertRoot(f.target.workspaceId, f.target.rootId), {
			code: "UNAUTHORIZED",
		});
		const roots = await f.agent.listRoots(f.target.workspaceId);
		assert.equal(roots.length, 1);
		f.authority.revokeRoot(f.target.rootId);
		assert.throws(() => f.agent.assertRoot(roots[0].workspaceId, roots[0].rootId), { code: "UNAUTHORIZED" });
		const replacement = await f.authority.grantRoot({
			principalId: "alice",
			workspaceId: f.target.workspaceId,
			absolutePath: f.directory,
			writable: true,
		});
		assert.notEqual(replacement.rootId, f.target.rootId);
		assert.throws(() => f.agent.assertRoot(f.target.workspaceId, f.target.rootId), { code: "UNAUTHORIZED" });
		f.agent.assertRoot(replacement.workspaceId, replacement.rootId);
		const closing = f.authority.close();
		assert.throws(() => f.agent.assertRoot(replacement.workspaceId, replacement.rootId), { code: "CLOSED" });
		await closing;
	} finally {
		await f.close();
	}
});
