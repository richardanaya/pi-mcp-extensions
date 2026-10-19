import type { McpFetch } from "@earendil-works/pi-mcp";

/**
 * SEP-3415 (draft, head 2ec39b9) "Streamable HTTP: Routing Headers".
 * `Mcp-Name` and the Base64 sentinel encoding are SEP-2243, carried in the
 * 2026-07-28 Streamable HTTP transport.
 */
export const HEADER_MISMATCH = -32020;

/** Methods whose `params.name` must be mirrored into `Mcp-Name`. `events/list` is not one of them. */
export const NAME_HEADER_METHODS = new Set(["events/poll", "events/stream", "events/subscribe", "events/unsubscribe"]);

const SENTINEL_PREFIX = "=?base64?";
const SENTINEL_SUFFIX = "?=";

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * A header value is plain when every character is visible ASCII or an internal
 * space, it has no leading or trailing whitespace, and it is not the Base64
 * sentinel pattern. Anything else is encoded.
 */
export function isPlainHeaderValue(value: string): boolean {
	if (value.length === 0) return false;
	if (value.startsWith(" ") || value.endsWith(" ") || value.startsWith("\t") || value.endsWith("\t")) return false;
	for (let index = 0; index < value.length; index++) {
		const code = value.charCodeAt(index);
		if (code < 0x20 || code > 0x7e) return false;
	}
	return !(value.startsWith(SENTINEL_PREFIX) && value.endsWith(SENTINEL_SUFFIX));
}

/** SEP-2243 value encoding: plain ASCII, or `=?base64?{utf8-base64}?=`. */
export function encodeMcpHeaderValue(value: string): string {
	if (isPlainHeaderValue(value)) return value;
	return `${SENTINEL_PREFIX}${Buffer.from(value, "utf8").toString("base64")}${SENTINEL_SUFFIX}`;
}

/**
 * Set `Mcp-Method` on a JSON-RPC request. Set `Mcp-Name` to `params.name` for
 * the four event methods that carry a name, using the sentinel encoding when
 * the name is not a safe header value. Remove `Mcp-Name` on every other
 * request, including `events/list` and `server/discover`.
 */
export function applyRoutingHeaders(headers: Headers, message: unknown): void {
	if (!isRecord(message) || typeof message.method !== "string" || !("id" in message)) return;
	headers.set("Mcp-Method", message.method);
	const params = isRecord(message.params) ? message.params : undefined;
	const name = params && typeof params.name === "string" ? params.name : undefined;
	if (NAME_HEADER_METHODS.has(message.method) && name !== undefined) {
		headers.set("Mcp-Name", encodeMcpHeaderValue(name));
		return;
	}
	headers.delete("Mcp-Name");
}

/** Wrap fetch so Streamable HTTP posts pick up routing headers from the JSON-RPC body. */
export function fetchWithEventRouting(base: McpFetch = globalThis.fetch): McpFetch {
	return (input, init) => {
		const headers = new Headers(init?.headers);
		if (typeof init?.body === "string") {
			try {
				applyRoutingHeaders(headers, JSON.parse(init.body));
			} catch {
				// A body that is not JSON keeps the headers the transport already set.
			}
		}
		return base(input, { ...init, headers });
	};
}
