import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { McpClient } from "@earendil-works/pi-mcp";
import { bundledMcpClients, installBridge, patchBundledMcpClients } from "../src/bridge.ts";
import { ElicitationRuntime } from "../src/runtime.ts";

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
  async getClient() { return new McpClient(); }
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

describe("bundled McpClient", () => {
  it("advertises elicitation when runtime-*.js does not export McpClient", async () => {
    const root = mkdtempSync(join(tmpdir(), "pi-mcp-elicitations-bundle-"));
    writeBundle(root);
    try {
      const clients = await patchBundledMcpClients(root);
      assert.equal(clients.length, 1);
      const client = new clients[0]!({
        name: "pi",
        version: "0",
        capabilities: { sampling: {}, extensions: { "io.modelcontextprotocol/tasks": {} } },
      });
      await client.connect?.(undefined);
      const seen = (client as { seen?: { elicitation?: { form?: unknown; url?: unknown }; sampling?: unknown; extensions?: unknown } }).seen;
      assert.deepEqual(seen?.elicitation, { form: {}, url: {} });
      assert.deepEqual(seen?.sampling, {});
      assert.deepEqual(seen?.extensions, { "io.modelcontextprotocol/tasks": {} });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("patches the installed pi bundle client, which is not the package export", async () => {
    await installBridge(new ElicitationRuntime());
    const root = dirname(dirname(fileURLToPath(import.meta.resolve("@earendil-works/pi-coding-agent"))));
    await patchBundledMcpClients(root);
    const clients = await bundledMcpClients(root);
    assert.ok(clients.length >= 1);
    const Client = clients.find((candidate) => (candidate as unknown) !== McpClient);
    assert.ok(Client);
    const client = new Client({
      name: "pi",
      version: "0",
      capabilities: { sampling: {}, extensions: { "io.modelcontextprotocol/tasks": {} } },
    });
    const connect = client.connect?.bind(client);
    if (typeof connect !== "function") throw new Error("bundled McpClient has no connect");
    await assert.rejects(() => connect(stoppingTransport()));
    const caps = client.options?.capabilities as {
      elicitation?: { form?: unknown; url?: unknown };
      sampling?: unknown;
      extensions?: unknown;
    };
    assert.deepEqual(caps.elicitation, { form: {}, url: {} });
    assert.deepEqual(caps.sampling, {});
    assert.deepEqual(caps.extensions, { "io.modelcontextprotocol/tasks": {} });
  });

  it("patches a pi-mcp package imported beside the bundle, not this package's copy", async () => {
    const root = mkdtempSync(join(tmpdir(), "pi-mcp-elicitations-dist-"));
    const chunks = join(root, "dist/bundle/chunks");
    const pkgDir = join(root, "node_modules/@earendil-works/pi-mcp");
    mkdirSync(chunks, { recursive: true });
    mkdirSync(join(pkgDir, "dist"), { recursive: true });
    writeFileSync(join(root, "package.json"), JSON.stringify({ type: "module" }));
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
    writeFileSync(
      join(chunks, "chunk-CONN.js"),
      `import { McpClient } from "@earendil-works/pi-mcp";
export class McpServerConnection {
  async getClient() { return new McpClient(); }
}
`,
    );
    writeFileSync(
      join(chunks, "runtime-FIXTURE.js"),
      `import { McpServerConnection } from "./chunk-CONN.js";
export { McpServerConnection };
`,
    );
    try {
      const clients = await patchBundledMcpClients(root);
      assert.equal(clients.length, 1);
      assert.notEqual(clients[0], McpClient);
      const client = new clients[0]!({
        name: "pi",
        version: "0",
        capabilities: { sampling: {}, extensions: { "io.modelcontextprotocol/tasks": {} } },
      });
      await client.connect?.(undefined);
      const seen = (client as { seen?: { elicitation?: { form?: unknown; url?: unknown }; sampling?: unknown; extensions?: unknown } }).seen;
      assert.deepEqual(seen?.elicitation, { form: {}, url: {} });
      assert.deepEqual(seen?.sampling, {});
      assert.deepEqual(seen?.extensions, { "io.modelcontextprotocol/tasks": {} });
      const mod = await import(pathToFileURL(join(pkgDir, "dist/index.js")).href);
      assert.equal(clients[0], (mod as { McpClient: unknown }).McpClient);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
