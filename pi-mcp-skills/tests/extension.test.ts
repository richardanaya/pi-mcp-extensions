import assert from "node:assert/strict";
import test from "node:test";
import type { ExtensionAPI, ToolCallEvent } from "@earendil-works/pi-coding-agent";
import { createExtension, formatReport } from "../index.ts";
import { skillDocument, FakePort, listedSkill, readResult, skillsCapabilities } from "./support.ts";

function fakeApi() {
  const handlers = new Map<string, ((event: unknown, ctx: unknown) => unknown)[]>();
  const tools = new Map<string, { execute: (...args: unknown[]) => Promise<unknown> }>();
  const servers: { name: string }[] = [];
  const api = {
    on(event: string, handler: (event: unknown, ctx: unknown) => unknown) {
      const list = handlers.get(event) ?? [];
      list.push(handler);
      handlers.set(event, list);
      return () => undefined;
    },
    registerTool(tool: { name: string; execute: (...args: unknown[]) => Promise<unknown> }) {
      tools.set(tool.name, tool);
    },
    registerFlag() {},
    getFlag() {
      return undefined;
    },
    getMcpServers() {
      return servers;
    },
  };
  return { api: api as unknown as ExtensionAPI, handlers, tools, servers };
}

function ui(confirm: (title: string, message: string) => Promise<boolean> | boolean, editor?: (title: string, text: string) => Promise<string | undefined>) {
  const notes: string[] = [];
  const edits: { title: string; text: string }[] = [];
  const confirms: { title: string; message: string }[] = [];
  const ctx = {
    hasUI: true,
    ui: {
      async confirm(title: string, message: string) {
        confirms.push({ title, message });
        return confirm(title, message);
      },
      notify(message: string) {
        notes.push(message);
      },
      async editor(title: string, text?: string) {
        edits.push({ title, text: text ?? "" });
        return editor?.(title, text ?? "");
      },
      setStatus() {},
    },
  };
  return { ctx, notes, edits, confirms };
}

test("C53 extension servers are tracked and mcp.json servers stay attached", async () => {
  const fake = fakeApi();
  const host = await createExtension(fake.api);
  const file = skillDocument("demo", "A demo skill");
  const uri = "skill://demo/SKILL.md";
  const jsonPort = new FakePort(skillsCapabilities(), (method) => {
    if (method === "skills/list") return { skills: [listedSkill(uri, "demo", "A demo skill", file)] };
    throw new Error(method);
  });
  const extPort = new FakePort(skillsCapabilities(), (method) => {
    if (method === "skills/list") return { skills: [listedSkill("skill://ext/SKILL.md", "ext", "Extension skill", skillDocument("ext", "Extension skill"))] };
    throw new Error(method);
  });
  await host.attach("from-json", jsonPort);
  const start = fake.handlers.get("session_start")?.[0];
  assert.ok(start);
  await start?.({ type: "session_start" }, {});
  assert.deepEqual(host.serverNames(), ["from-json"]);
  await host.attach("ext", extPort);
  fake.servers.push({ name: "ext" });
  const change = fake.handlers.get("mcp_servers_change")?.[0];
  await change?.({ type: "mcp_servers_change", servers: [{ name: "ext" }] }, {});
  assert.deepEqual(host.serverNames().sort(), ["ext", "from-json"]);
  await change?.({ type: "mcp_servers_change", servers: [] }, {});
  assert.deepEqual(host.serverNames(), ["from-json"]);
  const shutdown = fake.handlers.get("session_shutdown")?.[0];
  await shutdown?.({ type: "session_shutdown" }, {});
  assert.deepEqual(host.serverNames(), []);
});

test("C47 show inspects a skill without loading it", async () => {
  const fake = fakeApi();
  const host = await createExtension(fake.api);
  const file = skillDocument("demo", "A demo skill");
  const uri = "skill://demo/SKILL.md";
  const port = new FakePort(skillsCapabilities(), (method) => {
    if (method === "skills/list") return { skills: [listedSkill(uri, "demo", "A demo skill", file)] };
    if (method === "resources/read") return readResult(uri, file.text);
    throw new Error(method);
  });
  await host.attach("docs", port);
  const presented = await host.show("docs", "demo");
  assert.match(presented.text, /server "docs"/);
  assert.match(presented.text, /A demo skill/);
  assert.equal(host.acting().length, 0);
  assert.match(formatReport(host), /docs\tdemo\t/);
});

test("tool approval mode loads only when approve is true and skips the dialog", async () => {
  const previous = process.env.PI_MCP_SKILLS_APPROVALS;
  process.env.PI_MCP_SKILLS_APPROVALS = "tool";
  try {
    const fake = fakeApi();
    const file = skillDocument("demo", "A demo skill");
    const uri = "skill://demo/SKILL.md";
    const port = new FakePort(skillsCapabilities(), (method) => {
      if (method === "skills/list") return { skills: [listedSkill(uri, "demo", "A demo skill", file)] };
      if (method === "resources/read") return readResult(uri, file.text);
      throw new Error(method);
    });
    const host = await createExtension(fake.api);
    await host.attach("docs", port);
    const load = fake.tools.get("mcp_skills_load");
    assert.ok(load);
    const dialog = ui(async () => true);
    const refused = await load.execute("1", { server: "docs", skill: "demo" }, undefined, undefined, dialog.ctx);
    assert.equal((refused as { isError?: boolean }).isError, true);
    assert.equal(dialog.confirms.length, 0);
    const accepted = await load.execute("2", { server: "docs", skill: "demo", approve: true }, undefined, undefined, dialog.ctx);
    assert.equal((accepted as { isError?: boolean }).isError, undefined);
    assert.equal(dialog.confirms.length, 0);
    assert.equal(host.acting().length, 1);
  } finally {
    if (previous === undefined) delete process.env.PI_MCP_SKILLS_APPROVALS;
    else process.env.PI_MCP_SKILLS_APPROVALS = previous;
  }
});

test("C43 code execution needs its own approval while a skill is loaded", async () => {
  const fake = fakeApi();
  const host = await createExtension(fake.api);
  const file = skillDocument("demo", "A demo skill");
  const uri = "skill://demo/SKILL.md";
  const port = new FakePort(skillsCapabilities(), (method) => {
    if (method === "skills/list") return { skills: [listedSkill(uri, "demo", "A demo skill", file)] };
    if (method === "resources/read") return readResult(uri, file.text);
    throw new Error(method);
  });
  await host.attach("docs", port);
  const gate = fake.handlers.get("tool_call")?.[0];
  assert.ok(gate);
  const idle = ui(async () => false);
  const before = await gate?.({ type: "tool_call", toolName: "bash", toolCallId: "1", input: { command: "ls" } } as ToolCallEvent, idle.ctx);
  assert.equal(before, undefined);
  await host.load("docs", uri, () => true);
  const denied = ui(async () => false);
  const blocked = await gate?.({ type: "tool_call", toolName: "bash", toolCallId: "2", input: { command: "ls" } } as ToolCallEvent, denied.ctx);
  assert.deepEqual(blocked, { block: true, reason: "Code execution (bash) was not approved while an MCP skill is loaded." });
  assert.match(denied.confirms[0]?.message ?? "", /docs/);
  const allowed = ui(async () => true);
  const passed = await gate?.({ type: "tool_call", toolName: "shell", toolCallId: "3", input: {} } as ToolCallEvent, allowed.ctx);
  assert.equal(passed, undefined);
  const remote = await gate?.({ type: "tool_call", toolName: "mcp__docs__touch", toolCallId: "4", input: {} } as ToolCallEvent, idle.ctx);
  assert.equal(remote, undefined);
});
