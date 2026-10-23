# pi-mcp-tasks

Client for the [MCP Tasks extension](https://github.com/modelcontextprotocol/ext-tasks/blob/899c1bbc869567670093face3591b39c28ce3219/specification/2026-07-28/tasks.md) (`io.modelcontextprotocol/tasks`), as a [pi](https://github.com/earendil-works/pi) extension. The extension was introduced by [SEP-2663](https://github.com/modelcontextprotocol/modelcontextprotocol/pull/2663).

A tool call can return a task handle instead of a finished result. This extension tells the server that pi supports tasks, polls `tasks/get` until the task ends, and puts the result, error, or cancellation back into the conversation so the model sees it. It uses the MCP servers already registered with pi. It does not open a second connection.

The pinned spec is ext-tasks `899c1bbc869567670093face3591b39c28ce3219`, `specification/2026-07-28/tasks.md`. A missing required client capability is JSON-RPC `-32021` (Missing Required Client Capability), the code in that spec and in the core `2026-07-28` schema. The extension follows the migration rules from the legacy 2025-11-25 tasks protocol: it never calls `tasks/result`, never sends the legacy `task` parameter, and never advertises `tasks.requests`, `tasks.list`, or `tasks.cancel`.

## Install

Node 22. The peer dependency is the exact pin `@earendil-works/pi-coding-agent` 1.4.0, the release this package is tested against. The hook patches the connection class in `dist/bundle/chunks/runtime-*.js` and the `McpClient` that class constructs. pi 1.4.0 still inlines that client in a bundle chunk, separate from `@earendil-works/pi-mcp`, so patching only the package export does not change `initialize`.

```bash
pi install npm:pi-mcp-tasks
```

Or add the package path to your pi settings. The package advertises itself with:

```json
"pi": { "extensions": ["./index.ts"] }
```

Register MCP servers the usual way, in `~/.pi/agent/mcp.json` or the project `.pi/mcp.json`. This extension does not register a slash command and does not replace pi's built-in MCP client.

```json
{
  "mcpServers": {
    "jobs": {
      "command": "my-tasks-server",
      "args": []
    }
  }
}
```

## How a task runs

1. On connect, the client adds `extensions["io.modelcontextprotocol/tasks"] = {}` to the initialize capabilities when pi's `McpClient.connect` can be patched.
2. Every `tools/call`, `tasks/get`, `tasks/update`, `tasks/cancel`, and `subscriptions/listen` request carries `_meta["io.modelcontextprotocol/clientCapabilities"].extensions["io.modelcontextprotocol/tasks"] = {}`. That per-request object is the signal the spec requires. A server that does not see it must not return a task handle.
3. When `tools/call` returns `resultType: "task"`, the tool result in the conversation describes the running task. The tool itself returns immediately. The final payload arrives later.
4. The client calls `tasks/get` at once, then again after `pollIntervalMs` (or 1000 ms when the server omits it). A changed interval is honored on the next wait.
5. While the task is open, the status line shows `tasks N` and the `mcp-tasks` widget lists each task's id, server, tool, status, status message, poll interval, and TTL.
6. `input_required` is shown to the user for confirmation before any `tasks/update` when approval mode is `ui` (the default). In print mode, with no UI, the key stays pending and the model is told to call `mcp_tasks_respond`. Set `--mcp-tasks-approvals tool` or `PI_MCP_TASKS_APPROVALS=tool` to skip the confirm and input dialogs even when a UI exists. The environment variable wins. `mcp_tasks_respond` is then the only way to answer.
7. A terminal snapshot is appended as a custom message (`customType: "mcp-task"`). When a model is selected, that message starts a follow-up turn. The text includes the status, `statusMessage`, and the tool result, JSON-RPC error, or cancellation.
8. Open tasks are stored as session entries (`customType: "pi-mcp-tasks"`) and polling resumes on the next `session_start`.

`completed` with `isError: true` stays `completed`. `failed` is only a JSON-RPC execution error, and that error is included in the message. A dropped connection is a client-local `disconnected` outcome. It is not relabeled as the spec status `failed`.

Codemode scripts see the task handle in `structuredContent`, not the final tool result. The final result is the later `mcp-task` message. The tool is not held open until completion, because pi's tool timeout would fire first.

## Tools

| Tool | Effect |
| --- | --- |
| `mcp_tasks_list` | Every task from this session: status, status message, poll interval, TTL. |
| `mcp_tasks_show` | One task, including result or error. The id is a task id, or `server/taskId` when two servers share an id. |
| `mcp_tasks_cancel` | `tasks/cancel`. Polling stops. Does not send `notifications/cancelled`. |
| `mcp_tasks_respond` | `tasks/update` with `inputResponses` as a JSON string. Keys already answered are skipped. |

## Compliance

Every client requirement below is implemented. The test column is the node:test name that covers it.

| ID | Level | Requirement | Status | Test |
| --- | --- | --- | --- | --- |
| C-MUST-01 | MUST | Handle either CallToolResult or CreateTaskResult for a supported request (`tools/call`). | implemented | C-MUST-01 |
| C-MUST-02 | MUST | Treat CreateTaskResult on an unsupported request type as an invalid response. | implemented | C-MUST-02 |
| C-MUST-03 | MUST | Inspect `inputRequests` when a task is `input_required`. | implemented | C-MUST-03 |
| C-MUST-04 | MUST | Apply the same trust model to `inputRequests` as to a direct elicitation or sampling request. | implemented | C-MUST-04 |
| C-MUST-05 | MUST | Cancel tasks with `tasks/cancel`, never `notifications/cancelled`. | implemented | C-MUST-05 |
| C-MUST-06 | MUST | Set `Mcp-Name` to the task id on `tasks/get`, `tasks/update`, and `tasks/cancel` over Streamable HTTP. | implemented | C-MUST-06 |
| C-MUST-07 | MUST | Do not call the removed `tasks/result` method. | implemented | C-MUST-07 |
| C-MUST-08 | MUST | Do not send the legacy `task` parameter on `tools/call`. | implemented | C-MUST-08 |
| C-MUST-09 | MUST | Do not advertise legacy `tasks.requests`, `tasks.list`, or `tasks.cancel` capabilities. | implemented | C-MUST-09 |
| C-MUST-10 | MUST | Declare `io.modelcontextprotocol/tasks` on `tools/call` and on task protocol requests. | implemented | C-MUST-10 |
| C-MUST-11 | MUST | Keep a tool result with `isError: true` on the `completed` status, not `failed`. | implemented | C-MUST-11 |
| C-MUST-12 | MUST | Surface a failed task's JSON-RPC error to the user and the model. | implemented | C-MUST-12 |
| C-SHOULD-01 | SHOULD | Keep the set of task-augmented methods open so later revisions can add request types. | implemented | C-SHOULD-01 |
| C-SHOULD-02 | SHOULD | Honor `pollIntervalMs`, including a value that changes between polls. | implemented | C-SHOULD-02 |
| C-SHOULD-03 | SHOULD | Keep polling until the task is terminal or the client cancels it. | implemented | C-SHOULD-03 |
| C-SHOULD-04 | SHOULD | Persist task ids so polling can resume after a restart. | implemented | C-SHOULD-04 |
| C-SHOULD-05 | SHOULD | Fulfill `input_required` by sending `inputResponses` on `tasks/update`. | implemented | C-SHOULD-05 |
| C-SHOULD-06 | SHOULD | After `tasks/update`, keep observing the task until it is terminal. | implemented | C-SHOULD-06 |
| C-SHOULD-07 | SHOULD | Deduplicate `inputRequests` keys across polls. | implemented | C-SHOULD-07 |
| C-SHOULD-08 | SHOULD | Do not send `inputResponses` for a key that was already answered. | implemented | C-SHOULD-08 |
| C-SHOULD-09 | SHOULD | Show `statusMessage` to the user and include it in what the model sees. | implemented | C-SHOULD-09 |
| C-MAY-01 | MAY | Expose the task lifecycle with list, inspect, cancel, and respond tools, and a status widget. | implemented | C-MAY-01 |
| C-MAY-02 | MAY | Treat `createdAt` plus `ttlMs` as a backstop when the task never reaches a terminal status. | implemented | C-MAY-02 |
| C-MAY-03 | MAY | Subscribe to `notifications/tasks` and keep polling. | implemented | C-MAY-03 |
| C-MAY-04 | MAY | Drop answered input-request state after `tasks/cancel`. | implemented | C-MAY-04 |
| C-MAY-05 | MAY | Accept a later terminal notification after a cooperative cancel. | implemented | C-MAY-05 |

`tests/coverage.test.ts` fails if a row in `src/requirements.ts` has no matching test name.

Integration tests against a local server cover completion, failure, cancellation, update, expiry, a tool result with `isError: true`, a legacy server that has no tasks methods, a dropped connection, and the Streamable HTTP `Mcp-Name` header. A pi session test calls a direct MCP tool through pi's own connection and waits for the `mcp-task` message.

## Readings

The spec leaves these points open. This is the reading the code uses.

- **Poll default.** The spec does not define a default `pollIntervalMs`. A missing or non-positive value waits 1000 ms. A positive value is rounded and honored, including a value that changes on a later poll. The first `tasks/get` is sent immediately.
- **TTL backstop.** When `ttlMs` is a number and the status is still non-terminal at `Date.parse(createdAt) + ttlMs` on the client clock, the task is expired locally and polling stops. `ttlMs: null` or a missing field means unlimited. An unparseable `createdAt` skips the backstop. `ttlMs: 0` expires at `createdAt`. A later snapshot can change `ttlMs`; the deadline uses the latest value and the original `createdAt`. Clock skew between client and server can expire a task early or late.
- **`-32602`.** A `tasks/get` invalid-params error whose message matches `/expir/i`, or that arrives after the TTL deadline, is `expired`. Any other `-32602` is `unavailable` (not found). Other failures retry, then become `disconnected`.
- **`tasks/get` without `resultType`.** A snapshot with a task id and a known status is accepted. The spec says `tasks/get` results use `resultType: "complete"`, which is not a create result, so it is not treated as a new task.
- **Elicitation content.** The spec's example sends `{ "input": "Luca" }` while `requestedSchema` asks for `{ name }`. Submitted content matches `requestedSchema`. The user confirms before accept. Declining leaves the key pending and tells the user to call `mcp_tasks_respond`. URL elicitation shows the URL and confirms completion. Sampling wraps the user's text as an assistant text result (`model: "user"`, `stopReason: "endTurn"`).
- **Cancel.** `tasks/cancel` is sent, polling stops, answered keys are cleared, and the conversation gets a cancellation-requested message. A later terminal `notifications/tasks` can replace that outcome.
- **Capability placement.** The normative client signal is the per-request `_meta` object. Initialize `capabilities.extensions` is sent as well, on the `@earendil-works/pi-mcp` client and on the client class the bundled CLI constructs. Legacy `capabilities.tasks` is removed from that initialize payload.
- **HTTP headers.** `Mcp-Name` is the task id and `Mcp-Method` is the JSON-RPC method, and only on `tasks/get`, `tasks/update`, and `tasks/cancel`. Stdio does not send them.
- **Unknown status.** A status outside `working | input_required | completed | cancelled | failed` is a protocol failure. It retries, then becomes `disconnected`.

## pi gaps

pi's public extension API cannot do four things this protocol needs. The workaround patches the MCP client pi already created: `McpServerConnection.getClient` in `dist/extensions/mcp/runtime.js`, and the same class re-exported from `dist/bundle/chunks/runtime-*.js`. It does not construct a second client.

| Gap | Workaround |
| --- | --- |
| `ClientCapabilities` has no `extensions` field, and nothing lets an extension add one at initialize. | Wrap `McpClient.prototype.connect` on the `@earendil-works/pi-mcp` export and on the `McpClient` the bundled runtime imports. pi 1.4.0 still inlines that class in a chunk reached from `dist/bundle/chunks/runtime-*.js`; the chunk hash is not hard-coded. Both initialize payloads gain the tasks extension. |
| `tools/call` sends only `name` and `arguments`. There is no hook to add `_meta`. | Wrap `client.request` after `getClient()`. |
| There is no public `pi.mcpRequest`. | `tasks/get`, `tasks/update`, `tasks/cancel`, `server/discover`, and `subscriptions/listen` go through that same `client.request`. The binding calls the original `getClient` so the wrap does not recurse. |
| Streamable HTTP builds headers inside the transport, with no per-request hook. | Replace `transport.headers` for the duration of those three methods, under `AsyncLocalStorage`, so concurrent calls do not share a task id. |

Other limits, left as they are:

- `tool_result` runs after pi has converted the MCP result. A direct `tool.execute()` never emits it. Task detection therefore starts in the wrapped `request`, and `tool_result` only rewrites the text the model sees. The rewritten result still returns `structuredContent`.
- pi does not implement elicitation or sampling. This extension confirms through `ctx.ui` and does not accept on the user's behalf.
- `McpServerConnection` is not in the package exports map, and the exports condition is `import` only. The patch loads that runtime by file URL. `@earendil-works/pi-mcp` is the package beside that file: Node 22 ignores the parent argument of `import.meta.resolve` unless `--experimental-import-meta-resolve` is set, and `require.resolve` cannot see an `import`-only export, so the hook walks `node_modules` from the runtime and reads the `import` condition.
- pi 1.4.0 still requests `2025-11-25` and also accepts `2025-06-18`, `2025-03-26`, and `2024-11-05`. It does not offer `2026-07-28`. `McpClient.connect` rejects a server that selects a version outside that list, so this package cannot negotiate the tasks revision with a spec-strict server. SEP-2663 says the tasks extension is not defined for `2025-11-25` and that servers must not treat the capability as enabling tasks on it. This client still sends the capability. A server that follows the spec on `2025-11-25` will answer with an immediate tool result, which this client delivers unchanged. The test server speaks `2025-11-25` because that is the version pi will negotiate, and it honors the extension anyway.
- `session.dispose()` does not emit `session_shutdown`. pi closes MCP children only on that event. Quitting or reloading the session does emit it. Tests emit it themselves so the fixture process exits.

## Development

```bash
npm ci
npm test
npm run typecheck
```

`npm test` runs the unit, integration, session, and coverage suites with Node's test runner (`--experimental-strip-types`). CI on GitHub Actions runs both commands on Node 22.

## License

MIT. Copyright (c) 2026 Richard Anaya.
