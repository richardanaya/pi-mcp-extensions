import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  createAgentSession,
  createMcpExtension,
  DefaultResourceLoader,
  SessionManager,
  SettingsManager,
  type ExtensionUIContext,
} from "@earendil-works/pi-coding-agent";
import { createTasksExtension } from "../index.ts";
import { MESSAGE_TYPE } from "../src/protocol.ts";
import { readTrace, until } from "./util.ts";

const serverFile = fileURLToPath(new URL("./stdio-server.ts", import.meta.url));

describe("pi session", () => {
  it("uses pi's built-in MCP connection and delivers the task result into the session", async () => {
    const dir = await mkdtemp(join(tmpdir(), "pi-mcp-tasks-session-"));
    const cwd = join(dir, "project");
    const agentDir = join(dir, "agent");
    const trace = join(dir, "trace.log");
    const { mkdir } = await import("node:fs/promises");
    await mkdir(cwd);
    await mkdir(agentDir);
    const settings = SettingsManager.inMemory();
    const loader = new DefaultResourceLoader({
      cwd,
      agentDir,
      settingsManager: settings,
      noSkills: true,
      noPromptTemplates: true,
      noThemes: true,
      noContextFiles: true,
      extensionFactories: [
        {
          name: "mcp",
          builtin: true,
          replaceable: true,
          factory: createMcpExtension({
            logPath: join(dir, "mcp.log"),
            loadConfig: () => ({
              servers: [{
                name: "tasks",
                config: {
                  command: process.execPath,
                  args: ["--experimental-strip-types", serverFile],
                  timeout: 10,
                  exposure: "direct",
                  env: { PI_MCP_TASKS_TRACE: trace },
                },
                source: "test",
                scope: "global",
              }],
              autoEnableCodemode: false,
              errors: [],
            }),
          }),
        },
        createTasksExtension(),
      ],
    });
    let session: Awaited<ReturnType<typeof createAgentSession>>["session"] | undefined;
    try {
      await loader.reload();
      const extensionErrors = loader.getExtensions().errors;
      assert.deepEqual(extensionErrors, [], JSON.stringify(extensionErrors));
      const created = await createAgentSession({
        cwd,
        agentDir,
        settingsManager: settings,
        sessionManager: SessionManager.inMemory(cwd),
        resourceLoader: loader,
        noTools: "builtin",
      });
      session = created.session;
      await session.bindExtensions({ mode: "print", uiContext: testUi() });
      let tool: ReturnType<typeof session.getToolDefinition>;
      try {
        await until(() => {
          tool = session?.getToolDefinition("mcp__tasks__complete_job");
          return tool !== undefined;
        }, 8_000);
      } catch (error) {
        const log = await readFile(join(dir, "mcp.log"), "utf8").catch(() => "");
        const traced = readTrace(trace);
        throw new Error(`${error instanceof Error ? error.message : error}\n${log}\n${JSON.stringify(traced)}`, { cause: error });
      }
      assert.ok(tool);
      await tool.execute("call-1", {}, undefined, undefined, undefined as never);
      await until(() => session?.sessionManager.getEntries().some((entry) => (
        entry.type === "custom_message" && entry.customType === MESSAGE_TYPE && typeof entry.content === "string" && entry.content.includes("Operation completed successfully.")
      )) === true, 8_000);
      const calls = readTrace(trace);
      assert.equal(calls.some((call) => call.method === "tasks/get"), true);
      assert.equal(calls.some((call) => call.method === "tasks/result"), false);
      assert.equal(calls.some((call) => call.hasTaskParam), false);
    } finally {
      if (session) {
        // dispose() does not emit session_shutdown, so pi's MCP client would leave the stdio child running.
        await emitShutdown(session).catch(() => undefined);
        session.dispose();
      }
      await rm(dir, { recursive: true, force: true });
    }
  });
});

async function emitShutdown(session: { extensionRunner: unknown }): Promise<void> {
  const agentEntry = fileURLToPath(import.meta.resolve("@earendil-works/pi-coding-agent"));
  const runnerUrl = pathToFileURL(join(dirname(dirname(agentEntry)), "dist/core/extensions/runner.js")).href;
  const runner = await import(runnerUrl) as {
    emitSessionShutdownEvent: (
      extensionRunner: unknown,
      event: { type: "session_shutdown"; reason: "quit" },
    ) => Promise<boolean>;
  };
  await runner.emitSessionShutdownEvent(session.extensionRunner, { type: "session_shutdown", reason: "quit" });
}

function testUi(): ExtensionUIContext {
  return {
    select: async () => undefined,
    confirm: async () => true,
    input: async () => "Luca",
    notify() {},
    onTerminalInput: () => () => {},
    setStatus() {},
    setWorkingMessage() {},
    setWorkingVisible() {},
    setWorkingIndicator() {},
    setHiddenThinkingLabel() {},
    setWidget() {},
    setFooter() {},
    setHeader() {},
    setTitle() {},
    custom: async () => undefined as never,
    pasteToEditor() {},
    setEditorText() {},
    getEditorText: () => "",
    editor: async () => undefined,
    addAutocompleteProvider() {},
  } as unknown as ExtensionUIContext;
}
