/**
 * SEP-2663 client protocol helpers.
 *
 * Readings chosen where the spec is silent or inconsistent are documented in the README.
 */

export const TASKS_EXTENSION_ID = "io.modelcontextprotocol/tasks";
export const CLIENT_CAPABILITIES_META = "io.modelcontextprotocol/clientCapabilities";

/** Methods that must carry the tasks capability or the server returns -32021 (Missing Required Client Capability). */
export const CAPABILITY_METHODS = new Set([
  "tools/call",
  "tasks/get",
  "tasks/update",
  "tasks/cancel",
  "subscriptions/listen",
]);

/**
 * Request types that may return CreateTaskResult. A Set so a later revision can add methods
 * without a second code path (C-SHOULD-01). `tools/call` is the only method in this revision.
 */
export const SUPPORTED_TASK_METHODS = new Set<string>(["tools/call"]);

/** Streamable HTTP routing headers apply to these methods only. */
export const TASK_HEADER_METHODS = new Set(["tasks/get", "tasks/update", "tasks/cancel"]);

export const SPEC_STATUSES = ["working", "input_required", "completed", "cancelled", "failed"] as const;
export type SpecStatus = (typeof SPEC_STATUSES)[number];

export const TERMINAL_STATUSES = new Set<SpecStatus>(["completed", "cancelled", "failed"]);

/**
 * Spec does not define a default. A missing or non-positive pollIntervalMs waits this long
 * so a server that omits the field cannot be polled in a tight loop.
 */
export const DEFAULT_POLL_INTERVAL_MS = 1000;

/** Missing Required Client Capability. Core schema 2026-07-28 and the ext-tasks spec. */
export const MISSING_CAPABILITY = -32021;
export const INVALID_PARAMS = -32602;
export const METHOD_NOT_FOUND = -32601;

export const PERSIST_TYPE = "pi-mcp-tasks";
export const MESSAGE_TYPE = "mcp-task";

export type LocalOutcome = "cancel_requested" | "expired" | "unavailable" | "disconnected";

export interface JsonRpcErrorShape {
  code: number;
  message: string;
  data?: unknown;
}

export interface InputRequest {
  method: string;
  params?: Record<string, unknown>;
}

export interface TaskSnapshot {
  taskId: string;
  status: SpecStatus;
  statusMessage?: string;
  createdAt: string;
  lastUpdatedAt?: string;
  ttlMs: number | null;
  pollIntervalMs: number;
  inputRequests?: Record<string, InputRequest>;
  result?: unknown;
  error?: JsonRpcErrorShape;
}

export interface TrackedTask extends TaskSnapshot {
  server: string;
  tool?: string;
  answeredKeys: string[];
  pendingKeys: string[];
  delivered: boolean;
  includedInToolResult: boolean;
  localOutcome?: LocalOutcome;
  outcomeDetail?: string;
  toolCallId?: string;
}

export class InvalidTaskResultError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidTaskResultError";
  }
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function taskKey(server: string, taskId: string): string {
  return `${server}\0${taskId}`;
}

export function isTerminalStatus(status: string): boolean {
  return TERMINAL_STATUSES.has(status as SpecStatus);
}

export function isOpenTask(task: TrackedTask): boolean {
  return !task.localOutcome && !isTerminalStatus(task.status);
}

/** Positive intervals are honored (non-integers rounded). Anything else uses the default. */
export function normalizePollInterval(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) return DEFAULT_POLL_INTERVAL_MS;
  return Math.round(value);
}

export function normalizeTtl(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) return null;
  return Math.round(value);
}

/** Deadline in epoch ms, or undefined when TTL is unlimited or createdAt cannot be parsed. */
export function ttlDeadline(createdAt: string, ttlMs: number | null): number | undefined {
  if (ttlMs === null) return undefined;
  const created = Date.parse(createdAt);
  if (Number.isNaN(created)) return undefined;
  return created + ttlMs;
}

/**
 * MAY backstop: a non-terminal task is unusable once createdAt + ttlMs has elapsed.
 * Equal to the deadline counts as elapsed.
 */
export function isPastTtl(now: number, task: Pick<TaskSnapshot, "createdAt" | "ttlMs" | "status">): boolean {
  if (isTerminalStatus(task.status)) return false;
  const deadline = ttlDeadline(task.createdAt, task.ttlMs);
  return deadline !== undefined && now >= deadline;
}

export function emptyTasksCapability(): Record<string, unknown> {
  return {};
}

/** Merge the tasks extension into per-request client capabilities. Does not touch tool arguments. */
export function withTasksCapability(params: Record<string, unknown> | undefined): Record<string, unknown> {
  const next: Record<string, unknown> = { ...(params ?? {}) };
  if ("task" in next) delete next.task;
  const meta = isRecord(next._meta) ? { ...next._meta } : {};
  const caps = isRecord(meta[CLIENT_CAPABILITIES_META]) ? { ...meta[CLIENT_CAPABILITIES_META] } : {};
  const extensions = isRecord(caps.extensions) ? { ...caps.extensions } : {};
  extensions[TASKS_EXTENSION_ID] = emptyTasksCapability();
  caps.extensions = extensions;
  meta[CLIENT_CAPABILITIES_META] = caps;
  next._meta = meta;
  return next;
}

/**
 * Remove the legacy 2025-11-25 tasks capability object (`tasks.requests`, `tasks.list`, `tasks.cancel`).
 * The extension capability lives under `extensions`, which this leaves in place.
 */
export function stripLegacyCapabilities(capabilities: Record<string, unknown> | undefined): Record<string, unknown> {
  const next = { ...(capabilities ?? {}) };
  delete next.tasks;
  return next;
}

export function withInitializeExtensions(capabilities: Record<string, unknown> | undefined): Record<string, unknown> {
  const next = stripLegacyCapabilities(capabilities);
  const extensions = isRecord(next.extensions) ? { ...next.extensions } : {};
  extensions[TASKS_EXTENSION_ID] = emptyTasksCapability();
  next.extensions = extensions;
  return next;
}

export interface PreparedRequest {
  params: Record<string, unknown> | undefined;
  taskId?: string;
}

/** Attach the capability on task-aware methods and drop a top-level legacy `task` param. */
export function prepareOutgoing(method: string, params: unknown): PreparedRequest {
  if (!CAPABILITY_METHODS.has(method)) {
    return { params: isRecord(params) ? params : undefined };
  }
  const prepared = withTasksCapability(isRecord(params) ? params : undefined);
  let taskId: string | undefined;
  if (TASK_HEADER_METHODS.has(method) && typeof prepared.taskId === "string" && prepared.taskId.length > 0) {
    taskId = prepared.taskId;
  }
  return { params: prepared, taskId };
}

function readStatus(value: unknown): SpecStatus | undefined {
  return typeof value === "string" && (SPEC_STATUSES as readonly string[]).includes(value) ? (value as SpecStatus) : undefined;
}

function readError(value: unknown): JsonRpcErrorShape | undefined {
  if (!isRecord(value) || typeof value.message !== "string" || typeof value.code !== "number") return undefined;
  return { code: value.code, message: value.message, ...(value.data !== undefined ? { data: value.data } : {}) };
}

function readInputRequests(value: unknown): Record<string, InputRequest> | undefined {
  if (!isRecord(value)) return undefined;
  const out: Record<string, InputRequest> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (!isRecord(entry) || typeof entry.method !== "string") continue;
    out[key] = { method: entry.method, ...(isRecord(entry.params) ? { params: entry.params } : {}) };
  }
  return out;
}

/** Parse a Task / DetailedTask. Missing pollIntervalMs uses the client default. Missing ttlMs means unlimited. */
export function parseSnapshot(value: unknown): TaskSnapshot | undefined {
  if (!isRecord(value)) return undefined;
  if (typeof value.taskId !== "string" || value.taskId.length === 0) return undefined;
  const status = readStatus(value.status);
  if (!status) return undefined;
  if (typeof value.createdAt !== "string" || value.createdAt.length === 0) return undefined;
  const snapshot: TaskSnapshot = {
    taskId: value.taskId,
    status,
    createdAt: value.createdAt,
    ttlMs: normalizeTtl(value.ttlMs),
    pollIntervalMs: normalizePollInterval(value.pollIntervalMs),
  };
  if (typeof value.statusMessage === "string") snapshot.statusMessage = value.statusMessage;
  if (typeof value.lastUpdatedAt === "string") snapshot.lastUpdatedAt = value.lastUpdatedAt;
  const inputRequests = readInputRequests(value.inputRequests);
  if (inputRequests && Object.keys(inputRequests).length > 0) snapshot.inputRequests = inputRequests;
  if (value.result !== undefined) snapshot.result = value.result;
  const error = readError(value.error);
  if (error) snapshot.error = error;
  return snapshot;
}

/**
 * Classify a JSON-RPC result.
 * CreateTaskResult on a method outside {@link SUPPORTED_TASK_METHODS} is an invalid response.
 */
export function classifyResult(method: string, result: unknown): { kind: "task"; snapshot: TaskSnapshot } | { kind: "other" } {
  if (!isRecord(result) || result.resultType !== "task") return { kind: "other" };
  if (!SUPPORTED_TASK_METHODS.has(method)) {
    throw new InvalidTaskResultError(
      `Server returned CreateTaskResult for ${method}, which is not a task-augmented method`,
    );
  }
  const snapshot = parseSnapshot(result);
  if (!snapshot) throw new InvalidTaskResultError("Server returned an invalid CreateTaskResult");
  return { kind: "task", snapshot };
}

/** Drop a non-array `content` so pi's tools/call validator does not reject a task handle. */
export function sanitizeTaskResult(result: unknown): unknown {
  if (!isRecord(result) || result.resultType !== "task") return result;
  if (result.content !== undefined && !Array.isArray(result.content)) delete result.content;
  return result;
}

export function errorCode(error: unknown): number | undefined {
  if (!isRecord(error) || typeof error.code !== "number") return undefined;
  return error.code;
}

export function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (isRecord(error) && typeof error.message === "string") return error.message;
  return String(error);
}

export function textFromContent(content: unknown): string {
  if (!Array.isArray(content)) return "";
  return content
    .map((block) => (isRecord(block) && block.type === "text" && typeof block.text === "string" ? block.text : ""))
    .filter((text) => text.length > 0)
    .join("\n");
}

export function describeResult(result: unknown): string {
  if (!isRecord(result)) return result === undefined ? "" : JSON.stringify(result);
  const text = textFromContent(result.content);
  const lines = [];
  if (typeof result.isError === "boolean") lines.push(`isError: ${result.isError}`);
  if (text) lines.push(text);
  else lines.push(JSON.stringify(result));
  return lines.join("\n");
}

export function formatStarted(task: TrackedTask): string {
  const message = task.statusMessage ? `\n${task.statusMessage}` : "";
  return [
    `MCP task ${task.taskId} on server ${task.server}${task.tool ? ` (${task.tool})` : ""} is ${task.status}.`,
    `status: ${task.status}`,
    message.trimEnd(),
    `The final result will arrive in a later message. Inspect it with mcp_tasks_show and cancel it with mcp_tasks_cancel. Task id: ${task.taskId}.`,
  ]
    .filter((line) => line.length > 0)
    .join("\n");
}

export function formatTaskMessage(task: TrackedTask): string {
  const head = `MCP task ${task.taskId} on server ${task.server}${task.tool ? ` (${task.tool})` : ""}`;
  const statusLine = `status: ${task.localOutcome ?? task.status}`;
  const message = task.statusMessage ? task.statusMessage : "";
  if (task.localOutcome === "cancel_requested") {
    return [
      `${head} cancellation was requested.`,
      statusLine,
      message,
      "The server acknowledged tasks/cancel. Polling has stopped. A later notification may still report the final status.",
    ]
      .filter((line) => line.length > 0)
      .join("\n");
  }
  if (task.localOutcome === "expired") {
    return [
      `${head} expired and is no longer usable.`,
      statusLine,
      message,
      task.outcomeDetail ?? `The client stopped after createdAt + ttlMs (${task.ttlMs} ms).`,
    ]
      .filter((line) => line.length > 0)
      .join("\n");
  }
  if (task.localOutcome === "unavailable" || task.localOutcome === "disconnected") {
    return [
      `${head} is ${task.localOutcome}.`,
      statusLine,
      message,
      task.outcomeDetail ?? "The task could not be read.",
    ]
      .filter((line) => line.length > 0)
      .join("\n");
  }
  if (task.status === "failed") {
    const error = task.error
      ? `JSON-RPC error ${task.error.code}: ${task.error.message}`
      : "The task failed without a JSON-RPC error object.";
    return [`${head} failed.`, statusLine, message, error].filter((line) => line.length > 0).join("\n");
  }
  if (task.status === "cancelled") {
    return [`${head} was cancelled.`, statusLine, message].filter((line) => line.length > 0).join("\n");
  }
  if (task.status === "completed") {
    return [`${head} completed.`, statusLine, message, describeResult(task.result)]
      .filter((line) => line.length > 0)
      .join("\n");
  }
  return formatStarted(task);
}

export function ttlLabel(task: Pick<TaskSnapshot, "createdAt" | "ttlMs">, now: number): string {
  if (task.ttlMs === null) return "ttl unlimited";
  const deadline = ttlDeadline(task.createdAt, task.ttlMs);
  if (deadline === undefined) return "ttl unknown";
  return `ttl ${Math.max(0, deadline - now)}ms left`;
}

export function widgetLines(tasks: readonly TrackedTask[], now: number): string[] | undefined {
  const open = tasks.filter(isOpenTask);
  if (open.length === 0) return undefined;
  return open.map((task) => {
    const message = task.statusMessage ? `  ${task.statusMessage}` : "";
    return `${task.taskId}  ${task.server}${task.tool ? `/${task.tool}` : ""}  ${task.status}${message}  poll ${task.pollIntervalMs}ms  ${ttlLabel(task, now)}`;
  });
}

export function statusText(tasks: readonly TrackedTask[]): string | undefined {
  const open = tasks.filter(isOpenTask);
  if (open.length === 0) return undefined;
  return `tasks ${open.length}`;
}

export interface PersistedTask {
  server: string;
  tool?: string;
  taskId: string;
  status: string;
  statusMessage?: string;
  createdAt: string;
  lastUpdatedAt?: string;
  ttlMs: number | null;
  pollIntervalMs: number;
  answeredKeys: string[];
  pendingKeys: string[];
  delivered: boolean;
  includedInToolResult: boolean;
  localOutcome?: LocalOutcome;
  outcomeDetail?: string;
  result?: unknown;
  error?: JsonRpcErrorShape;
  toolCallId?: string;
}

export function toPersisted(task: TrackedTask): PersistedTask {
  return {
    server: task.server,
    tool: task.tool,
    taskId: task.taskId,
    status: task.status,
    statusMessage: task.statusMessage,
    createdAt: task.createdAt,
    lastUpdatedAt: task.lastUpdatedAt,
    ttlMs: task.ttlMs,
    pollIntervalMs: task.pollIntervalMs,
    answeredKeys: [...task.answeredKeys],
    pendingKeys: [...task.pendingKeys],
    delivered: task.delivered,
    includedInToolResult: task.includedInToolResult,
    localOutcome: task.localOutcome,
    outcomeDetail: task.outcomeDetail,
    result: task.result,
    error: task.error,
    toolCallId: task.toolCallId,
  };
}

export function isPersistedTask(value: unknown): value is PersistedTask {
  if (!isRecord(value)) return false;
  return typeof value.server === "string" && typeof value.taskId === "string" && typeof value.createdAt === "string";
}

export function shouldResume(entry: PersistedTask): boolean {
  if (entry.localOutcome) return false;
  if (isTerminalStatus(entry.status)) return false;
  return readStatus(entry.status) !== undefined;
}
