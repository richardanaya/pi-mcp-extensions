import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { type JsonRpcMessage, type JsonRpcRequest } from "@earendil-works/pi-mcp";
import { createInMemoryTransportPair } from "@earendil-works/pi-mcp/testing";
import { listEventTypes } from "../src/events.ts";
import { callbackResponse, isWebhookSecret, PROTOCOL_VERSION, signWebhook } from "../src/wire.ts";
import { EventSession } from "../src/wire.ts";

function isRequest(message: JsonRpcMessage): message is JsonRpcRequest {
	return "id" in message && "method" in message;
}

const SECRET = `whsec_${Buffer.from("0123456789abcdef01234567").toString("base64")}`;

const EVENT = { name: "comment.created", description: "review", delivery: ["webhook"], inputSchema: { type: "object" }, payloadSchema: { type: "object" } };

async function sessionWith(capabilities: Record<string, unknown>, answerList: boolean) {
	const { client: clientTransport, server } = createInMemoryTransportPair();
	await server.start();
	let listed = 0;
	server.onMessage((message) => {
		if (!isRequest(message)) return;
		const meta = (message.params as { _meta?: Record<string, unknown> } | undefined)?._meta;
		assert.equal(meta?.["io.modelcontextprotocol/protocolVersion"], PROTOCOL_VERSION);
		const clientCaps = meta?.["io.modelcontextprotocol/clientCapabilities"] as { extensions?: Record<string, unknown> } | undefined;
		assert.deepEqual(clientCaps?.extensions?.["io.modelcontextprotocol/events"], {});
		if (message.method === "server/discover") {
			void server.send({
				jsonrpc: "2.0",
				id: message.id,
				result: {
					resultType: "complete",
					supportedVersions: [PROTOCOL_VERSION],
					capabilities,
					serverInfo: { name: "fixture", version: "0" },
				},
			});
			return;
		}
		if (message.method === "events/list") {
			listed += 1;
			if (!answerList) return;
			void server.send({ jsonrpc: "2.0", id: message.id, result: { events: [EVENT] } });
		}
	});
	const session = await EventSession.open(clientTransport);
	return { session, listed: () => listed };
}

describe("listEventTypes", () => {
	it("reads events/list when SEP-3415 advertises io.modelcontextprotocol/events", async () => {
		const { session } = await sessionWith({ tools: {}, extensions: { "io.modelcontextprotocol/events": { listChanged: true } } }, true);
		const types = await listEventTypes(session);
		assert.equal(types[0]?.name, "comment.created");
		assert.deepEqual(types[0]?.delivery, ["webhook"]);
		await session.close();
	});

	it("still reads events/list when a prototype advertises a top-level events capability", async () => {
		const { session } = await sessionWith({ tools: {}, events: {} }, true);
		const types = await listEventTypes(session);
		assert.equal(types[0]?.name, "comment.created");
		await session.close();
	});

	it("does not call events/list when neither capability is present", async () => {
		const { session, listed } = await sessionWith({ tools: {} }, false);
		const types = await listEventTypes(session);
		assert.deepEqual(types, []);
		assert.equal(listed(), 0);
		await session.close();
	});
});

describe("webhook callback", () => {
	it("accepts a 24-byte whsec secret and echoes a signed verification challenge", () => {
		assert.equal(isWebhookSecret(SECRET), true);
		assert.equal(isWebhookSecret("whsec_YQ=="), false);
		const body = JSON.stringify({ type: "verification", challenge: "once" });
		const timestamp = "1739980800";
		const signature = signWebhook(SECRET, "msg_verification_1", timestamp, body);
		const ok = callbackResponse(SECRET, { id: "msg_verification_1", timestamp, signature }, body, 1739980800 * 1000);
		assert.equal(ok.status, 200);
		assert.deepEqual(JSON.parse(ok.body), { challenge: "once" });
		const bad = callbackResponse(SECRET, { id: "msg_verification_1", timestamp, signature: "v1,nope" }, body, 1739980800 * 1000);
		assert.equal(bad.status, 401);
	});
});
