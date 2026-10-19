import { parentPort } from "node:worker_threads";

// Deliberately uncooperative parser fixture: only termination can release it.
parentPort?.once("message", () => {
	while (true) {
		/* fault injection */
	}
});
