/**
 * Fulfill task inputRequests with the same confirm-before-accept trust model as a direct
 * elicitation or sampling request. Nothing is accepted silently.
 *
 * Elicitation `content` is built from `requestedSchema` properties. The SEP example sends
 * `{ input: "Luca" }` while the schema asks for `{ name }`; the schema is the normative shape.
 */

import type { InputRequest, TrackedTask } from "./protocol.ts";
import { isRecord } from "./protocol.ts";

export interface PendingInput {
  key: string;
  request: InputRequest;
}

export interface InputUi {
  confirm(title: string, message: string): Promise<boolean>;
  input(title: string, placeholder?: string): Promise<string | undefined>;
  notify(message: string, type?: "info" | "warning" | "error"): void;
}

export async function collectInputResponses(
  ui: InputUi | undefined,
  task: TrackedTask,
  requests: readonly PendingInput[],
): Promise<Record<string, unknown> | undefined> {
  if (!ui || requests.length === 0) return undefined;
  const responses: Record<string, unknown> = {};
  for (const item of requests) {
    const response = await collectOne(ui, task, item);
    if (!response) return undefined;
    responses[item.key] = response;
  }
  return responses;
}

async function collectOne(ui: InputUi, task: TrackedTask, item: PendingInput): Promise<unknown | undefined> {
  const params = item.request.params ?? {};
  const message = typeof params.message === "string" ? params.message : `Input required for task ${task.taskId}.`;
  const allowed = await ui.confirm(
    `MCP task ${task.taskId}`,
    `${item.request.method} from server ${task.server}.\n${message}\n\nAnswer this request?`,
  );
  if (!allowed) {
    ui.notify(`Left ${item.key} pending. Call mcp_tasks_respond for ${task.taskId}.`, "warning");
    return undefined;
  }
  if (item.request.method === "elicitation/create") return collectElicitation(ui, params);
  if (item.request.method === "sampling/createMessage") return collectSampling(ui, params);
  ui.notify(`No UI for ${item.request.method}. Call mcp_tasks_respond for ${task.taskId}.`, "warning");
  return undefined;
}

async function collectElicitation(ui: InputUi, params: Record<string, unknown>): Promise<unknown | undefined> {
  const mode = typeof params.mode === "string" ? params.mode : "form";
  if (mode === "url") {
    const url = typeof params.url === "string" ? params.url : "";
    ui.notify(url ? `Open ${url}` : "The server asked you to complete a URL elicitation.", "info");
    const done = await ui.confirm("Elicitation", "Confirm when the URL step is finished.");
    if (!done) return undefined;
    return { action: "accept" };
  }
  const schema = isRecord(params.requestedSchema) ? params.requestedSchema : {};
  const properties = isRecord(schema.properties) ? schema.properties : {};
  const content: Record<string, unknown> = {};
  const names = Object.keys(properties);
  if (names.length === 0) {
    const value = await ui.input("Response", "Value");
    if (value === undefined) return undefined;
    content.value = value;
  } else {
    for (const name of names) {
      const property = properties[name];
      const hint = isRecord(property) && typeof property.description === "string" ? property.description : name;
      const value = await ui.input(name, hint);
      if (value === undefined) return undefined;
      content[name] = coerce(value, property);
    }
  }
  return { action: "accept", content };
}

async function collectSampling(ui: InputUi, params: Record<string, unknown>): Promise<unknown | undefined> {
  const prompt = typeof params.systemPrompt === "string" ? params.systemPrompt : "Sampling response";
  const text = await ui.input("Sampling", prompt);
  if (text === undefined) return undefined;
  return {
    role: "assistant",
    content: { type: "text", text },
    model: "user",
    stopReason: "endTurn",
  };
}

function coerce(value: string, property: unknown): unknown {
  const type = isRecord(property) && typeof property.type === "string" ? property.type : "string";
  if (type === "number" || type === "integer") {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : value;
  }
  if (type === "boolean") return value === "true";
  return value;
}
