import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { isJsonRpcRequest, LATEST_PROTOCOL_VERSION, McpClient, SUPPORTED_PROTOCOL_VERSIONS, type JsonRpcMessage, type JsonRpcRequest } from "@earendil-works/pi-mcp";
import { attachClient, bundledMcpClients, installBridge } from "../src/bridge.ts";
import { disableProtocol2026, protocolIncludesPatched } from "../src/protocol.ts";
import { ElicitationRuntime } from "../src/runtime.ts";
import { ScriptedTransport, ScriptedUi } from "./support.ts";

const STOCK = ["2025-11-25", "2025-06-18", "2025-03-26", "2024-11-05"];

function initializeResult(version: string): Record<string, unknown> {
  return {
    protocolVersion: version,
    capabilities: { tools: {} },
    serverInfo: { name: "demo", version: "0" },
  };
}

function replyInitialize(version: string) {
  return (message: JsonRpcMessage, reply: (message: JsonRpcMessage) => void) => {
    if (!isJsonRpcRequest(message)) return;
    if (message.method === "initialize") {
      reply({ jsonrpc: "2.0", id: message.id, result: initializeResult(version) });
    }
  };
}

describe("pi client", () => {
  it("C-MUST-01 C-MUST-12 C-MUST-13 answers a legacy form elicitation on the connected client", async () => {
    const ui = new ScriptedUi(["Answer", "octocat", "Accept"]);
    const runtime = new ElicitationRuntime({ mode: () => "ui", ui: () => ui });
    await installBridge(runtime);
    let toolId: JsonRpcMessage extends never ? never : number | string | undefined;
    const transport = new ScriptedTransport((message, reply) => {
      if (isJsonRpcRequest(message) && message.method === "initialize") {
        reply({ jsonrpc: "2.0", id: message.id, result: initializeResult("2025-11-25") });
        return;
      }
      if (isJsonRpcRequest(message) && message.method === "tools/call") {
        toolId = message.id;
        reply({
          jsonrpc: "2.0",
          id: 4242,
          method: "elicitation/create",
          params: {
            message: "Please provide your GitHub username",
            requestedSchema: { type: "object", properties: { name: { type: "string" } }, required: ["name"] },
          },
        });
        return;
      }
      if ("id" in message && message.id === 4242 && "result" in message) {
        reply({
          jsonrpc: "2.0",
          id: toolId ?? 2,
          result: { content: [{ type: "text", text: JSON.stringify(message.result) }] },
        });
      }
    });
    const client = new McpClient({
      name: "pi-mcp-elicitations-test",
      version: "0.0.0",
      capabilities: { sampling: {}, extensions: { "io.modelcontextprotocol/tasks": {} } } as never,
    });
    attachClient(client, "billing", runtime);
    try {
      await client.connect(transport);
      const result = await client.callTool("ask", {});
      const init = transport.sent.find((item) => isJsonRpcRequest(item) && item.method === "initialize");
      assert.ok(init && isJsonRpcRequest(init));
      const capabilities = (init.params as { capabilities: { elicitation: unknown; sampling: unknown; extensions: unknown } }).capabilities;
      assert.deepEqual(capabilities.elicitation, { form: {}, url: {} });
      assert.deepEqual(capabilities.sampling, {});
      assert.deepEqual(capabilities.extensions, { "io.modelcontextprotocol/tasks": {} });
      const answer = transport.sent.find((item) => isJsonRpcRequest(item) === false && "id" in item && item.id === 4242 && "result" in item);
      assert.ok(answer && "result" in answer);
      assert.deepEqual(answer.result, { action: "accept", content: { name: "octocat" } });
      assert.match(JSON.stringify(result), /octocat/);
      const toolCall = transport.sent.find((item) => isJsonRpcRequest(item) && item.method === "tools/call");
      assert.ok(toolCall && isJsonRpcRequest(toolCall));
      const meta = (toolCall.params as { _meta: Record<string, unknown> })._meta;
      assert.equal(meta["io.modelcontextprotocol/protocolVersion"], "2025-11-25");
      assert.deepEqual(
        (meta["io.modelcontextprotocol/clientCapabilities"] as { elicitation: unknown }).elicitation,
        { form: {}, url: {} },
      );
    } finally {
      await client.close().catch(() => undefined);
    }
  });

  it("C-MUST-09 C-MUST-11 retries MRTR with a new id and the echoed state", async () => {
    const ui = new ScriptedUi(["Answer", "octocat", "Accept"]);
    const runtime = new ElicitationRuntime({ mode: () => "ui", ui: () => ui });
    await installBridge(runtime);
    const transport = new ScriptedTransport((message, reply) => {
      if (!isJsonRpcRequest(message)) return;
      if (message.method === "initialize") {
        reply({ jsonrpc: "2.0", id: message.id, result: initializeResult("2025-11-25") });
        return;
      }
      if (message.method !== "tools/call") return;
      const params = message.params as { inputResponses?: unknown; requestState?: string } | undefined;
      if (!params?.inputResponses) {
        reply({
          jsonrpc: "2.0",
          id: message.id,
          result: {
            resultType: "input_required",
            inputRequests: {
              name: {
                method: "elicitation/create",
                params: {
                  mode: "form",
                  message: "Username",
                  requestedSchema: { type: "object", properties: { name: { type: "string" } }, required: ["name"] },
                },
              },
            },
            requestState: "AEAD-protected blob",
          },
        });
        return;
      }
      reply({
        jsonrpc: "2.0",
        id: message.id,
        result: { content: [{ type: "text", text: `state=${params.requestState}` }] },
      });
    });
    const client = new McpClient({ name: "pi-mcp-elicitations-test", version: "0.0.0" });
    attachClient(client, "billing", runtime);
    try {
      await client.connect(transport);
      const result = await client.callTool("deploy", { env: "prod" });
      const calls = transport.sent.filter((item): item is JsonRpcRequest => isJsonRpcRequest(item) && item.method === "tools/call");
      assert.equal(calls.length, 2);
      assert.notEqual(calls[0]?.id, calls[1]?.id);
      const retry = calls[1];
      assert.ok(retry && isJsonRpcRequest(retry));
      const params = retry.params as { requestState: string; inputResponses: { name: { content: { name: string } } }; arguments: { env: string } };
      assert.equal(params.requestState, "AEAD-protected blob");
      assert.equal(params.inputResponses.name.content.name, "octocat");
      assert.equal(params.arguments.env, "prod");
      assert.match(JSON.stringify(result), /AEAD-protected blob/);
    } finally {
      await client.close().catch(() => undefined);
    }
  });

  it("C-MAY-02 keeps 2025-11-25 unless the protocol flag is set", async () => {
    assert.equal(LATEST_PROTOCOL_VERSION, "2025-11-25");
    assert.deepEqual([...SUPPORTED_PROTOCOL_VERSIONS], STOCK);
    const runtime = new ElicitationRuntime({ protocol: () => undefined });
    await installBridge(runtime);
    const client = new McpClient({ name: "pi-mcp-elicitations-test", version: "0.0.0" });
    await assert.rejects(() => client.connect(new ScriptedTransport(replyInitialize("2026-07-28"))), /unsupported protocol version 2026-07-28/);
    assert.equal(protocolIncludesPatched(), false);
    assert.deepEqual([...SUPPORTED_PROTOCOL_VERSIONS], STOCK);
    const root = dirname(dirname(fileURLToPath(import.meta.resolve("@earendil-works/pi-coding-agent"))));
    const [Bundled] = await bundledMcpClients(root);
    assert.ok(Bundled);
    const bundled = new Bundled!({ name: "pi", version: "0" });
    await assert.rejects(async () => {
      const pending = bundled.connect?.(new ScriptedTransport(replyInitialize("2026-07-28")));
      if (!pending) throw new Error("bundled client has no connect");
      await pending;
    }, /unsupported protocol version 2026-07-28/);

    const opted = new ElicitationRuntime({ protocol: () => "2026-07-28" });
    await installBridge(opted);
    try {
      const accepted = new McpClient({ name: "pi-mcp-elicitations-test", version: "0.0.0" });
      const result = await accepted.connect(new ScriptedTransport(replyInitialize("2026-07-28")));
      assert.equal(result.protocolVersion, "2026-07-28");
      const init = accepted;
      assert.equal(init.protocolVersion, "2026-07-28");
      await accepted.close();
      const bundledAccepted = new Bundled!({ name: "pi", version: "0" });
      const bundledResult = await bundledAccepted.connect?.(new ScriptedTransport(replyInitialize("2026-07-28")));
      assert.equal((bundledResult as { protocolVersion?: string } | undefined)?.protocolVersion, "2026-07-28");
      await (bundledAccepted as { close?: () => Promise<void> }).close?.();
      const copy = ["2025-11-25", "2025-06-18", "2025-03-26", "2024-11-05"];
      assert.equal(copy.includes("2026-07-28"), true);
      const strict = new McpClient({ name: "pi-mcp-elicitations-test", version: "0.0.0" });
      const strictTransport = new ScriptedTransport((message, reply) => {
        if (!isJsonRpcRequest(message) || message.method !== "initialize") return;
        reply({ jsonrpc: "2.0", id: message.id, error: { code: -32601, message: "initialize was removed" } });
      });
      await assert.rejects(() => strict.connect(strictTransport), /initialize was removed/);
    } finally {
      disableProtocol2026();
    }
    assert.equal(protocolIncludesPatched(), false);
    assert.equal(["2025-11-25", "2025-06-18", "2025-03-26", "2024-11-05"].includes("2026-07-28"), false);
    assert.equal((SUPPORTED_PROTOCOL_VERSIONS as unknown as string[]).includes("2026-07-28"), false);
  });
});
