import { readdirSync, realpathSync } from "node:fs";
import { dirname, join, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const PATCH = Symbol.for("pi-mcp-apps.bridge");
const UI_EXTENSION = "io.modelcontextprotocol/ui";

export interface LiveClient {
  request(method: string, params?: Record<string, unknown>): Promise<unknown>;
}

const clients = new Map<string, LiveClient>();

interface Patchable {
  options?: { capabilities?: Record<string, unknown> };
  connect?: (transport: unknown) => Promise<unknown>;
  request: LiveClient["request"];
  getClient?: () => Promise<Patchable>;
  entry?: { name: string };
  name?: string;
}

export function connectedClient(server: string): LiveClient | undefined {
  return clients.get(server);
}

export function connectedServers(): string[] {
  return [...clients.keys()];
}

export async function installBridge(): Promise<void> {
  const root = await piRoot();
  for (const runtimePath of runtimeFiles(root)) {
    const runtime = await import(pathToFileURL(runtimePath).href) as Record<string, unknown>;
    for (const value of Object.values(runtime)) {
      if (typeof value === "function" && value.prototype && typeof value.prototype.getClient === "function") {
        patchConnection(value.prototype as Patchable);
      }
    }
    const mcp = (await import(import.meta.resolve("@earendil-works/pi-mcp", pathToFileURL(runtimePath).href))) as {
      McpClient: { prototype: Patchable };
    };
    patchClient(mcp.McpClient.prototype);
  }
}

function patchClient(proto: Patchable): void {
  const marked = proto as Patchable & Record<symbol, boolean>;
  if (marked[PATCH] || typeof proto.connect !== "function") return;
  const original = proto.connect;
  proto.connect = async function connect(this: Patchable, transport: unknown) {
    const options = this.options ?? {};
    const capabilities = { ...(options.capabilities ?? {}) };
    const extensions = isRecord(capabilities.extensions) ? { ...capabilities.extensions } : {};
    extensions[UI_EXTENSION] = { mimeTypes: ["text/html;profile=mcp-app"] };
    this.options = { ...options, capabilities: { ...capabilities, extensions } };
    return original.call(this, transport);
  };
  marked[PATCH] = true;
}

function patchConnection(proto: Patchable): void {
  const marked = proto as Patchable & Record<symbol, boolean> & {
    callTool?: (name: string, args: unknown, options?: unknown) => Promise<unknown>;
    readResource?: (uri: string, options?: unknown) => Promise<unknown>;
  };
  if (marked[PATCH] || typeof proto.getClient !== "function") return;
  const original = proto.getClient;
  const remember = (connection: Patchable, client: LiveClient) => {
    const server = connection.entry?.name ?? connection.name;
    if (server) clients.set(server, client);
  };
  proto.getClient = function getClient(this: Patchable) {
    return Promise.resolve(original.call(this)).then((client) => {
      remember(this, client);
      return client;
    });
  };
  if (typeof marked.callTool === "function") {
    const originalCall = marked.callTool;
    marked.callTool = function callTool(this: Patchable, name: string, args: unknown, options?: unknown) {
      return originalCall.call(this, name, args, options).then((result) => {
        const client = (this as Patchable & { client?: LiveClient }).client;
        if (client) remember(this, client);
        return result;
      });
    };
  }
  marked[PATCH] = true;
}

export async function piRoot(): Promise<string> {
  const script = process.argv[1];
  if (script) {
    const real = realpathSync(script);
    const marker = `${sep}pi-coding-agent${sep}`;
    const at = real.indexOf(marker);
    if (at !== -1) return real.slice(0, at + marker.length - 1);
  }
  return dirname(dirname(fileURLToPath(import.meta.resolve("@earendil-works/pi-coding-agent"))));
}

function runtimeFiles(agentRoot: string): string[] {
  const files = [join(agentRoot, "dist/extensions/mcp/runtime.js")];
  try {
    for (const name of readdirSync(join(agentRoot, "dist/bundle/chunks"))) {
      if (/^runtime-.*\.js$/.test(name)) files.push(join(agentRoot, "dist/bundle/chunks", name));
    }
  } catch {
    // Source checkouts have no CLI bundle.
  }
  return files;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
