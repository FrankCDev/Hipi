export function endpoint(value, port, kind) {
	if (kind !== "page" && kind !== "browser") throw new Error("Invalid CDP target kind");
	const url = new URL(value);
	if (
		!Number.isInteger(port) ||
		port < 1 ||
		port > 65535 ||
		url.protocol !== "ws:" ||
		url.hostname !== "127.0.0.1" ||
		url.port !== String(port) ||
		url.username ||
		url.password ||
		url.search ||
		url.hash ||
		!value.startsWith(`ws://127.0.0.1:${port}/`) ||
		!new RegExp(`^/devtools/${kind}/[A-Za-z0-9-]+$`).test(url.pathname)
	)
		throw new Error("Unexpected CDP endpoint");
	return url.href;
}

export class Cdp {
	#socket;
	#pending = new Map();
	#listeners = new Set();
	#id = 0;
	#closed = false;
	#timeout;
	constructor(socket, timeout = 15000) {
		this.#socket = socket;
		this.#timeout = timeout;
		socket.addEventListener("message", (event) => {
			try {
				if (typeof event.data !== "string" || event.data.length > 16 * 1024 * 1024)
					throw new Error("Invalid or oversized CDP message");
				const value = JSON.parse(event.data);
				if (value.id !== undefined) {
					const pending = this.#pending.get(value.id);
					if (!pending) return;
					this.#pending.delete(value.id);
					clearTimeout(pending.timer);
					if (value.error) pending.reject(new Error(`CDP ${pending.method} failed (${value.error.code})`));
					else pending.resolve(value.result);
				} else if (typeof value.method === "string") {
					for (const listener of this.#listeners) listener(value.method, value.params);
				} else throw new Error("Malformed CDP response");
			} catch (error) {
				this.close(error);
			}
		});
		socket.addEventListener("close", () => this.close(new Error("CDP socket closed")));
		socket.addEventListener("error", () => this.close(new Error("CDP socket failed")));
	}
	static async connect(url, port, kind = "page") {
		const socket = new WebSocket(endpoint(url, port, kind));
		await new Promise((resolve, reject) => {
			const timer = setTimeout(() => {
				cleanup();
				socket.close();
				reject(new Error("CDP connection timeout"));
			}, 10000);
			const cleanup = () => {
				clearTimeout(timer);
				socket.removeEventListener("open", opened);
				socket.removeEventListener("error", failed);
				socket.removeEventListener("close", failed);
			};
			const opened = () => {
				cleanup();
				resolve();
			};
			const failed = () => {
				cleanup();
				socket.close();
				reject(new Error("CDP connection failed"));
			};
			socket.addEventListener("open", opened);
			socket.addEventListener("error", failed);
			socket.addEventListener("close", failed);
		});
		return new Cdp(socket);
	}
	onEvent(listener) {
		this.#listeners.add(listener);
		return () => this.#listeners.delete(listener);
	}
	request(method, params = {}) {
		if (this.#closed || this.#socket.readyState !== 1) return Promise.reject(new Error("CDP is closed"));
		if (this.#pending.size >= 64) return Promise.reject(new Error("CDP request capacity exceeded"));
		return new Promise((resolve, reject) => {
			const id = ++this.#id;
			const timer = setTimeout(() => this.close(new Error(`CDP ${method} timed out`)), this.#timeout);
			this.#pending.set(id, { resolve, reject, timer, method });
			try {
				this.#socket.send(JSON.stringify({ id, method, params }));
			} catch (error) {
				this.close(error);
			}
		});
	}
	// Electron may close the transport without acknowledging Browser.close.
	requestQuit() {
		if (this.#closed || this.#socket.readyState !== 1) throw new Error("Cannot request quit on closed CDP");
		this.#socket.send(JSON.stringify({ id: ++this.#id, method: "Browser.close" }));
	}
	close(reason = new Error("CDP disposed")) {
		if (this.#closed) return;
		this.#closed = true;
		for (const pending of this.#pending.values()) {
			clearTimeout(pending.timer);
			pending.reject(reason);
		}
		this.#pending.clear();
		this.#listeners.clear();
		this.#socket.close();
	}
}

export async function pageTarget(port) {
	if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("Invalid CDP discovery port");
	const response = await fetch(`http://127.0.0.1:${port}/json/list`, {
		redirect: "error",
		signal: AbortSignal.timeout(5000),
	});
	if (!response.ok || Number(response.headers.get("content-length") ?? 0) > 1024 * 1024) {
		await response.body?.cancel();
		throw new Error("Invalid CDP discovery response");
	}
	if (!response.body) throw new Error("Missing CDP discovery body");
	const chunks = [];
	let bytes = 0;
	for await (const chunk of response.body) {
		bytes += chunk.length;
		if (bytes > 1024 * 1024) throw new Error("CDP discovery too large");
		chunks.push(chunk);
	}
	const targets = JSON.parse(Buffer.concat(chunks).toString("utf8"));
	if (!Array.isArray(targets)) throw new Error("Invalid CDP target list");
	const matching = targets.filter((target) => target.type === "page" && target.url === "hipi-work://app/index.html");
	if (matching.length === 0) return undefined;
	if (matching.length !== 1) throw new Error("Ambiguous application page");
	return endpoint(matching[0].webSocketDebuggerUrl, port, "page");
}
