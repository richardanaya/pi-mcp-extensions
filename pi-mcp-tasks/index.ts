/**
 * pi extension: client for the MCP Tasks extension (SEP-2663).
 *
 * Uses pi's built-in MCP connection. Servers already registered with pi are the only servers
 * this extension talks to.
 */

import type { ExtensionContext, ExtensionFactory } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { approvalMode } from "./src/approval-mode.ts";
import { installBridge } from "./src/bridge.ts";
import { runTasksCommand } from "./src/commands.ts";
import { collectInputResponses, type InputUi } from "./src/input.ts";
import { isRecord, MESSAGE_TYPE, PERSIST_TYPE, toPersisted, type TrackedTask } from "./src/protocol.ts";
import { TaskRuntime, type TaskRuntimeOptions } from "./src/runtime.ts";

export type { TaskRuntimeOptions } from "./src/runtime.ts";

export function createTasksExtension(options: TaskRuntimeOptions = {}): ExtensionFactory {
  return async (pi) => {
    let context: ExtensionContext | undefined;
    pi.registerFlag("mcp-tasks-approvals", {
      type: "string",
      default: "ui",
      description: "ui asks before task input. tool skips dialogs and uses mcp_tasks_respond.",
    });
    const mode = approvalMode(pi.getFlag("mcp-tasks-approvals"));
    const runtime = new TaskRuntime({
      ...options,
      deliver: options.deliver ?? ((task, text) => deliver(pi, context, task, text)),
      persist: options.persist ?? ((task) => {
        pi.appendEntry(PERSIST_TYPE, toPersisted(task));
      }),
      notify: options.notify ?? ((message, type) => {
        context?.ui.notify(message, type ?? "info");
      }),
      setWidget: options.setWidget ?? ((lines) => {
        context?.ui.setWidget("mcp-tasks", lines);
      }),
      setStatus: options.setStatus ?? ((text) => {
        context?.ui.setStatus("mcp-tasks", text);
      }),
      promptInput: options.promptInput ?? (async (task, requests) => {
        const ui = mode === "tool" ? undefined : inputUi(context);
        if (!ui) {
          const keys = requests.map((request) => request.key).join(", ");
          deliver(
            pi,
            context,
            task,
            `MCP task ${task.taskId} on server ${task.server} needs input (${keys}). Call mcp_tasks_respond. Do not answer an elicitation or sampling request the user has not confirmed.`,
          );
          return undefined;
        }
        return collectInputResponses(ui, task, requests);
      }),
    });
    await installBridge(runtime);

    const remember = (ctx: ExtensionContext) => {
      context = ctx;
    };

    pi.on("session_start", (_event, ctx) => {
      remember(ctx);
      runtime.resume(ctx.sessionManager.getEntries().flatMap((entry) => (
        entry.type === "custom" && entry.customType === PERSIST_TYPE ? [entry.data] : []
      )));
    });
    pi.on("session_shutdown", () => {
      runtime.close();
    });
    pi.on("tool_result", (event, ctx) => {
      remember(ctx);
      const details = isRecord(event.details) ? event.details : undefined;
      const server = typeof details?.server === "string" ? details.server : undefined;
      if (!server) return undefined;
      const tool = typeof details?.tool === "string" ? details.tool : undefined;
      const text = runtime.toolResultText(server, tool, event.structuredContent);
      if (!text) return undefined;
      return {
        content: [{ type: "text" as const, text }],
        structuredContent: event.structuredContent,
      };
    });

    pi.registerTool({
      name: "mcp_tasks_list",
      label: "MCP tasks",
      description: "List MCP tasks from this session, with status, server, tool, and status message.",
      promptSnippet: "List running MCP tasks",
      promptGuidelines: [
        "When an MCP tool returns a task handle, the final result arrives later as a message of type mcp-task. Keep working only on other parts of the request until that message arrives.",
        "Use mcp_tasks_list, mcp_tasks_show, mcp_tasks_cancel, and mcp_tasks_respond to inspect and control those tasks.",
      ],
      parameters: Type.Object({}),
      execute: async (_toolCallId, _params, _signal, _onUpdate, ctx) => {
        remember(ctx);
        return { content: [{ type: "text", text: await runTasksCommand(runtime, "list") }], details: { tasks: runtime.list() } };
      },
    });
    pi.registerTool({
      name: "mcp_tasks_show",
      label: "MCP task",
      description: "Show one MCP task, including status, status message, poll interval, and any result or error.",
      parameters: Type.Object({ id: Type.String({ description: "Task id, or server/taskId when two servers share an id" }) }),
      execute: async (_toolCallId, params, _signal, _onUpdate, ctx) => {
        remember(ctx);
        return { content: [{ type: "text", text: await runTasksCommand(runtime, `show ${params.id}`) }], details: undefined };
      },
    });
    pi.registerTool({
      name: "mcp_tasks_cancel",
      label: "Cancel MCP task",
      description: "Ask the server to cancel an MCP task with tasks/cancel. This does not send notifications/cancelled.",
      parameters: Type.Object({ id: Type.String({ description: "Task id or server/taskId" }) }),
      execute: async (_toolCallId, params, _signal, _onUpdate, ctx) => {
        remember(ctx);
        return { content: [{ type: "text", text: await runTasksCommand(runtime, `cancel ${params.id}`) }], details: undefined };
      },
    });
    pi.registerTool({
      name: "mcp_tasks_respond",
      label: "Answer MCP task",
      description: "Send tasks/update inputResponses for an MCP task that is waiting on input. The value is a JSON object keyed by inputRequests keys. Keys already answered are not sent again.",
      parameters: Type.Object({
        id: Type.String({ description: "Task id or server/taskId" }),
        inputResponses: Type.String({ description: "JSON object of inputResponses" }),
      }),
      execute: async (_toolCallId, params, _signal, _onUpdate, ctx) => {
        remember(ctx);
        return {
          content: [{ type: "text", text: await runTasksCommand(runtime, `respond ${params.id} ${params.inputResponses}`) }],
          details: undefined,
        };
      },
    });
  };
}

function deliver(
  pi: Parameters<ExtensionFactory>[0],
  context: ExtensionContext | undefined,
  task: TrackedTask,
  text: string,
): void {
  const turn = Boolean(context?.model);
  pi.sendMessage({
    customType: MESSAGE_TYPE,
    content: text,
    display: true,
    details: { server: task.server, taskId: task.taskId, status: task.localOutcome ?? task.status },
  }, turn ? { triggerTurn: true, deliverAs: "followUp" } : { triggerTurn: false });
}

function inputUi(context: ExtensionContext | undefined): InputUi | undefined {
  if (!context?.hasUI) return undefined;
  return {
    confirm: (title, message) => context.ui.confirm(title, message),
    input: (title, placeholder) => context.ui.input(title, placeholder),
    notify: (message, type) => context.ui.notify(message, type),
  };
}

const extension = createTasksExtension();
export default extension;
