import { writeFileSync } from "node:fs";

const pidPath = process.env.HIPI_TEST_CHILD_PID_PATH;
if (!pidPath) throw new Error("Missing test child PID path");
writeFileSync(pidPath, String(process.pid));
process.stdout.write("Token: synthetic-startup-secret\n");
process.stderr.write("https://synthetic-credential.invalid/private?key=synthetic-startup-secret\n");
// Hold initialization before the real host entry runs. The parent must kill and reap us.
await new Promise<void>((resolve) => setTimeout(resolve, 60_000));
