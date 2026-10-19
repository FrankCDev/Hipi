import { build } from "esbuild";

// Browser consumers can import only the public contract and browser transport, not Node or PI.
for (const entry of [
	"src/contracts.ts",
	"src/transport-http-client.ts",
	"src/credential-contracts.ts",
	"src/credential-http-client.ts",
	"src/files/contracts.ts",
	"src/files/protocol.ts",
	"src/files/http-client.ts",
	"src/previews/contracts.ts",
	"src/previews/protocol.ts",
	"src/previews/http-client.ts",
]) {
	await build({ entryPoints: [entry], bundle: true, platform: "browser", format: "esm", write: false, logLevel: "silent" });
}
console.log("Hipi Work browser contracts and HTTP client bundle without Node dependencies.");
