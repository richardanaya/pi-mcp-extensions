import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";
import { McpClient } from "@earendil-works/pi-mcp";
import { bundledMcpClients, installPiMcpHooks, piCodingAgentRoot } from "../src/attach.ts";
import { EXTENSION_ID } from "../src/model.ts";

function stoppingTransport() {
  return {
    async start() {
      throw new Error("stop");
    },
    async close() {},
    onMessage() {
      return () => {};
    },
    onError() {
      return () => {};
    },
    onClose() {
      return () => {};
    },
    async send() {},
  };
}

function writeBundle(root: string): void {
  const chunks = join(root, "dist/bundle/chunks");
  mkdirSync(chunks, { recursive: true });
  writeFileSync(join(root, "package.json"), JSON.stringify({ type: "module" }));
  writeFileSync(
    join(chunks, "chunk-CLIENT.js"),
    `class McpClient {
  constructor(options = {}) { this.options = options ?? {}; }
  async connect() { this.seen = this.options.capabilities; return {}; }
}
export { McpClient };
`,
  );
  writeFileSync(
    join(chunks, "chunk-CONN.js"),
    `import{McpClient}from"./chunk-CLIENT.js";
export class McpServerConnection {
  async connectOnce() { return new McpClient(); }
  async getClient() { return this.connectOnce(); }
  handleClientClose() {}
  async close() {}
}
`,
  );
  writeFileSync(
    join(chunks, "runtime-FIXTURE.js"),
    `import{McpServerConnection}from"./chunk-CONN.js";
export{McpServerConnection};
`,
  );
}

test("inlined bundle client advertises skills when runtime-*.js does not export McpClient", async () => {
  const root = mkdtempSync(join(tmpdir(), "pi-mcp-skills-bundle-"));
  writeBundle(root);
  try {
    const hook = await installPiMcpHooks({ onReady() {}, onClose() {} }, root);
    assert.equal(hook.installed, true);
    const clients = await bundledMcpClients(root);
    assert.equal(clients.length, 1);
    const client = new clients[0]!({ name: "pi", version: "0", capabilities: { sampling: {} } });
    await client.connect(undefined);
    const seen = (client as { seen?: { extensions?: Record<string, unknown>; sampling?: unknown } }).seen;
    assert.deepEqual(seen?.extensions?.[EXTENSION_ID], {});
    assert.deepEqual(seen?.sampling, {});
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("installed pi bundle McpClient is not the package export and advertises skills", async () => {
  const root = piCodingAgentRoot();
  const hook = await installPiMcpHooks({ onReady() {}, onClose() {} });
  assert.equal(hook.installed, true);
  const clients = await bundledMcpClients(root);
  assert.ok(clients.length >= 1);
  const Client = clients.find((candidate) => candidate !== McpClient);
  assert.ok(Client);
  const client = new Client({ name: "pi", version: "0", capabilities: { sampling: {} } });
  await assert.rejects(() => client.connect(stoppingTransport()));
  const caps = client.options?.capabilities as { extensions?: Record<string, unknown>; sampling?: unknown };
  assert.deepEqual(caps.extensions?.[EXTENSION_ID], {});
  assert.deepEqual(caps.sampling, {});
});

test("pi-mcp beside the runtime is patched when it is not this package's copy", async () => {
  const root = mkdtempSync(join(tmpdir(), "pi-mcp-skills-dist-"));
  const pkgDir = join(root, "node_modules/@earendil-works/pi-mcp");
  mkdirSync(join(root, "dist/extensions/mcp"), { recursive: true });
  mkdirSync(join(pkgDir, "dist"), { recursive: true });
  writeFileSync(join(root, "dist/extensions/mcp/runtime.js"), "export {}\n");
  writeFileSync(
    join(pkgDir, "package.json"),
    JSON.stringify({ name: "@earendil-works/pi-mcp", type: "module", exports: { ".": { import: "./dist/index.js" } } }),
  );
  writeFileSync(
    join(pkgDir, "dist/index.js"),
    `export class McpClient {
  constructor(options = {}) { this.options = options ?? {}; }
  async connect() { this.seen = this.options.capabilities; }
}
`,
  );
  try {
    const hook = await installPiMcpHooks({ onReady() {}, onClose() {} }, root);
    assert.equal(hook.installed, true, hook.gap);
    const mod = (await import(pathToFileURL(join(pkgDir, "dist/index.js")).href)) as {
      McpClient: new (options?: { capabilities?: Record<string, unknown> }) => {
        connect(): Promise<void>;
        seen?: { extensions?: Record<string, unknown>; sampling?: unknown };
      };
    };
    assert.notEqual(mod.McpClient, McpClient);
    const client = new mod.McpClient({ capabilities: { sampling: {} } });
    await client.connect();
    assert.deepEqual(client.seen?.extensions?.[EXTENSION_ID], {});
    assert.deepEqual(client.seen?.sampling, {});
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
