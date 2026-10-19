/**
 * Stdio MCP server used by the integration tests. It speaks the Skills extension
 * with the official TypeScript SDK: paginated skills/list, skills/get, resource
 * reads, directory reads, and both list-changed notifications.
 */
import { createHash } from "node:crypto";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { ErrorCode, McpError, type ServerCapabilities } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";

const EXTENSION_ID = "io.modelcontextprotocol/skills";

interface FileRecord {
  text: string;
  digest: string;
  size: number;
}

interface SkillEntry {
  uri: string;
  frontmatter: { name: string; description: string };
  resources: { uri: string; digest: string; size: number }[] | "dynamic";
}

const files = new Map<string, FileRecord>();
const skills: SkillEntry[] = [];
let corruptGitWorkflow = false;
let initializes = 0;
let clientExtensions: unknown;

function fileOf(text: string): FileRecord {
  const size = Buffer.byteLength(text);
  const digest = `sha256:${createHash("sha256").update(text).digest("hex")}`;
  return { text, digest, size };
}

function document(name: string, description: string, body: string): FileRecord {
  return fileOf(`---\nname: ${name}\ndescription: ${description}\n---\n${body}\n`);
}

function addStatic(uri: string, name: string, description: string, extra: { uri: string; text: string }[] = []): void {
  const skillFile = document(name, description, `${name} body`);
  files.set(uri, skillFile);
  const resources = [{ uri, digest: skillFile.digest, size: skillFile.size }];
  for (const item of extra) {
    const record = fileOf(item.text);
    files.set(item.uri, record);
    resources.push({ uri: item.uri, digest: record.digest, size: record.size });
  }
  skills.push({ uri, frontmatter: { name, description }, resources });
}

function addDynamic(uri: string, name: string, description: string): void {
  files.set(uri, document(name, description, `${name} body`));
  skills.push({ uri, frontmatter: { name, description }, resources: "dynamic" });
}

addStatic("skill://git-workflow/SKILL.md", "git-workflow", "How to branch and commit", [
  { uri: "skill://git-workflow/explode.txt", text: "do not return this\n" },
]);
const gitWorkflow = skills[0];
if (gitWorkflow && gitWorkflow.resources !== "dynamic") {
  gitWorkflow.resources.push({
    uri: "skill://git-workflow/missing.txt",
    digest: `sha256:${"ab".repeat(32)}`,
    size: 4,
  });
}
addStatic("skill://acme/billing/refunds/SKILL.md", "refunds", "Billing refunds");
addStatic("skill://acme/support/refunds/SKILL.md", "refunds", "Support refunds");
addStatic("skill://pdf-processing/SKILL.md", "pdf-processing", "Fill PDF forms", [
  { uri: "skill://pdf-processing/templates/sample.txt", text: "sample template\n" },
]);
addDynamic("skill://live-notes/SKILL.md", "live-notes", "Notes with no digest");
addStatic("github://acme/release-notes/SKILL.md", "release-notes", "Release notes from another scheme");
const hidden = "skill://hidden-skill/SKILL.md";
files.set(hidden, document("hidden-skill", "Omitted from the list", "hidden body"));

const invalid = { uri: "skill://broken/SKILL.md", frontmatter: { name: "broken", description: "Missing resources" } };

function listedPage(cursor: string | undefined): { skills: unknown[]; nextCursor?: string } {
  const page = [ ...skills, invalid ];
  const index = cursor === undefined ? 0 : Number(cursor);
  if (!Number.isInteger(index) || index < 0 || index >= page.length) {
    throw new McpError(ErrorCode.InvalidParams, `Bad skills/list cursor: ${String(cursor)}`);
  }
  const next = index + 1 < page.length ? String(index + 1) : undefined;
  const entry = page[index];
  return { skills: entry ? [entry] : [], ...(next === undefined ? {} : { nextCursor: next }) };
}

function skillByUri(uri: string): SkillEntry {
  const found = skills.find((skill) => skill.uri === uri);
  if (found) return found;
  if (uri === hidden) {
    const record = files.get(hidden);
    if (!record) throw new McpError(ErrorCode.InternalError, "hidden skill file is missing");
    return {
      uri,
      frontmatter: { name: "hidden-skill", description: "Omitted from the list" },
      resources: [{ uri, digest: record.digest, size: record.size }],
    };
  }
  throw new McpError(ErrorCode.InvalidParams, `Unknown skill URI: ${uri}`);
}

function directoryChildren(uri: string): { uri: string; name: string; mimeType: string }[] {
  const prefix = `${uri.replace(/\/$/, "")}/`;
  const children = new Map<string, { uri: string; name: string; mimeType: string }>();
  for (const fileUri of files.keys()) {
    if (!fileUri.startsWith(prefix)) continue;
    const rest = fileUri.slice(prefix.length);
    const slash = rest.indexOf("/");
    const name = slash === -1 ? rest : rest.slice(0, slash);
    if (children.has(name)) continue;
    if (slash === -1) children.set(name, { uri: fileUri, name, mimeType: "text/plain" });
    else children.set(name, { uri: `${prefix}${name}`, name, mimeType: "inode/directory" });
  }
  return [...children.values()];
}

const cache = { resultType: "complete" as const, ttlMs: 60_000, cacheScope: "session" };

function schema(method: string) {
  return z.object({
    method: z.literal(method),
    params: z
      .object({
        uri: z.string().optional(),
        cursor: z.string().optional(),
        name: z.string().optional(),
        arguments: z.record(z.string(), z.unknown()).optional(),
      })
      .optional(),
  });
}

const server = new Server(
  { name: "skills-fixture", version: "1.0.0" },
  {
    capabilities: {
      resources: { listChanged: true },
      tools: {},
      extensions: { [EXTENSION_ID]: { directoryRead: true } },
    } as ServerCapabilities,
    instructions: `An unlisted skill is available at ${hidden}.`,
  },
);

server.oninitialized = () => {
  initializes += 1;
  clientExtensions = server.getClientCapabilities()?.extensions;
};

server.setRequestHandler(schema("skills/list"), (request) => {
  const page = listedPage(request.params?.cursor);
  return { ...page, ...cache };
});

server.setRequestHandler(schema("skills/get"), (request) => {
  const uri = request.params?.uri;
  if (!uri) throw new McpError(ErrorCode.InvalidParams, "skills/get requires uri");
  return { skill: skillByUri(uri), ...cache };
});

server.setRequestHandler(schema("resources/read"), (request) => {
  const uri = request.params?.uri;
  if (!uri) throw new McpError(ErrorCode.InvalidParams, "resources/read requires uri");
  if (uri.endsWith("/explode.txt")) throw new McpError(ErrorCode.InternalError, "catalog store failed");
  const record = files.get(uri);
  if (!record) throw new McpError(ErrorCode.InvalidParams, `Resource not found: ${uri}`);
  const text = corruptGitWorkflow && uri === "skill://git-workflow/SKILL.md" ? `${record.text}\nCORRUPT_PAYLOAD_xyz\n` : record.text;
  return { contents: [{ uri, mimeType: "text/markdown", text }] };
});

server.setRequestHandler(schema("resources/directory/read"), (request) => {
  const uri = request.params?.uri;
  if (!uri) throw new McpError(ErrorCode.InvalidParams, "resources/directory/read requires uri");
  if (/\.[A-Za-z0-9]+$/.test(uri)) throw new McpError(ErrorCode.InvalidParams, `Not a directory: ${uri}`);
  const children = directoryChildren(uri);
  const index = request.params?.cursor === undefined ? 0 : Number(request.params.cursor);
  if (!Number.isInteger(index) || index < 0 || (children.length > 0 && index >= children.length)) {
    throw new McpError(ErrorCode.InvalidParams, `Bad directory cursor: ${String(request.params?.cursor)}`);
  }
  const child = children[index];
  const next = index + 1 < children.length ? String(index + 1) : undefined;
  return {
    resources: child ? [child] : [],
    ...(next === undefined ? {} : { nextCursor: next }),
    ...cache,
  };
});

server.setRequestHandler(schema("resources/list"), () => ({ resources: [] }));
server.setRequestHandler(schema("resources/templates/list"), () => ({ resourceTemplates: [] }));
server.setRequestHandler(schema("tools/list"), () => ({
  tools: [
    { name: "probe", description: "Report initialize count and client extensions", inputSchema: { type: "object", properties: {} } },
    { name: "corrupt", description: "Toggle a digest mismatch on git-workflow", inputSchema: { type: "object", properties: { enabled: { type: "boolean" } } } },
    { name: "touch_resources", description: "Add a skill and send resources/list_changed", inputSchema: { type: "object", properties: {} } },
    { name: "touch_skills", description: "Add a skill and send skills/list_changed", inputSchema: { type: "object", properties: {} } },
  ],
}));

server.setRequestHandler(schema("tools/call"), async (request) => {
  const name = request.params?.name;
  const args = request.params?.arguments ?? {};
  if (name === "probe") {
    return { content: [{ type: "text" as const, text: JSON.stringify({ initializes, clientExtensions }) }] };
  }
  if (name === "corrupt") {
    corruptGitWorkflow = args.enabled === true;
    return { content: [{ type: "text" as const, text: corruptGitWorkflow ? "on" : "off" }] };
  }
  if (name === "touch_resources") {
    addStatic("skill://from-resources/SKILL.md", "from-resources", "Added after resources/list_changed");
    await server.sendResourceListChanged();
    return { content: [{ type: "text" as const, text: "resources" }] };
  }
  if (name === "touch_skills") {
    addStatic("skill://from-skills/SKILL.md", "from-skills", "Added after skills/list_changed");
    await server.notification({ method: "notifications/skills/list_changed", params: {} });
    return { content: [{ type: "text" as const, text: "skills" }] };
  }
  throw new McpError(ErrorCode.InvalidParams, `Unknown tool: ${String(name)}`);
});

const transport = new StdioServerTransport();
await server.connect(transport);
