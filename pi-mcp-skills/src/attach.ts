import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join, sep } from "node:path";
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
 *
 * The `pi` CLI loads `dist/bundle/chunks/runtime-*.js`, which inlines its own McpClient. That
 * class is not the one `@earendil-works/pi-mcp` exports. Both are patched.
 */
export async function installPiMcpHooks(
  hooks: PiMcpHooks,
  agentRoot = piCodingAgentRoot(),
): Promise<{ installed: boolean; gap?: string }> {
  listeners.add(hooks);
  try {
    const runtimes = runtimeFiles(agentRoot);
    if (runtimes.length === 0) throw new Error("MCP runtime was not found");
    for (const runtimePath of runtimes) {
      const runtimeUrl = pathToFileURL(runtimePath).href;
      const runtime = (await import(runtimeUrl)) as { McpServerConnection?: { prototype: ConnectionLike } };
      if (runtime.McpServerConnection) patchConnection(runtime.McpServerConnection.prototype);
      await patchPackageClient(runtimePath);
      for (const Client of await inlinedMcpClients(runtimePath)) patchClient(Client.prototype);
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

/** McpClient classes the CLI bundle constructs. Empty when this root has no bundle. */
export async function bundledMcpClients(agentRoot: string): Promise<BundledMcpClient[]> {
  const clients: BundledMcpClient[] = [];
  for (const runtimePath of runtimeFiles(agentRoot)) {
    if (!isBundleRuntime(runtimePath)) continue;
    for (const Client of await inlinedMcpClients(runtimePath)) {
      if (!clients.includes(Client)) clients.push(Client);
    }
  }
  return clients;
}

export interface BundledMcpClient {
  new (options?: { name?: string; version?: string; capabilities?: Record<string, unknown> }): ClientLike & {
    options?: { capabilities?: Record<string, unknown> };
    connect(transport: unknown): Promise<unknown>;
  };
  prototype: ClientLike & { connect(transport: unknown): Promise<unknown> };
}

/** Unbundled runtime plus the Pi CLI bundle (`runtime-*.js`). Patch every copy the process might construct. */
function runtimeFiles(agentRoot: string): string[] {
  const files: string[] = [];
  const unbundled = join(agentRoot, "dist/extensions/mcp/runtime.js");
  if (existsSync(unbundled)) files.push(unbundled);
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

async function patchPackageClient(runtimePath: string): Promise<void> {
  try {
    const mcp = (await import(resolveFromFile(runtimePath, "@earendil-works/pi-mcp"))) as { McpClient: BundledMcpClient };
    patchClient(mcp.McpClient.prototype);
  } catch (error) {
    // A fixture bundle does not sit next to the published package. The inlined client is patched separately.
    if (!isBundleRuntime(runtimePath)) throw error;
  }
}

function isBundleRuntime(runtimePath: string): boolean {
  return runtimePath.includes(`${sep}bundle${sep}`);
}

const NAMED_IMPORT = /import\s*\{([^}]*)\}\s*from\s*["']([^"']+)["']/g;
const SIDE_IMPORT = /import\s*["'](\.[^"']+)["']/g;
const EXPORT_CLAUSE = /export\s*\{([^}]*)\}/g;
const EXPORT_DECL = /export\s+(?:class|function)\s+([A-Za-z0-9_$]+)/g;

/**
 * Follow the bundle graph without a hashed filename. `runtime-*.js` re-exports the connection.
 * The client is either exported by a chunk that file imports, or imported by that chunk under
 * the name McpClient. pi 1.1 keeps it in the second chunk, not in `@earendil-works/pi-mcp`.
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
  return resolveFromFile(fromFile, spec);
}

/**
 * Node 22 ignores the parent argument of `import.meta.resolve` unless
 * `--experimental-import-meta-resolve` is set, and pi-mcp's exports map is
 * `import` only, so `require.resolve` cannot see it. Walk from the runtime
 * file and read the `import` condition.
 */
function resolveFromFile(fromFile: string, spec: string): string {
  if (spec.startsWith(".")) return new URL(spec, pathToFileURL(fromFile)).href;
  const name = spec.startsWith("@") ? spec.split("/").slice(0, 2).join("/") : spec.split("/")[0]!;
  const sub = spec.slice(name.length).replace(/^\//, "");
  let dir = dirname(fromFile);
  for (;;) {
    const pkgDir = join(dir, "node_modules", name);
    const manifestPath = join(pkgDir, "package.json");
    if (existsSync(manifestPath)) {
      const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as { exports?: unknown; main?: string };
      return pathToFileURL(join(pkgDir, exportedPath(manifest, sub))).href;
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  throw new Error(`Cannot resolve ${spec} from ${fromFile}`);
}

function exportedPath(manifest: { exports?: unknown; main?: string }, sub: string): string {
  const key = sub === "" ? "." : `./${sub}`;
  const exportsField = manifest.exports;
  if (typeof exportsField === "string" && sub === "") return exportsField;
  if (isExportRecord(exportsField) && Object.hasOwn(exportsField, key)) {
    const target = exportTarget(exportsField[key]);
    if (target) return target;
  }
  if (sub === "" && typeof manifest.main === "string") return manifest.main;
  throw new Error(`Package has no ${key} export`);
}

function exportTarget(value: unknown): string | undefined {
  if (typeof value === "string") return value;
  if (!isExportRecord(value)) return undefined;
  for (const condition of ["import", "default", "require"]) {
    const target = exportTarget(value[condition]);
    if (target) return target;
  }
  return undefined;
}

function isExportRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isMcpClientClass(value: unknown): value is BundledMcpClient {
  if (typeof value !== "function") return false;
  const proto = (value as { prototype?: { connect?: unknown } }).prototype;
  return typeof proto?.connect === "function";
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
