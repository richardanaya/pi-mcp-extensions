import assert from "node:assert/strict";
import test from "node:test";
import { startSite } from "../src/site.ts";

const APP = `<!DOCTYPE html><html><head></head><body><p>board</p></body></html>`;

test("host answers the app methods from the 2026-01-26 spec", async () => {
  const reads: string[] = [];
  const contexts: unknown[] = [];
  const opened: string[] = [];
  const site = await startSite(
    () => {},
    async () => ({ content: [] }),
    async (_view, uri) => {
      reads.push(uri);
      return { contents: [] };
    },
    (_view, params) => contexts.push(params),
    async (url) => { opened.push(url); },
  );
  const link = site.publish({
    server: "todos",
    tool: "todo_list",
    html: APP,
    arguments: {},
    resultText: "",
    csp: { connectDomains: ["https://api.example.com"], resourceDomains: ["https://cdn.example.com"] },
    permissions: { clipboardWrite: {} },
  });
  const rpc = link.replace("/view/", "/rpc/");
  await post(rpc, { jsonrpc: "2.0", id: 1, method: "ui/initialize", params: { protocolVersion: "2026-01-26", appCapabilities: {} } });
  const ping = await post(rpc, { jsonrpc: "2.0", id: 2, method: "ping" });
  assert.deepEqual(ping.result, {});
  const mode = await post(rpc, { jsonrpc: "2.0", id: 3, method: "ui/request-display-mode", params: { mode: "fullscreen" } });
  assert.deepEqual(mode.result, { mode: "inline" });
  const read = await post(rpc, { jsonrpc: "2.0", id: 4, method: "resources/read", params: { uri: "ui://todos/board" } });
  assert.deepEqual(read.result, { contents: [] });
  assert.deepEqual(reads, ["ui://todos/board"]);
  const context = await post(rpc, { jsonrpc: "2.0", id: 5, method: "ui/update-model-context", params: { content: [{ type: "text", text: "two open" }] } });
  assert.deepEqual(context.result, {});
  assert.equal(contexts.length, 1);
  const linkOpen = await post(rpc, { jsonrpc: "2.0", id: 6, method: "ui/open-link", params: { url: "https://example.com" } });
  assert.deepEqual(linkOpen.result, {});
  assert.deepEqual(opened, ["https://example.com"]);
  const denied = await post(rpc, { jsonrpc: "2.0", id: 7, method: "ui/open-link", params: { url: "javascript:alert(1)" } });
  assert.equal((denied as { error?: { code?: number } }).error?.code, -32000);
  const sandbox = await fetch(link.replace("/view/", "/sandbox/"));
  const sandboxHtml = await sandbox.text();
  assert.match(sandboxHtml, /injectCsp/);
  const page = await fetch(link);
  const pageHtml = await page.text();
  assert.match(pageHtml, /https:\/\/api\.example\.com/);
  assert.match(pageHtml, /clipboard-write/);
  assert.match(pageHtml, /script-src 'self' 'unsafe-inline'/);
  await site.close();
});

test("ui/initialize then ui/message reaches the session callback", async () => {
  const heard: string[] = [];
  const site = await startSite(
    (_view, text) => heard.push(text),
    async () => ({ content: [] }),
  );
  const link = site.publish({ server: "todos", tool: "todo_list", html: APP, arguments: { status: "open" }, resultText: "[]" });
  const token = link.split("/").pop();
  const init = await post(link.replace("/view/", "/rpc/"), {
    jsonrpc: "2.0",
    id: 1,
    method: "ui/initialize",
    params: { protocolVersion: "2026-01-26", appCapabilities: { availableDisplayModes: ["inline"] } },
  });
  assert.equal(init.result.protocolVersion, "2026-01-26");
  const sent = await post(link.replace("/view/", "/rpc/"), {
    jsonrpc: "2.0",
    id: 2,
    method: "ui/message",
    params: { role: "user", content: { type: "text", text: "mark the first todo done" } },
  });
  assert.deepEqual(sent.result, {});
  assert.deepEqual(heard, ["mark the first todo done"]);
  const page = await fetch(link);
  assert.equal(page.status, 200);
  const body = await page.text();
  assert.match(body, /sandbox=/);
  assert.match(body, new RegExp(`127\\.0\\.0\\.2:${site.port}`));
  void token;
  await site.close();
});

async function post(url: string, body: unknown): Promise<{ result: Record<string, unknown> }> {
  const response = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  return response.json() as Promise<{ result: Record<string, unknown> }>;
}
