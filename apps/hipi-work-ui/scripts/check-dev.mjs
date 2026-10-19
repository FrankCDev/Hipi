import assert from "node:assert/strict";
import { readdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";

// Compile every owned browser module through the development pipeline, without a production build.
// This checks source transforms and CSS generation, not DOM behavior or layout.
const root = fileURLToPath(new URL("../", import.meta.url));
const server = await createServer({ root, server: { host: "127.0.0.1", port: 0, strictPort: false } });
try {
  await server.listen();
  const address = server.httpServer?.address();
  assert(address && typeof address === "object");
  const response = await fetch(`http://127.0.0.1:${address.port}/`);
  assert.equal(response.status, 200);
  assert.match(await response.text(), /src\/main.tsx/);
  const files = await readdir(new URL("../src/", import.meta.url), { recursive: true });
  for (const file of files.filter(file => /\.(tsx?|css)$/.test(file))) {
    const result = await server.transformRequest(`/src/${file}`);
    assert(result?.code, `No transformed module: ${file}`);
  }
  console.log(`PASS: HTTP entry and ${files.filter(file => /\.(tsx?|css)$/.test(file)).length} Vite development transforms. No browser execution claimed.`);
} finally {
  await server.close();
}
