import assert from "node:assert/strict";
import { createServer, type IncomingMessage } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { attachClient, installBridge, loadPiMcp } from "../src/bridge.ts";
import { TaskRuntime } from "../src/runtime.ts";
import { TaskEngine } from "./task-engine.ts";
import { readTrace, until } from "./util.ts";

const serverFile = fileURLToPath(new URL("./stdio-server.ts", import.meta.url));

async function withStdio(legacy: boolean, run: (runtime: TaskRuntime, trace: string, client: { callTool: (name: string, args?: Record<string, unknown>) => Promise<unknown>; request: (method: string, params?: Record<string, unknown>) => Promise<unknown>; close: () => Promise<void> }) => Promise<void>) {
  const dir = await mkdtemp(join(tmpdir(), "pi-mcp-tasks-"));
  const trace = join(dir, "trace.log");
  const mcp = await loadPiMcp();
  const runtime = new TaskRuntime({
    limits: { maxFailures: 3, backoffMs: [20, 20, 20], startupGraceMs: 1_000 },
  });
  await installBridge(runtime);
  const args = ["--experimental-strip-types", serverFile];
  if (legacy) args.push("--legacy");
  const transport = new mcp.StdioTransport({
    command: process.execPath,
    args,
    env: { PI_MCP_TASKS_TRACE: trace },
  });
  const client = new mcp.McpClient({
    name: "pi-mcp-tasks-test",
    version: "0.0.0",
    capabilities: { tasks: { requests: { tools: { call: {} } }, list: {}, cancel: {} } } as never,
  });
  try {
    await client.connect(transport);
    await run(runtime, trace, client);
  } finally {
    runtime.close();
    await client.close().catch(() => undefined);
    await rm(dir, { recursive: true, force: true });
  }
}

describe("stdio tasks server", () => {
  it("C-MUST-01 C-MUST-07 C-MUST-10 completes a task by polling tasks/get", async () => {
    const texts: string[] = [];
    await withStdio(false, async (_runtime, trace, client) => {
      await assert.rejects(() => client.callTool("complete_job", {}), (error: unknown) => {
        assert.equal((error as { code?: number }).code, -32003);
        return true;
      });
      const watching = new TaskRuntime({
        deliver: (_task, text) => {
          texts.push(text);
        },
        limits: { maxFailures: 3, backoffMs: [20], startupGraceMs: 1_000 },
      });
      attachClient(client, "jobs", watching);
      try {
        const created = await client.callTool("complete_job", {});
        assert.equal((created as { resultType?: string }).resultType, "task");
        await until(() => texts.some((text) => text.includes("Operation completed successfully.")));
        const calls = readTrace(trace);
        assert.equal(calls.some((call) => call.method === "tasks/get"), true);
        assert.equal(calls.some((call) => call.method === "tasks/result"), false);
        assert.equal(calls.some((call) => call.method === "notifications/cancelled"), false);
        const toolCall = calls.find((call) => call.method === "tools/call" && call.hasTasksCapability);
        assert.ok(toolCall);
        const initialize = calls.find((call) => call.method === "initialize");
        assert.equal(initialize?.legacyTasksCapability, false);
        assert.equal(calls.some((call) => call.method === "tasks/get" && call.hasTasksCapability), true);
      } finally {
        watching.close();
      }
    });
  });

  it("C-MUST-12 fails with the server JSON-RPC error", async () => {
    const texts: string[] = [];
    await withStdio(false, async (_runtime, _trace, client) => {
      const watching = new TaskRuntime({ deliver: (_task, text) => {
        texts.push(text);
      } });
      attachClient(client, "jobs", watching);
      try {
        await client.callTool("fail_job", {});
        await until(() => texts.some((text) => text.includes("API rate limit exceeded") && text.includes("-32603")));
      } finally {
        watching.close();
      }
    });
  });

  it("C-MUST-05 C-MUST-07 cancels with tasks/cancel", async () => {
    const texts: string[] = [];
    await withStdio(false, async (_runtime, trace, client) => {
      const watching = new TaskRuntime({ deliver: (_task, text) => {
        texts.push(text);
      } });
      attachClient(client, "jobs", watching);
      try {
        const created = await client.callTool("cancel_job", {}) as unknown as { taskId: string };
        await until(() => watching.list().some((item) => item.taskId === created.taskId));
        await watching.cancel(created.taskId);
        await until(() => texts.some((text) => /cancel/i.test(text)));
        const calls = readTrace(trace);
        assert.equal(calls.some((call) => call.method === "tasks/cancel"), true);
        assert.equal(calls.some((call) => call.method === "tasks/result"), false);
        assert.equal(calls.some((call) => call.method === "notifications/cancelled"), false);
      } finally {
        watching.close();
      }
    });
  });

  it("C-SHOULD-05 C-SHOULD-06 updates an input_required task and waits for the result", async () => {
    const texts: string[] = [];
    await withStdio(false, async (_runtime, trace, client) => {
      const watching = new TaskRuntime({
        deliver: (_task, text) => {
          texts.push(text);
        },
        promptInput: async () => ({ name: { action: "accept", content: { name: "Luca" } } }),
      });
      attachClient(client, "jobs", watching);
      try {
        await client.callTool("ask_job", {});
        await until(() => texts.some((text) => text.includes("Hello, Luca")));
        const calls = readTrace(trace);
        assert.equal(calls.some((call) => call.method === "tasks/update"), true);
        assert.ok(calls.filter((call) => call.method === "tasks/get").length >= 2);
      } finally {
        watching.close();
      }
    });
  });

  it("C-MAY-02 expires when the server keeps the task working past ttlMs", async () => {
    const texts: string[] = [];
    await withStdio(false, async (_runtime, _trace, client) => {
      const watching = new TaskRuntime({ deliver: (_task, text) => {
        texts.push(text);
      } });
      attachClient(client, "jobs", watching);
      try {
        await client.callTool("expire_job", {});
        await until(() => texts.some((text) => text.includes("expired")), 3_000);
      } finally {
        watching.close();
      }
    });
  });

  it("C-MUST-11 delivers a completed tool error without marking the task failed", async () => {
    const texts: string[] = [];
    await withStdio(false, async (_runtime, _trace, client) => {
      const watching = new TaskRuntime({ deliver: (_task, text) => {
        texts.push(text);
      } });
      attachClient(client, "jobs", watching);
      try {
        await client.callTool("tool_error_job", {});
        await until(() => texts.some((text) => text.includes("isError: true") && text.includes("status: completed")));
        assert.equal(texts.some((text) => text.includes("status: failed")), false);
      } finally {
        watching.close();
      }
    });
  });

  it("C-MUST-07 C-MUST-08 ignores a legacy server and does not send task or tasks/result", async () => {
    await withStdio(true, async (runtime, trace, client) => {
      attachClient(client, "jobs", runtime);
      const result = await client.callTool("complete_job", {}) as { content?: Array<{ text?: string }> };
      assert.match(result.content?.[0]?.text ?? "", /legacy complete_job/);
      await client.request("tools/call", { name: "echo", arguments: { task: "keep-me", message: "hi" }, task: { ttl: 1 } });
      await new Promise((resolve) => setTimeout(resolve, 80));
      const calls = readTrace(trace);
      assert.equal(calls.some((call) => call.method === "tasks/get"), false);
      assert.equal(calls.some((call) => call.method === "tasks/result"), false);
      assert.equal(calls.some((call) => call.hasTaskParam), false);
      const echoed = calls.find((call) => call.method === "tools/call" && call.argumentTask === "keep-me");
      assert.ok(echoed);
      assert.equal(runtime.list().length, 0);
    });
  });

  it("stops polling when the connection drops", async () => {
    const texts: string[] = [];
    await withStdio(false, async (_runtime, _trace, client) => {
      const watching = new TaskRuntime({
        deliver: (_task, text) => {
          texts.push(text);
        },
        limits: { maxFailures: 2, backoffMs: [10, 10], startupGraceMs: 0 },
      });
      attachClient(client, "jobs", watching);
      try {
        await client.callTool("hang_job", {});
        await until(() => watching.list().length === 1);
        await client.close();
        await until(() => texts.some((text) => text.includes("disconnected")), 3_000);
      } finally {
        watching.close();
      }
    });
  });
});

describe("streamable http headers", () => {
  it("C-MUST-06 sets Mcp-Name and Mcp-Method on tasks/get, tasks/update, and tasks/cancel", async () => {
    const engine = new TaskEngine(false);
    const server = createServer(async (req, res) => {
      if (req.method !== "POST") {
        res.writeHead(405);
        res.end();
        return;
      }
      const body = await readBody(req);
      const response = engine.handle(JSON.parse(body), {
        "mcp-name": header(req, "mcp-name"),
        "mcp-method": header(req, "mcp-method"),
      });
      if (response === undefined) {
        res.writeHead(202);
        res.end();
        return;
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(response));
    });
    const mcp = await loadPiMcp();
    const runtime = new TaskRuntime({ limits: { maxFailures: 2, backoffMs: [10], startupGraceMs: 0 } });
    const client = new mcp.McpClient({ name: "pi-mcp-tasks-test", version: "0.0.0" });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
    const address = server.address();
    const port = typeof address === "object" && address ? address.port : 0;
    try {
      await installBridge(runtime);
      await client.connect(new mcp.StreamableHttpTransport({ url: `http://127.0.0.1:${port}/mcp` }));
      attachClient(client, "jobs", runtime);
      const created = await client.callTool("cancel_job", {}) as unknown as { taskId: string };
      await client.request("tasks/get", { taskId: created.taskId });
      await client.request("tasks/update", { taskId: created.taskId, inputResponses: {} });
      await client.request("tasks/cancel", { taskId: created.taskId });
      const named = engine.calls.filter((call) => call.method === "tasks/get" || call.method === "tasks/update" || call.method === "tasks/cancel");
      assert.ok(named.length >= 3);
      for (const call of named) {
        assert.equal(call.mcpName, created.taskId);
        assert.equal(call.mcpMethod, call.method);
      }
      const toolCalls = engine.calls.filter((call) => call.method === "tools/call");
      assert.equal(toolCalls.some((call) => call.mcpName), false);
    } finally {
      runtime.close();
      await client.close().catch(() => undefined);
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
  });
});

function header(req: IncomingMessage, name: string): string | undefined {
  const value = req.headers[name];
  return Array.isArray(value) ? value[0] : value;
}

async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  return Buffer.concat(chunks).toString("utf8");
}
