/**
 * pi extension: MCP elicitation (form, URL, and multi round-trip requests).
 *
 * Uses the MCP connection pi already opened. It does not open a second connection.
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { approvalMode, protocolOffer } from "./src/approval-mode.ts";
import { installBridge } from "./src/bridge.ts";
import type { ElicitationUi } from "./src/elicit.ts";
import { openExternal } from "./src/open.ts";
import { ElicitationRuntime } from "./src/runtime.ts";

export { approvalMode, protocolOffer } from "./src/approval-mode.ts";
export { fulfillElicitation, validateFormContent, presentUrl } from "./src/elicit.ts";
export type { ElicitContext, ElicitResult, ElicitationUi } from "./src/elicit.ts";
export { buildMrtrRetryParams, readInputRequired } from "./src/mrtr.ts";
export { ElicitationRuntime } from "./src/runtime.ts";

export async function createExtension(pi: ExtensionAPI): Promise<ElicitationRuntime> {
  let context: ExtensionContext | undefined;
  pi.registerFlag("mcp-elicitations-approvals", {
    type: "string",
    default: "ui",
    description: "ui asks with dialogs. tool skips dialogs and uses mcp_elicitations_respond. PI_MCP_ELICITATIONS_APPROVALS wins.",
  });
  pi.registerFlag("mcp-elicitations-protocol", {
    type: "string",
    default: "",
    description: "Set to 2026-07-28 to offer that protocol version. Off by default. pi 1.4.0 still uses initialize. PI_MCP_ELICITATIONS_PROTOCOL wins.",
  });
  const runtime = new ElicitationRuntime({
    mode: () => approvalMode(pi.getFlag("mcp-elicitations-approvals")),
    protocol: () => protocolOffer(pi.getFlag("mcp-elicitations-protocol")),
    ui: () => dialogUi(context),
    openUrl: (url) => openExternal(url),
    notify: (message, type) => context?.ui.notify(message, type),
    deliver: (text) => {
      const turn = Boolean(context?.model);
      pi.sendMessage({
        customType: "mcp-elicitation",
        content: text,
        display: true,
      }, turn ? { triggerTurn: true, deliverAs: "followUp" } : { triggerTurn: false });
    },
    setStatus: (text) => context?.ui.setStatus("mcp-elicitations", text),
  });
  await installBridge(runtime);

  const remember = (ctx: ExtensionContext) => {
    context = ctx;
  };
  pi.on("session_start", (_event, ctx) => {
    remember(ctx);
  });
  pi.on("session_shutdown", () => {
    runtime.close();
  });

  pi.registerTool({
    name: "mcp_elicitations_list",
    label: "MCP elicitations",
    description: "List MCP elicitations waiting for mcp_elicitations_respond or mcp_elicitations_retry.",
    promptSnippet: "List MCP elicitations waiting for an answer",
    promptGuidelines: [
      "When a tool result says an MCP server needs elicitation, call mcp_elicitations_respond with the user's answer. Do not invent the content.",
      "For a URL, pass open true only after the user has agreed to open that exact URL.",
    ],
    parameters: Type.Object({}),
    execute: async (_toolCallId, _params, _signal, _onUpdate, ctx) => {
      remember(ctx);
      return { content: [{ type: "text", text: runtime.listText() }], details: undefined };
    },
  });
  pi.registerTool({
    name: "mcp_elicitations_respond",
    label: "Answer MCP elicitation",
    description: "Answer a pending elicitation. inputResponses is JSON: one {action, content?} object for a legacy elicitation/create, or a map of those objects keyed like inputRequests for a multi round-trip round. action is accept, decline, or cancel. Pass open true to consent to open a URL. Invalid form content is rejected and the elicitation stays pending.",
    parameters: Type.Object({
      id: Type.String({ description: "Pending elicitation id, such as e1" }),
      inputResponses: Type.String({ description: "JSON elicitation result, or a JSON object of results" }),
      open: Type.Optional(Type.Boolean({ description: "True consents to open every accepted URL in this response. The browser is not opened otherwise." })),
    }),
    execute: async (_toolCallId, params, _signal, _onUpdate, ctx) => {
      remember(ctx);
      const text = await runtime.respond(params.id, params.inputResponses, params.open === true);
      return { content: [{ type: "text", text }], details: undefined, ...(text.startsWith("Error:") ? { isError: true as const } : {}) };
    },
  });
  pi.registerTool({
    name: "mcp_elicitations_retry",
    label: "Retry MCP elicitation",
    description: "Retry a request that is waiting after a URL elicitation. Use this when notifications/elicitation/complete does not arrive.",
    parameters: Type.Object({
      id: Type.Optional(Type.String({ description: "Pending URL retry id. Omit to retry every one that is waiting." })),
    }),
    execute: async (_toolCallId, params, _signal, _onUpdate, ctx) => {
      remember(ctx);
      return { content: [{ type: "text", text: await runtime.retry(params.id) }], details: undefined };
    },
  });
  return runtime;
}

function dialogUi(context: ExtensionContext | undefined): ElicitationUi | undefined {
  if (!context?.hasUI) return undefined;
  return {
    select: (title, options) => context.ui.select(title, options),
    input: (title, placeholder) => context.ui.input(title, placeholder),
    editor: (title, prefill) => context.ui.editor(title, prefill),
    notify: (message, type) => context.ui.notify(message, type),
  };
}

const extension = createExtension;
export default extension;
