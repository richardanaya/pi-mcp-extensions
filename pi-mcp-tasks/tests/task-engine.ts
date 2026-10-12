/**
 * In-process SEP-2663 fixture. Stdio and HTTP tests share it.
 * `legacy` answers tools/call with CallToolResult and rejects every tasks method.
 */

import { appendFileSync } from "node:fs";
import { MISSING_CAPABILITY, TASKS_EXTENSION_ID } from "../src/protocol.ts";

export interface EngineCall {
  method: string;
  hasTaskParam: boolean;
  argumentTask: unknown;
  hasTasksCapability: boolean;
  legacyTasksCapability: boolean;
  mcpName?: string;
  mcpMethod?: string;
}

interface Job {
  tool: string;
  createdAt: string;
  ttlMs: number | null;
  pollIntervalMs: number;
  gets: number;
  answeredName?: string;
  cancelRequested: boolean;
}

export class TaskEngine {
  readonly calls: EngineCall[] = [];
  private readonly jobs = new Map<string, Job>();
  private readonly pendingNotes: unknown[] = [];
  private seq = 1;
  private readonly legacy: boolean;

  constructor(legacy = false) {
    this.legacy = legacy;
  }

  handle(message: unknown, headers: Record<string, string | undefined> = {}): unknown | undefined {
    if (!isRecord(message) || typeof message.method !== "string") {
      const id = isRecord(message) ? message.id : null;
      return rpcError(id ?? null, -32600, "Invalid request");
    }
    const params = isRecord(message.params) ? message.params : {};
    const record: EngineCall = {
      method: message.method,
      hasTaskParam: "task" in params,
      argumentTask: isRecord(params.arguments) ? params.arguments.task : undefined,
      hasTasksCapability: hasTasksCapability(params),
      legacyTasksCapability: isRecord(params.capabilities) && "tasks" in params.capabilities,
      mcpName: headers["mcp-name"] ?? headers["Mcp-Name"],
      mcpMethod: headers["mcp-method"] ?? headers["Mcp-Method"],
    };
    this.calls.push(record);
    const trace = process.env.PI_MCP_TASKS_TRACE;
    if (trace) appendFileSync(trace, `${JSON.stringify(record)}\n`);
    if (message.id === undefined) return undefined;
    try {
      return { jsonrpc: "2.0", id: message.id, result: this.dispatch(message.method, params) };
    } catch (error) {
      const code = isRecord(error) && typeof error.code === "number" ? error.code : -32603;
      const messageText = isRecord(error) && typeof error.message === "string" ? error.message : "Internal error";
      const data = isRecord(error) ? error.data : undefined;
      return { jsonrpc: "2.0", id: message.id, error: { code, message: messageText, ...(data === undefined ? {} : { data }) } };
    }
  }

  drain(): unknown[] {
    return this.pendingNotes.splice(0);
  }

  private dispatch(method: string, params: Record<string, unknown>): unknown {
    if (method === "initialize") {
      return {
        protocolVersion: "2025-11-25",
        capabilities: this.legacy ? { tools: {} } : { tools: {}, extensions: { [TASKS_EXTENSION_ID]: {} } },
        serverInfo: { name: "pi-mcp-tasks-fixture", version: "0.0.0" },
      };
    }
    if (method === "ping") return {};
    if (method === "tools/list") return { tools: TOOLS };
    if (method === "server/discover") {
      return { capabilities: this.legacy ? {} : { extensions: { [TASKS_EXTENSION_ID]: {} } } };
    }
    if (method === "subscriptions/listen") {
      if (this.legacy) fail(-32601, "Method not found");
      const taskIds = isRecord(params.notifications) && Array.isArray(params.notifications.taskIds)
        ? params.notifications.taskIds
        : [];
      return { notifications: { taskIds } };
    }
    if (method === "tasks/result" || (this.legacy && method.startsWith("tasks/"))) fail(-32601, "Method not found");
    if (method === "tasks/get") return this.get(params);
    if (method === "tasks/update") return this.update(params);
    if (method === "tasks/cancel") return this.cancel(params);
    if (method === "tools/call") return this.call(params);
    fail(-32601, "Method not found");
  }

  private call(params: Record<string, unknown>): unknown {
    const name = typeof params.name === "string" ? params.name : "";
    if (this.legacy || name === "echo") {
      const message = isRecord(params.arguments) && typeof params.arguments.message === "string" ? params.arguments.message : name;
      return { content: [{ type: "text", text: this.legacy ? `legacy ${message}` : message }], isError: false };
    }
    if (!TASK_TOOLS.has(name)) fail(-32602, `Unknown tool ${name}`);
    if (!hasTasksCapability(params)) {
      fail(MISSING_CAPABILITY, "Missing required client capability", {
        requiredCapabilities: { extensions: { [TASKS_EXTENSION_ID]: {} } },
      });
    }
    const taskId = `task-${this.seq++}`;
    const now = new Date().toISOString();
    const expire = name === "expire_job";
    this.jobs.set(taskId, {
      tool: name,
      createdAt: now,
      ttlMs: expire ? 300 : 60_000,
      pollIntervalMs: expire ? 5_000 : 40,
      gets: 0,
      cancelRequested: false,
    });
    return this.view(this.jobs.get(taskId)!, taskId, true);
  }

  private get(params: Record<string, unknown>): unknown {
    this.requireCapability(params);
    const job = this.job(params);
    job.gets += 1;
    if (job.tool === "fail_job") {
      return {
        ...this.base(job, this.idOf(job), "failed"),
        resultType: "complete",
        statusMessage: "Tool execution failed: API rate limit exceeded",
        error: { code: -32603, message: "API rate limit exceeded" },
      };
    }
    if (job.tool === "tool_error_job") {
      return {
        ...this.base(job, this.idOf(job), "completed"),
        resultType: "complete",
        result: { content: [{ type: "text", text: "Failed to process request: invalid input" }], isError: true },
      };
    }
    if (job.tool === "ask_job") {
      if (!job.answeredName) {
        return {
          ...this.base(job, this.idOf(job), "input_required"),
          resultType: "complete",
          inputRequests: {
            name: {
              method: "elicitation/create",
              params: {
                mode: "form",
                message: "Please enter your name.",
                requestedSchema: { type: "object", properties: { name: { type: "string" } }, required: ["name"] },
              },
            },
          },
        };
      }
      return {
        ...this.base(job, this.idOf(job), "completed"),
        resultType: "complete",
        result: { content: [{ type: "text", text: `Hello, ${job.answeredName}` }], isError: false },
      };
    }
    if (job.cancelRequested) {
      return { ...this.base(job, this.idOf(job), "cancelled"), resultType: "complete", statusMessage: "Cancelled by client." };
    }
    if (job.tool === "complete_job" && job.gets >= 2) {
      return {
        ...this.base(job, this.idOf(job), "completed"),
        resultType: "complete",
        statusMessage: "The operation finished.",
        result: { content: [{ type: "text", text: "Operation completed successfully." }], isError: false },
      };
    }
    return { ...this.base(job, this.idOf(job), "working"), resultType: "complete", statusMessage: "The operation is now in progress." };
  }

  private update(params: Record<string, unknown>): unknown {
    this.requireCapability(params);
    const job = this.job(params);
    const responses = isRecord(params.inputResponses) ? params.inputResponses : {};
    const answer = responses.name;
    if (isRecord(answer) && isRecord(answer.content)) {
      const value = answer.content.name ?? answer.content.input;
      if (typeof value === "string") job.answeredName = value;
    }
    return { resultType: "complete" };
  }

  private cancel(params: Record<string, unknown>): unknown {
    this.requireCapability(params);
    const job = this.job(params);
    job.cancelRequested = true;
    const taskId = this.idOf(job);
    this.pendingNotes.push({
      jsonrpc: "2.0",
      method: "notifications/tasks",
      params: { ...this.base(job, taskId, "cancelled"), statusMessage: "Cancelled by client." },
    });
    return { resultType: "complete" };
  }

  private job(params: Record<string, unknown>): Job {
    const taskId = typeof params.taskId === "string" ? params.taskId : "";
    const job = this.jobs.get(taskId);
    if (!job) fail(-32602, "Failed to retrieve task: Task not found");
    return job;
  }

  private idOf(job: Job): string {
    for (const [id, candidate] of this.jobs) if (candidate === job) return id;
    return "";
  }

  private requireCapability(params: Record<string, unknown>): void {
    if (!hasTasksCapability(params)) {
      fail(MISSING_CAPABILITY, "Missing required client capability", {
        requiredCapabilities: { extensions: { [TASKS_EXTENSION_ID]: {} } },
      });
    }
  }

  private view(job: Job, taskId: string, create: boolean): unknown {
    return { ...this.base(job, taskId, "working"), ...(create ? { resultType: "task" } : { resultType: "complete" }), statusMessage: "The operation is now in progress." };
  }

  private base(job: Job, taskId: string, status: string): Record<string, unknown> {
    return {
      taskId,
      status,
      createdAt: job.createdAt,
      lastUpdatedAt: new Date().toISOString(),
      ttlMs: job.ttlMs,
      pollIntervalMs: job.pollIntervalMs,
    };
  }
}

const TASK_TOOLS = new Set(["complete_job", "fail_job", "cancel_job", "ask_job", "expire_job", "tool_error_job", "hang_job"]);

const TOOLS = [...TASK_TOOLS, "echo"].map((name) => ({
  name,
  description: name,
  inputSchema: { type: "object", properties: { message: { type: "string" }, task: { type: "string" } } },
}));

function hasTasksCapability(params: Record<string, unknown>): boolean {
  const meta = params._meta;
  if (!isRecord(meta)) return false;
  const caps = meta["io.modelcontextprotocol/clientCapabilities"];
  if (!isRecord(caps) || !isRecord(caps.extensions)) return false;
  return Object.prototype.hasOwnProperty.call(caps.extensions, TASKS_EXTENSION_ID);
}

function fail(code: number, message: string, data?: unknown): never {
  const error: { code: number; message: string; data?: unknown } = { code, message };
  if (data !== undefined) error.data = data;
  throw error;
}

function rpcError(id: unknown, code: number, message: string): unknown {
  return { jsonrpc: "2.0", id, error: { code, message } };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
