/**
 * Narrow patches on pi's built-in MCP client.
 *
 * pi 1.0.1 does not let an extension declare an extension capability at initialize, put `_meta`
 * on tools/call, set per-request HTTP headers, or send a custom method through a public API.
 * These patches use the client pi already constructed. They do not open a second connection.
 *
 * The `pi` CLI inlines McpClient inside `dist/bundle/chunks/`. That class is not the
 * `@earendil-works/pi-mcp` export. `connect` is patched on both, or initialize from the CLI
 * never advertises the tasks extension.
 */

import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { AsyncLocalStorage } from "node:async_hooks";
import { prepareOutgoing, TASK_HEADER_METHODS, withInitializeExtensions } from "./protocol.ts";
import type { TaskRuntime } from "./runtime.ts";

const PATCH = Symbol.for("pi-mcp-tasks.bridge");

interface HeaderContext {
  method: string;
  taskId?: string;
}

interface PatchableClient {
  options?: { capabilities?: Record<string, unknown> } & Record<string, unknown>;
  connect?: (transport: unknown) => Promise<unknown>;
  request: (method: string, params?: Record<string, unknown>, options?: unknown) => Promise<unknown>;
  onNotification?: (method: string, listener: (params: unknown) => void) => unknown;
  transport?: HeaderTransport;
}

interface HeaderTransport {
  headers?: (extra?: Record<string, string>) => Promise<{ headers: Headers }>;
  __piMcpTasksHeaders?: boolean;
}

interface ConnectionLike {
  name?: string;
  prototype?: { getClient?: () => Promise<PatchableClient> };
}

const headerStore = new AsyncLocalStorage<HeaderContext>();
const slot: { runtime?: TaskRuntime } = {};
let patched = false;

export function installBridge(runtime: TaskRuntime): Promise<void> {
  slot.runtime = runtime;
  return ensurePatched();
}

export async function loadPiMcp(): Promise<typeof import("@earendil-works/pi-mcp")> {
  const loaded = await locate();
  return loaded.mcp;
}

/** Instrument a client the built-in connection already returned, or one a test connected. */
export function attachClient(client: object, server: string, runtime: TaskRuntime): void {
  const patchable = client as PatchableClient;
  slot.runtime = runtime;
  instrument(patchable, server);
  runtime.attachServer(server, async () => patchable);
}

async function ensurePatched(): Promise<void> {
  if (patched) return;
  const located = await locate();
  patchConnect(located.mcp.McpClient as unknown as { prototype: PatchableClient });
  for (const Connection of located.connections) patchGetClient(Connection);
  await patchBundledMcpClients(located.agentRoot);
  patched = true;
}

/** Patch McpClient classes the CLI bundle constructs and return them. */
export async function patchBundledMcpClients(agentRoot: string): Promise<BundledMcpClient[]> {
  const clients = await bundledMcpClients(agentRoot);
  for (const Client of clients) patchConnect(Client);
  return clients;
}

export async function bundledMcpClients(agentRoot: string): Promise<BundledMcpClient[]> {
  const clients: BundledMcpClient[] = [];
  const chunks = join(agentRoot, "dist/bundle/chunks");
  let names: string[] = [];
  try {
    names = readdirSync(chunks);
  } catch {
    return clients;
  }
  for (const name of names) {
    if (!/^runtime-.*\.js$/.test(name)) continue;
    for (const Client of await inlinedMcpClients(join(chunks, name))) {
      if (!clients.includes(Client)) clients.push(Client);
    }
  }
  return clients;
}

export interface BundledMcpClient {
  new (options?: { name?: string; version?: string; capabilities?: Record<string, unknown> }): PatchableClient;
  prototype: PatchableClient;
}

function patchConnect(Client: { prototype: PatchableClient }): void {
  const proto = Client.prototype as PatchableClient & Record<symbol, boolean>;
  if (proto[PATCH]) return;
  const original = proto.connect;
  if (typeof original !== "function") return;
  proto.connect = async function connect(this: PatchableClient, transport: unknown) {
    const options = this.options ?? {};
    this.options = Object.freeze({
      ...options,
      capabilities: withInitializeExtensions(options.capabilities),
    });
    return original.call(this, transport);
  };
  proto[PATCH] = true;
}

function patchGetClient(Connection: ConnectionLike): void {
  const proto = Connection.prototype as (ConnectionLike["prototype"] & Record<symbol, boolean>) | undefined;
  if (!proto || proto[PATCH] || typeof proto.getClient !== "function") return;
  const original = proto.getClient;
  proto.getClient = function getClient(this: { name?: string }) {
    const server = this.name ?? "mcp";
    return Promise.resolve(original.call(this)).then((client) => {
      instrument(client, server);
      slot.runtime?.attachServer(server, () => original.call(this));
      return client;
    });
  };
  proto[PATCH] = true;
}

const instrumented = new WeakMap<PatchableClient, { server: string }>();

function instrument(client: PatchableClient, server: string): void {
  const existing = instrumented.get(client);
  if (existing) {
    existing.server = server;
    return;
  }
  const original = client.request.bind(client);
  const state = { server };
  instrumented.set(client, state);
  client.request = (method, params, options) => {
    const prepared = prepareOutgoing(method, params);
    return headerStore.run({ method, taskId: prepared.taskId }, async () => {
      armHeaders(client);
      const result = await original(method, prepared.params, options);
      const runtime = slot.runtime;
      if (!runtime) return result;
      return runtime.observeCall(state.server, method, params, result);
    });
  };
  client.onNotification?.("notifications/tasks", (params) => {
    slot.runtime?.applyNotification(state.server, params);
  });
}

export function armHeaders(client: PatchableClient): void {
  const transport = client.transport;
  if (!transport || transport.__piMcpTasksHeaders || typeof transport.headers !== "function") return;
  const original = transport.headers.bind(transport);
  transport.headers = async (extra) => {
    const result = await original(extra);
    const context = headerStore.getStore();
    if (context && TASK_HEADER_METHODS.has(context.method) && context.taskId) {
      result.headers.set("Mcp-Name", context.taskId);
      result.headers.set("Mcp-Method", context.method);
    }
    return result;
  };
  transport.__piMcpTasksHeaders = true;
}

interface Located {
  agentRoot: string;
  mcp: typeof import("@earendil-works/pi-mcp");
  connections: ConnectionLike[];
}

let located: Promise<Located> | undefined;

function locate(): Promise<Located> {
  located ??= locateOnce();
  return located;
}

async function locateOnce(): Promise<Located> {
  const agentEntry = fileURLToPath(import.meta.resolve("@earendil-works/pi-coding-agent"));
  const agentRoot = dirname(dirname(agentEntry));
  const runtimeJs = join(agentRoot, "dist/extensions/mcp/runtime.js");
  const mcp = (await import(resolveFromFile(runtimeJs, "@earendil-works/pi-mcp"))) as typeof import("@earendil-works/pi-mcp");
  const connections: ConnectionLike[] = [];
  if (existsSync(runtimeJs)) {
    const unbundled = (await import(pathToFileURL(runtimeJs).href)) as { McpServerConnection?: ConnectionLike };
    if (typeof unbundled.McpServerConnection === "function") connections.push(unbundled.McpServerConnection);
  }
  const chunks = join(agentRoot, "dist/bundle/chunks");
  let names: string[] = [];
  try {
    names = readdirSync(chunks);
  } catch {
    names = [];
  }
  for (const name of names) {
    if (!/^runtime-.*\.js$/.test(name)) continue;
    try {
      const bundled = (await import(pathToFileURL(join(chunks, name)).href)) as { McpServerConnection?: ConnectionLike };
      if (typeof bundled.McpServerConnection === "function") connections.push(bundled.McpServerConnection);
    } catch {
      // The bundled CLI is optional. Per-request capability still applies to the SDK client.
    }
  }
  return { agentRoot, mcp, connections };
}

const NAMED_IMPORT = /import\s*\{([^}]*)\}\s*from\s*["']([^"']+)["']/g;
const SIDE_IMPORT = /import\s*["'](\.[^"']+)["']/g;
const EXPORT_CLAUSE = /export\s*\{([^}]*)\}/g;
const EXPORT_DECL = /export\s+(?:class|function)\s+([A-Za-z0-9_$]+)/g;

/**
 * Follow imports from `runtime-*.js` to the McpClient the bundle actually constructs.
 * The chunk filename is hashed, so it is not hard-coded.
 */
async function inlinedMcpClients(runtimePath: string): Promise<BundledMcpClient[]> {
  if (!runtimePath.includes(`${sep}bundle${sep}`)) return [];
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
