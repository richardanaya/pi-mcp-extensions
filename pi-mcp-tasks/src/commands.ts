/** Text for the task tools. The argument shape is list, show, cancel, and respond. */

import { formatTaskMessage, isOpenTask, ttlLabel, type TrackedTask } from "./protocol.ts";
import type { TaskRuntime } from "./runtime.ts";

export type TasksAction =
  | { action: "list" }
  | { action: "show"; id: string }
  | { action: "cancel"; id: string }
  | { action: "respond"; id: string; body: string }
  | { action: "help"; error?: string };

export function parseTasksCommand(args: string): TasksAction {
  const trimmed = args.trim();
  if (!trimmed || trimmed === "list") return { action: "list" };
  const match = /^(\S+)(?:\s+(\S+))?(?:\s+([\s\S]+))?$/.exec(trimmed);
  if (!match) return { action: "help", error: usage() };
  const [, command, id, rest] = match;
  if ((command === "show" || command === "cancel") && id) return { action: command, id };
  if (command === "respond" && id && rest) return { action: "respond", id, body: rest.trim() };
  return { action: "help", error: usage() };
}

export function usage(): string {
  return "Use mcp_tasks_list, mcp_tasks_show, mcp_tasks_cancel, or mcp_tasks_respond.";
}

export function formatTaskList(tasks: readonly TrackedTask[], now: number): string {
  if (tasks.length === 0) return "No MCP tasks.";
  return tasks
    .map((task) => {
      const state = task.localOutcome ?? task.status;
      const message = task.statusMessage ? ` — ${task.statusMessage}` : "";
      const open = isOpenTask(task) ? `  poll ${task.pollIntervalMs}ms  ${ttlLabel(task, now)}` : "";
      return `${task.server}/${task.taskId}  ${state}${message}${open}`;
    })
    .join("\n");
}

export function formatTaskShow(task: TrackedTask, now: number): string {
  return [
    formatTaskMessage(task),
    `pollIntervalMs: ${task.pollIntervalMs}`,
    ttlLabel(task, now),
    task.answeredKeys.length > 0 ? `answered: ${task.answeredKeys.join(", ")}` : "",
  ]
    .filter((line) => line.length > 0)
    .join("\n");
}

export async function runTasksCommand(runtime: TaskRuntime, args: string, now = Date.now()): Promise<string> {
  const parsed = parseTasksCommand(args);
  if (parsed.action === "help") return parsed.error ?? usage();
  if (parsed.action === "list") return formatTaskList(runtime.list(), now);
  if (parsed.action === "show") {
    const found = runtime.find(parsed.id);
    if ("error" in found) return found.error;
    return formatTaskShow(found.task, now);
  }
  if (parsed.action === "cancel") return runtime.cancel(parsed.id);
  let body: unknown;
  try {
    body = JSON.parse(parsed.body);
  } catch {
    return "inputResponses must be a JSON object.";
  }
  if (typeof body !== "object" || body === null || Array.isArray(body)) return "inputResponses must be a JSON object.";
  return runtime.respond(parsed.id, body as Record<string, unknown>);
}
