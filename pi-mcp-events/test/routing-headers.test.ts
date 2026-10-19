import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { StreamableHttpTransport } from "@earendil-works/pi-mcp";
import { encodeMcpHeaderValue, HEADER_MISMATCH } from "../src/headers.ts";
import { fetchWithEventRouting } from "../src/headers.ts";
import { EventSession } from "../src/wire.ts";

describe("SEP-2243 header encoding", () => {
	it("leaves safe ASCII plain and wraps the spec's unsafe examples", () => {
		assert.equal(encodeMcpHeaderValue("comment.created"), "comment.created");
		assert.equal(encodeMcpHeaderValue("us-west1"), "us-west1");
		assert.equal(encodeMcpHeaderValue("Hello, 世界"), "=?base64?SGVsbG8sIOS4lueVjA==?=");
		assert.equal(encodeMcpHeaderValue(" padded "), "=?base64?IHBhZGRlZCA=?=");
		assert.equal(encodeMcpHeaderValue("line1\nline2"), "=?base64?bGluZTEKbGluZTI=?=");
		assert.equal(encodeMcpHeaderValue("=?base64?literal?="), "=?base64?PT9iYXNlNjQ/bGl0ZXJhbD89?=");
		assert.equal(HEADER_MISMATCH, -32020);
	});
});

describe("Streamable HTTP routing headers", () => {
	it("sets Mcp-Method on every request and Mcp-Name only for named event methods", async () => {
		const seen: { rpc: string; method: string | null; name: string | null }[] = [];
		const fetchImpl: typeof fetch = async (_input, init) => {
			const headers = new Headers(init?.headers);
			const body = JSON.parse(String(init?.body)) as { id?: number; method?: string };
			seen.push({ rpc: body.method ?? "", method: headers.get("Mcp-Method"), name: headers.get("Mcp-Name") });
			const result =
				body.method === "server/discover"
					? { supportedVersions: ["2026-07-28"], capabilities: { extensions: { "io.modelcontextprotocol/events": {} } }, serverInfo: { name: "fixture", version: "0" } }
					: body.method === "events/list"
						? { events: [] }
						: body.method === "events/poll"
							? { events: [], cursor: null, truncated: false, hasMore: false }
							: {};
			return new Response(JSON.stringify({ jsonrpc: "2.0", id: body.id, result }), {
				status: 200,
				headers: { "content-type": "application/json" },
			});
		};
		const transport = new StreamableHttpTransport({
			url: "https://events.example/mcp",
			fetch: fetchWithEventRouting(fetchImpl),
			headers: { "Mcp-Name": "stale-static-name" },
			openGetStream: false,
		});
		const session = await EventSession.open(transport);
		await session.request("events/list", {});
		await session.request("events/poll", { name: "comment.created", cursor: null });
		await session.request("events/stream", { name: "事件", cursor: null });
		await session.request("events/subscribe", { name: "=?base64?literal?=", delivery: { mode: "webhook", url: "https://example/hook", secret: "whsec_x" }, cursor: null });
		await session.request("events/unsubscribe", { name: "comment.created", delivery: { mode: "webhook", url: "https://example/hook" } });
		await session.close();

		const byRpc = (rpc: string) => seen.filter((entry) => entry.rpc === rpc);
		assert.equal(byRpc("server/discover")[0]?.method, "server/discover");
		assert.equal(byRpc("server/discover")[0]?.name, null);
		assert.equal(byRpc("events/list")[0]?.method, "events/list");
		assert.equal(byRpc("events/list")[0]?.name, null);
		assert.deepEqual(byRpc("events/poll")[0], { rpc: "events/poll", method: "events/poll", name: "comment.created" });
		assert.equal(byRpc("events/stream")[0]?.name, "=?base64?5LqL5Lu2?=");
		assert.equal(byRpc("events/subscribe")[0]?.method, "events/subscribe");
		assert.equal(byRpc("events/subscribe")[0]?.name, "=?base64?PT9iYXNlNjQ/bGl0ZXJhbD89?=");
		assert.equal(byRpc("events/unsubscribe")[0]?.name, "comment.created");
	});
});
