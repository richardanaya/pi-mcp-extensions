# pi-mcp-apps

Pi extension for [MCP Apps](https://github.com/modelcontextprotocol/ext-apps/blob/main/specification/2026-01-26/apps.mdx), stable `2026-01-26`, extension id `io.modelcontextprotocol/ui`.

It uses the MCP servers already connected in Pi. It does not open a second connection and it does not register a slash command.

Version 0.1.0. MIT. Copyright (c) 2026 Richard Anaya.

## What the host does

During MCP `initialize`, the client advertises:

```json
{ "io.modelcontextprotocol/ui": { "mimeTypes": ["text/html;profile=mcp-app"] } }
```

When Pi reports `hasUI` and a tool result comes from a tool whose `_meta.ui.resourceUri` is a `ui://` resource, the extension reads that resource with `resources/read` and hosts the page. It does not call `resources/list`, and it does not need pi to have listed resources at connect. pi 1.4.0 records the resources capability (`pi mcp list --json` reports `resources: true`) and does not list resources while connecting. The extension does not launch a browser. The deprecated flat `_meta["ui/resourceUri"]` key is still accepted. `mcp_apps_open` hosts a URI you name. HTML may arrive as `text` or base64 `blob`. The MIME type must be `text/html;profile=mcp-app`.

pi 1.4.0 accepts a non-object `structuredContent` on an MCP `tools/call` result. This host does not re-check that field. A `tools/call` from a view is returned to the view as the server sent it. `ui/update-model-context` still requires `structuredContent` to be an object when it is present, which is the Apps host message rather than the MCP tool result.

The words "Open MCP App" are drawn under the tool call as a clickable link only when Pi reports `hasUI`. Console and print mode leave the tool result unchanged and do not host a page for it. `mcp_apps_open` still returns a URL when called.

Tools with `visibility` that does not include `"model"` are removed from the active tool list. `"app"` is required before this host will proxy `tools/call` from a view, and the call stays on that view's server. Omitted visibility means `["model", "app"]`.

## Page and sandbox

Open the link in a browser. The page is `127.0.0.1`. The app runs in a sandboxed iframe on `127.0.0.2` at the same port. The outer sandbox iframe is `allow-scripts allow-same-origin`. The inner view iframe is `allow-scripts`.

The sandbox sends `ui/notifications/sandbox-proxy-ready`. The host answers with `ui/notifications/sandbox-resource-ready`, including the raw HTML, the CSP, and any permission policy from `_meta.ui`. The sandbox injects that CSP and sets the inner `allow` attribute. Undeclared origins are dropped. If the resource omits CSP, the header is the spec default: `default-src 'none'`, `'self'` plus `'unsafe-inline'` for scripts and styles, `img-src` and `media-src` limited to `'self'` and `data:`, `connect-src 'none'`, `frame-src 'none'`, `object-src 'none'`, `base-uri 'self'`.

After `ui/notifications/initialized`, the host sends `ui/notifications/tool-input`, `ui/notifications/tool-result`, and `ui/notifications/host-context-changed` with the window size. Nothing is sent to the view before `initialized`.

`ui/initialize` returns protocol `2026-01-26`, host info, `openLinks`, `serverTools`, `serverResources`, `logging`, the sandbox CSP that was applied, and host context (`inline` only, desktop, locale, time zone). `ui/request-display-mode` always results in `inline`. This host does not offer fullscreen or picture-in-picture.

## View requests

| Method | Behavior |
| --- | --- |
| `ping` | Empty result |
| `tools/call` | Proxied when visibility includes `app` |
| `resources/read` | Proxied to the same server |
| `notifications/message` | Accepted |
| `ui/message` | `role: "user"` text is delivered with `sendUserMessage` (`deliverAs: "followUp"`) |
| `ui/update-model-context` | Stored and added on later turns. It does not start a turn |
| `ui/open-link` | `http:` and `https:` URLs are opened with `xdg-open` |
| `ui/request-display-mode` | Stays `inline` |

`tools/call` from the view returns the server result to the view. It does not start a model turn.

## Install

Node 22 or newer. The peer dependency is the exact pin `@earendil-works/pi-coding-agent` 1.4.0, the release this package is tested against. pi's CLI inlines `McpClient` in a chunk reached from `dist/bundle/chunks/runtime-*.js`. That layout is unchanged in 1.4.0, and that class is not the `@earendil-works/pi-mcp` export. The hook follows the bundle's imports and patches the class the CLI constructs, so `initialize` advertises `io.modelcontextprotocol/ui`. The chunk hash is not hard-coded. `mcp_apps_open` does not set `reachesTools`. It calls the MCP client pi already connected, after that connection exists.

```bash
pi install npm:pi-mcp-apps
```

Local load from a checkout of [pi-mcp-extensions](https://github.com/richardanaya/pi-mcp-extensions): `pi -e pi-mcp-apps/index.ts`.

## Not in this host

Partial tool-argument streaming, theme CSS variables, and `ui/resource-teardown` are not sent. Views live until the Pi process exits. A dedicated `domain` from resource metadata is not mapped to another origin; the sandbox origin is always `127.0.0.2`.

## License

MIT. Copyright (c) 2026 Richard Anaya.
