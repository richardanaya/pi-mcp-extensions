import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { attachClient } from "../src/bridge.ts";
import { formatTaskShow, parseTasksCommand, runTasksCommand } from "../src/commands.ts";
import { collectInputResponses, type InputUi } from "../src/input.ts";
import {
  classifyResult,
  formatTaskMessage,
  InvalidTaskResultError,
  prepareOutgoing,
  stripLegacyCapabilities,
  SUPPORTED_TASK_METHODS,
  widgetLines,
  withInitializeExtensions,
  type TaskSnapshot,
  type TrackedTask,
} from "../src/protocol.ts";
import { TaskRuntime, type RpcBinding } from "../src/runtime.ts";

const CREATED = "1970-01-01T00:00:00.000Z";

function snapshot(overrides: Partial<TaskSnapshot> = {}): TaskSnapshot {
  return {
    taskId: "task-1",
    status: "working",
    createdAt: CREATED,
    ttlMs: null,
    pollIntervalMs: 1000,
    ...overrides,
  };
}

function task(overrides: Partial<TrackedTask> = {}): TrackedTask {
  return {
    ...snapshot(),
    server: "jobs",
    answeredKeys: [],
    pendingKeys: [],
    delivered: false,
    includedInToolResult: false,
    ...overrides,
  };
}

describe("protocol", () => {
  it("C-MUST-01 handles CallToolResult and CreateTaskResult", () => {
    const immediate = classifyResult("tools/call", { content: [{ type: "text", text: "ok" }] });
    assert.equal(immediate.kind, "other");
    const created = classifyResult("tools/call", { resultType: "task", ...snapshot() });
    assert.equal(created.kind, "task");
    if (created.kind === "task") assert.equal(created.snapshot.taskId, "task-1");
  });

  it("C-MUST-02 rejects CreateTaskResult for an unsupported method", () => {
    assert.throws(
      () => classifyResult("resources/read", { resultType: "task", ...snapshot() }),
      InvalidTaskResultError,
    );
  });

  it("C-SHOULD-01 keeps task-augmented methods in an open set", () => {
    assert.equal(SUPPORTED_TASK_METHODS.has("tools/call"), true);
    SUPPORTED_TASK_METHODS.add("prompts/get");
    try {
      const created = classifyResult("prompts/get", { resultType: "task", ...snapshot() });
      assert.equal(created.kind, "task");
    } finally {
      SUPPORTED_TASK_METHODS.delete("prompts/get");
    }
    assert.throws(() => classifyResult("prompts/get", { resultType: "task", ...snapshot() }), InvalidTaskResultError);
  });

  it("C-MUST-08 strips the legacy task parameter and keeps arguments.task", () => {
    const prepared = prepareOutgoing("tools/call", {
      name: "echo",
      arguments: { task: "keep" },
      task: { ttl: 1 },
    });
    assert.equal(prepared.params?.task, undefined);
    assert.equal((prepared.params?.arguments as { task: string }).task, "keep");
  });

  it("C-MUST-10 declares the tasks extension on tools/call and task requests", () => {
    for (const method of ["tools/call", "tasks/get", "tasks/update", "tasks/cancel", "subscriptions/listen"]) {
      const prepared = prepareOutgoing(method, method === "tools/call" ? { name: "echo" } : { taskId: "task-1" });
      const meta = prepared.params?._meta as { "io.modelcontextprotocol/clientCapabilities": { extensions: Record<string, unknown> } };
      assert.deepEqual(meta["io.modelcontextprotocol/clientCapabilities"].extensions["io.modelcontextprotocol/tasks"], {});
    }
    assert.equal(prepareOutgoing("tasks/get", { taskId: "task-1" }).taskId, "task-1");
    assert.equal(prepareOutgoing("tools/call", { name: "echo" }).taskId, undefined);
  });

  it("C-MUST-09 does not advertise legacy tasks capabilities", () => {
    const capabilities = withInitializeExtensions({
      tasks: { requests: { tools: { call: {} } }, list: {}, cancel: {} },
      roots: {},
    });
    assert.equal("tasks" in capabilities, false);
    assert.deepEqual((capabilities.extensions as Record<string, unknown>)["io.modelcontextprotocol/tasks"], {});
    assert.deepEqual(stripLegacyCapabilities({ tasks: { list: {} }, experimental: {} }).tasks, undefined);
  });

  it("C-SHOULD-09 includes statusMessage in the model text and the widget", () => {
    const sample = task({ status: "working", statusMessage: "The operation is now in progress." });
    assert.match(formatTaskMessage(sample), /The operation is now in progress\./);
    const lines = widgetLines([sample], 0);
    assert.ok(lines?.some((line) => line.includes("The operation is now in progress.")));
  });

  it("C-MUST-11 keeps isError tool results on completed", () => {
    const text = formatTaskMessage(task({
      status: "completed",
      result: { content: [{ type: "text", text: "Failed to process request: invalid input" }], isError: true },
    }));
    assert.match(text, /status: completed/);
    assert.match(text, /isError: true/);
    assert.doesNotMatch(text, /status: failed/);
  });

  it("C-MUST-12 surfaces the JSON-RPC error from a failed task", () => {
    const text = formatTaskMessage(task({
      status: "failed",
      statusMessage: "Tool execution failed: API rate limit exceeded",
      error: { code: -32603, message: "API rate limit exceeded" },
    }));
    assert.match(text, /status: failed/);
    assert.match(text, /API rate limit exceeded/);
    assert.match(text, /-32603/);
    assert.match(text, /Tool execution failed: API rate limit exceeded/);
  });

  it("C-MAY-01 lists, shows, and cancels through the command parser and widget", async () => {
    assert.deepEqual(parseTasksCommand(""), { action: "list" });
    assert.deepEqual(parseTasksCommand("show task-1"), { action: "show", id: "task-1" });
    assert.deepEqual(parseTasksCommand("cancel jobs/task-1"), { action: "cancel", id: "jobs/task-1" });
    const parsed = parseTasksCommand('respond task-1 {"name":{"action":"accept"}}');
    assert.equal(parsed.action, "respond");
    const runtime = new TaskRuntime({
      sleep: () => new Promise(() => {}),
      defer: (fn) => fn(),
    });
    runtime.attachServer("jobs", async () => ({ request: async () => ({ resultType: "complete" }) }));
    runtime.acceptCreated("jobs", "echo", snapshot({ statusMessage: "working hard" }));
    const listed = await runTasksCommand(runtime, "list", 0);
    assert.match(listed, /jobs\/task-1/);
    assert.match(listed, /working hard/);
    assert.match(await runTasksCommand(runtime, "show task-1", 0), /working hard/);
    assert.match(formatTaskShow(task({ statusMessage: "working hard" }), 0), /pollIntervalMs/);
    runtime.close();
  });
});

describe("input trust", () => {
  it("C-MUST-03 inspects inputRequests and C-MUST-04 confirms before accept", async () => {
    const calls: string[] = [];
    const ui: InputUi = {
      confirm: async (_title, message) => {
        calls.push(`confirm:${message}`);
        return true;
      },
      input: async (title) => {
        calls.push(`input:${title}`);
        return title === "name" ? "Luca" : "x";
      },
      notify: () => {},
    };
    const responses = await collectInputResponses(ui, task({ taskId: "task-1" }), [{
      key: "name",
      request: {
        method: "elicitation/create",
        params: {
          mode: "form",
          message: "Please enter your name.",
          requestedSchema: { type: "object", properties: { name: { type: "string" } }, required: ["name"] },
        },
      },
    }]);
    assert.equal(calls[0]?.startsWith("confirm:"), true);
    assert.deepEqual(responses, { name: { action: "accept", content: { name: "Luca" } } });
    const declined = await collectInputResponses({ ...ui, confirm: async () => false }, task(), [{
      key: "name",
      request: { method: "elicitation/create", params: { message: "name" } },
    }]);
    assert.equal(declined, undefined);
  });
});

interface Harness {
  runtime: TaskRuntime;
  calls: { method: string; params?: Record<string, unknown> }[];
  waits: number[];
  delivered: string[];
  persisted: unknown[];
  now: { value: number };
}

function harness(handle: (method: string, params?: Record<string, unknown>) => Promise<unknown> | unknown, options: { prompt?: TaskRuntime["respond"] extends never ? never : unknown } = {}): Harness {
  void options;
  const calls: Harness["calls"] = [];
  const waits: number[] = [];
  const delivered: string[] = [];
  const persisted: unknown[] = [];
  const now = { value: 0 };
  const runtime = new TaskRuntime({
    now: () => now.value,
    sleep: async (ms) => {
      waits.push(ms);
      now.value += ms;
    },
    deliver: (_task, text) => {
      delivered.push(text);
    },
    persist: (item) => {
      persisted.push(structuredClone(item));
    },
    defer: (fn) => fn(),
    limits: { maxFailures: 3, backoffMs: [5, 5, 5], startupGraceMs: 0 },
    promptInput: async () => undefined,
  });
  const binding: RpcBinding = {
    request: async (method, params) => {
      calls.push({ method, params });
      return handle(method, params);
    },
  };
  runtime.attachServer("jobs", async () => binding);
  return { runtime, calls, waits, delivered, persisted, now };
}

async function settle(): Promise<void> {
  for (let i = 0; i < 40; i++) await Promise.resolve();
}

function methods(calls: { method: string }[]): string[] {
  return calls.map((call) => call.method);
}

describe("runtime", () => {
  it("C-SHOULD-02 honors pollIntervalMs when it changes and C-SHOULD-03 polls until terminal", async () => {
    let polls = 0;
    const intervals = [100, 250];
    const env = harness((method) => {
      if (method !== "tasks/get") return { resultType: "complete" };
      const interval = intervals[Math.min(polls, intervals.length - 1)] ?? 250;
      polls += 1;
      if (polls >= 3) return { ...snapshot({ pollIntervalMs: interval }), resultType: "complete", status: "completed", result: { content: [{ type: "text", text: "done" }] } };
      return { ...snapshot({ pollIntervalMs: interval }), resultType: "complete", status: "working" };
    });
    env.runtime.acceptCreated("jobs", "complete_job", snapshot({ pollIntervalMs: 100 }));
    await settle();
    assert.deepEqual(env.waits, [100, 250]);
    assert.equal(env.calls.filter((call) => call.method === "tasks/get").length, 3);
    assert.equal(methods(env.calls).includes("tasks/result"), false);
    assert.match(env.delivered.join("\n"), /done/);
    env.runtime.close();
  });

  it("C-MAY-02 expires a non-terminal task at createdAt plus ttlMs", async () => {
    let gets = 0;
    const env = harness((method) => {
      if (method === "tasks/get") gets += 1;
      return { ...snapshot({ ttlMs: 80, pollIntervalMs: 5000 }), resultType: "complete", status: "working" };
    });
    env.runtime.acceptCreated("jobs", "expire_job", snapshot({ ttlMs: 80, pollIntervalMs: 5000 }));
    await settle();
    assert.equal(gets, 1);
    assert.deepEqual(env.waits, [80]);
    assert.match(env.delivered.join("\n"), /expired/);
    assert.equal(methods(env.calls).includes("tasks/result"), false);
    env.runtime.close();
  });

  it("C-MUST-05 cancels with tasks/cancel and never notifications/cancelled or tasks/result", async () => {
    const env = harness(() => ({ ...snapshot(), resultType: "complete", status: "working" }));
    env.runtime.acceptCreated("jobs", "cancel_job", snapshot());
    await settle();
    const text = await env.runtime.cancel("task-1");
    assert.match(text, /Cancellation requested/);
    assert.equal(methods(env.calls).includes("tasks/cancel"), true);
    assert.equal(methods(env.calls).includes("notifications/cancelled"), false);
    assert.equal(methods(env.calls).includes("tasks/result"), false);
    env.runtime.close();
  });

  it("C-MAY-04 drops answered input keys after tasks/cancel", async () => {
    const env = harness(() => ({ resultType: "complete" }));
    const created = env.runtime.acceptCreated("jobs", "ask_job", snapshot({ status: "input_required" }));
    created.answeredKeys.push("name");
    await env.runtime.cancel("task-1");
    assert.deepEqual(created.answeredKeys, []);
    env.runtime.close();
  });

  it("C-MAY-05 accepts a later terminal notification after cooperative cancel", async () => {
    const env = harness(() => ({ resultType: "complete" }));
    env.runtime.acceptCreated("jobs", "cancel_job", snapshot());
    await env.runtime.cancel("task-1");
    env.runtime.applyNotification("jobs", {
      ...snapshot({ status: "completed" }),
      result: { content: [{ type: "text", text: "finished anyway" }] },
    });
    assert.match(env.delivered.join("\n"), /finished anyway/);
    env.runtime.close();
  });

  it("C-SHOULD-04 persists task ids and resumes polling", async () => {
    const first = harness((method) => {
      if (method === "tasks/get") return { ...snapshot(), resultType: "complete", status: "working", pollIntervalMs: 10 };
      return {};
    });
    first.runtime.acceptCreated("jobs", "complete_job", snapshot({ pollIntervalMs: 10 }));
    await settle();
    first.runtime.close();
    const saved = first.persisted[0];
    let gets = 0;
    const second = harness((method) => {
      if (method !== "tasks/get") return {};
      gets += 1;
      return { ...snapshot(), resultType: "complete", status: "completed", result: { content: [{ type: "text", text: "resumed" }] } };
    });
    second.runtime.resume([saved]);
    await settle();
    assert.ok(gets >= 1);
    assert.match(second.delivered.join("\n"), /resumed/);
    second.runtime.close();
  });

  it("C-SHOULD-05 C-SHOULD-06 C-SHOULD-07 and C-SHOULD-08 update, keep watching, and answer a key once", async () => {
    let prompts = 0;
    let gets = 0;
    let updates = 0;
    const calls: string[] = [];
    const runtime = new TaskRuntime({
      now: () => 0,
      sleep: async () => {},
      defer: (fn) => fn(),
      limits: { maxFailures: 2, backoffMs: [1], startupGraceMs: 0 },
      promptInput: async (_task, requests) => {
        prompts += 1;
        assert.equal(requests[0]?.key, "name");
        assert.equal(requests[0]?.request.method, "elicitation/create");
        return prompts === 1 ? { name: { action: "accept", content: { name: "Luca" } } } : undefined;
      },
    });
    runtime.attachServer("jobs", async () => ({
      request: async (method, params) => {
        calls.push(method);
        if (method === "tasks/update") {
          updates += 1;
          assert.deepEqual(params?.inputResponses, { name: { action: "accept", content: { name: "Luca" } } });
          return { resultType: "complete" };
        }
        if (method === "tasks/get") {
          gets += 1;
          if (gets < 3) {
            return {
              ...snapshot({ status: "input_required", pollIntervalMs: 5 }),
              resultType: "complete",
              inputRequests: { name: { method: "elicitation/create", params: { message: "Please enter your name." } } },
            };
          }
          return { ...snapshot({ status: "completed" }), resultType: "complete", result: { content: [{ type: "text", text: "Hello, Luca" }] } };
        }
        if (method === "subscriptions/listen") {
          const error = new Error("Method not found") as Error & { code: number };
          error.code = -32601;
          throw error;
        }
        return {};
      },
    }));
    runtime.acceptCreated("jobs", "ask_job", snapshot({ pollIntervalMs: 5 }));
    await settle();
    assert.equal(prompts, 1);
    assert.equal(updates, 1);
    assert.ok(gets >= 2);
    const again = await runtime.respond("task-1", { name: { action: "accept", content: { name: "Luca" } } });
    assert.match(again, /already answered/);
    assert.equal(updates, 1);
    assert.equal(calls.includes("tasks/result"), false);
    runtime.close();
  });

  it("C-MAY-03 subscribes and keeps polling when subscriptions/listen is missing", async () => {
    let gets = 0;
    let listens = 0;
    const env = harness((method) => {
      if (method === "subscriptions/listen") {
        listens += 1;
        const error = new Error("Method not found") as Error & { code: number };
        error.code = -32601;
        throw error;
      }
      if (method === "tasks/get") {
        gets += 1;
        if (gets < 2) return { ...snapshot({ pollIntervalMs: 5 }), resultType: "complete", status: "working" };
        return { ...snapshot({ status: "completed" }), resultType: "complete", result: { content: [{ type: "text", text: "polled" }] } };
      }
      return {};
    });
    env.runtime.acceptCreated("jobs", "complete_job", snapshot({ pollIntervalMs: 5 }));
    await settle();
    env.runtime.applyNotification("jobs", { ...snapshot({ taskId: "other" }), status: "working" });
    assert.ok(listens >= 1);
    assert.ok(gets >= 2);
    assert.match(env.delivered.join("\n"), /polled/);
    env.runtime.close();
  });

  it("treats a dropped connection as unavailable to the model", async () => {
    let gets = 0;
    const env = harness((method) => {
      if (method === "tasks/get") {
        gets += 1;
        throw new Error("connection closed");
      }
      return {};
    });
    env.runtime.acceptCreated("jobs", "hang_job", snapshot({ pollIntervalMs: 5 }));
    await settle();
    assert.ok(gets >= 3);
    assert.match(env.delivered.join("\n"), /disconnected/);
    env.runtime.close();
  });

  it("sets Mcp-Name only around task routing requests", async () => {
    const recorded: Array<{ name: string | null; method: string | null; rpc: string }> = [];
    const transport = {
      async headers(extra: Record<string, string> = {}) {
        return { headers: new Headers(extra) };
      },
      async send(this: { headers: (extra?: Record<string, string>) => Promise<{ headers: Headers }> }, rpc: string) {
        const { headers } = await this.headers();
        recorded.push({ name: headers.get("Mcp-Name"), method: headers.get("Mcp-Method"), rpc });
      },
    };
    const client = {
      transport,
      async request(this: { transport: typeof transport }, method: string, _params?: Record<string, unknown>) {
        await this.transport.send(method);
        return { resultType: "complete" };
      },
      onNotification() {},
    };
    const runtime = new TaskRuntime({ sleep: () => new Promise(() => {}) });
    attachClient(client, "jobs", runtime);
    await client.request("tools/call", { name: "echo" });
    await client.request("tasks/get", { taskId: "abc" });
    const get = recorded.find((entry) => entry.rpc === "tasks/get");
    const call = recorded.find((entry) => entry.rpc === "tools/call");
    assert.equal(get?.name, "abc");
    assert.equal(get?.method, "tasks/get");
    assert.equal(call?.name, null);
    runtime.close();
  });
});
