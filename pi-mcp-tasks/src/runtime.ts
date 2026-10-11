/**
 * Task lifecycle: poll tasks/get, send tasks/update and tasks/cancel, and deliver terminal
 * outcomes. Does not open its own MCP connection; callers pass the built-in client's request.
 */

import {
  errorCode,
  errorMessage,
  formatStarted,
  formatTaskMessage,
  INVALID_PARAMS,
  isOpenTask,
  isPastTtl,
  isPersistedTask,
  isTerminalStatus,
  METHOD_NOT_FOUND,
  parseSnapshot,
  classifyResult,
  sanitizeTaskResult,
  shouldResume,
  statusText,
  taskKey,
  ttlDeadline,
  widgetLines,
  type LocalOutcome,
  type PersistedTask,
  type TaskSnapshot,
  type TrackedTask,
} from "./protocol.ts";
import type { PendingInput } from "./input.ts";

export interface RpcBinding {
  request(method: string, params?: Record<string, unknown>): Promise<unknown>;
}

export interface TaskLimits {
  maxFailures?: number;
  backoffMs?: number[];
  startupGraceMs?: number;
}

export interface TaskRuntimeOptions {
  now?: () => number;
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
  deliver?: (task: TrackedTask, text: string) => void | Promise<void>;
  persist?: (task: TrackedTask) => void;
  notify?: (message: string, type?: "info" | "warning" | "error") => void;
  setWidget?: (lines: string[] | undefined) => void;
  setStatus?: (text: string | undefined) => void;
  promptInput?: (task: TrackedTask, requests: readonly PendingInput[]) => Promise<Record<string, unknown> | undefined>;
  limits?: TaskLimits;
  defer?: (fn: () => void) => void;
  trace?: (event: { server: string; method: string; params?: Record<string, unknown> }) => void;
}

const DEFAULT_BACKOFF = [250, 500, 1000, 1500];

export class TaskRuntime {
  private readonly tasks = new Map<string, TrackedTask>();
  private readonly bindings = new Map<string, () => Promise<RpcBinding>>();
  private readonly controllers = new Map<string, AbortController>();
  private readonly discovered = new Set<string>();
  private readonly listened = new Set<string>();
  private readonly watchStarted = new Map<string, number>();
  private closed = false;

  private readonly now: () => number;
  private readonly sleep: (ms: number, signal: AbortSignal) => Promise<void>;
  private readonly deliver: (task: TrackedTask, text: string) => void | Promise<void>;
  private readonly persistTask: (task: TrackedTask) => void;
  private readonly notify: (message: string, type?: "info" | "warning" | "error") => void;
  private readonly setWidget: (lines: string[] | undefined) => void;
  private readonly setStatus: (text: string | undefined) => void;
  private readonly promptInput: (task: TrackedTask, requests: readonly PendingInput[]) => Promise<Record<string, unknown> | undefined>;
  private readonly defer: (fn: () => void) => void;
  private readonly trace: (event: { server: string; method: string; params?: Record<string, unknown> }) => void;
  private readonly maxFailures: number;
  private readonly backoffMs: number[];
  private readonly startupGraceMs: number;

  constructor(options: TaskRuntimeOptions = {}) {
    this.now = options.now ?? (() => Date.now());
    this.sleep = options.sleep ?? defaultSleep;
    this.deliver = options.deliver ?? (() => {});
    this.persistTask = options.persist ?? (() => {});
    this.notify = options.notify ?? (() => {});
    this.setWidget = options.setWidget ?? (() => {});
    this.setStatus = options.setStatus ?? (() => {});
    this.promptInput = options.promptInput ?? (async () => undefined);
    this.defer = options.defer ?? ((fn) => setTimeout(fn, 0));
    this.trace = options.trace ?? (() => {});
    this.maxFailures = options.limits?.maxFailures ?? 4;
    this.backoffMs = options.limits?.backoffMs ?? DEFAULT_BACKOFF;
    this.startupGraceMs = options.limits?.startupGraceMs ?? 10_000;
  }

  attachServer(server: string, getClient: () => Promise<RpcBinding>): void {
    this.bindings.set(server, getClient);
    if (this.discovered.has(server)) return;
    this.discovered.add(server);
    void this.discover(server);
  }

  list(): TrackedTask[] {
    return [...this.tasks.values()];
  }

  find(id: string): { task: TrackedTask } | { error: string } {
    const trimmed = id.trim();
    const direct = [...this.tasks.values()].filter((task) => task.taskId === trimmed || taskKey(task.server, task.taskId) === trimmed || `${task.server}/${task.taskId}` === trimmed);
    if (direct.length === 1) return { task: direct[0]! };
    if (direct.length === 0) return { error: `No task ${trimmed}` };
    return { error: `Task id ${trimmed} is on more than one server. Use server/taskId.` };
  }

  /**
   * A tools/call (or future method) returned CreateTaskResult.
   * Idempotent for the same server and task id.
   */
  acceptCreated(server: string, tool: string | undefined, snapshot: TaskSnapshot, meta?: { toolCallId?: string }): TrackedTask {
    const key = taskKey(server, snapshot.taskId);
    const existing = this.tasks.get(key);
    if (existing) return existing;
    const task: TrackedTask = {
      ...snapshot,
      server,
      tool,
      answeredKeys: [],
      pendingKeys: [],
      delivered: false,
      includedInToolResult: false,
      toolCallId: meta?.toolCallId,
    };
    this.tasks.set(key, task);
    this.remember(task);
    this.refreshUi();
    if (isTerminalStatus(task.status) || isPastTtl(this.now(), task)) {
      if (isPastTtl(this.now(), task) && !isTerminalStatus(task.status)) this.mark(task, "expired");
      else this.scheduleDelivery(task);
    } else {
      this.watchStarted.set(key, this.now());
      void this.loop(key);
      void this.listen(task);
      if (task.status === "input_required") void this.maybePrompt(task);
    }
    return task;
  }

  /** Model-facing tool result text. Terminal creates are delivered here, not as a second message. */
  toolResultText(server: string, tool: string | undefined, result: unknown): string | undefined {
    let classified;
    try {
      classified = classifyResult("tools/call", result);
    } catch {
      return undefined;
    }
    if (classified.kind !== "task") return undefined;
    const task = this.acceptCreated(server, tool, classified.snapshot);
    if (!isOpenTask(task)) {
      task.includedInToolResult = true;
      task.delivered = true;
      return formatTaskMessage(task);
    }
    return formatStarted(task);
  }

  /**
   * Intercept a JSON-RPC result from the built-in client.
   * Throws InvalidTaskResultError when a CreateTaskResult is not allowed or not well formed.
   */
  observeCall(server: string, method: string, requestParams: unknown, result: unknown): unknown {
    const classified = classifyResult(method, result);
    if (classified.kind !== "task") return result;
    sanitizeTaskResult(result);
    const tool = method === "tools/call" && isRecordParams(requestParams) && typeof requestParams.name === "string"
        ? requestParams.name
        : undefined;
    this.acceptCreated(server, tool, classified.snapshot);
    return result;
  }

  applyNotification(server: string | undefined, params: unknown): void {
    const snapshot = parseSnapshot(params);
    if (!snapshot) return;
    for (const task of this.tasks.values()) {
      if (task.taskId !== snapshot.taskId) continue;
      if (server && task.server !== server) continue;
      if (task.localOutcome === "cancel_requested" && isTerminalStatus(snapshot.status)) {
        task.localOutcome = undefined;
        task.outcomeDetail = undefined;
        task.delivered = false;
      } else if (task.localOutcome || isTerminalStatus(task.status)) {
        continue;
      }
      const previous = task.status;
      this.applySnapshot(task, snapshot);
      if (isTerminalStatus(task.status)) this.scheduleDelivery(task);
      else if (task.status === "input_required" && previous !== "input_required") void this.maybePrompt(task);
      else void this.maybePrompt(task);
    }
  }

  resume(entries: readonly unknown[]): void {
    const folded = new Map<string, PersistedTask>();
    for (const entry of entries) {
      if (!isPersistedTask(entry)) continue;
      folded.set(taskKey(entry.server, entry.taskId), entry);
    }
    for (const entry of folded.values()) {
      const snapshot = parseSnapshot(entry);
      if (!snapshot || !shouldResume(entry)) continue;
      const task: TrackedTask = {
        ...snapshot,
        server: entry.server,
        tool: entry.tool,
        answeredKeys: [...(entry.answeredKeys ?? [])],
        pendingKeys: [...(entry.pendingKeys ?? [])],
        delivered: entry.delivered === true,
        includedInToolResult: entry.includedInToolResult === true,
        toolCallId: entry.toolCallId,
      };
      const key = taskKey(task.server, task.taskId);
      if (this.tasks.has(key)) continue;
      this.tasks.set(key, task);
      if (isPastTtl(this.now(), task)) {
        this.mark(task, "expired");
        continue;
      }
      this.watchStarted.set(key, this.now());
      void this.loop(key);
      void this.listen(task);
    }
    this.refreshUi();
  }

  async cancel(id: string): Promise<string> {
    const found = this.find(id);
    if ("error" in found) return found.error;
    const task = found.task;
    if (isTerminalStatus(task.status)) return `Task ${task.taskId} is already ${task.status}.`;
    try {
      await this.rpc(task.server, "tasks/cancel", { taskId: task.taskId });
    } catch (error) {
      return `Cancel failed for ${task.taskId}: ${errorMessage(error)}. Still polling.`;
    }
    const current = this.tasks.get(taskKey(task.server, task.taskId)) ?? task;
    if (isTerminalStatus(current.status)) return formatTaskMessage(current);
    current.localOutcome = "cancel_requested";
    current.answeredKeys = [];
    current.pendingKeys = [];
    this.stopWatch(current);
    this.remember(current);
    this.scheduleDelivery(current);
    this.refreshUi();
    return `Cancellation requested for ${current.taskId}.`;
  }

  async respond(id: string, inputResponses: Record<string, unknown>): Promise<string> {
    const found = this.find(id);
    if ("error" in found) return found.error;
    const task = found.task;
    const fresh: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(inputResponses)) {
      if (task.answeredKeys.includes(key)) continue;
      fresh[key] = value;
    }
    if (Object.keys(fresh).length === 0) return `Input for ${task.taskId} was already answered.`;
    await this.rpc(task.server, "tasks/update", { taskId: task.taskId, inputResponses: fresh });
    for (const key of Object.keys(fresh)) {
      task.answeredKeys.push(key);
      task.pendingKeys = task.pendingKeys.filter((pending) => pending !== key);
    }
    this.remember(task);
    return `Sent input for ${task.taskId}: ${Object.keys(fresh).join(", ")}.`;
  }

  close(): void {
    this.closed = true;
    for (const controller of this.controllers.values()) controller.abort();
    this.controllers.clear();
  }

  private async loop(key: string): Promise<void> {
    this.controllers.get(key)?.abort();
    const controller = new AbortController();
    this.controllers.set(key, controller);
    const signal = controller.signal;
    let failures = 0;
    let polled = false;
    try {
      while (!signal.aborted && !this.closed) {
        const task = this.tasks.get(key);
        if (!task || task.localOutcome || isTerminalStatus(task.status)) return;
        if (isPastTtl(this.now(), task)) {
          this.mark(task, "expired");
          return;
        }
        if (polled) {
          const deadline = ttlDeadline(task.createdAt, task.ttlMs);
          let wait = task.pollIntervalMs;
          if (deadline !== undefined) wait = Math.min(wait, Math.max(0, deadline - this.now()));
          if (wait > 0) await this.sleep(wait, signal);
          if (signal.aborted || this.closed) return;
          const after = this.tasks.get(key);
          if (!after || after.localOutcome || isTerminalStatus(after.status)) return;
          if (isPastTtl(this.now(), after)) {
            this.mark(after, "expired");
            return;
          }
        }
        polled = true;
        const bound = await this.resolve(task.server);
        if (bound.missing) {
          const started = this.watchStarted.get(key) ?? this.now();
          if (this.now() - started < this.startupGraceMs) {
            polled = false;
            await this.sleep(Math.min(task.pollIntervalMs, 200), signal);
            continue;
          }
          failures += 1;
        } else if (bound.error) {
          const outcome = terminalRpc(bound.error, task, this.now());
          if (outcome) {
            this.mark(task, outcome.outcome, outcome.detail);
            return;
          }
          failures += 1;
        } else if (bound.rpc) {
          try {
            const result = await this.rpc(task.server, "tasks/get", { taskId: task.taskId });
            const snapshot = parseSnapshot(result);
            if (!snapshot || snapshot.taskId !== task.taskId) {
              failures += 1;
            } else {
              failures = 0;
              const previous = task.status;
              this.applySnapshot(task, snapshot);
              if (isTerminalStatus(task.status)) {
                this.scheduleDelivery(task);
                return;
              }
              if (isPastTtl(this.now(), task)) {
                this.mark(task, "expired");
                return;
              }
              if (task.status === "input_required") void this.maybePrompt(task);
              else if (previous !== task.status) this.notify(`${task.taskId} is ${task.status}`, "info");
              continue;
            }
          } catch (error) {
            if (signal.aborted || isAbort(error)) return;
            const outcome = terminalRpc(error, task, this.now());
            if (outcome) {
              this.mark(task, outcome.outcome, outcome.detail);
              return;
            }
            failures += 1;
          }
        }
        if (failures >= this.maxFailures) {
          this.mark(task, "disconnected", `Stopped after ${failures} failed reads of ${task.taskId}.`);
          return;
        }
        const delay = this.backoffMs[Math.min(failures - 1, this.backoffMs.length - 1)] ?? 250;
        polled = false;
        await this.sleep(delay, signal);
      }
    } catch (error) {
      if (signal.aborted || isAbort(error) || this.closed) return;
      const task = this.tasks.get(key);
      if (task && isOpenTask(task)) this.mark(task, "disconnected", errorMessage(error));
    } finally {
      if (this.controllers.get(key) === controller) this.controllers.delete(key);
    }
  }

  private applySnapshot(task: TrackedTask, snapshot: TaskSnapshot): void {
    const changed = task.status !== snapshot.status
      || task.statusMessage !== snapshot.statusMessage
      || task.pollIntervalMs !== snapshot.pollIntervalMs
      || task.ttlMs !== snapshot.ttlMs
      || JSON.stringify(task.inputRequests ?? {}) !== JSON.stringify(snapshot.inputRequests ?? {});
    task.status = snapshot.status;
    task.statusMessage = snapshot.statusMessage;
    task.lastUpdatedAt = snapshot.lastUpdatedAt;
    task.ttlMs = snapshot.ttlMs;
    task.pollIntervalMs = snapshot.pollIntervalMs;
    task.inputRequests = snapshot.inputRequests;
    task.result = snapshot.result;
    task.error = snapshot.error;
    if (changed) this.remember(task);
    if (snapshot.status === "input_required" && changed) {
      this.notify(`${task.taskId} needs input. Call mcp_tasks_respond.`, "warning");
    }
    this.refreshUi();
  }

  private async maybePrompt(task: TrackedTask): Promise<void> {
    if (task.status !== "input_required" || !task.inputRequests) return;
    const fresh = Object.keys(task.inputRequests).filter((key) => !task.answeredKeys.includes(key) && !task.pendingKeys.includes(key));
    if (fresh.length === 0) return;
    task.pendingKeys.push(...fresh);
    this.remember(task);
    const requests: PendingInput[] = fresh.map((key) => ({ key, request: task.inputRequests![key]! }));
    let responses: Record<string, unknown> | undefined;
    try {
      responses = await this.promptInput(task, requests);
    } catch {
      return;
    }
    if (!responses) return;
    const filtered: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(responses)) {
      if (task.answeredKeys.includes(key)) continue;
      if (!fresh.includes(key)) continue;
      filtered[key] = value;
    }
    if (Object.keys(filtered).length === 0) return;
    try {
      await this.rpc(task.server, "tasks/update", { taskId: task.taskId, inputResponses: filtered });
    } catch {
      return;
    }
    for (const key of Object.keys(filtered)) {
      task.answeredKeys.push(key);
      task.pendingKeys = task.pendingKeys.filter((pending) => pending !== key);
    }
    this.remember(task);
  }

  private async listen(task: TrackedTask): Promise<void> {
    const key = taskKey(task.server, task.taskId);
    if (this.listened.has(key)) return;
    this.listened.add(key);
    try {
      await this.rpc(task.server, "subscriptions/listen", { notifications: { taskIds: [task.taskId] } });
    } catch (error) {
      if (errorCode(error) === METHOD_NOT_FOUND) return;
    }
  }

  private async discover(server: string): Promise<void> {
    try {
      await this.rpc(server, "server/discover", {});
    } catch {
      // Discovery is informational. A CreateTaskResult is enough to poll.
    }
  }

  private async rpc(server: string, method: string, params?: Record<string, unknown>): Promise<unknown> {
    this.trace({ server, method, params });
    const bound = await this.resolve(server);
    if (!bound.rpc) throw bound.error ?? new Error(`MCP server "${server}" is not connected`);
    return bound.rpc.request(method, params);
  }

  private async resolve(server: string): Promise<{ rpc?: RpcBinding; missing?: boolean; error?: unknown }> {
    const get = this.bindings.get(server);
    if (!get) return { missing: true };
    try {
      return { rpc: await get() };
    } catch (error) {
      return { error };
    }
  }

  private mark(task: TrackedTask, outcome: LocalOutcome, detail?: string): void {
    task.localOutcome = outcome;
    task.outcomeDetail = detail;
    this.stopWatch(task);
    this.remember(task);
    this.scheduleDelivery(task);
    this.refreshUi();
    const type = outcome === "expired" || outcome === "disconnected" || outcome === "unavailable" ? "error" : "warning";
    this.notify(`${task.taskId} ${outcome}`, type);
  }

  private scheduleDelivery(task: TrackedTask): void {
    const key = taskKey(task.server, task.taskId);
    this.defer(() => {
      const current = this.tasks.get(key);
      if (!current || current.delivered || current.includedInToolResult) return;
      current.delivered = true;
      this.remember(current);
      void Promise.resolve(this.deliver(current, formatTaskMessage(current))).catch(() => {});
    });
  }

  private remember(task: TrackedTask): void {
    try {
      this.persistTask(task);
    } catch {
      // Persistence is best-effort. Polling still runs in this process.
    }
  }

  private stopWatch(task: TrackedTask): void {
    const key = taskKey(task.server, task.taskId);
    this.controllers.get(key)?.abort();
  }

  private refreshUi(): void {
    const tasks = this.list();
    try {
      this.setWidget(widgetLines(tasks, this.now()));
    } catch {
      // Print mode and tests may not host a widget.
    }
    try {
      this.setStatus(statusText(tasks));
    } catch {
      // Same as the widget.
    }
  }
}

function isRecordParams(value: unknown): value is { name?: string } {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isAbort(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}

function terminalRpc(error: unknown, task: TrackedTask, now: number): { outcome: LocalOutcome; detail: string } | undefined {
  if (errorCode(error) !== INVALID_PARAMS) return undefined;
  const message = errorMessage(error);
  if (/expir/i.test(message) || isPastTtl(now, task)) return { outcome: "expired", detail: message };
  return { outcome: "unavailable", detail: message };
}

function defaultSleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(Object.assign(new Error("aborted"), { name: "AbortError" }));
    };
    if (signal.aborted) onAbort();
    else signal.addEventListener("abort", onAbort, { once: true });
  });
}
