/** Stdio MCP server for integration tests. One JSON-RPC message per line. */

import { createInterface } from "node:readline";
import { TaskEngine } from "./task-engine.ts";

const engine = new TaskEngine(process.argv.includes("--legacy"));
const lines = createInterface({ input: process.stdin, terminal: false });
lines.on("line", (line) => {
  const trimmed = line.trim();
  if (!trimmed) return;
  let message: unknown;
  try {
    message = JSON.parse(trimmed);
  } catch {
    process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } })}\n`);
    return;
  }
  const response = engine.handle(message);
  if (response !== undefined) process.stdout.write(`${JSON.stringify(response)}\n`);
  for (const note of engine.drain()) process.stdout.write(`${JSON.stringify(note)}\n`);
});
