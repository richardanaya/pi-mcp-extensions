import { createHash } from "node:crypto";
import { parse as parseYaml } from "yaml";

/** Stable Skills extension this client implements. */
export const EXTENSION_ID = "io.modelcontextprotocol/skills";

/** Protocol revision at which list and get results must carry SEP-2549 cache fields. */
export const CACHE_PROTOCOL = "2026-07-28";

export const MAX_RESOURCES = 512;
export const MAX_SKILL_BYTES = 16_777_216;

const DIGEST = /^sha256:[0-9a-f]{64}$/;
/**
 * Current Agent Skills `name` rule, plus the previous rule that allowed a doubled hyphen.
 * The extension says a client should keep accepting the specification as it stood before an
 * incompatible tightening, so a name that was legal under that looser pattern still loads.
 */
const NAME_CURRENT = /^[\p{Ll}\p{Nd}]+(?:-[\p{Ll}\p{Nd}]+)*$/u;
const NAME_PREVIOUS = /^[\p{Ll}\p{Nd}]+(?:-+[\p{Ll}\p{Nd}]+)*$/u;

export interface SkillResource {
  uri: string;
  digest: string;
  size: number;
}

export interface Skill {
  uri: string;
  frontmatter: { name: string; description: string; [key: string]: unknown };
  resources: SkillResource[] | "dynamic";
  /** Optional. Keys this extension defines use the `io.modelcontextprotocol.skills/` prefix. */
  _meta?: Record<string, unknown>;
}

/** Required request metadata from the 2026-07-28 base schema. pi's client does not add these. */
export const PROTOCOL_VERSION_META = "io.modelcontextprotocol/protocolVersion";
export const CLIENT_INFO_META = "io.modelcontextprotocol/clientInfo";
export const CLIENT_CAPABILITIES_META = "io.modelcontextprotocol/clientCapabilities";

export const SKILLS_CLIENT_INFO = { name: "pi-mcp-skills", version: "0.1.0" } as const;

export interface McpPort {
  request(method: string, params?: Record<string, unknown>): Promise<unknown>;
  onNotification(method: string, listener: (params: unknown) => void): () => void;
  capabilities(): Record<string, unknown> | undefined;
  instructions(): string | undefined;
  protocolVersion(): string | undefined;
}

export class SkillsFailure extends Error {
  readonly code: number | undefined;

  constructor(message: string, code?: number) {
    super(message);
    this.name = "SkillsFailure";
    this.code = code;
  }
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function rpcFailure(error: unknown): SkillsFailure {
  if (error instanceof SkillsFailure) return error;
  const code =
    isRecord(error) && typeof error.code === "number" && Number.isFinite(error.code) ? error.code : undefined;
  const message = error instanceof Error ? error.message : String(error);
  return new SkillsFailure(message, code);
}

export function protocolRequiresCacheFields(version: string | undefined): boolean {
  return version !== undefined && version >= CACHE_PROTOCOL;
}

export function sha256(bytes: Uint8Array): string {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

export function utf8(text: string): Uint8Array {
  return new TextEncoder().encode(text);
}

/** Skill path with no scheme and no `/SKILL.md` suffix. The first segment is an authority, not a host. */
export function skillPath(uri: string): string | undefined {
  if (!uri.endsWith("/SKILL.md")) return undefined;
  const marker = uri.indexOf("://");
  if (marker < 1) return undefined;
  const path = uri.slice(marker + 3, -"/SKILL.md".length);
  if (path.length === 0 || path.endsWith("/") || path.split("/").some((part) => part.length === 0 || part === "." || part === "..")) {
    return undefined;
  }
  return path;
}

export function skillRoot(uri: string): string | undefined {
  const path = skillPath(uri);
  if (path === undefined) return undefined;
  return uri.slice(0, -"/SKILL.md".length);
}

export function skillNameFromUri(uri: string): string | undefined {
  const path = skillPath(uri);
  if (path === undefined) return undefined;
  return path.slice(path.lastIndexOf("/") + 1);
}

export function validSkillName(name: string): boolean {
  return name.length >= 1 && name.length <= 64 && (NAME_CURRENT.test(name) || NAME_PREVIOUS.test(name));
}

/** Identity used everywhere a skill is stored or addressed. */
export function skillIdentity(server: string, uri: string): string {
  return `${server}\0${uri}`;
}

export function resourcesFingerprint(resources: SkillResource[] | "dynamic"): string {
  if (resources === "dynamic") return "dynamic";
  return resources
    .map((resource) => `${resource.uri}\n${resource.digest}\n${resource.size}`)
    .sort()
    .join("\n");
}

export function sameValue(left: unknown, right: unknown): boolean {
  return stable(left) === stable(right);
}

function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map((item) => stable(item)).join(",")}]`;
  if (isRecord(value)) {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stable(value[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value) ?? "undefined";
}

export function isWithinSkill(skillMdUri: string, fileUri: string): boolean {
  const root = skillRoot(skillMdUri);
  if (root === undefined) return false;
  if (fileUri === skillMdUri) return true;
  const prefix = `${root}/`;
  if (!fileUri.startsWith(prefix)) return false;
  const rest = fileUri.slice(prefix.length);
  if (rest.length === 0 || rest.endsWith("/")) return false;
  return rest.split("/").every((part) => part.length > 0 && part !== "." && part !== "..");
}

/** Resolve a relative reference against the skill root. Absolute URIs pass through. `..` may not escape the root. */
export function resolveReference(skillMdUri: string, reference: string): string | undefined {
  if (reference.includes("://")) return reference;
  const root = skillRoot(skillMdUri);
  if (root === undefined) return undefined;
  const parts: string[] = [];
  for (const part of reference.split("/")) {
    if (part === "" || part === ".") continue;
    if (part === "..") {
      if (parts.length === 0) return undefined;
      parts.pop();
      continue;
    }
    parts.push(part);
  }
  if (parts.length === 0) return undefined;
  return `${root}/${parts.join("/")}`;
}

export interface ParsedFrontmatter {
  value: Record<string, unknown>;
  body: string;
}

export function parseFrontmatter(text: string): ParsedFrontmatter | { error: string } {
  const match = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)([\s\S]*)$/.exec(text);
  if (!match) return { error: "SKILL.md does not begin with YAML frontmatter" };
  let parsed: unknown;
  try {
    parsed = parseYaml(match[1] ?? "", { schema: "core" });
  } catch (error) {
    return { error: error instanceof Error ? error.message : "YAML frontmatter did not parse" };
  }
  const value = toJson(parsed);
  if (!isRecord(value)) return { error: "SKILL.md frontmatter must be a YAML mapping" };
  return { value, body: match[2] ?? "" };
}

function toJson(value: unknown): unknown {
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) return value.map((item) => toJson(item));
  if (isRecord(value)) {
    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value)) out[key] = toJson(item);
    return out;
  }
  return value;
}

export function unrecognizedMetadataKeys(frontmatter: Record<string, unknown>): string[] {
  const metadata = frontmatter.metadata;
  if (!isRecord(metadata)) return [];
  return Object.keys(metadata).filter((key) => key.startsWith("io.modelcontextprotocol/"));
}

export type SkillVerdict = { ok: true } | { ok: false; reason: string };

export function validateSkill(skill: Skill): SkillVerdict {
  const nameOnUri = skillNameFromUri(skill.uri);
  if (nameOnUri === undefined) return { ok: false, reason: `${skill.uri} is not a SKILL.md URI` };
  if (skill.frontmatter.name !== nameOnUri) {
    return { ok: false, reason: `${skill.uri} does not end in frontmatter name ${skill.frontmatter.name}` };
  }
  if (!validSkillName(skill.frontmatter.name)) {
    return { ok: false, reason: `${skill.frontmatter.name} does not match the Agent Skills name rules` };
  }
  if (typeof skill.frontmatter.description !== "string" || skill.frontmatter.description.length < 1 || skill.frontmatter.description.length > 1024) {
    return { ok: false, reason: `${skill.uri} description must be 1 to 1024 characters` };
  }
  const compatibility = skill.frontmatter.compatibility;
  if (compatibility !== undefined && (typeof compatibility !== "string" || compatibility.length < 1 || compatibility.length > 500)) {
    return { ok: false, reason: `${skill.uri} compatibility must be 1 to 500 characters when present` };
  }
  if (skill.resources === "dynamic") return { ok: true };
  if (skill.resources.length > MAX_RESOURCES) {
    return { ok: false, reason: `${skill.uri} has ${skill.resources.length} resources, above the ${MAX_RESOURCES} limit` };
  }
  let total = 0;
  const seen = new Set<string>();
  let sawSelf = false;
  for (const resource of skill.resources) {
    if (seen.has(resource.uri)) return { ok: false, reason: `${skill.uri} lists ${resource.uri} more than once` };
    seen.add(resource.uri);
    if (!DIGEST.test(resource.digest)) return { ok: false, reason: `${resource.uri} digest must be sha256 and 64 lowercase hex digits` };
    if (!Number.isSafeInteger(resource.size) || resource.size < 0) {
      return { ok: false, reason: `${resource.uri} size must be a non-negative integer` };
    }
    if (!isWithinSkill(skill.uri, resource.uri)) {
      return { ok: false, reason: `${resource.uri} is outside ${skill.uri}` };
    }
    if (resource.uri === skill.uri) sawSelf = true;
    total += resource.size;
  }
  if (!sawSelf) return { ok: false, reason: `${skill.uri} resources omit SKILL.md` };
  if (total > MAX_SKILL_BYTES) {
    return { ok: false, reason: `${skill.uri} is ${total} bytes, above the ${MAX_SKILL_BYTES} byte limit` };
  }
  return { ok: true };
}

export function parseSkill(value: unknown): { skill: Skill } | { error: string } {
  if (!isRecord(value)) return { error: "skill entry must be an object" };
  if (typeof value.uri !== "string" || value.uri.length === 0) return { error: "skill entry is missing uri" };
  if (!isRecord(value.frontmatter)) return { error: `${value.uri} is missing frontmatter` };
  if (typeof value.frontmatter.name !== "string" || typeof value.frontmatter.description !== "string") {
    return { error: `${value.uri} frontmatter needs name and description strings` };
  }
  if (!Object.hasOwn(value, "resources")) return { error: `${value.uri} is missing resources` };
  const meta = skillMeta(value, value.uri);
  if ("error" in meta) return meta;
  if (value.resources === "dynamic") {
    return { skill: { uri: value.uri, frontmatter: value.frontmatter as Skill["frontmatter"], resources: "dynamic", ...meta.meta } };
  }
  if (!Array.isArray(value.resources)) return { error: `${value.uri} resources must be an array or "dynamic"` };
  const resources: SkillResource[] = [];
  for (const item of value.resources) {
    if (!isRecord(item) || typeof item.uri !== "string" || typeof item.digest !== "string" || typeof item.size !== "number") {
      return { error: `${value.uri} has a resource without uri, digest, and size` };
    }
    resources.push({ uri: item.uri, digest: item.digest, size: item.size });
  }
  return { skill: { uri: value.uri, frontmatter: value.frontmatter as Skill["frontmatter"], resources, ...meta.meta } };
}

function skillMeta(value: Record<string, unknown>, uri: string): { meta: { _meta?: Record<string, unknown> } } | { error: string } {
  if (!Object.hasOwn(value, "_meta") || value._meta === undefined) return { meta: {} };
  if (!isRecord(value._meta)) return { error: `${uri} _meta must be an object` };
  return { meta: { _meta: value._meta } };
}

/**
 * Every skills request must carry `_meta`. pi 1.4.0's `McpClient.request` only
 * adds `progressToken` there, and only when a progress listener is set. The
 * protocol version is the one the connection negotiated: pi's Streamable HTTP
 * transport mirrors that same value into `MCP-Protocol-Version`, and a mismatch
 * is `HeaderMismatch`. When the port has not negotiated a version, the field is
 * left unset rather than inventing `2026-07-28`.
 */
export function withRequestMeta(
  params: Record<string, unknown> | undefined,
  protocolVersion: string | undefined,
): Record<string, unknown> {
  const body = { ...(params ?? {}) };
  const meta = isRecord(body._meta) ? { ...body._meta } : {};
  if (protocolVersion !== undefined && meta[PROTOCOL_VERSION_META] === undefined) {
    meta[PROTOCOL_VERSION_META] = protocolVersion;
  }
  if (meta[CLIENT_INFO_META] === undefined) meta[CLIENT_INFO_META] = { ...SKILLS_CLIENT_INFO };
  const declared = isRecord(meta[CLIENT_CAPABILITIES_META]) ? meta[CLIENT_CAPABILITIES_META] : undefined;
  meta[CLIENT_CAPABILITIES_META] = clientCapabilitiesWithSkills(declared);
  body._meta = meta;
  return body;
}

export interface ListPage {
  skills: unknown[];
  nextCursor?: string;
  ttlMs?: number;
  cacheScope?: string;
}

export function parseListResult(value: unknown, protocolVersion: string | undefined): ListPage | { error: string } {
  if (!isRecord(value) || !Array.isArray(value.skills)) return { error: "skills/list result needs a skills array" };
  const cacheError = readCacheFields(value, protocolVersion, "skills/list");
  if (typeof cacheError === "string") return { error: cacheError };
  const nextCursor = value.nextCursor === null || value.nextCursor === "" ? undefined : value.nextCursor;
  if (nextCursor !== undefined && typeof nextCursor !== "string") return { error: "skills/list nextCursor must be a string" };
  return {
    skills: value.skills,
    ...(nextCursor === undefined ? {} : { nextCursor }),
    ...cacheError,
  };
}

export function parseGetResult(
  value: unknown,
  protocolVersion: string | undefined,
): { skill: unknown; ttlMs?: number; cacheScope?: string } | { error: string } {
  if (!isRecord(value) || !Object.hasOwn(value, "skill")) return { error: "skills/get result needs a skill" };
  const cacheError = readCacheFields(value, protocolVersion, "skills/get");
  if (typeof cacheError === "string") return { error: cacheError };
  return { skill: value.skill, ...cacheError };
}

function readCacheFields(
  value: Record<string, unknown>,
  protocolVersion: string | undefined,
  method: string,
): { ttlMs?: number; cacheScope?: string } | string {
  const strict = protocolRequiresCacheFields(protocolVersion);
  if (value.resultType === undefined) {
    if (strict) return `${method} resultType must be "complete" on protocol ${CACHE_PROTOCOL} and later`;
  } else if (value.resultType !== "complete") {
    return `${method} resultType must be "complete"`;
  }
  let ttlMs: number | undefined;
  if (value.ttlMs === undefined) {
    if (strict) return `${method} ttlMs is required on protocol ${CACHE_PROTOCOL} and later`;
  } else if (typeof value.ttlMs !== "number" || !Number.isFinite(value.ttlMs) || value.ttlMs < 0) {
    return `${method} ttlMs must be a non-negative number`;
  } else {
    ttlMs = value.ttlMs;
  }
  let cacheScope: string | undefined;
  if (value.cacheScope === undefined) {
    if (strict) return `${method} cacheScope is required on protocol ${CACHE_PROTOCOL} and later`;
  } else if (typeof value.cacheScope !== "string" || value.cacheScope.length === 0) {
    return `${method} cacheScope must be a non-empty string`;
  } else {
    cacheScope = value.cacheScope;
  }
  return { ...(ttlMs === undefined ? {} : { ttlMs }), ...(cacheScope === undefined ? {} : { cacheScope }) };
}

export interface DirectoryChild {
  uri: string;
  name: string;
  mimeType?: string;
}

export function parseDirectoryResult(
  value: unknown,
  protocolVersion: string | undefined,
): { resources: DirectoryChild[]; nextCursor?: string; ttlMs?: number; cacheScope?: string } | { error: string } {
  if (!isRecord(value) || !Array.isArray(value.resources)) return { error: "resources/directory/read result needs a resources array" };
  const cache = readCacheFields(value, protocolVersion, "resources/directory/read");
  if (typeof cache === "string") return { error: cache };
  const resources: DirectoryChild[] = [];
  for (const item of value.resources) {
    if (!isRecord(item) || typeof item.uri !== "string") return { error: "directory child is missing uri" };
    const name = typeof item.name === "string" && item.name.length > 0 ? item.name : item.uri.slice(item.uri.lastIndexOf("/") + 1);
    resources.push({
      uri: item.uri,
      name,
      ...(typeof item.mimeType === "string" ? { mimeType: item.mimeType } : {}),
    });
  }
  const nextCursor = value.nextCursor === null || value.nextCursor === "" ? undefined : value.nextCursor;
  if (nextCursor !== undefined && typeof nextCursor !== "string") return { error: "directory nextCursor must be a string" };
  return { resources, ...(nextCursor === undefined ? {} : { nextCursor }), ...cache };
}

export function manifestChildren(skill: Skill, directoryUri: string): DirectoryChild[] {
  if (skill.resources === "dynamic") return [];
  const prefix = directoryUri.endsWith("/") ? directoryUri : `${directoryUri}/`;
  const children = new Map<string, DirectoryChild>();
  for (const resource of skill.resources) {
    if (!resource.uri.startsWith(prefix)) continue;
    const rest = resource.uri.slice(prefix.length);
    const slash = rest.indexOf("/");
    const name = slash === -1 ? rest : rest.slice(0, slash);
    if (name.length === 0 || children.has(name)) continue;
    if (slash === -1) {
      children.set(name, {
        uri: resource.uri,
        name,
        mimeType: name.endsWith(".md") ? "text/markdown" : "application/octet-stream",
      });
    } else {
      children.set(name, { uri: `${prefix}${name}`, name, mimeType: "inode/directory" });
    }
  }
  return [...children.values()];
}

const SKILL_URI = /\b[a-z][a-z0-9+.-]*:\/\/[^\s<>)"']+\/SKILL\.md/g;

/** URIs mentioned in server instructions. They are references, not proof that a skill exists. */
export function instructionSkillUris(instructions: string | undefined): string[] {
  if (!instructions) return [];
  const found = new Set<string>();
  for (const match of instructions.matchAll(SKILL_URI)) {
    const uri = match[0];
    if (uri) found.add(uri);
  }
  return [...found];
}

export function displayNameFor(skill: Skill, siblings: readonly Skill[]): string {
  const name = skill.frontmatter.name;
  const collision = siblings.some((other) => other !== skill && other.frontmatter.name === name);
  if (!collision) return name;
  return skillPath(skill.uri) ?? name;
}

export function extensionSettings(capabilities: Record<string, unknown> | undefined): { declared: boolean; directoryRead: boolean; resources: boolean } {
  const extensions = capabilities && isRecord(capabilities.extensions) ? capabilities.extensions : undefined;
  const settings = extensions && isRecord(extensions[EXTENSION_ID]) ? extensions[EXTENSION_ID] : undefined;
  return {
    declared: settings !== undefined,
    directoryRead: settings !== undefined && settings.directoryRead === true,
    resources: capabilities?.resources !== undefined,
  };
}

/** SEP-2133 client advertisement. Does not clobber a settings object the caller already set. */
export function clientCapabilitiesWithSkills(capabilities: Record<string, unknown> | undefined): Record<string, unknown> {
  const base = { ...(capabilities ?? {}) };
  const extensions = isRecord(base.extensions) ? { ...base.extensions } : {};
  if (!isRecord(extensions[EXTENSION_ID])) extensions[EXTENSION_ID] = {};
  return { ...base, extensions };
}

export function decodeResource(contents: unknown, uri: string): { bytes: Uint8Array; text?: string; mimeType?: string } | { error: string } {
  if (!isRecord(contents) || !Array.isArray(contents.contents)) return { error: "resources/read result needs contents" };
  const items = contents.contents.filter((item) => isRecord(item));
  const match = items.find((item) => item.uri === uri) ?? items[0];
  if (!match) return { error: `resources/read returned no contents for ${uri}` };
  const mimeType = typeof match.mimeType === "string" ? match.mimeType : undefined;
  if (typeof match.text === "string") {
    return { bytes: utf8(match.text), text: match.text, ...(mimeType === undefined ? {} : { mimeType }) };
  }
  if (typeof match.blob === "string") {
    const bytes = Buffer.from(match.blob, "base64");
    return { bytes, ...(mimeType === undefined ? {} : { mimeType }) };
  }
  return { error: `resources/read for ${uri} has neither text nor blob` };
}

export const CODE_EXECUTION_TOOLS = new Set(["bash", "shell", "exec"]);

export function isCodeExecutionTool(name: string): boolean {
  return CODE_EXECUTION_TOOLS.has(name);
}

/** Servers other than `target` that currently have a loaded skill. A read of `target` is cross-origin for each of them. */
export function crossOriginActors(actingServers: readonly string[], target: string): string[] {
  return [...new Set(actingServers.filter((server) => server !== target))];
}

/** User-facing lines for names that collide inside one server. Paths stay on the entries; this says so explicitly. */
export function collisionLines(entries: readonly { server: string; name: string; uri: string }[]): string[] {
  const groups = new Map<string, string[]>();
  for (const entry of entries) {
    const key = `${entry.server}\0${entry.name}`;
    const list = groups.get(key) ?? [];
    list.push(entry.uri);
    groups.set(key, list);
  }
  const lines: string[] = [];
  for (const [key, uris] of groups) {
    if (uris.length < 2) continue;
    const split = key.indexOf("\0");
    lines.push(`Name collision on ${key.slice(0, split)}: ${key.slice(split + 1)} is ${uris.join(" and ")}`);
  }
  return lines;
}
