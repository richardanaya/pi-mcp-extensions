import {
  EXTENSION_ID,
  type DirectoryChild,
  type McpPort,
  MAX_SKILL_BYTES,
  type Skill,
  SkillsFailure,
  crossOriginActors,
  decodeResource,
  displayNameFor,
  extensionSettings,
  instructionSkillUris,
  manifestChildren,
  parseDirectoryResult,
  parseFrontmatter,
  parseGetResult,
  parseListResult,
  parseSkill,
  resolveReference,
  resourcesFingerprint,
  rpcFailure,
  sameValue,
  sha256,
  skillIdentity,
  skillRoot,
  unrecognizedMetadataKeys,
  validateSkill,
  withRequestMeta,
} from "./model.ts";

export interface CatalogEntry {
  server: string;
  skill: Skill;
  displayName: string;
  directoryRead: boolean;
  ttlMs?: number;
  cacheScope?: string;
  fetchedAt: number;
  /** True when the listing did not include this skill and skills/get did. */
  fromGet: boolean;
}

export interface RejectedEntry {
  server: string;
  uri?: string;
  reason: string;
}

export interface ReferenceEntry {
  server: string;
  uri: string;
}

export interface ApprovalPrompt {
  kind: "load" | "cross-origin";
  title: string;
  message: string;
  server: string;
  otherServer?: string;
  uri?: string;
  dynamic: boolean;
  changed: boolean;
}

export type Approver = (prompt: ApprovalPrompt) => Promise<boolean> | boolean;

export interface PresentedSkill {
  server: string;
  uri: string;
  activated: boolean;
  text: string;
  mediaType: "skill" | "resource" | "directory";
}

interface DirectoryCache {
  children: DirectoryChild[];
  ttlMs: number;
  cacheScope?: string;
  fetchedAt: number;
}

interface ServerState {
  port: McpPort;
  protocolVersion: string | undefined;
  directoryRead: boolean;
  instructions: string | undefined;
  skills: Skill[];
  rejected: RejectedEntry[];
  ttlMs?: number;
  cacheScope?: string;
  fetchedAt?: number;
  listError?: string;
  unsubs: (() => void)[];
  dynamicBytes: Map<string, number>;
  /** Directory listings reused only while their own ttlMs has not elapsed. */
  directories: Map<string, DirectoryCache>;
}

interface HeldSkill {
  skill: Skill;
  fingerprint: string;
}

const MAX_PAGES = 1_000;

/**
 * Lookup and load state for every skills-capable server pi is connected to.
 * File bytes stay in memory. Nothing here opens its own MCP connection.
 */
export class SkillsHost {
  private readonly servers = new Map<string, ServerState>();
  private readonly approvals = new Map<string, string>();
  private readonly held = new Map<string, HeldSkill>();
  private readonly bytes = new Map<string, Uint8Array>();
  private readonly refreshTail = new Map<string, Promise<void>>();
  private readonly dirty = new Set<string>();
  /** Extension-registered server names last reported by pi. mcp.json servers are absent from this set. */
  private extensionServers = new Set<string>();
  readonly gap: string | undefined;

  private readonly options: { now?: () => number; gap?: string };

  constructor(options: { now?: () => number; gap?: string } = {}) {
    this.options = options;
    this.gap = options.gap;
  }

  private now(): number {
    return this.options.now?.() ?? Date.now();
  }

  /** Servers pi reported through getMcpServers or mcp_servers_change. Missing names are extension unregisters. */
  noteRegistered(names: readonly string[]): void {
    const next = new Set(names);
    for (const name of this.extensionServers) {
      if (!next.has(name)) this.detach(name);
    }
    this.extensionServers = next;
  }

  async attach(server: string, port: McpPort): Promise<void> {
    const settings = extensionSettings(port.capabilities());
    if (!settings.declared) {
      this.detach(server);
      return;
    }
    this.detach(server);
    const state: ServerState = {
      port,
      protocolVersion: port.protocolVersion(),
      directoryRead: settings.directoryRead,
      instructions: port.instructions(),
      skills: [],
      rejected: [],
      unsubs: [],
      dynamicBytes: new Map(),
      directories: new Map(),
    };
    if (!settings.resources) {
      state.listError = `${server} declares ${EXTENSION_ID} but not the resources capability`;
      state.rejected.push({ server, reason: state.listError });
      this.servers.set(server, state);
      return;
    }
    state.unsubs.push(
      port.onNotification("notifications/resources/list_changed", () => {
        this.dirty.add(server);
        void this.enqueueRefresh(server);
      }),
      port.onNotification("notifications/skills/list_changed", () => {
        this.dirty.add(server);
        void this.enqueueRefresh(server);
      }),
    );
    this.servers.set(server, state);
    await this.enqueueRefresh(server);
  }

  detach(server: string): void {
    const state = this.servers.get(server);
    if (!state) return;
    for (const unsubscribe of state.unsubs) unsubscribe();
    this.servers.delete(server);
    this.dirty.delete(server);
    for (const key of [...this.approvals.keys(), ...this.held.keys()]) {
      if (key.startsWith(`${server}\0`)) {
        this.approvals.delete(key);
        this.held.delete(key);
      }
    }
    for (const key of this.bytes.keys()) {
      if (key.startsWith(`${server}\0`)) this.bytes.delete(key);
    }
  }

  clear(): void {
    for (const server of [...this.servers.keys()]) this.detach(server);
    this.extensionServers.clear();
  }

  async refresh(server?: string): Promise<void> {
    const names = server === undefined ? [...this.servers.keys()] : [server];
    await Promise.all(names.map((name) => this.enqueueRefresh(name)));
  }

  serverNames(): string[] {
    return [...this.servers.keys()];
  }

  catalog(): CatalogEntry[] {
    const entries: CatalogEntry[] = [];
    for (const [server, state] of this.servers) {
      for (const skill of state.skills) {
        entries.push(this.toEntry(server, state, skill, false));
      }
    }
    return entries;
  }

  rejected(): RejectedEntry[] {
    return [...this.servers.values()].flatMap((state) => state.rejected);
  }

  references(server?: string): ReferenceEntry[] {
    const out: ReferenceEntry[] = [];
    for (const [name, state] of this.servers) {
      if (server !== undefined && name !== server) continue;
      const known = new Set(state.skills.map((skill) => skill.uri));
      for (const uri of instructionSkillUris(state.instructions)) {
        if (!known.has(uri)) out.push({ server: name, uri });
      }
    }
    return out;
  }

  errors(): { server: string; message: string }[] {
    const out: { server: string; message: string }[] = [];
    for (const [server, state] of this.servers) {
      if (state.listError) out.push({ server, message: state.listError });
    }
    return out;
  }

  search(query?: string, server?: string): CatalogEntry[] {
    const needle = query?.trim().toLowerCase();
    return this.catalog().filter((entry) => {
      if (server !== undefined && entry.server !== server) return false;
      if (!needle) return true;
      const haystack = `${entry.displayName}\n${entry.skill.frontmatter.description}\n${entry.skill.uri}\n${entry.server}`.toLowerCase();
      return haystack.includes(needle);
    });
  }

  acting(): { server: string; uri: string }[] {
    return [...this.held.keys()].map((key) => {
      const split = key.indexOf("\0");
      return { server: key.slice(0, split), uri: key.slice(split + 1) };
    });
  }

  unload(server: string, uri: string): void {
    this.held.delete(skillIdentity(server, uri));
  }

  /**
   * User inspection. Fetches and verifies SKILL.md, and does not open an acting window.
   */
  async show(server: string, uriOrName: string): Promise<PresentedSkill> {
    const skill = await this.resolve(server, uriOrName);
    const file = await this.fetchVerified(server, skill, skill.uri, false);
    return present(server, skill.uri, false, renderSkill(server, skill, file.text, false), "skill");
  }

  /**
   * Host skill-loading path. Approval is taken against the entry before any file is fetched.
   */
  async load(server: string, uriOrName: string, approve: Approver): Promise<PresentedSkill> {
    await this.assertSameOrigin(server, approve);
    const skill = await this.resolve(server, uriOrName);
    const fingerprint = resourcesFingerprint(skill.resources);
    const id = skillIdentity(server, skill.uri);
    const previous = this.approvals.get(id);
    const dynamic = skill.resources === "dynamic";
    const changed = previous !== undefined && previous !== fingerprint;
    if (dynamic || previous !== fingerprint) {
      const allowed = await approve({
        kind: "load",
        title: changed ? `Skill changed on ${server}` : `Load skill from ${server}`,
        message: approvalMessage(server, skill, changed),
        server,
        uri: skill.uri,
        dynamic,
        changed,
      });
      if (!allowed) throw new SkillsFailure(`Loading ${skill.uri} from ${server} was not approved`);
    }
    const file = await this.fetchVerified(server, skill, skill.uri, true);
    if (!dynamic) this.approvals.set(id, fingerprint);
    else this.approvals.delete(id);
    this.held.set(id, { skill, fingerprint });
    return present(server, skill.uri, true, renderSkill(server, skill, file.text, true), "skill");
  }

  /**
   * Read one file of a skill. Relative URIs resolve against `skill`. This does not load a skill.
   */
  async read(server: string, uri: string, skillRef: string | undefined, approve: Approver): Promise<PresentedSkill> {
    await this.assertSameOrigin(server, approve);
    const target = this.absoluteUri(server, uri, skillRef);
    const skill = await this.skillForFile(server, target, skillRef);
    const held = this.held.get(skillIdentity(server, skill.uri));
    const entry = held?.skill ?? skill;
    if (held && entry.resources !== "dynamic") {
      const listed = entry.resources.some((resource) => resource.uri === target);
      if (!listed) {
        await this.recoverChanged(server, skill.uri, held);
        throw new SkillsFailure(
          `${target} is not in the approved files for ${skill.uri} on ${server}. The skill may have changed and needs to be loaded again.`,
        );
      }
    }
    const file = await this.fetchVerified(server, entry, target, false);
    const nested = target.endsWith("/SKILL.md") && target !== skill.uri;
    const ownSkill = target === skill.uri;
    const banner = nested
      ? "This nested SKILL.md is supporting content. Its frontmatter was not activated.\n\n"
      : ownSkill
        ? "This is a resource read, not a loaded skill.\n\n"
        : "";
    return present(server, target, false, `${originBanner(server, target, false)}${banner}${file.text ?? ""}`, "resource");
  }

  async directory(server: string, uri: string, skillRef: string | undefined, approve: Approver): Promise<PresentedSkill> {
    await this.assertSameOrigin(server, approve);
    const state = this.requireServer(server);
    const directoryUri = uri.replace(/\/$/, "");
    const skill = this.skillCovering(server, directoryUri, skillRef);
    const held = skill ? this.held.get(skillIdentity(server, skill.uri)) : undefined;
    const entry = held?.skill ?? skill;
    if (!state.directoryRead) {
      if (!entry || entry.resources === "dynamic") {
        throw new SkillsFailure(`${server} has not declared directoryRead, and ${directoryUri} is not covered by a skill manifest`);
      }
      const children = manifestChildren(entry, directoryUri);
      return present(server, directoryUri, false, renderDirectory(server, directoryUri, children, []), "directory");
    }
    const live = await this.readDirectory(state, directoryUri);
    if (!entry || entry.resources === "dynamic") {
      return present(server, directoryUri, false, renderDirectory(server, directoryUri, live, []), "directory");
    }
    const allowed = new Set(manifestChildren(entry, directoryUri).map((child) => child.uri));
    const shown = live.filter((child) => allowed.has(child.uri));
    const hidden = live.filter((child) => !allowed.has(child.uri)).map((child) => child.uri);
    if (hidden.length > 0) {
      await this.recoverChanged(server, entry.uri, held);
    }
    return present(server, directoryUri, false, renderDirectory(server, directoryUri, shown, hidden), "directory");
  }

  private async recoverChanged(server: string, uri: string, held: HeldSkill | undefined): Promise<void> {
    if (!held) return;
    try {
      const fresh = await this.getSkill(server, uri);
      if (resourcesFingerprint(fresh.resources) !== held.fingerprint) {
        const id = skillIdentity(server, uri);
        this.approvals.delete(id);
        this.held.delete(id);
      }
    } catch {
      // The directory or read error still reports the stale manifest. A failed refresh does not invent a new approval.
    }
  }

  private async readDirectory(state: ServerState, uri: string): Promise<DirectoryChild[]> {
    const cached = state.directories.get(uri);
    if (cached && this.now() - cached.fetchedAt < cached.ttlMs) return cached.children;
    const children: DirectoryChild[] = [];
    let cursor: string | undefined;
    let ttlMs: number | undefined;
    let cacheScope: string | undefined;
    const seen = new Set<string>();
    for (let page = 0; page < MAX_PAGES; page++) {
      let result: unknown;
      try {
        result = await this.rpc(state, "resources/directory/read", cursor ? { uri, cursor } : { uri });
      } catch (error) {
        throw rpcFailure(error);
      }
      const parsed = parseDirectoryResult(result, state.port.protocolVersion());
      if ("error" in parsed) throw new SkillsFailure(parsed.error);
      if (page === 0) {
        ttlMs = parsed.ttlMs;
        cacheScope = parsed.cacheScope;
      }
      children.push(...parsed.resources);
      if (!parsed.nextCursor) {
        if (ttlMs !== undefined) {
          state.directories.set(uri, {
            children,
            ttlMs,
            fetchedAt: this.now(),
            ...(cacheScope === undefined ? {} : { cacheScope }),
          });
        } else {
          state.directories.delete(uri);
        }
        return children;
      }
      if (seen.has(parsed.nextCursor)) throw new SkillsFailure("resources/directory/read repeated nextCursor");
      seen.add(parsed.nextCursor);
      cursor = parsed.nextCursor;
    }
    throw new SkillsFailure("resources/directory/read exceeded the page limit");
  }

  /** pi does not attach protocol `_meta`. Use the version the connection negotiated. */
  private rpc(state: ServerState, method: string, params?: Record<string, unknown>): Promise<unknown> {
    return state.port.request(method, withRequestMeta(params, state.port.protocolVersion()));
  }

  private absoluteUri(server: string, uri: string, skillRef: string | undefined): string {
    if (uri.includes("://")) return uri;
    const skill = skillRef ? this.catalog().find((entry) => entry.server === server && (entry.skill.uri === skillRef || entry.displayName === skillRef)) : undefined;
    const rootSkill = skill?.skill.uri ?? this.onlyHeld(server);
    if (!rootSkill) throw new SkillsFailure(`Relative URI ${uri} needs a skill on ${server}`);
    const resolved = resolveReference(rootSkill, uri);
    if (!resolved) throw new SkillsFailure(`${uri} escapes the skill root of ${rootSkill}`);
    return resolved;
  }

  private onlyHeld(server: string): string | undefined {
    const matches = this.acting().filter((item) => item.server === server);
    return matches.length === 1 ? matches[0]?.uri : undefined;
  }

  private skillCovering(server: string, directoryUri: string, skillRef: string | undefined): Skill | undefined {
    const state = this.servers.get(server);
    if (!state) return undefined;
    if (skillRef) {
      const named = state.skills.find((skill) => skill.uri === skillRef);
      if (named && directoryUri.startsWith(skillRoot(named.uri) ?? "\0")) return named;
    }
    let best: Skill | undefined;
    let bestLength = -1;
    for (const skill of state.skills) {
      const root = skillRoot(skill.uri);
      if (root && (directoryUri === root || directoryUri.startsWith(`${root}/`)) && root.length > bestLength) {
        best = skill;
        bestLength = root.length;
      }
    }
    return best;
  }

  private async skillForFile(server: string, fileUri: string, skillRef: string | undefined): Promise<Skill> {
    if (skillRef) return this.resolve(server, skillRef);
    const covering = this.skillCovering(server, fileUri, undefined);
    if (covering && (covering.resources === "dynamic" || covering.resources.some((resource) => resource.uri === fileUri) || fileUri === covering.uri)) {
      return covering;
    }
    if (fileUri.endsWith("/SKILL.md")) return this.resolve(server, fileUri);
    throw new SkillsFailure(`${fileUri} is not a file of a known skill on ${server}`);
  }

  private async resolve(server: string, uriOrName: string): Promise<Skill> {
    const state = this.requireListed(server);
    if (uriOrName.includes("://")) {
      const known = state.skills.find((skill) => skill.uri === uriOrName);
      if (known && this.listingFresh(state)) return known;
      return this.getSkill(server, uriOrName);
    }
    const matches = state.skills.filter((skill) => skill.frontmatter.name === uriOrName || displayNameFor(skill, state.skills) === uriOrName);
    if (matches.length === 1 && matches[0]) return matches[0];
    if (matches.length > 1) {
      const choices = matches.map((skill) => skill.uri).join(", ");
      throw new SkillsFailure(`More than one skill on ${server} is named ${uriOrName}: ${choices}`);
    }
    throw new SkillsFailure(`No listed skill named ${uriOrName} on ${server}. Pass the SKILL.md URI to load a skill the listing omitted.`);
  }

  private async getSkill(server: string, uri: string): Promise<Skill> {
    const state = this.requireServer(server);
    if (!extensionSettings(state.port.capabilities()).declared) {
      throw new SkillsFailure(`${server} has not declared the skills extension`);
    }
    let result: unknown;
    try {
      result = await this.rpc(state, "skills/get", { uri });
    } catch (error) {
      throw rpcFailure(error);
    }
    const parsed = parseGetResult(result, state.port.protocolVersion());
    if ("error" in parsed) throw new SkillsFailure(parsed.error);
    const skill = parseSkill(parsed.skill);
    if ("error" in skill) throw new SkillsFailure(skill.error);
    const verdict = validateSkill(skill.skill);
    if (!verdict.ok) throw new SkillsFailure(verdict.reason);
    const index = state.skills.findIndex((item) => item.uri === skill.skill.uri);
    if (index === -1) state.skills.push(skill.skill);
    else state.skills[index] = skill.skill;
    return skill.skill;
  }

  private async fetchVerified(server: string, skill: Skill, uri: string, activating: boolean): Promise<{ text?: string; bytes: Uint8Array }> {
    const state = this.requireServer(server);
    let current = skill;
    let listed = current.resources === "dynamic" ? undefined : current.resources.find((resource) => resource.uri === uri);
    if (current.resources !== "dynamic" && !listed) {
      throw new SkillsFailure(`${uri} is not listed in ${current.uri}`);
    }
    const cached = this.takeCached(server, uri, listed);
    if (cached) return cached;
    let result: unknown;
    try {
      result = await this.rpc(state, "resources/read", { uri });
    } catch (error) {
      throw rpcFailure(error);
    }
    const decoded = decodeResource(result, uri);
    if ("error" in decoded) throw new SkillsFailure(decoded.error);
    if (listed && !bytesMatch(decoded.bytes, listed)) {
      const fresh = await this.getSkill(server, current.uri);
      const moved = resourcesFingerprint(fresh.resources) !== resourcesFingerprint(current.resources);
      if (moved) {
        this.approvals.delete(skillIdentity(server, current.uri));
        this.held.delete(skillIdentity(server, current.uri));
        throw new SkillsFailure(`${uri} on ${server} no longer matches the approved skill. Load it again to approve the new files.`);
      }
      current = fresh;
      listed = fresh.resources === "dynamic" ? undefined : fresh.resources.find((resource) => resource.uri === uri);
      if (!listed || !bytesMatch(decoded.bytes, listed)) {
        throw new SkillsFailure(`${uri} on ${server} does not match the digest or size in the skill entry`);
      }
    }
    if (current.resources === "dynamic") {
      const used = state.dynamicBytes.get(current.uri) ?? 0;
      const next = used + decoded.bytes.byteLength;
      if (next > MAX_SKILL_BYTES) {
        throw new SkillsFailure(`${current.uri} on ${server} reached the ${MAX_SKILL_BYTES} byte limit for a dynamic skill`);
      }
      state.dynamicBytes.set(current.uri, next);
    }
    if (uri === current.uri || (activating && uri.endsWith("/SKILL.md"))) {
      const frontmatter = parseFrontmatter(decoded.text ?? "");
      if ("error" in frontmatter) throw new SkillsFailure(frontmatter.error);
      if (!sameValue(frontmatter.value, current.frontmatter)) {
        throw new SkillsFailure(`Frontmatter of ${uri} does not match the skill entry from ${server}`);
      }
    }
    if (listed) this.bytes.set(`${server}\0${uri}\0${listed.digest}`, decoded.bytes);
    return { bytes: decoded.bytes, ...(decoded.text === undefined ? {} : { text: decoded.text }) };
  }

  private takeCached(server: string, uri: string, listed: { digest: string; size: number } | undefined): { bytes: Uint8Array; text: string } | undefined {
    if (!listed) return undefined;
    const key = `${server}\0${uri}\0${listed.digest}`;
    const cached = this.bytes.get(key);
    if (!cached) return undefined;
    if (sha256(cached) !== listed.digest || cached.byteLength !== listed.size) {
      this.bytes.delete(key);
      return undefined;
    }
    return { bytes: cached, text: new TextDecoder("utf-8", { fatal: false }).decode(cached) };
  }

  private async assertSameOrigin(server: string, approve: Approver): Promise<void> {
    const others = crossOriginActors(this.acting().map((item) => item.server), server);
    for (const other of others) {
      const allowed = await approve({
        kind: "cross-origin",
        title: `Read ${server} while a skill from ${other} is loaded`,
        message: `A skill from ${other} is loaded. This read uses ${server}. Approve this cross-origin read?`,
        server,
        otherServer: other,
        dynamic: false,
        changed: false,
      });
      if (!allowed) throw new SkillsFailure(`Cross-origin read from ${other} to ${server} was not approved`);
    }
  }

  private requireServer(server: string): ServerState {
    const state = this.servers.get(server);
    if (!state) throw new SkillsFailure(`${server} is not a connected skills server`);
    return state;
  }

  private requireListed(server: string): ServerState {
    const state = this.requireServer(server);
    if (state.listError && state.skills.length === 0 && !extensionSettings(state.port.capabilities()).resources) {
      throw new SkillsFailure(state.listError);
    }
    return state;
  }

  private listingFresh(state: ServerState): boolean {
    if (state.fetchedAt === undefined) return false;
    if (state.ttlMs === undefined) return true;
    return this.now() - state.fetchedAt < state.ttlMs;
  }

  private toEntry(server: string, state: ServerState, skill: Skill, fromGet: boolean): CatalogEntry {
    return {
      server,
      skill,
      displayName: displayNameFor(skill, state.skills),
      directoryRead: state.directoryRead,
      ...(state.ttlMs === undefined ? {} : { ttlMs: state.ttlMs }),
      ...(state.cacheScope === undefined ? {} : { cacheScope: state.cacheScope }),
      fetchedAt: state.fetchedAt ?? this.now(),
      fromGet,
    };
  }

  private enqueueRefresh(server: string): Promise<void> {
    const previous = this.refreshTail.get(server) ?? Promise.resolve();
    const next = previous.then(() => this.pullUntilClean(server));
    this.refreshTail.set(server, next);
    return next;
  }

  private async pullUntilClean(server: string): Promise<void> {
    do {
      this.dirty.delete(server);
      await this.pullList(server);
    } while (this.dirty.has(server));
  }

  private async pullList(server: string): Promise<void> {
    const state = this.servers.get(server);
    if (!state || !extensionSettings(state.port.capabilities()).declared) return;
    if (!extensionSettings(state.port.capabilities()).resources) return;
    const skills: Skill[] = [];
    const rejected: RejectedEntry[] = [];
    let cursor: string | undefined;
    let ttlMs: number | undefined;
    let cacheScope: string | undefined;
    const seen = new Set<string>();
    state.directories.clear();
    try {
      for (let page = 0; page < MAX_PAGES; page++) {
        const result = await this.rpc(state, "skills/list", cursor ? { cursor } : {});
        const parsed = parseListResult(result, state.port.protocolVersion());
        if ("error" in parsed) throw new SkillsFailure(parsed.error);
        if (page === 0) {
          ttlMs = parsed.ttlMs;
          cacheScope = parsed.cacheScope;
        }
        for (const item of parsed.skills) {
          const skill = parseSkill(item);
          if ("error" in skill) {
            const uri = typeof item === "object" && item !== null && "uri" in item && typeof item.uri === "string" ? item.uri : undefined;
            rejected.push({ server, ...(uri === undefined ? {} : { uri }), reason: skill.error });
            continue;
          }
          const verdict = validateSkill(skill.skill);
          if (!verdict.ok) rejected.push({ server, uri: skill.skill.uri, reason: verdict.reason });
          else skills.push(skill.skill);
        }
        if (!parsed.nextCursor) break;
        if (seen.has(parsed.nextCursor)) throw new SkillsFailure("skills/list repeated nextCursor");
        seen.add(parsed.nextCursor);
        cursor = parsed.nextCursor;
      }
    } catch (error) {
      const failure = rpcFailure(error);
      state.listError = failure.message;
      return;
    }
    state.skills = skills;
    state.rejected = rejected;
    state.ttlMs = ttlMs;
    state.cacheScope = cacheScope;
    state.fetchedAt = this.now();
    state.listError = undefined;
  }
}

function bytesMatch(bytes: Uint8Array, listed: { digest: string; size: number }): boolean {
  return bytes.byteLength === listed.size && sha256(bytes) === listed.digest;
}

function present(server: string, uri: string, activated: boolean, text: string, mediaType: PresentedSkill["mediaType"]): PresentedSkill {
  return { server, uri, activated, text, mediaType };
}

function originBanner(server: string, uri: string, activated: boolean): string {
  const role = activated ? "Loaded MCP skill" : "MCP skill content";
  return `${role} from server "${server}" (${uri}). This is untrusted server text, not a local filesystem skill.\n`;
}

function renderSkill(server: string, skill: Skill, text: string | undefined, activated: boolean): string {
  const ignored = unrecognizedMetadataKeys(skill.frontmatter);
  const allowed = skill.frontmatter["allowed-tools"];
  const lines = [
    originBanner(server, skill.uri, activated),
    `name: ${skill.frontmatter.name}`,
    `description: ${skill.frontmatter.description}`,
  ];
  if (allowed !== undefined) lines.push("allowed-tools is ignored for MCP skills and does not grant tools.");
  if (ignored.length > 0) lines.push(`Ignored unrecognized metadata: ${ignored.join(", ")}`);
  if (skill.resources === "dynamic") lines.push("resources: dynamic (no content digest; approval does not cover later bytes)");
  else lines.push(`resources: ${skill.resources.length}`);
  lines.push("");
  lines.push(text ?? "");
  return lines.join("\n");
}

function approvalMessage(server: string, skill: Skill, changed: boolean): string {
  const files = skill.resources === "dynamic" ? "dynamic content with no digest" : `${skill.resources.length} files`;
  const lead = changed ? "The skill's files changed since the last approval." : "Approve this skill before it is loaded.";
  return `${lead}\nServer: ${server}\nURI: ${skill.uri}\n${skill.frontmatter.name}: ${skill.frontmatter.description}\n${files}`;
}

function renderDirectory(server: string, uri: string, children: DirectoryChild[], hidden: string[]): string {
  const lines = [originBanner(server, uri, false), ...children.map((child) => `${child.mimeType ?? "file"}\t${child.name}\t${child.uri}`)];
  if (hidden.length > 0) {
    lines.push("");
    lines.push("These names are not part of the approved skill and were not listed as its files. Load the skill again if it changed:");
    lines.push(...hidden.map((item) => `- ${item}`));
  }
  if (children.length === 0) lines.push("(empty)");
  return lines.join("\n");
}
