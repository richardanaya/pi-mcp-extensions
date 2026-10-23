/**
 * Narrow patches on pi's built-in MCP client.
 *
 * pi 1.3.0 does not let an extension add the elicitation capability at initialize
 * or handle `elicitation/create` on the client it already opened. These patches
 * use that client. They do not open a second connection.
 *
 * The `pi` CLI inlines McpClient inside `dist/bundle/chunks/`. That class is not
 * the `@earendil-works/pi-mcp` export. `connect` is patched on both. The chunk
 * hash is not hard-coded: `runtime-*.js` is followed to the client it imports.
 */

import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { enableProtocol2026, withElicitationCapability, withElicitationMeta } from "./protocol.ts";
import { MRTR_METHODS } from "./mrtr.ts";
import type { ElicitationRuntime } from "./runtime.ts";
import { isRecord } from "./schema.ts";

const PATCH = Symbol.for("pi-mcp-elicitations.bridge");

interface PatchableClient {
  options?: { capabilities?: Record<string, unknown>; protocolVersion?: string } & Record<string, unknown>;
  protocolVersion?: string;
  connect?: (transport: unknown) => Promise<unknown>;
  request: (method: string, params?: Record<string, unknown>, options?: unknown) => Promise<unknown>;
  setRequestHandler?: (method: string, handler: (params: unknown, context: { signal: AbortSignal }) => unknown) => () => void;
  onNotification?: (method: string, listener: (params: unknown) => void) => unknown;
}

interface ConnectionLike {
  name?: string;
  entry?: { name?: string };
  prototype?: { getClient?: () => Promise<PatchableClient>; connectOnce?: () => Promise<PatchableClient> };
}

export interface BundledMcpClient {
  new (options?: { name?: string; version?: string; capabilities?: Record<string, unknown> }): PatchableClient;
  prototype: PatchableClient;
}

const slot: { runtime?: ElicitationRuntime } = {};
let patched = false;

export function installBridge(runtime: ElicitationRuntime): Promise<void> {
  slot.runtime = runtime;
  return ensurePatched();
}

export function attachClient(client: object, server: string, runtime: ElicitationRuntime): void {
  slot.runtime = runtime;
  instrument(client as PatchableClient, server);
}

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

/**
 * The package client checks this exported array. The CLI bundle inlines a second
 * copy and does not export it; {@link enableProtocol2026} reaches that copy
 * through `Array.prototype.includes`.
 */
export async function exportedProtocolLists(): Promise<string[][]> {
  try {
    const mcp = await import("@earendil-works/pi-mcp");
    return Array.isArray(mcp.SUPPORTED_PROTOCOL_VERSIONS) ? [mcp.SUPPORTED_PROTOCOL_VERSIONS as unknown as string[]] : [];
  } catch {
    return [];
  }
}

async function ensurePatched(): Promise<void> {
  if (patched) return;
  const located = await locate();
  patchConnect(located.mcp.McpClient as unknown as { prototype: PatchableClient });
  for (const Connection of located.connections) patchConnection(Connection);
  await patchBundledMcpClients(located.agentRoot);
  patched = true;
}

function patchConnect(Client: { prototype: PatchableClient }): void {
  const proto = Client.prototype as PatchableClient & Record<symbol, boolean>;
  if (proto[PATCH]) return;
  const original = proto.connect;
  if (typeof original !== "function") return;
  proto.connect = async function connect(this: PatchableClient, transport: unknown) {
    const options = this.options ?? {};
    const offer = slot.runtime?.offer();
    if (offer === "2026-07-28") enableProtocol2026(await exportedProtocolLists());
    const next: Record<string, unknown> = {
      ...options,
      capabilities: withElicitationCapability(isRecord(options.capabilities) ? options.capabilities : undefined),
    };
    if (offer === "2026-07-28") next.protocolVersion = offer;
    this.options = Object.freeze(next);
    return original.call(this, transport);
  };
  proto[PATCH] = true;
}

function patchConnection(Connection: ConnectionLike): void {
  const proto = Connection.prototype as (ConnectionLike["prototype"] & Record<symbol, boolean>) | undefined;
  if (!proto || proto[PATCH]) return;
  if (typeof proto.connectOnce === "function") {
    const originalOnce = proto.connectOnce;
    proto.connectOnce = function connectOnce(this: ConnectionLike) {
      const server = serverName(this);
      return Promise.resolve(originalOnce.call(this)).then((client) => {
        instrument(client, server);
        return client;
      });
    };
  }
  if (typeof proto.getClient === "function") {
    const original = proto.getClient;
    proto.getClient = function getClient(this: ConnectionLike) {
      const server = serverName(this);
      return Promise.resolve(original.call(this)).then((client) => {
        instrument(client, server);
        return client;
      });
    };
  }
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
    const runtime = slot.runtime;
    const negotiated = typeof client.protocolVersion === "string" ? client.protocolVersion : undefined;
    const send = (nextMethod: string, nextParams?: Record<string, unknown>, nextOptions?: unknown) => {
      const prepared = MRTR_METHODS.has(nextMethod) ? withElicitationMeta(nextParams, negotiated) : nextParams;
      return original(nextMethod, prepared, nextOptions);
    };
    if (!runtime) return send(method, params, options);
    return runtime.around(state.server, method, params, options, send);
  };
  client.setRequestHandler?.("elicitation/create", (params, context) => {
    const runtime = slot.runtime;
    if (!runtime) return { action: "cancel" };
    return runtime.legacy(state.server, params, context.signal);
  });
  client.onNotification?.("notifications/elicitation/complete", (params) => {
    slot.runtime?.completeNotification(state.server, params);
  });
}

function serverName(connection: ConnectionLike): string {
  if (typeof connection.name === "string" && connection.name.length > 0) return connection.name;
  if (typeof connection.entry?.name === "string" && connection.entry.name.length > 0) return connection.entry.name;
  return "mcp";
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
  const runtimeUrl = pathToFileURL(runtimeJs).href;
  const mcpUrl = import.meta.resolve("@earendil-works/pi-mcp", runtimeUrl);
  const mcp = (await import(mcpUrl)) as typeof import("@earendil-works/pi-mcp");
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
      // The bundled CLI is optional. Capability still applies to the SDK client.
    }
  }
  return { agentRoot, mcp, connections };
}

const NAMED_IMPORT = /import\s*\{([^}]*)\}\s*from\s*["']([^"']+)["']/g;
const SIDE_IMPORT = /import\s*["'](\.[^"']+)["']/g;
const EXPORT_CLAUSE = /export\s*\{([^}]*)\}/g;
const EXPORT_DECL = /export\s+(?:class|function)\s+([A-Za-z0-9_$]+)/g;

/** Follow imports from `runtime-*.js` to the McpClient the bundle actually constructs. */
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
    if (clauseNames(match[1] ?? "").includes(exportName)) specs.push(match[2] ?? "");
  }
  return specs.filter((spec) => spec.length > 0);
}

function relativeSpecifiers(source: string): string[] {
  const specs: string[] = [];
  for (const match of source.matchAll(NAMED_IMPORT)) {
    if ((match[2] ?? "").startsWith(".")) specs.push(match[2] ?? "");
  }
  for (const match of source.matchAll(SIDE_IMPORT)) specs.push(match[1] ?? "");
  return specs.filter((spec) => spec.length > 0);
}

function exportsName(source: string, name: string): boolean {
  for (const match of source.matchAll(EXPORT_CLAUSE)) {
    if (clauseNames(match[1] ?? "").includes(name)) return true;
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
