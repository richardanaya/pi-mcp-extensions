import { createServer, type ServerResponse } from "node:http";
import { randomBytes } from "node:crypto";

export interface CspMeta {
  connectDomains?: string[];
  resourceDomains?: string[];
  frameDomains?: string[];
  baseUriDomains?: string[];
}

export interface PermissionsMeta {
  camera?: object;
  microphone?: object;
  geolocation?: object;
  clipboardWrite?: object;
}

export interface ViewRecord {
  token: string;
  server: string;
  tool: string;
  html: string;
  arguments: Record<string, unknown>;
  resultText: string;
  csp?: CspMeta;
  permissions?: PermissionsMeta;
  initialized: boolean;
  displayModes: string[];
}

export interface ViewSite {
  port: number;
  publish(view: Omit<ViewRecord, "token" | "initialized" | "displayModes">): string;
  close(): Promise<void>;
}

const BIND = "0.0.0.0";
const PAGE_HOST = "127.0.0.1";
const SANDBOX_HOST = "127.0.0.2";

export function startSite(
  onMessage: (view: ViewRecord, text: string) => void,
  onCall: (view: ViewRecord, name: string, args: Record<string, unknown>) => Promise<unknown>,
  onRead: (view: ViewRecord, uri: string) => Promise<unknown> = async () => {
    throw new Error("resources/read is not available");
  },
  onContext: (view: ViewRecord, params: Record<string, unknown>) => void = () => {},
  onOpen: (url: string) => Promise<void> = async () => {},
): Promise<ViewSite> {
  const views = new Map<string, ViewRecord>();
  let port = 0;
  const server = createServer(async (request, response) => {
    const url = new URL(request.url ?? "/", `http://${PAGE_HOST}`);
    const token = pathToken(url.pathname);
    const view = token ? views.get(token) : undefined;
    if (!view) {
      response.writeHead(404).end("not found");
      return;
    }
    if (request.method === "GET" && url.pathname.startsWith("/resource/")) {
      response.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end(view.html);
      return;
    }
    if (request.method === "GET" && url.pathname.startsWith("/view/")) {
      return html(response, hostPage(port, view.token, view));
    }
    if (request.method === "GET" && url.pathname.startsWith("/sandbox/")) {
      return html(response, sandboxPage(port, view));
    }
    if (request.method === "POST" && url.pathname.startsWith("/rpc/")) {
      const message = JSON.parse(await readBody(request)) as Record<string, unknown>;
      const answered = await dispatch(view, message, onMessage, onCall, onRead, onContext, onOpen);
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify(answered));
      return;
    }
    response.writeHead(404).end("not found");
  });
  return new Promise((resolve) => {
    server.listen(0, BIND, () => {
      const address = server.address();
      port = address && typeof address === "object" ? address.port : 0;
      resolve({
        port,
        publish(input) {
          const token = randomBytes(16).toString("hex");
          views.set(token, { ...input, token, initialized: false, displayModes: ["inline"] });
          return `http://${PAGE_HOST}:${port}/view/${token}`;
        },
        close: () => new Promise((done, reject) => server.close((error) => (error ? reject(error) : done()))),
      });
    });
  });
}

async function dispatch(
  view: ViewRecord,
  message: Record<string, unknown>,
  onMessage: (view: ViewRecord, text: string) => void,
  onCall: (view: ViewRecord, name: string, args: Record<string, unknown>) => Promise<unknown>,
  onRead: (view: ViewRecord, uri: string) => Promise<unknown>,
  onContext: (view: ViewRecord, params: Record<string, unknown>) => void,
  onOpen: (url: string) => Promise<void>,
): Promise<unknown> {
  const method = typeof message.method === "string" ? message.method : "";
  const id = message.id;
  const notify = id === undefined;
  const params = isRecord(message.params) ? message.params : {};
  if (method === "ui/initialize") {
    const caps = isRecord(params.appCapabilities) ? params.appCapabilities : {};
    const modes = Array.isArray(caps.availableDisplayModes)
      ? caps.availableDisplayModes.filter((mode): mode is string => typeof mode === "string")
      : [];
    view.displayModes = modes.length > 0 ? modes : ["inline"];
    view.initialized = true;
    const locale = Intl.DateTimeFormat().resolvedOptions();
    return result(id, {
      protocolVersion: "2026-01-26",
      hostCapabilities: {
        openLinks: {},
        serverTools: {},
        serverResources: {},
        logging: {},
        sandbox: { csp: view.csp ?? {}, permissions: view.permissions ?? {} },
      },
      hostInfo: { name: "pi-mcp-apps", version: "0.1.0" },
      hostContext: {
        toolInfo: { tool: { name: view.tool } },
        displayMode: "inline",
        availableDisplayModes: ["inline"],
        platform: "desktop",
        locale: locale.locale,
        timeZone: locale.timeZone,
      },
    });
  }
  if (method === "ui/notifications/initialized" || method === "ui/notifications/sandbox-proxy-ready") return null;
  if (!view.initialized) return notify ? null : error(id, -32002, "View is not initialized");
  if (method === "ping") return result(id, {});
  if (method === "notifications/message" || method === "ui/notifications/size-changed") return null;
  if (method === "ui/message") {
    const content = isRecord(params.content) ? params.content : {};
    const text = typeof content.text === "string" ? content.text : "";
    if (params.role !== "user" || content.type !== "text" || text.length === 0) return error(id, -32000, "Invalid message format");
    onMessage(view, text);
    return result(id, {});
  }
  if (method === "ui/update-model-context") {
    if (params.content !== undefined && !Array.isArray(params.content)) return error(id, -32000, "Invalid content format");
    if (params.structuredContent !== undefined && !isRecord(params.structuredContent)) return error(id, -32000, "Invalid content format");
    onContext(view, params);
    return result(id, {});
  }
  if (method === "ui/request-display-mode") {
    return result(id, { mode: "inline" });
  }
  if (method === "ui/open-link") {
    const url = typeof params.url === "string" ? params.url : "";
    if (!/^https?:\/\//.test(url)) return error(id, -32000, "Invalid URL");
    try {
      await onOpen(url);
      return result(id, {});
    } catch (caught) {
      return error(id, -32000, caught instanceof Error ? caught.message : "Link opening denied");
    }
  }
  if (method === "tools/call") {
    const name = typeof params.name === "string" ? params.name : "";
    const args = isRecord(params.arguments) ? params.arguments : {};
    try {
      return result(id, await onCall(view, name, args));
    } catch (caught) {
      return error(id, -32000, caught instanceof Error ? caught.message : "Tool call failed");
    }
  }
  if (method === "resources/read") {
    const uri = typeof params.uri === "string" ? params.uri : "";
    if (!uri) return error(id, -32602, "uri is required");
    try {
      return result(id, await onRead(view, uri));
    } catch (caught) {
      return error(id, -32000, caught instanceof Error ? caught.message : "Resource read failed");
    }
  }
  return notify ? null : error(id, -32601, `Method not found: ${method}`);
}

function hostPage(port: number, token: string, view: ViewRecord): string {
  const sandboxOrigin = `http://${SANDBOX_HOST}:${port}`;
  const rpc = `http://${PAGE_HOST}:${port}/rpc/${token}`;
  const csp = cspHeader(view.csp);
  const allow = allowAttr(view.permissions);
  return `<!DOCTYPE html>
<html><head><meta charset="utf-8"><title>MCP App</title>
<style>html,body{margin:0;height:100%}iframe{display:block;width:100%;height:100%;border:0}</style></head>
<body>
<iframe id="sandbox" sandbox="allow-scripts allow-same-origin" src="${sandboxOrigin}/sandbox/${token}"></iframe>
<script>
const sandboxOrigin = ${JSON.stringify(sandboxOrigin)};
const frame = document.getElementById("sandbox");
const toolArguments = ${embed(view.arguments)};
const toolResult = ${embed({ content: [{ type: "text", text: view.resultText }], isError: false })};
let ready = false;
window.addEventListener("message", async (event) => {
  if (event.origin !== sandboxOrigin || !event.data || event.data.jsonrpc !== "2.0") return;
  const data = event.data;
  if (data.method === "ui/notifications/sandbox-proxy-ready") {
    const resource = await fetch(${JSON.stringify(`http://${PAGE_HOST}:${port}/resource/${token}`)});
    frame.contentWindow.postMessage({
      jsonrpc: "2.0",
      method: "ui/notifications/sandbox-resource-ready",
      params: { html: await resource.text(), csp: ${embed(csp)}, allow: ${embed(allow)}, permissions: ${embed(view.permissions ?? {})} }
    }, sandboxOrigin);
    return;
  }
  const response = await fetch(${JSON.stringify(rpc)}, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(data)
  });
  const body = await response.json();
  if (body) frame.contentWindow.postMessage(body, sandboxOrigin);
  if (data.method === "ui/notifications/initialized" && !ready) {
    ready = true;
    frame.contentWindow.postMessage({ jsonrpc: "2.0", method: "ui/notifications/tool-input", params: { arguments: toolArguments } }, sandboxOrigin);
    frame.contentWindow.postMessage({ jsonrpc: "2.0", method: "ui/notifications/tool-result", params: toolResult }, sandboxOrigin);
    frame.contentWindow.postMessage({
      jsonrpc: "2.0",
      method: "ui/notifications/host-context-changed",
      params: { containerDimensions: { width: window.innerWidth, height: window.innerHeight }, displayMode: "inline" }
    }, sandboxOrigin);
  }
});
</script>
</body></html>`;
}

function sandboxPage(port: number, view: ViewRecord): string {
  const hostOrigin = `http://${PAGE_HOST}:${port}`;
    return `<!DOCTYPE html>
<html><head><meta charset="utf-8">
<style>html,body{margin:0;height:100%}iframe{display:block;width:100%;height:100%;border:0}</style></head>
<body>
<iframe id="view" sandbox="allow-scripts"></iframe>
<script>
const hostOrigin = ${JSON.stringify(hostOrigin)};
const viewFrame = document.getElementById("view");
parent.postMessage({ jsonrpc: "2.0", method: "ui/notifications/sandbox-proxy-ready" }, hostOrigin);
window.addEventListener("message", (event) => {
  const data = event.data;
  if (!data) return;
  if (event.source === parent && event.origin === hostOrigin) {
    if (data.method === "ui/notifications/sandbox-resource-ready") {
      const policy = typeof data.params?.csp === "string" ? data.params.csp : ${embed(cspHeader())};
      const allow = typeof data.params?.allow === "string" ? data.params.allow : "";
      if (allow) viewFrame.setAttribute("allow", allow);
      const raw = typeof data.params?.html === "string" ? data.params.html : "";
      viewFrame.srcdoc = injectCsp(raw, policy);
      return;
    }
    if (String(data.method || "").startsWith("ui/notifications/sandbox-")) return;
    viewFrame.contentWindow?.postMessage(data, "*");
    return;
  }
  if (event.source === viewFrame.contentWindow) {
    if (String(data.method || "").startsWith("ui/notifications/sandbox-")) return;
    parent.postMessage(data, hostOrigin);
  }
});
function injectCsp(html, policy) {
  const meta = '<meta http-equiv="Content-Security-Policy" content="' + String(policy).replace(/"/g, "") + '">';
  if (html.includes("<head>")) return html.replace("<head>", "<head>" + meta);
  return "<!DOCTYPE html><html><head>" + meta + "</head><body>" + html + "</body></html>";
}
</script>
</body></html>`;
}

/** JSON that cannot close a surrounding HTML script element. */
function embed(value: unknown): string {
  return JSON.stringify(value).replace(/</g, "\\u003c");
}

const ORIGIN = /^(?:https?|wss?):\/\/\*\.?[a-z0-9.-]+(?::\d+)?$/i;
const ORIGIN_EXACT = /^(?:https?|wss?):\/\/[a-z0-9.-]+(?::\d+)?$/i;

export function cspHeader(csp?: CspMeta): string {
  const resources = domains(csp?.resourceDomains);
  const connect = domains(csp?.connectDomains);
  const frames = domains(csp?.frameDomains);
  const bases = domains(csp?.baseUriDomains);
  const extra = resources.length ? ` ${resources.join(" ")}` : "";
  return [
    "default-src 'none'",
    `script-src 'self' 'unsafe-inline'${extra}`,
    `style-src 'self' 'unsafe-inline'${extra}`,
    `img-src 'self' data:${extra}`,
    `font-src 'self'${extra}`,
    `media-src 'self' data:${extra}`,
    `connect-src ${connect.length ? connect.join(" ") : "'none'"}`,
    `frame-src ${frames.length ? frames.join(" ") : "'none'"}`,
    "object-src 'none'",
    `base-uri ${bases.length ? bases.join(" ") : "'self'"}`,
  ].join("; ");
}

function domains(values: string[] | undefined): string[] {
  if (!values) return [];
  return values.filter((value) => ORIGIN.test(value) || ORIGIN_EXACT.test(value));
}

function allowAttr(permissions: PermissionsMeta | undefined): string {
  const allow: string[] = [];
  if (permissions?.camera) allow.push("camera");
  if (permissions?.microphone) allow.push("microphone");
  if (permissions?.geolocation) allow.push("geolocation");
  if (permissions?.clipboardWrite) allow.push("clipboard-write");
  return allow.join("; ");
}

function pathToken(pathname: string): string | undefined {
  const match = /^\/(?:view|sandbox|rpc|resource)\/([a-f0-9]+)$/.exec(pathname);
  return match?.[1];
}

function html(response: ServerResponse, body: string): void {
  response.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" }).end(body);
}

function result(id: unknown, value: unknown): unknown {
  return { jsonrpc: "2.0", id, result: value };
}

function error(id: unknown, code: number, message: string): unknown {
  return { jsonrpc: "2.0", id, error: { code, message } };
}

function readBody(request: { on(event: string, listener: (chunk?: Buffer) => void): void }): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk) => { if (chunk) chunks.push(chunk); });
    request.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    request.on("error", reject);
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
