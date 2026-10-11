import { createRequire } from "node:module";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { spawn } from "node:child_process";
import { connectedClient, connectedServers, installBridge, piRoot } from "./src/bridge.ts";
import { startSite, type CspMeta, type PermissionsMeta, type ViewSite } from "./src/site.ts";

const APP_LINE = /^MCP app: (https?:\/\/\S+)/;

interface AppLine {
  render(width: number): string[];
  invalidate(): void;
}

interface TuiWidgets {
  Text: new (text?: string) => AppLine;
  VStack: new (children?: AppLine[]) => AppLine;
  hyperlink: (text: string, url: string) => string;
}

async function loadTui(): Promise<TuiWidgets> {
  const require = createRequire(import.meta.url);
  const agent = await piRoot();
  const entry = require.resolve("@earendil-works/pi-tui", { paths: [join(agent, "node_modules")] });
  return import(pathToFileURL(entry).href) as Promise<TuiWidgets>;
}

const UI_EXTENSION = "io.modelcontextprotocol/ui";

interface UiTool {
  server: string;
  name: string;
  resourceUri: string;
  appVisible: boolean;
  modelVisible: boolean;
}

interface AppResource {
  html: string;
  csp?: CspMeta;
  permissions?: PermissionsMeta;
}

/**
 * Render MCP Apps from the MCP servers pi is already connected to.
 * A tool result that names a ui:// resource gets a localhost link. The page embeds the
 * app in a sandboxed iframe on a different origin and forwards ui/message into the session.
 */
export async function createExtension(pi: ExtensionAPI): Promise<void> {
  const tools = new Map<string, UiTool>();
  const appLinks = new Map<string, string>();
  let site: ViewSite | undefined;
  let hasUx = false;
  let modelContext: string | undefined;
  let tui: TuiWidgets | undefined;

  pi.on("session_start", async (_event, ctx) => {
    hasUx = ctx.hasUI;
    if (hasUx && !tui) {
      tui = await loadTui();
      registerAppLink(pi, tui, appLinks);
    }
    void hideAppOnlyTools();
  });

  pi.on("mcp_servers_change", () => {
    void hideAppOnlyTools();
  });

  pi.on("context", (event) => {
    if (!modelContext) return;
    const note = `[mcp-app context] ${modelContext}`;
    const last = event.messages.at(-1) as { content?: unknown } | undefined;
    const text = JSON.stringify(last?.content ?? "");
    if (text.includes(note)) return;
    return {
      messages: [
        ...event.messages,
        { role: "user", content: [{ type: "text", text: note }], timestamp: Date.now() },
      ],
    };
  });

  await installBridge();
  const opened = await startSite(
    (view, text) => {
      const line = `[mcp-app ${view.server}/${view.tool}] ${text}`;
      void Promise.resolve(pi.sendUserMessage(line, { deliverAs: "followUp" })).catch((error: unknown) => {
        console.error(`[pi-mcp-apps] could not deliver ui/message: ${error instanceof Error ? error.message : error}`);
      });
    },
    async (view, name, args) => {
      const tool = tools.get(`${view.server}/${name}`);
      if (!tool?.appVisible) throw new Error(`Tool ${name} is not callable from this app`);
      return request(view.server, "tools/call", { name, arguments: args });
    },
    (view, uri) => request(view.server, "resources/read", { uri }),
    (_view, params) => {
      modelContext = JSON.stringify({ content: params.content, structuredContent: params.structuredContent });
    },
    async (url) => {
      const child = spawn("xdg-open", [url], { stdio: "ignore", detached: true });
      child.unref();
    },
  );
  site = opened;

  pi.registerTool({
    name: "mcp_apps_open",
    label: "Open MCP app",
    description: "Read a ui:// resource from a connected MCP server and return a localhost page that embeds it. Call this only when the user asks to open an MCP app.",
    promptGuidelines: ["Do not open an MCP app unless the user asks for it. A tool result that names a ui:// resource is not a request to open the app."],
    parameters: Type.Object({
      server: Type.String({ description: "Host-assigned MCP server label, the middle segment of mcp__server__tool" }),
      uri: Type.String({ description: "ui:// resource URI" }),
      tool: Type.Optional(Type.String({ description: "Tool name this view belongs to" })),
    }),
    async execute(_id, params) {
      const read = await readResource(params.server, params.uri);
      const link = site.publish({
        server: params.server,
        tool: params.tool ?? "app",
        html: read.html,
        csp: read.csp,
        permissions: read.permissions,
        arguments: {},
        resultText: "",
      });
      if (hasUx) appLinks.set(_id, link);
      return { content: [{ type: "text" as const, text: link }], details: { link } };
    },
  });

  pi.on("tool_result", async (event, ctx) => {
    const parsed = parseMcpTool(event.toolName);
    if (!parsed) return;
    const resourceUri = await rememberTools(parsed.server, parsed.tool);
    await hideAppOnlyTools();
    if (!ctx.hasUI || !resourceUri) return;
    if (!tui) {
      tui = await loadTui();
      registerAppLink(pi, tui, appLinks);
    }
    const html = await readResource(parsed.server, resourceUri);
    const text = event.content.filter((item) => item.type === "text").map((item) => item.text).join("\n");
    const link = site.publish({
      server: parsed.server,
      tool: parsed.tool,
      html: html.html,
      csp: html.csp,
      permissions: html.permissions,
      arguments: event.input,
      resultText: text,
    });
    appLinks.set(event.toolCallId, link);
  });

  async function rememberTools(server: string, tool: string): Promise<string | undefined> {
    const listed = await request(server, "tools/list", {}) as { tools?: Array<Record<string, unknown>> };
    for (const entry of listed.tools ?? []) {
      const name = typeof entry.name === "string" ? entry.name : "";
      const meta = isRecord(entry._meta) && isRecord(entry._meta.ui) ? entry._meta.ui : undefined;
      const flat = isRecord(entry._meta) && typeof entry._meta["ui/resourceUri"] === "string" ? entry._meta["ui/resourceUri"] : undefined;
      const resourceUri = meta && typeof meta.resourceUri === "string" ? meta.resourceUri : flat;
      if (!name || !resourceUri?.startsWith("ui://")) continue;
      const visibility = Array.isArray(meta?.visibility) ? meta.visibility : ["model", "app"];
      tools.set(`${server}/${name}`, {
        server,
        name,
        resourceUri,
        appVisible: visibility.includes("app"),
        modelVisible: visibility.includes("model"),
      });
    }
    return tools.get(`${server}/${tool}`)?.resourceUri;
  }

  async function hideAppOnlyTools(): Promise<void> {
    for (const server of connectedServers()) {
      try {
        await rememberTools(server, "");
      } catch (error) {
        console.error(`[pi-mcp-apps] could not list tools on ${server}: ${error instanceof Error ? error.message : error}`);
      }
    }
    const hidden = new Set(
      [...tools.values()].filter((tool) => !tool.modelVisible).map((tool) => `mcp__${tool.server}__${tool.name}`),
    );
    if (hidden.size === 0) return;
    const active = pi.getActiveTools().filter((name) => !hidden.has(name));
    if (active.length !== pi.getActiveTools().length) pi.setActiveTools(active);
  }
}

async function readResource(server: string, uri: string): Promise<AppResource> {
  const result = await request(server, "resources/read", { uri }) as {
    contents?: Array<{ text?: string; blob?: string; mimeType?: string; _meta?: unknown }>;
  };
  const content = result.contents?.[0];
  const html = content?.text ?? (content?.blob ? Buffer.from(content.blob, "base64").toString("utf8") : undefined);
  if (!html || content?.mimeType !== "text/html;profile=mcp-app") throw new Error(`Resource ${uri} is not an MCP app`);
  const ui = isRecord(content._meta) && isRecord(content._meta.ui) ? content._meta.ui : undefined;
  return {
    html,
    csp: ui && isRecord(ui.csp) ? ui.csp as CspMeta : undefined,
    permissions: ui && isRecord(ui.permissions) ? ui.permissions as PermissionsMeta : undefined,
  };
}

async function request(server: string, method: string, params: Record<string, unknown>): Promise<unknown> {
  const client = connectedClient(server);
  if (!client) throw new Error(`MCP server ${server} is not connected`);
  return client.request(method, params);
}

function parseMcpTool(toolName: string): { server: string; tool: string } | undefined {
  const match = /^mcp__([^_].*?)__([^_].+)$/.exec(toolName);
  if (!match?.[1] || !match[2]) return undefined;
  return { server: match[1], tool: match[2] };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function registerAppLink(pi: ExtensionAPI, tui: TuiWidgets, appLinks: Map<string, string>): void {
  pi.registerToolRenderer((toolName, next) => {
    if (!toolName.startsWith("mcp__") && toolName !== "mcp_apps_open") return undefined;
    const base = next();
    return {
      renderCall: base?.renderCall,
      renderResult: (result, options, theme, context) => {
        const link = appLinks.get(context.toolCallId);
        const shown = link ? hideAppLine(result) : result;
        const body = base?.renderResult?.(shown, options, theme, context);
        if (!link) return body ?? new tui.Text("");
        const line = new tui.Text(theme.fg("mdLink", tui.hyperlink("Open MCP App", link)));
        return body ? new tui.VStack([body as AppLine, line]) : line;
      },
    };
  });
}

function hideAppLine<T extends { content?: Array<{ type?: string; text?: string }> }>(result: T): T {
  if (!result.content) return result;
  return {
    ...result,
    content: result.content.filter((item) => !(item.type === "text" && item.text && APP_LINE.test(item.text.trim()))),
  };
}

export default function (pi: ExtensionAPI): Promise<void> {
  return createExtension(pi);
}

void UI_EXTENSION;
