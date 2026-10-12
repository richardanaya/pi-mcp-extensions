import { existsSync, readFileSync, readdirSync, realpathSync } from "node:fs";
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

export async function installBridge(agentRoot?: string): Promise<void> {
  const root = agentRoot ?? (await piRoot());
  for (const runtimePath of runtimeFiles(root)) {
    const runtimeUrl = pathToFileURL(runtimePath).href;
    const runtime = (await import(runtimeUrl)) as Record<string, unknown>;
    for (const value of Object.values(runtime)) {
      if (typeof value === "function" && value.prototype && typeof value.prototype.getClient === "function") {
        patchConnection(value.prototype as Patchable);
      }
    }
    try {
      const mcp = (await import(import.meta.resolve("@earendil-works/pi-mcp", runtimeUrl))) as {
        McpClient: { prototype: Patchable };
      };
      patchClient(mcp.McpClient.prototype);
    } catch (error) {
      // The CLI bundle inlines McpClient. A fixture has no published package beside that chunk.
      if (!isBundleRuntime(runtimePath)) throw error;
    }
    for (const Client of await inlinedMcpClients(runtimePath)) patchClient(Client.prototype);
  }
}

/** McpClient classes the CLI bundle constructs. Empty when this root has no bundle. */
export async function bundledMcpClients(agentRoot: string): Promise<BundledMcpClient[]> {
  const clients: BundledMcpClient[] = [];
  for (const runtimePath of runtimeFiles(agentRoot)) {
    for (const Client of await inlinedMcpClients(runtimePath)) {
      if (!clients.includes(Client)) clients.push(Client);
    }
  }
  return clients;
}

export interface BundledMcpClient {
  new (options?: { name?: string; version?: string; capabilities?: Record<string, unknown> }): Patchable;
  prototype: Patchable;
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
  const files: string[] = [];
  const unbundled = join(agentRoot, "dist/extensions/mcp/runtime.js");
  if (existsSync(unbundled)) files.push(unbundled);
  try {
    for (const name of readdirSync(join(agentRoot, "dist/bundle/chunks"))) {
      if (/^runtime-.*\.js$/.test(name)) files.push(join(agentRoot, "dist/bundle/chunks", name));
    }
  } catch {
    // Source checkouts have no CLI bundle.
  }
  return files;
}

function isBundleRuntime(runtimePath: string): boolean {
  return runtimePath.includes(`${sep}bundle${sep}`);
}

const NAMED_IMPORT = /import\s*\{([^}]*)\}\s*from\s*["']([^"']+)["']/g;
const SIDE_IMPORT = /import\s*["'](\.[^"']+)["']/g;
const EXPORT_CLAUSE = /export\s*\{([^}]*)\}/g;
const EXPORT_DECL = /export\s+(?:class|function)\s+([A-Za-z0-9_$]+)/g;

/**
 * `runtime-*.js` re-exports the connection. The client class is a chunk that file imports,
 * or a chunk that connection file imports as McpClient. pi 1.1 inlines it there, separate
 * from the `@earendil-works/pi-mcp` export. Chunk names stay hashed, so this follows imports.
 */
async function inlinedMcpClients(runtimePath: string): Promise<BundledMcpClient[]> {
  if (!isBundleRuntime(runtimePath)) return [];
  const source = readSource(runtimePath);
  if (source === undefined) return [];
  const hrefs: string[] = [];
  const push = (href: string) => {
    if (!hrefs.includes(href)) hrefs.push(href);
  };
  for (const spec of specifierTargets(source, "McpClient")) push(resolveSpecifier(runtimePath, spec));
  for (const spec of relativeSpecifiers(source)) {
    const childHref = new URL(spec, pathToFileURL(runtimePath)).href;
    const childPath = fileURLToPath(childHref);
    const child = readSource(childPath);
    if (child === undefined) continue;
    if (exportsName(child, "McpClient")) push(childHref);
    for (const inner of specifierTargets(child, "McpClient")) push(resolveSpecifier(childPath, inner));
  }
  const clients: BundledMcpClient[] = [];
  for (const href of hrefs) {
    const mod = (await import(href)) as { McpClient?: unknown };
    if (isMcpClientClass(mod.McpClient) && !clients.includes(mod.McpClient)) clients.push(mod.McpClient);
  }
  return clients;
}

function readSource(file: string): string | undefined {
  try {
    return readFileSync(file, "utf8");
  } catch {
    return undefined;
  }
}

function specifierTargets(source: string, exportName: string): string[] {
  const specs: string[] = [];
  for (const match of source.matchAll(NAMED_IMPORT)) {
    if (clauseNames(match[1]).includes(exportName)) specs.push(match[2]);
  }
  return specs;
}

function relativeSpecifiers(source: string): string[] {
  const specs: string[] = [];
  for (const match of source.matchAll(NAMED_IMPORT)) {
    if (match[2].startsWith(".")) specs.push(match[2]);
  }
  for (const match of source.matchAll(SIDE_IMPORT)) specs.push(match[1]);
  return specs;
}

function exportsName(source: string, name: string): boolean {
  for (const match of source.matchAll(EXPORT_CLAUSE)) {
    if (clauseNames(match[1]).includes(name)) return true;
  }
  for (const match of source.matchAll(EXPORT_DECL)) {
    if (match[1] === name) return true;
  }
  return false;
}

function clauseNames(clause: string): string[] {
  const names: string[] = [];
  for (const part of clause.split(",")) {
    const cleaned = part.trim().replace(/^type\s+/, "");
    if (!cleaned) continue;
    for (const bit of cleaned.split(/\s+as\s+/)) {
      const name = bit.trim();
      if (name) names.push(name);
    }
  }
  return names;
}

function resolveSpecifier(fromFile: string, spec: string): string {
  if (spec.startsWith(".")) return new URL(spec, pathToFileURL(fromFile)).href;
  return import.meta.resolve(spec, pathToFileURL(fromFile).href);
}

function isMcpClientClass(value: unknown): value is BundledMcpClient {
  if (typeof value !== "function") return false;
  const proto = (value as { prototype?: { connect?: unknown } }).prototype;
  return typeof proto?.connect === "function";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
