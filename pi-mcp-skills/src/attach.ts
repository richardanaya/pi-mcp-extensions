import { readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { clientCapabilitiesWithSkills, type McpPort } from "./model.ts";

const PATCH = Symbol.for("pi-mcp-skills.patched");

/** Package root of the installed pi 1.0.1 coding agent. Its export map hides package.json. */
export function piCodingAgentRoot(): string {
  return dirname(dirname(fileURLToPath(import.meta.resolve("@earendil-works/pi-coding-agent"))));
}

export interface LiveServer extends McpPort {
  server: string;
}

export interface PiMcpHooks {
  onReady(live: LiveServer): void | Promise<void>;
  onClose(server: string): void;
}

interface ClientLike {
  options: { capabilities?: Record<string, unknown> };
  request(method: string, params?: Record<string, unknown>): Promise<unknown>;
  onNotification(method: string, listener: (params: unknown) => void): () => void;
  serverCapabilities?: Record<string, unknown>;
  instructions?: string;
  protocolVersion?: string;
}

interface ConnectionLike {
  entry: { name: string };
  connectOnce(): Promise<ClientLike>;
  getClient?(): Promise<ClientLike>;
  handleClientClose(client: ClientLike, stdio: unknown): void;
  close(): Promise<void>;
}

const announced = new WeakSet<object>();

const listeners = new Set<PiMcpHooks>();

/**
 * pi 1.0.1 does not let an extension send a custom MCP method or observe notifications on the
 * client the built-in MCP extension already opened. Patch that same module instance: advertise
 * the skills extension on initialize, and hand each connected client to the skills host.
 * A second McpClient is not constructed for those servers.
 */
export async function installPiMcpHooks(hooks: PiMcpHooks): Promise<{ installed: boolean; gap?: string }> {
  listeners.add(hooks);
  try {
    const runtimes = runtimeFiles(piCodingAgentRoot());
    if (runtimes.length === 0) throw new Error("MCP runtime was not found");
    for (const runtimePath of runtimes) {
      const runtimeUrl = pathToFileURL(runtimePath).href;
      const runtime = (await import(runtimeUrl)) as { McpServerConnection?: { prototype: ConnectionLike } };
      if (runtime.McpServerConnection) patchConnection(runtime.McpServerConnection.prototype);
      const mcpUrl = import.meta.resolve("@earendil-works/pi-mcp", runtimeUrl);
      const mcp = (await import(mcpUrl)) as {
        McpClient: { prototype: ClientLike & { connect(transport: unknown): Promise<unknown> } };
      };
      patchClient(mcp.McpClient.prototype);
    }
    return { installed: true };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      installed: false,
      gap: `pi has no extension API for custom MCP requests. The skills hook could not attach to the built-in client (${message}).`,
    };
  }
}

/** Unbundled runtime plus the Pi CLI bundle (`runtime-*.js`). Patch every copy the process might construct. */
function runtimeFiles(agentRoot: string): string[] {
  const files = [join(agentRoot, "dist/extensions/mcp/runtime.js")];
  const chunks = join(agentRoot, "dist/bundle/chunks");
  try {
    for (const name of readdirSync(chunks)) {
      if (/^runtime-.*\.js$/.test(name)) files.push(join(chunks, name));
    }
  } catch {
    // A source checkout of pi has no CLI bundle.
  }
  return files;
}

function patchClient(proto: ClientLike & { connect(transport: unknown): Promise<unknown> }): void {
  const target = proto as typeof proto & { [PATCH]?: boolean };
  if (target[PATCH]) return;
  const original = proto.connect;
  proto.connect = async function (this: ClientLike, transport: unknown) {
    const current = this.options;
    this.options = Object.freeze({
      ...current,
      capabilities: clientCapabilitiesWithSkills(current.capabilities),
    });
    return original.call(this, transport);
  };
  target[PATCH] = true;
}

function patchConnection(proto: ConnectionLike): void {
  const target = proto as ConnectionLike & { [PATCH]?: boolean };
  if (target[PATCH]) return;
  const originalOnce = proto.connectOnce;
  proto.connectOnce = async function (this: ConnectionLike) {
    const client = await originalOnce.call(this);
    await announce(this.entry.name, client);
    return client;
  };
  if (typeof proto.getClient === "function") {
    const originalGet = proto.getClient;
    proto.getClient = function (this: ConnectionLike) {
      return Promise.resolve(originalGet.call(this)).then(async (client) => {
        await announce(this.entry.name, client);
        return client;
      });
    };
  }
  const originalClose = proto.handleClientClose;
  proto.handleClientClose = function (this: ConnectionLike, client: ClientLike, stdio: unknown) {
    emitClose(this.entry.name);
    originalClose.call(this, client, stdio);
  };
  const originalShutdown = proto.close;
  proto.close = async function (this: ConnectionLike) {
    emitClose(this.entry.name);
    return originalShutdown.call(this);
  };
  target[PATCH] = true;
}

function wrap(server: string, client: ClientLike): LiveServer {
  return {
    server,
    request: (method, params) => client.request(method, params),
    onNotification: (method, listener) => client.onNotification(method, listener),
    capabilities: () => client.serverCapabilities,
    instructions: () => client.instructions,
    protocolVersion: () => client.protocolVersion,
  };
}

async function announce(server: string, client: ClientLike): Promise<void> {
  if (announced.has(client)) return;
  announced.add(client);
  await emitReady(wrap(server, client));
}

async function emitReady(live: LiveServer): Promise<void> {
  for (const listener of listeners) {
    try {
      await listener.onReady(live);
    } catch {
      // A skills refresh must not fail the MCP connection pi already established.
    }
  }
}

function emitClose(server: string): void {
  for (const listener of listeners) {
    try {
      listener.onClose(server);
    } catch {
      // Detach is best-effort.
    }
  }
}
