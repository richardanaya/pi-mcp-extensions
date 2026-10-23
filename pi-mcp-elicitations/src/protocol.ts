/**
 * Capability advertisement and the optional 2026-07-28 accept patch.
 *
 * pi 1.4.0's package client and its inlined CLI client both close over
 * `SUPPORTED_PROTOCOL_VERSIONS`. The package export is that array. The CLI
 * copy lives in the chunk imported by `dist/bundle/chunks/runtime-*.js` and
 * is not exported. `connect` calls `.includes` on it. The patch below is
 * installed only when the protocol flag asks for 2026-07-28.
 */

import { isRecord } from "./schema.ts";

export const CLIENT_CAPABILITIES_META = "io.modelcontextprotocol/clientCapabilities";
export const PROTOCOL_VERSION_META = "io.modelcontextprotocol/protocolVersion";
export const CLIENT_INFO_META = "io.modelcontextprotocol/clientInfo";
export const PROTOCOL_2026 = "2026-07-28";

const STOCK = ["2025-11-25", "2025-06-18", "2025-03-26", "2024-11-05"];

export function withElicitationCapability(capabilities: Record<string, unknown> | undefined): Record<string, unknown> {
  const next = { ...(capabilities ?? {}) };
  const current = isRecord(next.elicitation) ? { ...next.elicitation } : {};
  next.elicitation = {
    ...current,
    form: isRecord(current.form) ? current.form : {},
    url: isRecord(current.url) ? current.url : {},
  };
  return next;
}

/** Merge elicitation into per-request client capabilities. Does not replace extensions or an existing protocol version. */
export function withElicitationMeta(params: Record<string, unknown> | undefined, negotiated: string | undefined): Record<string, unknown> {
  const next: Record<string, unknown> = { ...(params ?? {}) };
  const meta = isRecord(next._meta) ? { ...next._meta } : {};
  const caps = isRecord(meta[CLIENT_CAPABILITIES_META]) ? { ...meta[CLIENT_CAPABILITIES_META] } : {};
  const elicitation = isRecord(caps.elicitation) ? { ...caps.elicitation } : {};
  caps.elicitation = {
    ...elicitation,
    form: isRecord(elicitation.form) ? elicitation.form : {},
    url: isRecord(elicitation.url) ? elicitation.url : {},
  };
  meta[CLIENT_CAPABILITIES_META] = caps;
  if (!isRecord(meta[CLIENT_INFO_META])) meta[CLIENT_INFO_META] = { name: "pi-mcp-elicitations", version: "0.1.0" };
  if (negotiated && meta[PROTOCOL_VERSION_META] === undefined) meta[PROTOCOL_VERSION_META] = negotiated;
  next._meta = meta;
  return next;
}

const patchedLists = new Set<string[]>();
let includesPatched = false;
const nativeIncludes = Array.prototype.includes;

function isProtocolList(value: unknown): value is string[] {
  if (!Array.isArray(value)) return false;
  if (value.length !== STOCK.length && value.length !== STOCK.length + 1) return false;
  for (let index = 0; index < STOCK.length; index += 1) {
    if (value[index] !== STOCK[index]) return false;
  }
  return value.length === STOCK.length || value[STOCK.length] === PROTOCOL_2026;
}

/**
 * Accept `2026-07-28` from a server that still completes initialize.
 * Pushes onto exported arrays and patches `includes` for the closed-over CLI copy.
 */
export function enableProtocol2026(lists: readonly string[][]): void {
  for (const list of lists) {
    if (!list.includes(PROTOCOL_2026)) {
      list.push(PROTOCOL_2026);
      patchedLists.add(list);
    }
  }
  if (includesPatched) return;
  includesPatched = true;
  Array.prototype.includes = function includes(this: unknown[], search: unknown, fromIndex?: number): boolean {
    if (search === PROTOCOL_2026 && isProtocolList(this)) return true;
    return nativeIncludes.call(this, search, fromIndex);
  } as typeof Array.prototype.includes;
}

/** Undo {@link enableProtocol2026}. Tests use this. The extension leaves the patch in place for the process. */
export function disableProtocol2026(): void {
  if (includesPatched) {
    Array.prototype.includes = nativeIncludes;
    includesPatched = false;
  }
  for (const list of patchedLists) {
    const index = list.indexOf(PROTOCOL_2026);
    if (index !== -1) list.splice(index, 1);
  }
  patchedLists.clear();
}

export function protocolIncludesPatched(): boolean {
  return includesPatched;
}
