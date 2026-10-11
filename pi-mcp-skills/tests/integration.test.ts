import assert from "node:assert/strict";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { installPiMcpHooks, piCodingAgentRoot } from "../src/attach.ts";
import { SkillsHost } from "../src/host.ts";
import { EXTENSION_ID, SkillsFailure } from "../src/model.ts";

test("C07 C22 C25 C26 C40 C51 C52 C54 skills lookup through pi's MCP client", async () => {
  const runtime = (await import(pathToFileURL(join(piCodingAgentRoot(), "dist/extensions/mcp/runtime.js")).href)) as {
    McpServerConnection: new (options: {
      entry: { name: string; config: { command: string; args: string[] }; source: string };
      cwd: string;
      createTransport: (entry: { name: string; config: { command: string; args: string[] } }, cwd: string, auth: undefined) => unknown;
      credentials: { forServer: () => never };
      onTools: () => void;
    }) => {
      getClient: () => Promise<{ request: (method: string, params?: Record<string, unknown>) => Promise<unknown> }>;
      close: () => Promise<void>;
    };
    createDefaultTransport: (entry: { name: string; config: { command: string; args: string[] } }, cwd: string, auth: undefined) => unknown;
  };
  const host = new SkillsHost();
  const hook = await installPiMcpHooks({
    onReady: (live) => host.attach(live.server, live),
    onClose: (server) => host.detach(server),
  });
  assert.equal(hook.installed, true);
  const fixture = fileURLToPath(new URL("./fixture-server.ts", import.meta.url));
  const connection = new runtime.McpServerConnection({
    entry: {
      name: "skills",
      config: { command: process.execPath, args: ["--experimental-strip-types", fixture] },
      source: "test",
    },
    cwd: process.cwd(),
    createTransport: runtime.createDefaultTransport,
    credentials: { forServer: () => { throw new Error("unused"); } },
    onTools() {},
  });
  try {
    const client = await connection.getClient();
    const listed = host.catalog();
    assert.equal(listed.every((entry) => entry.server === "skills"), true);
    assert.equal(listed.some((entry) => entry.skill.uri === "skill://broken/SKILL.md"), false);
    assert.equal(host.rejected().some((entry) => entry.uri === "skill://broken/SKILL.md"), true);
    assert.equal(listed.some((entry) => entry.displayName === "acme/billing/refunds"), true);
    assert.equal(listed.some((entry) => entry.displayName === "acme/support/refunds"), true);
    assert.equal(listed.some((entry) => entry.skill.uri === "skill://hidden-skill/SKILL.md"), false);
    assert.equal(host.references().some((entry) => entry.uri === "skill://hidden-skill/SKILL.md"), true);

    const probe = await client.request("tools/call", { name: "probe", arguments: {} });
    const probed = JSON.parse(textOf(probe)) as { initializes: number; clientExtensions: Record<string, unknown> };
    assert.equal(probed.initializes, 1);
    assert.deepEqual(probed.clientExtensions[EXTENSION_ID], {});

    const hidden = await host.load("skills", "skill://hidden-skill/SKILL.md", () => true);
    assert.match(hidden.text, /Omitted from the list/);
    assert.match(hidden.text, /server "skills"/);

    const github = await host.load("skills", "github://acme/release-notes/SKILL.md", () => true);
    assert.match(github.text, /Release notes from another scheme/);

    await assert.rejects(() => host.load("skills", "skill://missing/nope/SKILL.md", () => true), (error: unknown) => {
      assert.ok(error instanceof SkillsFailure);
      assert.equal(error.code, -32602);
      assert.match(error.message, /Unknown skill URI/);
      return true;
    });
    await assert.rejects(() => host.directory("skills", "skill://git-workflow/SKILL.md", "skill://git-workflow/SKILL.md", () => true), (error: unknown) => {
      assert.ok(error instanceof SkillsFailure);
      assert.equal(error.code, -32602);
      assert.match(error.message, /Not a directory/);
      return true;
    });
    await assert.rejects(() => host.read("skills", "skill://git-workflow/missing.txt", "skill://git-workflow/SKILL.md", () => true), (error: unknown) => {
      assert.ok(error instanceof SkillsFailure);
      assert.equal(error.code, -32602);
      assert.match(error.message, /Resource not found/);
      return true;
    });
    await assert.rejects(
      () => host.read("skills", "skill://git-workflow/explode.txt", "skill://git-workflow/SKILL.md", () => true),
      (error: unknown) => {
        assert.ok(error instanceof SkillsFailure);
        assert.equal(error.code, -32603);
        assert.match(error.message, /catalog store failed/);
        return true;
      },
    );

    await client.request("tools/call", { name: "corrupt", arguments: { enabled: true } });
    await assert.rejects(() => host.load("skills", "skill://git-workflow/SKILL.md", () => true), (error: unknown) => {
      const message = error instanceof Error ? error.message : "";
      assert.match(message, /digest or size|Load it again/);
      assert.equal(message.includes("CORRUPT_PAYLOAD_xyz"), false);
      return true;
    });
    assert.equal(host.acting().some((item) => item.uri === "skill://git-workflow/SKILL.md"), false);
    await client.request("tools/call", { name: "corrupt", arguments: { enabled: false } });

    await client.request("tools/call", { name: "touch_resources", arguments: {} });
    await waitFor(() => host.catalog().some((entry) => entry.skill.frontmatter.name === "from-resources"));
    await client.request("tools/call", { name: "touch_skills", arguments: {} });
    await waitFor(() => host.catalog().some((entry) => entry.skill.frontmatter.name === "from-skills"));
    const again = await client.request("tools/call", { name: "probe", arguments: {} });
    assert.equal((JSON.parse(textOf(again)) as { initializes: number }).initializes, 1);
  } finally {
    await connection.close();
  }
});

function textOf(result: unknown): string {
  if (typeof result === "object" && result !== null && "content" in result && Array.isArray(result.content)) {
    const first = result.content[0] as { text?: string } | undefined;
    if (first?.text) return first.text;
  }
  throw new Error(`Unexpected tool result: ${JSON.stringify(result)}`);
}

async function waitFor(ready: () => boolean): Promise<void> {
  const start = Date.now();
  while (!ready()) {
    if (Date.now() - start > 3_000) throw new Error("timed out waiting for a skill refresh");
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}
