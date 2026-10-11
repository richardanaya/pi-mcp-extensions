import type { McpPort } from "../src/model.ts";
import { sha256, utf8 } from "../src/model.ts";

export interface SkillFile {
  text: string;
  bytes: Uint8Array;
  digest: string;
  size: number;
}

export function skillDocument(name: string, description: string, body = "Do the thing.", extra = ""): SkillFile {
  const extraBlock = extra.length > 0 ? `${extra.endsWith("\n") ? extra : `${extra}\n`}` : "";
  const text = `---\nname: ${name}\ndescription: ${description}\n${extraBlock}---\n${body}\n`;
  const bytes = utf8(text);
  return { text, bytes, digest: sha256(bytes), size: bytes.byteLength };
}

export function listedSkill(
  uri: string,
  name: string,
  description: string,
  file: SkillFile,
  resources?: { uri: string; digest: string; size: number }[] | "dynamic",
  frontmatter: Record<string, unknown> = {},
) {
  return {
    uri,
    frontmatter: { name, description, ...frontmatter },
    resources: resources ?? [{ uri, digest: file.digest, size: file.size }],
  };
}

export function skillsCapabilities(directoryRead = false): Record<string, unknown> {
  return {
    resources: { listChanged: true },
    extensions: {
      "io.modelcontextprotocol/skills": directoryRead ? { directoryRead: true } : {},
    },
  };
}

export function cacheFields(ttlMs = 60_000): Record<string, unknown> {
  return { resultType: "complete", ttlMs, cacheScope: "session" };
}

export class FakePort implements McpPort {
  readonly calls: { method: string; params?: Record<string, unknown> }[] = [];
  private readonly listeners = new Map<string, Set<(params: unknown) => void>>();
  caps: Record<string, unknown> | undefined;
  handler: (method: string, params: Record<string, unknown> | undefined) => unknown;
  instr?: string;
  protocol?: string;

  constructor(
    caps: Record<string, unknown> | undefined,
    handler: (method: string, params: Record<string, unknown> | undefined) => unknown,
    instr?: string,
    protocol?: string,
  ) {
    this.caps = caps;
    this.handler = handler;
    this.instr = instr;
    this.protocol = protocol;
  }

  request(method: string, params?: Record<string, unknown>): Promise<unknown> {
    this.calls.push(params === undefined ? { method } : { method, params });
    return Promise.resolve(this.handler(method, params));
  }

  onNotification(method: string, listener: (params: unknown) => void): () => void {
    const set = this.listeners.get(method) ?? new Set();
    set.add(listener);
    this.listeners.set(method, set);
    return () => set.delete(listener);
  }

  emit(method: string): void {
    for (const listener of this.listeners.get(method) ?? []) listener(undefined);
  }

  capabilities(): Record<string, unknown> | undefined {
    return this.caps;
  }

  instructions(): string | undefined {
    return this.instr;
  }

  protocolVersion(): string | undefined {
    return this.protocol;
  }

  methods(): string[] {
    return this.calls.map((call) => call.method);
  }
}

export function readResult(uri: string, text: string) {
  return { contents: [{ uri, mimeType: "text/markdown", text }] };
}

export async function settle(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 20));
}
