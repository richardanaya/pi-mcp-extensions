# pi-mcp-elicitations

Client for MCP elicitation, as a [pi](https://github.com/earendil-works/pi) extension. It covers form mode and URL mode from the [2026-07-28 elicitation spec](https://modelcontextprotocol.io/specification/2026-07-28/client/elicitation) and the [2025-11-25 elicitation spec](https://modelcontextprotocol.io/specification/2025-11-25/client/elicitation), URL elicitation from [SEP-1036](https://github.com/modelcontextprotocol/modelcontextprotocol/issues/1036), and multi round-trip requests from [SEP-2322](https://github.com/modelcontextprotocol/modelcontextprotocol/issues/2322).

When a server needs a value or a yes-or-no, pi asks you and sends `accept`, `decline`, or `cancel` back. The extension uses the MCP servers already registered with pi. It does not open a second connection.

## Install

Node 22. The peer dependency is the exact pin `@earendil-works/pi-coding-agent` 1.4.0, the release this package is tested against. `@earendil-works/pi-mcp` is pinned to 1.4.0 as well. The hook patches the connection class in `dist/bundle/chunks/runtime-*.js` and the `McpClient` that class constructs. pi 1.4.0 still inlines that client in a bundle chunk, separate from `@earendil-works/pi-mcp`, so patching only the package export does not change `initialize`. The chunk hash is not hard-coded. `@earendil-works/pi-mcp` is the package beside the runtime file: Node 22 ignores the parent argument of `import.meta.resolve` unless `--experimental-import-meta-resolve` is set, and `require.resolve` cannot see an `import`-only export, so the hook walks `node_modules` from the runtime and reads the `import` condition.

```bash
pi install npm:pi-mcp-elicitations
```

Or add the package path to your pi settings. The package advertises itself with:

```json
"pi": { "extensions": ["./index.ts"] }
```

## How an elicitation runs

1. On connect, `capabilities.elicitation` is `{ "form": {}, "url": {} }`. An empty elicitation object would mean form only. Other capabilities (`sampling`, `extensions`, and anything else pi already set) stay in place.
2. `tools/call`, `prompts/get`, and `resources/read` also send `_meta["io.modelcontextprotocol/clientCapabilities"].elicitation` with the same form and url objects. Existing `_meta` keys, including `progressToken` and `extensions`, are kept. `io.modelcontextprotocol/protocolVersion` is set to the version this connection negotiated, and only when that key is absent. This package does not write `2026-07-28` into `_meta` on its own.
3. A result with no `resultType` is complete. A result with `resultType: "input_required"` is a multi round-trip round. The client builds `inputResponses` for every `elicitation/create` key, then retries the original method with a new JSON-RPC id. `requestState` is copied byte for byte when the result included it, including an empty string, and is omitted when the result did not include it. One request's state is never attached to another in-flight request.
4. A 2025-11-25 server can still send `elicitation/create` during a request. That handler returns `{ action, content? }`. `notifications/elicitation/complete` is honored for an id this client opened. An unknown id, or an id that already completed, is ignored. JSON-RPC `-32042` (`URLElicitationRequiredError`) is the same URL flow: the client shows the URL, and retries the original request after the completion notification or after `mcp_elicitations_retry`.
5. Form content is validated before accept: required fields, string, number, integer, boolean, string enum, `oneOf` `{ const, title }`, multi-select `items.enum` and `items.anyOf`, `format` (`email`, `uri`, `date`, `date-time`), `minLength` / `maxLength`, `pattern`, inclusive `minimum` / `maximum`, and `minItems` / `maxItems`. Defaults are prefilled. An invalid default is ignored. An empty optional string is omitted. A schema this client cannot show (a nested object, `exclusiveMinimum`, or any other keyword outside the flat primitive subset) is cancelled, with a notice, so the server is not left waiting.
6. URL mode shows the server message, the host on its own line (`Host: ...`), and the full original URL. The only choice that opens it is Open. Decline, Cancel, and dismissing the dialog do not open it and do not prefetch it. A non-`http` or non-`https` URL is rejected. Punycode labels (`xn--`) and non-https URLs (other than localhost, `127.0.0.1`, and `::1`) are warned about before the choice. The browser is `xdg-open`, detached, with stdio ignored, so pi cannot read the page or what you type. A URL typed into a form field is not opened.
7. Dismissing a dialog (escape, or a closed prompt) is `cancel`. Choosing Decline is `decline`. Accept on a form includes `content`. Accept on a URL omits `content`. Decline and cancel omit `content`.

## When nobody can answer

Print mode and JSON mode have no UI. If `--mcp-elicitations-approvals` is `ui` (the default) and `PI_MCP_ELICITATIONS_APPROVALS` is unset, a request that needs input is answered with `{ "action": "cancel" }` on the same turn. The client does not wait. Set the flag or the environment variable to `tool` when a headless caller will answer through `mcp_elicitations_respond`. The environment variable wins when it is non-empty.

Tool mode does not open dialogs. A legacy `elicitation/create` waits until `mcp_elicitations_respond`. That wait can deadlock a model turn: the server asked during `tools/call`, and the model cannot call the respond tool until that call returns. Servers that need a headless answer should use `resultType: "input_required"` instead. In that path the original call returns immediately with a note that names the pending id, and the retry happens when the model calls `mcp_elicitations_respond`.

A URL accept in tool mode is ignored unless `open` is `true`. The response starts with `Error:` and the browser is not launched.

## Tools

| Tool | Effect |
| --- | --- |
| `mcp_elicitations_list` | Elicitations waiting for `mcp_elicitations_respond` or `mcp_elicitations_retry`. |
| `mcp_elicitations_respond` | Answer one pending elicitation. `inputResponses` is JSON: one `{ action, content? }` for a legacy `elicitation/create`, or a map keyed like `inputRequests` for a round. `open: true` consents to open every accepted URL in that response. Invalid form content stays pending and the tool result is an error. |
| `mcp_elicitations_retry` | Replay a request that is parked after a URL elicitation, when `notifications/elicitation/complete` does not arrive. Omit `id` to retry every parked request. |

## Shared helper

`pi-mcp-tasks` collects `input_required` elicitations in `src/input.ts` (`collectElicitation`). That collector is unchanged in this package. The follow-up is for tasks to call `fulfillElicitation` so a task elicitation gets the same schema check, decline and cancel, defaults, and URL consent.

```ts
import { fulfillElicitation, validateFormContent, presentUrl, buildMrtrRetryParams, readInputRequired } from "pi-mcp-elicitations";
```

`fulfillElicitation(ui, params, { server, openUrl })` always resolves to `accept`, `decline`, or `cancel`. `ui` undefined is an immediate cancel. `openUrl` runs only after the user chooses Open.

## Compliance

Every client requirement below is implemented. The test column is the node:test name that covers it.

| ID | Level | Requirement | Status | Test |
| --- | --- | --- | --- | --- |
| C-MUST-01 | MUST | Declare elicitation form and url on initialize, and keep every other capability. | implemented | C-MUST-01 |
| C-MUST-02 | MUST | Name the server that is asking. | implemented | C-MUST-02 |
| C-MUST-03 | MUST | Send accept, decline, or cancel. Dismissing a dialog is cancel. Decline is the explicit refusal. | implemented | C-MUST-03 |
| C-MUST-04 | MUST | Let the user review and modify a form before accept, and send the content with accept. | implemented | C-MUST-04 |
| C-MUST-05 | MUST | Show the full URL and the host, get consent before opening, and never open or prefetch otherwise. | implemented | C-MUST-05 |
| C-MUST-06 | MUST | Treat a request with no mode as form mode. | implemented | C-MUST-06 |
| C-MUST-07 | MUST | Omit content on URL accept, decline, and cancel. | implemented | C-MUST-07 |
| C-MUST-08 | MUST | Open a consented URL in an external browser so the client cannot read the page or what the user types. | implemented | C-MUST-08 |
| C-MUST-09 | MUST | Build inputResponses for an input_required elicitation before retrying the original request. | implemented | C-MUST-09 |
| C-MUST-10 | MUST | Echo requestState exactly when the result included it, and omit it when the result did not. | implemented | C-MUST-10 |
| C-MUST-11 | MUST | Retry with a new JSON-RPC id, and do not attach one request's inputResponses or requestState to another request. | implemented | C-MUST-11 |
| C-MUST-12 | MUST | Treat a result that omits resultType as complete. | implemented | C-MUST-12 |
| C-MUST-13 | MUST | Answer a server-initiated elicitation/create from a 2025-11-25 server. | implemented | C-MUST-13 |
| C-MUST-14 | MUST | Ignore notifications/elicitation/complete for an unknown or already-completed elicitation id. | implemented | C-MUST-14 |
| C-MUST-15 | MUST | When there is no UI and tool mode is not configured, cancel immediately instead of waiting. | implemented | C-MUST-15 |
| C-MUST-16 | MUST | Validate form content before accept: required fields, types, enum, oneOf, format, length, pattern, and minimum, maximum, and item bounds. | implemented | C-MUST-16 |
| C-MUST-17 | MUST | Do not retry an input_required result whose inputRequests include a method other than elicitation/create. | implemented | C-MUST-17 |
| C-SHOULD-01 | SHOULD | Pre-populate form fields from defaults and let the user change them. | implemented | C-SHOULD-01 |
| C-SHOULD-02 | SHOULD | Highlight the URL host and warn on Punycode and non-https URLs. | implemented | C-SHOULD-02 |
| C-SHOULD-03 | SHOULD | Do not treat a URL in a form field as something to open. | implemented | C-SHOULD-03 |
| C-SHOULD-04 | SHOULD | Offer a manual retry when a URL completion notification never arrives. | implemented | C-SHOULD-04 |
| C-SHOULD-05 | SHOULD | Show oneOf and multi-select titles, and submit the const values. | implemented | C-SHOULD-05 |
| C-SHOULD-06 | SHOULD | In tool mode, answer through mcp_elicitations_respond instead of opening a dialog. | implemented | C-SHOULD-06 |
| C-MAY-01 | MAY | Retry a request that failed with URLElicitationRequiredError (-32042) after notifications/elicitation/complete. | implemented | C-MAY-01 |
| C-MAY-02 | MAY | Offer protocol 2026-07-28 only behind --mcp-elicitations-protocol. Leave pi's negotiation unchanged otherwise. | implemented | C-MAY-02 |
| C-MAY-03 | MAY | List elicitations that are waiting for a tool response. | implemented | C-MAY-03 |

`tests/coverage.test.ts` fails if a row in `src/requirements.ts` has no matching test name.

## Protocol version

pi 1.4.0 offers `2025-11-25` and accepts `2025-11-25`, `2025-06-18`, `2025-03-26`, and `2024-11-05`. `McpClient.connect` throws and closes the transport when a server selects anything else. The package export and `dist/client.js` share one mutable `SUPPORTED_PROTOCOL_VERSIONS` array. The CLI bundle inlines a second copy inside the chunk reached from `dist/bundle/chunks/runtime-*.js` and checks it with `Array.prototype.includes`. That copy is not exported.

The 2026-07-28 revision removes `initialize`. A server that follows that revision never answers the handshake, so accepting the version string cannot create a spec-strict 2026-07-28 session. Multi round-trip elicitation still works when a server that negotiated `2025-11-25` (the version pi offers) returns `resultType: "input_required"`. That is the supported path, and it does not change negotiation for skills, tasks, apps, or events.

`--mcp-elicitations-protocol 2026-07-28` (or `PI_MCP_ELICITATIONS_PROTOCOL=2026-07-28`) is off by default. The environment variable wins. When it is on, connect offers `2026-07-28`, the package array gains that version, and `Array.prototype.includes` returns true for `2026-07-28` only when the receiver is the stock four versions or those four plus `2026-07-28`. A lenient server that still completes `initialize` and selects `2026-07-28` can then connect. The patch is process-wide for the life of the process: every `McpClient` in that process, including other extensions, will accept that selection. pi still speaks the session it already implements. The flag does not add stateless requests, `server/discover`, or `subscriptions/listen`. A server that errors `initialize` still fails.

## Limits

- `sampling/createMessage` and `roots/list` inside `inputRequests` are not fulfilled. The request is not retried, and this client does not invent a response for those keys.
- Automatic multi round-trip retries stop after five rounds. If `inputRequests` is absent and `requestState` is present, the client retries once, then stops.
- After one cancel in a round, the remaining elicitation keys in that round are cancelled without another prompt. Decline does not stop the rest of the round.
- `notifications/elicitation/complete` is the 2025-11-25 / SEP-1036 signal. The 2026-07-28 changelog removed it; the outcome of a URL elicitation on that revision is learned by retrying with `requestState`.
- A form `pattern` longer than 256 characters is treated as an unsupported schema and cancelled.
- Two `oneOf` entries with the same title: the first match is submitted.
- Per-request elicitation capability metadata is sent on `tools/call`, `prompts/get`, and `resources/read`.
- Dialogs use `select`, `editor`, and `input`. `ui.custom()` is TUI-only and is not used, so the same prompts work over RPC.

## Development

```bash
npm ci
npm test
npm run typecheck
```

`npm test` runs the unit, runtime, client, bundle, and coverage suites with Node's test runner (`--experimental-strip-types`). CI on GitHub Actions runs both commands on Node 22.

## License

MIT. Copyright (c) 2026 Richard Anaya.
