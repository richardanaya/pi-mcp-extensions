import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { ElicitationRuntime } from "../src/runtime.ts";
import { routingUi, ScriptedUi } from "./support.ts";

const nameSchema = {
  type: "object",
  properties: { name: { type: "string", minLength: 1 } },
  required: ["name"],
};

function inputRequired(state: string, serverMessage = "Username") {
  return {
    resultType: "input_required",
    inputRequests: {
      name: {
        method: "elicitation/create",
        params: { mode: "form", message: serverMessage, requestedSchema: nameSchema },
      },
    },
    requestState: state,
  };
}

describe("runtime", () => {
  it("C-MUST-15 cancels a legacy elicitation immediately when nobody can answer", async () => {
    const runtime = new ElicitationRuntime({ mode: () => "ui", ui: () => undefined });
    const started = Date.now();
    const result = await runtime.legacy("billing", { mode: "form", message: "Name", requestedSchema: nameSchema });
    assert.deepEqual(result, { action: "cancel" });
    assert.ok(Date.now() - started < 50);
    assert.match(runtime.listText(), /No elicitations/);
  });

  it("C-SHOULD-06 C-MAY-03 waits for mcp_elicitations_respond in tool mode and validates the form", async () => {
    const runtime = new ElicitationRuntime({
      mode: () => "tool",
      ui: () => {
        throw new Error("dialog");
      },
    });
    let settled = false;
    const pending = runtime.legacy("billing", { mode: "form", message: "Name", requestedSchema: nameSchema }).then((result) => {
      settled = true;
      return result;
    });
    await Promise.resolve();
    assert.equal(settled, false);
    assert.match(runtime.listText(), /e1\tbilling\tlegacy/);
    const invalid = await runtime.respond("e1", JSON.stringify({ action: "accept", content: {} }));
    assert.match(invalid, /^Error:/);
    assert.equal(settled, false);
    const sent = await runtime.respond("e1", JSON.stringify({ action: "accept", content: { name: "octocat" } }));
    assert.match(sent, /accept/);
    assert.deepEqual(await pending, { action: "accept", content: { name: "octocat" } });
  });

  it("C-MUST-05 does not open a URL in tool mode unless open is true", async () => {
    const opened: string[] = [];
    const runtime = new ElicitationRuntime({
      mode: () => "tool",
      openUrl: (url) => {
        opened.push(url);
      },
    });
    const pending = runtime.legacy("billing", {
      mode: "url",
      url: "https://mcp.example.com/ui/set_api_key",
      elicitationId: "550e8400-e29b-41d4-a716-446655440000",
      message: "Provide the key in the browser.",
    });
    await Promise.resolve();
    const refused = await runtime.respond("e1", JSON.stringify({ action: "accept" }));
    assert.match(refused, /open true/);
    assert.deepEqual(opened, []);
    const accepted = await runtime.respond("e1", JSON.stringify({ action: "accept" }), true);
    assert.match(accepted, /accept/);
    assert.deepEqual(opened, ["https://mcp.example.com/ui/set_api_key"]);
    assert.deepEqual(await pending, { action: "accept" });
  });

  it("C-MUST-09 C-MUST-10 C-MUST-11 retries each request with its own state", async () => {
    const runtime = new ElicitationRuntime({ mode: () => "ui", ui: () => routingUi() });
    const seen: Record<string, unknown>[] = [];
    const send = async (_method: string, params?: Record<string, unknown>) => {
      seen.push(params ?? {});
      return { content: [{ type: "text", text: String(params?.requestState) }] };
    };
    const [first, second] = await Promise.all([
      runtime.handleInputRequired("server-a", "tools/call", { name: "a" }, inputRequired("STATE-A"), send),
      runtime.handleInputRequired("server-b", "tools/call", { name: "b" }, inputRequired("STATE-B"), send),
    ]);
    assert.equal(seen.length, 2);
    const states = seen.map((params) => params.requestState);
    assert.deepEqual(states.sort(), ["STATE-A", "STATE-B"]);
    const a = seen.find((params) => params.requestState === "STATE-A");
    const b = seen.find((params) => params.requestState === "STATE-B");
    assert.deepEqual((a?.inputResponses as { name: { content: { name: string } } }).name.content, { name: "from-a" });
    assert.deepEqual((b?.inputResponses as { name: { content: { name: string } } }).name.content, { name: "from-b" });
    assert.equal(JSON.stringify(a).includes("STATE-B"), false);
    assert.equal(JSON.stringify(b).includes("STATE-A"), false);
    assert.deepEqual(first, { content: [{ type: "text", text: "STATE-A" }] });
    assert.deepEqual(second, { content: [{ type: "text", text: "STATE-B" }] });
  });

  it("C-MUST-17 does not retry sampling input requests", async () => {
    const runtime = new ElicitationRuntime({ mode: () => "ui", ui: () => new ScriptedUi([]) });
    const calls: unknown[] = [];
    const result = await runtime.handleInputRequired("billing", "tools/call", { name: "ask" }, {
      resultType: "input_required",
      inputRequests: { sample: { method: "sampling/createMessage", params: {} } },
      requestState: "blob",
    }, async (_method, params) => {
      calls.push(params);
      return {};
    });
    assert.equal(calls.length, 0);
    const text = JSON.stringify(result);
    assert.match(text, /sampling\/createMessage/);
  });

  it("cancels an MRTR elicitation immediately when tool mode is off and there is no UI", async () => {
    const runtime = new ElicitationRuntime({ mode: () => "ui", ui: () => undefined });
    const seen: unknown[] = [];
    const result = await runtime.handleInputRequired("billing", "tools/call", { name: "ask" }, inputRequired("blob"), async (_method, params) => {
      seen.push(params);
      return { content: [{ type: "text", text: "cancelled-round" }] };
    });
    assert.deepEqual((seen[0] as { inputResponses: { name: { action: string } } }).inputResponses.name, { action: "cancel" });
    assert.equal((seen[0] as { requestState: string }).requestState, "blob");
    assert.deepEqual(result, { content: [{ type: "text", text: "cancelled-round" }] });
  });

  it("C-MUST-14 C-MAY-01 C-SHOULD-04 ignores unknown completion ids and retries after a known one", async () => {
    const delivered: string[] = [];
    const opened: string[] = [];
    let calls = 0;
    const runtime = new ElicitationRuntime({
      mode: () => "ui",
      ui: () => new ScriptedUi(["Open"]),
      openUrl: (url) => {
        opened.push(url);
      },
      deliver: (text) => {
        delivered.push(text);
      },
      notify: () => {},
    });
    const url = "https://mcp.example.com/connect?elicitationId=elicit-1";
    const pending = runtime.around("billing", "tools/call", { name: "files" }, undefined, async (_method, params) => {
      calls += 1;
      if (calls === 1) {
        const error = new Error("This request requires more information.");
        Object.assign(error, {
          code: -32042,
          data: { elicitations: [{ mode: "url", elicitationId: "elicit-1", url, message: "Authorize Example Co." }] },
        });
        throw error;
      }
      return { content: [{ type: "text", text: `retried ${String((params as { name?: string } | undefined)?.name)}` }] };
    });
    const parked = await pending;
    assert.match(JSON.stringify(parked), /mcp_elicitations_retry/);
    assert.deepEqual(opened, [url]);
    runtime.completeNotification("billing", { elicitationId: "someone-else" });
    assert.deepEqual(delivered, []);
    runtime.completeNotification("billing", { elicitationId: "elicit-1" });
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.deepEqual(delivered, ["retried files"]);
    runtime.completeNotification("billing", { elicitationId: "elicit-1" });
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.deepEqual(delivered, ["retried files"]);
    const manual = new ElicitationRuntime({
      mode: () => "ui",
      ui: () => new ScriptedUi(["Open"]),
      openUrl: () => {},
    });
    let manualCalls = 0;
    await manual.around("billing", "tools/call", { name: "files" }, undefined, async () => {
      manualCalls += 1;
      if (manualCalls === 1) {
        const error = new Error("required");
        Object.assign(error, { code: -32042, data: { elicitations: [{ mode: "url", elicitationId: "elicit-2", url, message: "Authorize." }] } });
        throw error;
      }
      return { content: [{ type: "text", text: "manual" }] };
    });
    const retried = await manual.retry();
    assert.match(retried, /manual/);
  });
});
