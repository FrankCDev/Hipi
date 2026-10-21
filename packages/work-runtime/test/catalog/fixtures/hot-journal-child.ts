import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { StoreOwnerLease } from "../../../src/store-owner.ts";

const directory = process.argv[2];
if (!directory || !process.send) throw new Error("A catalog directory and IPC channel are required");
const owner = await StoreOwnerLease.acquire(directory);
const database = new DatabaseSync(join(directory, "catalog.sqlite"));
database.exec("PRAGMA synchronous=FULL; PRAGMA cache_size=1; PRAGMA cache_spill=ON; BEGIN IMMEDIATE");
database.exec("UPDATE identity SET store_id='uncommitted-identity'");
const insert = database.prepare("INSERT INTO workspaces VALUES (?,?,0)");
for (let index = 0; index < 1000; index++) insert.run(`pending_${index}`, "x".repeat(100));
process.send({ phase: "spilled", journalMode: database.prepare("PRAGMA journal_mode").get()?.journal_mode });
// Hold the actual owner and dirty transaction until the parent simulates process death.
process.once("disconnect", () => {
	database.close();
	owner.close();
});
