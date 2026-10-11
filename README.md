# pi-mcp-extensions

[pi](https://github.com/earendil-works/pi) coding-agent extensions that add client support for MCP extensions. The standalone `pi-mcp-*` repositories are gone. This repository is the source for the four packages below. Each directory is published as its own npm package. Pi loads the TypeScript sources. There is no compile step.

Skills, tasks, and apps send MCP requests through the client pi already connected. Events opens its own connection: `server/discover` first, then every request carries `io.modelcontextprotocol/protocolVersion: "2026-07-28"` in `_meta`. None of the packages register a slash command.

## Packages

### pi-mcp-apps

Renders [MCP Apps](https://github.com/modelcontextprotocol/ext-apps/blob/main/specification/2026-01-26/apps.mdx) from the servers pi is already connected to. npm package `pi-mcp-apps` 0.1.0. Extension id `io.modelcontextprotocol/ui`.

**Spec.** SEP-1865, named in `package.json`. The package README calls the [2026-01-26 specification](https://github.com/modelcontextprotocol/ext-apps/blob/main/specification/2026-01-26/apps.mdx) stable. It does not label the SEP Final or an experimental draft.

```bash
pi install npm:pi-mcp-apps
```

Local load from this repo: `pi -e pi-mcp-apps/index.ts`. Details, tools, and the host gaps are in [`pi-mcp-apps/README.md`](pi-mcp-apps/README.md).

### pi-mcp-events

Discovers MCP event types on the servers `/mcp` already knows and manages subscriptions. npm package `pi-mcp-events` 0.1.1. There is no extension id. Discovery looks for an `events` capability.

**Spec.** Experimental draft. Events are not part of the MCP specification. The written text is the [triggers/events design sketch](https://github.com/modelcontextprotocol/experimental-ext-triggers-events/blob/main/docs/design-sketch-proposal.md). This package speaks protocol `2026-07-28` and the ChatGPT webhook slice of that draft, and it also calls poll and push when a server advertises them. No SEP number is named in the package.

```bash
pi install npm:pi-mcp-events
```

From a checkout, `cd pi-mcp-events && npm install --ignore-scripts`, then add that directory to pi's `extensions` setting. The package entry is `./src/index.ts`. Details are in [`pi-mcp-events/README.md`](pi-mcp-events/README.md).

### pi-mcp-skills

Discovers and loads MCP skills from the servers pi is already connected to. npm package `pi-mcp-skills` 0.1.0. Extension id `io.modelcontextprotocol/skills`.

**Spec.** [SEP-2640](https://modelcontextprotocol.io/seps/2640-skills-extension) is Final (merged 2026-09-13). That SEP page is a historical record. The package implements the [stable skills specification](https://skills.extensions.modelcontextprotocol.io/specification/stable/skills) that replaced it, base protocol `2026-07-28`. Where they disagree, the stable spec wins.

```bash
pi install npm:pi-mcp-skills
```

Details, tools, flags, and the requirement matrix are in [`pi-mcp-skills/README.md`](pi-mcp-skills/README.md).

### pi-mcp-tasks

Polls MCP task handles returned by `tools/call` and puts the result back into the conversation. npm package `pi-mcp-tasks` 0.1.0. Extension id `io.modelcontextprotocol/tasks`.

**Spec.** [SEP-2663](https://github.com/modelcontextprotocol/modelcontextprotocol/blob/02dd8f61/seps/2663-tasks-extension.md), pinned at commit `02dd8f61`. The package README and `src/requirements.ts` do not label this SEP Final or an experimental draft.

```bash
pi install npm:pi-mcp-tasks
```

Details, tools, flags, and the requirement matrix are in [`pi-mcp-tasks/README.md`](pi-mcp-tasks/README.md).

## pi-mcp-skills

The stable specification is the source of truth. SEP-2640 is the historical record. Where they disagree, the stable spec wins.

Node `>=22`. Peer dependency `@earendil-works/pi-coding-agent` `1.0.1` (and `typebox` `1.3.27`). The attach hook also patches the bundled connection class in `dist/bundle/chunks/runtime-*.js`, which is what pi 1.1 loads. Entry point: `./index.ts`.

```bash
pi install npm:pi-mcp-skills
```

**Flag.** `--mcp-skills-approvals` (`ui` by default, or `tool`). `PI_MCP_SKILLS_APPROVALS` wins over the flag.

In `ui` mode, loading asks with a confirm dialog. Print mode has no confirmation UI, so a load there is refused. In `tool` mode the dialogs stay closed: `mcp_skills_load`, `mcp_skills_read`, and `mcp_skills_directory` proceed only when `approve` is `true`, and `bash`, `shell`, and `exec` stay blocked until `mcp_skills_allow_exec` is called with `approve: true`.

| Tool | Effect |
| --- | --- |
| `mcp_skills_search` | List or filter skills by name, description, URI, and server |
| `mcp_skills_load` | Approve and load one skill. The model receives the origin-tagged `SKILL.md` body |
| `mcp_skills_read` | Read one file with `resources/read`. Relative paths resolve against that skill's directory. This does not load a skill |
| `mcp_skills_directory` | List a directory from the manifest, or from `resources/directory/read` when the server set `directoryRead: true` |
| `mcp_skills_allow_exec` | In `tool` approval mode, allow `bash`, `shell`, and `exec` while a skill is loaded |

`allowed-tools` in frontmatter is ignored. Skill files are not executed. The cache is in memory, keyed by server, URI, and digest.

| Item | Status |
| --- | --- |
| Client requirements C01–C55 in `src/requirements.ts` (capability negotiation, listing, names, URIs, resources, limits, frontmatter, integrity, reading, directories, security, notifications, pi integration) | supported |
| Advertising the extension on `initialize` | supported, by patching pi's `McpClient` |
| `server/discover` | missing. The client reads the extension from `initialize` capabilities. pi's negotiated protocol list stops at `2025-11-25` |
| `resultType`, `ttlMs`, and `cacheScope` before protocol `2026-07-28` | partial. Those fields are required only when the negotiated version is `2026-07-28` or later. When they are present they are still checked |
| Filesystem skill cache | missing. Verified bytes stay in memory and drop when the server goes away or pi restarts |

The full row-by-row matrix is in [`pi-mcp-skills/README.md`](pi-mcp-skills/README.md).

## pi-mcp-tasks

A `tools/call` can return a task handle. The extension tells the server that pi supports tasks, polls `tasks/get` until the task ends, and puts the result, error, or cancellation back into the conversation. It follows the migration off the legacy `2025-11-25` tasks protocol: it never calls `tasks/result`, never sends the legacy `task` parameter, and never advertises `tasks.requests`, `tasks.list`, or `tasks.cancel`.

Node `>=22`. Peer dependency `@earendil-works/pi-coding-agent` `1.0.1` (and `typebox` `1.3.27`). The hook also patches `dist/bundle/chunks/runtime-*.js`. Entry point: `./index.ts`.

```bash
pi install npm:pi-mcp-tasks
```

**Flag.** `--mcp-tasks-approvals` (`ui` by default, or `tool`). `PI_MCP_TASKS_APPROVALS` wins over the flag.

In `ui` mode, `input_required` is confirmed before `tasks/update`. In print mode the key stays pending and the model is told to call `mcp_tasks_respond`. In `tool` mode the confirm and input dialogs are skipped and `mcp_tasks_respond` is the only way to answer.

While a task is open, the status line shows `tasks N` and the `mcp-tasks` widget lists each task. Open tasks are stored as session entries (`customType: "pi-mcp-tasks"`) and polling resumes on the next `session_start`. A terminal snapshot is appended as a custom message (`customType: "mcp-task"`).

| Tool | Effect |
| --- | --- |
| `mcp_tasks_list` | Every task from this session: status, status message, poll interval, TTL |
| `mcp_tasks_show` | One task, including result or error. The id is a task id, or `server/taskId` when two servers share an id |
| `mcp_tasks_cancel` | `tasks/cancel`. Polling stops. Does not send `notifications/cancelled` |
| `mcp_tasks_respond` | `tasks/update` with `inputResponses` as a JSON string. Keys already answered are skipped |

| Item | Status |
| --- | --- |
| Client requirements C-MUST-01–12, C-SHOULD-01–09, and C-MAY-01–05 in `src/requirements.ts` | supported |
| Per-request `_meta` capability on `tools/call`, `tasks/get`, `tasks/update`, `tasks/cancel`, and `subscriptions/listen` | supported |
| `Mcp-Name` (task id) and `Mcp-Method` on Streamable HTTP for `tasks/get`, `tasks/update`, and `tasks/cancel` | supported. Stdio does not send those headers |
| `server/discover` and `subscriptions/listen` | supported. Discovery failure is ignored. `subscriptions/listen` method-not-found is ignored, and polling continues |
| `capabilities.extensions` on `initialize` | partial. Patched onto `McpClient` from `dist/extensions/mcp/runtime.js` and `dist/bundle/chunks/runtime-*.js`. The patch does not apply to pi's single-file binary, which inlines its own `McpClient`. Per-request `_meta` still does |
| Elicitation and sampling inside `input_required` | partial. Confirmed through pi's UI. pi does not implement those requests, and this client does not accept them on the user's behalf |
| Tasks while pi negotiates protocol `2025-11-25` | partial. The client still sends the capability. SEP-2663 says the extension is not defined for that version. A server that follows that rule returns an immediate tool result, which is delivered unchanged |

The full matrix and the readings the code uses are in [`pi-mcp-tasks/README.md`](pi-mcp-tasks/README.md).

## pi-mcp-apps

During `initialize` the client advertises:

```json
{ "io.modelcontextprotocol/ui": { "mimeTypes": ["text/html;profile=mcp-app"] } }
```

When pi reports `hasUI` and a tool result comes from a tool whose `_meta.ui.resourceUri` is a `ui://` resource, the extension reads that resource and hosts the page. The deprecated flat `_meta["ui/resourceUri"]` key is still accepted. HTML may arrive as `text` or base64 `blob`. The MIME type must be `text/html;profile=mcp-app`.

Node `>=22`. Peer dependency `@earendil-works/pi-coding-agent` `1.0.1` (and `typebox` `1.3.27`). The hook also patches the Pi 1.1 bundle at `dist/bundle/chunks/runtime-*.js`. Entry point: `./index.ts`. There is no flag.

```bash
pi install npm:pi-mcp-apps
```

Local load from this repo: `pi -e pi-mcp-apps/index.ts`.

| Tool | Effect |
| --- | --- |
| `mcp_apps_open` | Read a named `ui://` resource and return a localhost page that embeds it |

With a UI, the words "Open MCP App" are drawn under the tool call as a link to `http://127.0.0.1:<port>/view/<token>`. The app runs in a sandboxed iframe on `127.0.0.2` at the same port. The outer sandbox iframe is `allow-scripts allow-same-origin`. The inner view iframe is `allow-scripts`. Console and print mode leave the tool result unchanged and do not host a page for it. `mcp_apps_open` still returns a URL when called.

Tools whose `visibility` does not include `"model"` are removed from the active tool list. `"app"` is required before this host will proxy `tools/call` from a view, and the call stays on that view's server. Omitted visibility means `["model", "app"]`.

`ui/initialize` returns protocol `2026-01-26`. After `ui/notifications/initialized`, the host sends `ui/notifications/tool-input`, `ui/notifications/tool-result`, and `ui/notifications/host-context-changed`. Nothing is sent to the view before `initialized`.

| View method | Behavior |
| --- | --- |
| `ping` | Empty result |
| `tools/call` | Proxied when visibility includes `app`. The result goes back to the view and does not start a model turn |
| `resources/read` | Proxied to the same server |
| `notifications/message` | Accepted |
| `ui/message` | `role: "user"` text is delivered with `sendUserMessage` (`deliverAs: "followUp"`) |
| `ui/update-model-context` | Stored and added on later turns. It does not start a turn |
| `ui/open-link` | `http:` and `https:` URLs are opened with `xdg-open` |
| `ui/request-display-mode` | Always results in `inline` |

| Item | Status |
| --- | --- |
| Initialize advertisement, `ui://` hosting, deprecated resource-URI key, sandbox CSP, and the view methods above | supported |
| Display modes other than `inline` (fullscreen, picture-in-picture) | missing |
| Dedicated `domain` from resource metadata | missing. The sandbox origin is always `127.0.0.2` |
| Partial tool-argument streaming, theme CSS variables, and `ui/resource-teardown` | missing. Views live until the pi process exits |
| Hosting a page from a tool result in console or print mode | missing |

## pi-mcp-events

A server that only speaks `2025-11-25` fails discovery and is reported as an error.

Node `>=22.19.0`. Dependencies include `@earendil-works/pi-coding-agent` `1.0.2` and `@earendil-works/pi-mcp` `1.0.2`. Entry point: `./src/index.ts`. There is no flag.

```bash
pi install npm:pi-mcp-events
```

The published package is the TypeScript sources pi loads. From a checkout of this repo, `cd pi-mcp-events && npm install --ignore-scripts`, then add that directory to pi's `extensions` setting. `npm publish` runs the tests through `prepublishOnly`.

Servers come from the same places as `/mcp`: `<getAgentDir()>/mcp.json` (`$PI_CODING_AGENT_DIR` when set, otherwise `~/.pi/agent`), `<cwd>/.pi/mcp.json` when the project is trusted, and `pi.registerMcpServer()` unless a file already defines that name. A scan does not run at session startup. Session start registers scan and status for each enabled server. Scan registers one tool per advertised delivery mode.

Tool names follow pi's MCP tools: `mcp__<server>__<tool>`, sanitized to `[A-Za-z0-9_]` and hashed down to 64 characters when needed. Dots in an event name become underscores, so `demo.tick` on server `sprite` is `mcp__sprite__events__demo_tick__poll`.

| Tool | Method |
| --- | --- |
| `mcp__<server>__events__status` | None. Auth and the last scan |
| `mcp__<server>__events__scan` | `server/discover`, then `events/list` |
| `mcp__<server>__events__<event>__subscribe` | `events/subscribe`, when delivery includes `webhook` |
| `mcp__<server>__events__<event>__unsubscribe` | `events/unsubscribe` |
| `mcp__<server>__events__<event>__poll` | `events/poll`, when delivery includes `poll`. One request. Call again immediately when `hasMore` is true, otherwise after `nextPollMs` |
| `mcp__<server>__events__<event>__stream` | `events/stream`, when delivery includes `push`. Waits for `maxEvents` events (default 1). `waitMs` is only for when the user asked for a time limit. Heartbeats advance the cursor |

Webhook subscribe matches the ChatGPT slice: `delivery.mode` is `"webhook"`, the callback URL is `https`, and the secret is `whsec_` plus base64 of 24–64 bytes. The caller supplies the secret. `cursor: null` starts from now. A later subscribe sends the cursor from the previous subscribe response. The same server, event name, arguments, and URL refresh the subscription. The result is stored in `<getAgentDir()>/mcp-events.json`. While pi is open, refresh runs one minute before `refreshBefore`. If pi was closed past that time, the next session start sends the refresh.

HTTP auth is an `Authorization` header, a `/login` provider token, or the OAuth access token `/mcp` already saved in `mcp-auth.json`.

| Item | Status |
| --- | --- |
| `server/discover`, protocol `2026-07-28` in `_meta`, `events/list` (paged), `events/poll`, `events/stream`, `events/subscribe`, `events/unsubscribe` | supported |
| Webhook URL, secret shape, cursor, and stored refresh | supported |
| Receiving webhooks, answering a `verification` challenge, or checking a delivery signature on a listening port | missing. `verifyWebhook` and `callbackResponse` exist in the package and are not wired to a server |
| Cursor movement when a webhook is delivered | missing. The stored cursor moves on subscribe, refresh, poll, and stream |
| Push as a standing subscription, reconnect, `notifications/events/error`, `notifications/events/terminated` | missing. Stream is a bounded read |
| Background poll loop | missing. The model calls the poll tool again |
| `notifications/events/list_changed` | missing. The connection closes when the tool finishes |
| `gap` and `terminated` webhook control messages | missing |
| Browser sign-in | missing |

## Monorepo status

These four directories share one git repository. They are not set up as one workspace. The notes below are what is in the tree.

- **No root package manifest or workspace config.** There is no `package.json` at the repository root, and no `pnpm-workspace.yaml`, `lerna.json`, `nx.json`, or `turbo.json`. None of the package manifests declare a `workspaces` field.
- **CI files exist in two packages, and none at the root.** `pi-mcp-skills/.github/workflows/ci.yml` and `pi-mcp-tasks/.github/workflows/ci.yml` each run `npm ci`, `npm test`, and `npm run typecheck` on Node 22. `pi-mcp-apps` and `pi-mcp-events` have no workflow file. There is no `.github/workflows` directory at the repository root. GitHub Actions loads workflows from that root path, so the nested files are not the workflows for this repository.
- **Each package keeps its own lockfile.** `pi-mcp-apps/package-lock.json`, `pi-mcp-events/package-lock.json`, `pi-mcp-skills/package-lock.json`, and `pi-mcp-tasks/package-lock.json` are separate. There is no lockfile at the root.
- **`pi-coding-agent` and `pi-mcp` versions and dependency kinds differ.** `pi-mcp-apps`, `pi-mcp-skills`, and `pi-mcp-tasks` declare `@earendil-works/pi-coding-agent` `1.0.1` as a `peerDependency` and again as a `devDependency`. `pi-mcp-events` declares `@earendil-works/pi-coding-agent` `1.0.2` under `dependencies`, not as a peer. `@earendil-works/pi-mcp` is a `devDependency` at `1.0.1` in skills and tasks. Tasks also sets `overrides` so `@earendil-works/pi-mcp` stays at `1.0.1`. Apps does not depend on `@earendil-works/pi-mcp`. Events declares `@earendil-works/pi-mcp` `1.0.2` under `dependencies`. The same split applies to `typebox` `1.3.27`: a `peerDependency` in apps, skills, and tasks, and a direct `dependency` in events.
- **`pi-mcp-events` has no typecheck script.** Apps, skills, and tasks define `"typecheck": "tsc --noEmit"`. Events has a `tsconfig.json`. Its `scripts` are `test` and `prepublishOnly` only.
- **`repository`, `homepage`, and `bugs` still name the deleted standalone repositories.**
  - `pi-mcp-apps`: `git+https://github.com/richardanaya/pi-mcp-apps.git`, `https://github.com/richardanaya/pi-mcp-apps#readme`, `https://github.com/richardanaya/pi-mcp-apps/issues`
  - `pi-mcp-events`: `git+https://github.com/richardanaya/pi-mcp-events.git`, `https://github.com/richardanaya/pi-mcp-events#readme`, `https://github.com/richardanaya/pi-mcp-events/issues`
  - `pi-mcp-skills`: `git+https://github.com/richardanaya/pi-mcp-skills.git`, `https://github.com/richardanaya/pi-mcp-skills#readme`, `https://github.com/richardanaya/pi-mcp-skills/issues`
  - `pi-mcp-tasks`: `git+https://github.com/richardanaya/pi-mcp-tasks.git`, `https://github.com/richardanaya/pi-mcp-tasks#readme`, `https://github.com/richardanaya/pi-mcp-tasks/issues`

## Repository layout

```
pi-mcp-skills/     skills client (index.ts, src/, tests/)
pi-mcp-tasks/      tasks client (index.ts, src/, tests/)
pi-mcp-apps/       apps host (index.ts, src/, tests/)
pi-mcp-events/     events client (src/, test/)
```

Each package has its own `package.json`, `tsconfig.json`, `README.md`, and `LICENSE`. Differences in workspace setup, CI, lockfiles, dependency versions, typecheck scripts, and package metadata are listed under [Monorepo status](#monorepo-status).

There is no compile step. Pi loads the TypeScript sources. `tsc` is typecheck only (`noEmit: true`).

## Build and test

Node 22 or newer (events requires `>=22.19.0`). From the package directory:

| Package | Install | Test | Typecheck |
| --- | --- | --- | --- |
| `pi-mcp-skills` | `npm ci` | `npm test` | `npm run typecheck` |
| `pi-mcp-tasks` | `npm ci` | `npm test` | `npm run typecheck` |
| `pi-mcp-apps` | `npm ci` | `npm test` | `npm run typecheck` |
| `pi-mcp-events` | `npm install --ignore-scripts` | `npm test` | no `typecheck` script (`tsconfig.json` is present) |

`npm test` uses Node's built-in test runner with `--experimental-strip-types`.

- Skills: unit, extension, integration, and compliance tests. Integration tests spawn `tests/fixture-server.ts` through `McpServerConnection`.
- Tasks: unit, integration, session, and coverage. `tests/coverage.test.ts` fails if a row in `src/requirements.ts` has no matching test name.
- Apps: `tests/host.test.ts` exercises the localhost host against the `2026-01-26` view methods.
- Events: `test/*.test.ts`. `prepublishOnly` runs `npm test`.

## License

MIT. Each package directory contains the license text. Copyright (c) 2026 Richard Anaya.
