/**
 * Narrow patches on pi's built-in MCP client.
 *
 * pi 1.0.1 does not let an extension declare an extension capability at initialize, put `_meta`
 * on tools/call, set per-request HTTP headers, or send a custom method through a public API.
 * These patches use the client pi already constructed. They do not open a second connection.
 */

import { readdirSync } from "node:fs";
import { dirname, join } from "node:path";
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
  patched = true;
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
  const unbundled = await import(pathToFileURL(runtimeJs).href) as { McpServerConnection?: ConnectionLike };
  if (typeof unbundled.McpServerConnection === "function") connections.push(unbundled.McpServerConnection);
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
      const bundled = await import(pathToFileURL(join(chunks, name)).href) as { McpServerConnection?: ConnectionLike };
      if (typeof bundled.McpServerConnection === "function") connections.push(bundled.McpServerConnection);
    } catch {
      // The bundled CLI is optional. Per-request capability still applies to the SDK client.
    }
  }
  return { mcp, connections };
}
