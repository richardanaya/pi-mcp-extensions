# pi-mcp-skills

pi extension that discovers and loads [MCP skills](https://skills.extensions.modelcontextprotocol.io/specification/stable/skills) from the servers pi is already connected to.

[SEP-2640](https://modelcontextprotocol.io/seps/2640-skills-extension) (Final, merged 2026-09-13) added the Skills extension to MCP. The SEP page is a historical record. This package implements the client and lookup side of the stable specification that replaced it (`modelcontextprotocol/ext-skills specification/stable/skills.mdx`, base protocol 2026-07-28). The extension id is `io.modelcontextprotocol/skills`.

A skills server lists skill entries with `skills/list`. Each entry names a `SKILL.md` resource, the Agent Skills frontmatter, and either a complete file manifest (URI, sha256 digest, and size) or the string `dynamic`. The client fetches file bytes with `resources/read` only when a skill is inspected, loaded, or a supporting file is read, then checks the digest, the size, and the frontmatter. `skills/get` loads one skill by URI when a page of the list omitted it, and it is how a stale manifest is refreshed.

## Install

Node 22. The peer dependency is `@earendil-works/pi-coding-agent` 1.0.1. The same hook also patches the bundled connection class current `pi` builds load from `dist/bundle/chunks/runtime-*.js`, which is what pi 1.1 uses.

```bash
pi install npm:pi-mcp-skills
```

The package contributes `./index.ts` through the `pi.extensions` field. It uses the MCP servers already configured in `mcp.json` and the servers other extensions register with `pi.registerMcpServer`. It does not open a second MCP connection, and it does not replace `/mcp`. There is no slash command.

## Tools

| Tool | Effect |
| --- | --- |
| `mcp_skills_search` | List or filter skills by name, description, URI, and server |
| `mcp_skills_load` | Approve and load one skill. The model receives the origin-tagged `SKILL.md` body |
| `mcp_skills_read` | Read one file with `resources/read`. Relative paths resolve against that skill's directory. This does not load a skill |
| `mcp_skills_directory` | List a directory from the manifest, or from `resources/directory/read` when the server set `directoryRead: true` |

`mcp_skills_search` prints the catalog: collisions, unconfirmed instruction URIs, and rejected entries. Loading asks for confirmation that names the server, URI, name, and description. The `SKILL.md` body is fetched after that approval, not before. Print mode has no confirmation UI, so a load there is refused.

Loading asks for confirmation when approval mode is `ui` (the default). The approval is remembered for the session and is bound to the resource set (URI, digest, and size).

Set approvals to `tool` when there is no UI, or when a tool call should grant the approval. Pass `--mcp-skills-approvals tool`, or set `PI_MCP_SKILLS_APPROVALS=tool`. The environment variable wins. In that mode the dialogs are not opened. `mcp_skills_load`, `mcp_skills_read`, and `mcp_skills_directory` proceed only when their `approve` argument is `true`. `bash`, `shell`, and `exec` stay blocked until `mcp_skills_allow_exec` is called with `approve: true`. `ui` mode ignores `approve` and still uses the confirm dialog. A dynamic skill asks every time, and that approval does not cover later bytes. While any skill is loaded, `bash`, `shell`, and `exec` ask again. A read of a different server names both servers in its own confirmation. `allowed-tools` in frontmatter is ignored. Skill files are not executed.

The cache is in memory, keyed by server, URI, and digest. A cache hit is hashed again before use. Disconnecting the server drops its cache, its approvals, and its acting skills.

## How lookup runs

1. On startup the extension patches `McpClient.connect` and `McpServerConnection.connectOnce` / `getClient`. It patches both copies pi might construct: `dist/extensions/mcp/runtime.js`, and the class re-exported by `dist/bundle/chunks/runtime-*.js`. `initialize` gains `capabilities.extensions["io.modelcontextprotocol/skills"] = {}`. A connection that is already open is adopted on the next `getClient`. Each connection is handed to the skills host under `entry.name`, the host-assigned label.
2. If that server's `initialize` result does not declare the extension, the host stops. If it declares the extension and omits `resources`, the host records an error and does not call `skills/list`.
3. Otherwise the host pages through `skills/list`, keeps valid entries, and records why the others were rejected. It subscribes to `notifications/resources/list_changed` and `notifications/skills/list_changed` and lists again when either arrives. `session_start` and `mcp_servers_change` forget extension-registered servers that disappeared. Servers that exist only in `mcp.json` stay until their connection closes, because `getMcpServers()` does not include them.
4. `skills/get` is used when a URI was not on the fresh list, when the list's `ttlMs` has elapsed, and when fetched bytes do not match the manifest. A resources set that changed revokes the approval.
5. File bytes are checked against the listed digest and size. `SKILL.md` frontmatter is parsed as YAML (core schema; timestamps become ISO strings) and compared field by field with the entry. A mismatch is a failed load, and the bytes are not treated as the skill.

## Compliance

Source of truth: stable Skills extension, base protocol 2026-07-28. SEP-2640 Final (2026-09-13) is the historical record. Where they disagree, the stable spec wins and the note says so.

| ID | Level | Section | Requirement | Status | Test |
| --- | --- | --- | --- | --- | --- |
| C01 | MUST | Capability negotiation | Issue skills/list and skills/get only after the server declares io.modelcontextprotocol/skills. | implemented | `tests/unit.test.ts C01` |
| C02 | MUST | Capability negotiation | Do not call resources/directory/read unless the server declares directoryRead: true. An empty settings object means directory reading is off. | implemented | `tests/unit.test.ts C02` |
| C03 | MUST | Capability negotiation | Advertise the extension from the client during initialize (SEP-2133). An empty settings object means support with no client-specific settings. | implemented | `tests/unit.test.ts C03` |
| C04 | MUST | Capability negotiation | A skills server must also declare resources. Do not list or fetch skills from a server that omits that capability. | implemented | `tests/unit.test.ts C04` |
| C05 | MUST | Listing | Follow nextCursor with params.cursor until a page omits it. Keep each skill entry intact on one page. | implemented | `tests/unit.test.ts C05` |
| C06 | MUST | Listing | Do not treat an empty or partial listing as proof the server has no skills. | implemented | `tests/unit.test.ts C06` |
| C07 | MUST | Listing | Load a skill from its URI alone, using skills/get when the listing omitted it. | implemented | `tests/integration.test.ts C07` |
| C08 | MUST | Listing | Do not fetch SKILL.md or supporting files while assembling the registry. | implemented | `tests/unit.test.ts C08` |
| C09 | MUST | Listing | On protocol 2026-07-28 and later, require resultType complete plus ttlMs and cacheScope on skills/list and skills/get. Honor them as a freshness hint and a scope marker, not as an integrity check. | implemented | `tests/unit.test.ts C09` |
| C10 | MUST | Names | Do not assume name uniqueness. When names collide in one listing, keep every entry and disambiguate by path. Do not drop or prefer one. | implemented | `tests/unit.test.ts C10` |
| C11 | MUST | Names | Resolve names inside a per-origin namespace keyed by the host-assigned server label, not serverInfo.name. An MCP skill must not silently shadow another origin. | implemented | `tests/unit.test.ts C11` |
| C12 | MUST | Skill URIs | Identity is the pair of host server label and SKILL.md URI. Do not key the registry, approvals, cache, or tools on the URI alone. | implemented | `tests/unit.test.ts C12` |
| C13 | MUST | Resources | Refuse to load an entry whose resources field is missing or is neither an array nor the string dynamic. | implemented | `tests/unit.test.ts C13` |
| C14 | MUST | Resources | A resources array must contain SKILL.md exactly once, with sha256 digests and byte sizes, and every URI must stay inside the skill directory. | implemented | `tests/unit.test.ts C14` |
| C15 | MAY | Resources | Decline to treat a dynamic skill as content-bound. Loading one requires a fresh approval every time and that approval is not stored as covering later bytes. | implemented | `tests/unit.test.ts C15` |
| C16 | MUST | Limits | Accept skills of up to 512 resources and 16 MiB. Decline larger skills from the entry alone and say why. | implemented | `tests/unit.test.ts C16` |
| C17 | MAY | Limits | For a dynamic skill, stop once retrieved bytes reach 16 MiB. | implemented | `tests/unit.test.ts C17` |
| C18 | MUST | Frontmatter | Keep every frontmatter field from the entry. The final skill-path segment must equal frontmatter.name. | implemented | `tests/unit.test.ts C18` |
| C19 | SHOULD | Frontmatter | Ignore unrecognized metadata keys under the io.modelcontextprotocol/ prefix. | implemented | `tests/unit.test.ts C19` |
| C20 | MUST | Resource mapping | Do not resolve the skill:// authority with DNS or any network lookup. | implemented | `tests/unit.test.ts C20` |
| C21 | MUST | Resource mapping | Do not decide that a resource is a skill because of its URI scheme. Confirm with a listing entry or with skills/get. | implemented | `tests/unit.test.ts C21` |
| C22 | MAY | Resource mapping | Accept skills served under a scheme other than skill://. | implemented | `tests/integration.test.ts C22` |
| C23 | MUST | Skill format | Require a skill name that matches the Agent Skills naming rules, and a non-empty description of at most 1024 characters. | implemented | `tests/unit.test.ts C23` |
| C24 | SHOULD | Skill format | Keep accepting the Agent Skills shape this extension was written against if a later revision is incompatible. | implemented | `tests/unit.test.ts C24` |
| C25 | MUST | Getting a skill | skills/get returns one entry of the same shape as a list entry. Unknown URIs surface JSON-RPC -32602 and the server message. | implemented | `tests/integration.test.ts C25` |
| C26 | MUST | Integrity | When a file is listed, verify the fetched bytes against that entry's digest and size. Do not use bytes that disagree. | implemented | `tests/integration.test.ts C26` |
| C27 | MUST | Integrity | After a verified SKILL.md fetch, compare parsed YAML frontmatter field-by-field with the entry. Any difference is a failed load. | implemented | `tests/unit.test.ts C27` |
| C28 | MUST | Integrity | Recover from a stale read by calling skills/get. If the resources set changed, revoke the content-bound approval and ask again before loading. | implemented | `tests/unit.test.ts C28` |
| C29 | MUST | Integrity | While acting on a skill, read only URIs in the held resources set. An unlisted file is a verification failure and is not shown as a file of the skill. | implemented | `tests/unit.test.ts C29` |
| C30 | MUST | Integrity | Do not fetch skill files on connect, on listing, or at approval time. Fetch SKILL.md when the skill is loaded or inspected, and a supporting file when it is read. | implemented | `tests/unit.test.ts C30` |
| C31 | SHOULD | Integrity | Cache verified file bytes and serve a later read only when the cached bytes still hash to the entry digest. | implemented | `tests/unit.test.ts C31` |
| C32 | MUST | Integrity | Do not treat a digest match as a trust decision. Loaded text stays labeled as untrusted server content. | implemented | `tests/unit.test.ts C32` |
| C33 | MAY | Integrity | The acting window may stay open after SKILL.md might have left the transcript. This client holds it until the session drops that server. | implemented | `tests/unit.test.ts C33` |
| C34 | MUST | Reading | A resources/read of SKILL.md, including mcp_skills_read, does not load the skill. | implemented | `tests/unit.test.ts C34` |
| C35 | MUST | Reading | Resolve a relative reference against the directory that contains that SKILL.md, including a nested skill's own directory. | implemented | `tests/unit.test.ts C35` |
| C36 | MUST | Nested skills | A nested SKILL.md read as a supporting file is ordinary markdown. Do not act on its frontmatter or reuse the parent approval. | implemented | `tests/unit.test.ts C36` |
| C37 | MUST | Directory reads | Paginate resources/directory/read the same way as resources/list. | implemented | `tests/unit.test.ts C37` |
| C38 | MAY | Directory reads | When the held entry has a resources array, answer a directory question from that array. | implemented | `tests/unit.test.ts C38` |
| C39 | MUST | Directory reads | Do not let a directory result add files to the held manifest. Hide children that the manifest does not list, and describe that as a skill change rather than a read error. | implemented | `tests/unit.test.ts C39` |
| C40 | MUST | Errors | Surface -32602 for an unknown skill, a directory read of a non-directory, and a missing resource, and surface -32603 for an internal error, keeping the server message. | implemented | `tests/integration.test.ts C40` |
| C41 | MUST | Security | Tag MCP skill text with the host server label when it enters model context, and do not present it as a local filesystem skill. | implemented | `tests/unit.test.ts C41` |
| C42 | MUST | Security | Ignore allowed-tools and any other frontmatter that would widen tool or filesystem permissions. | implemented | `tests/unit.test.ts C42` |
| C43 | MUST | Security | Do not execute skill hooks or bundled scripts. While a skill is loaded, a host code-execution tool call requires its own user approval. | implemented | `tests/extension.test.ts C43` |
| C44 | MUST | Security | Bind a model-issued resource read to the skill's server. A read of a different server needs a per-call approval that names both servers. | implemented | `tests/unit.test.ts C44` |
| C45 | MUST | Security | A persisted or remembered approval is bound to the resources set (uri, digest, and size). A different set revokes it. | implemented | `tests/unit.test.ts C45` |
| C46 | MUST | Security | Activating a nested skill requires its own approval. Approving the parent does not approve the nested skill. | implemented | `tests/unit.test.ts C46` |
| C47 | SHOULD | Security | Show which server a skill comes from, and let the user inspect the body before it is loaded. | implemented | `tests/extension.test.ts C47` |
| C48 | SHOULD | Security | Tell the user when skill names collide. | implemented | `tests/unit.test.ts C48` |
| C49 | MAY | Security | Gate loading on per-skill user approval. | implemented | `tests/unit.test.ts C49` |
| C50 | SHOULD | Security | Cache verified bytes in memory, not on a filesystem skill path, and drop a server's cache when that server goes away. | implemented | `tests/unit.test.ts C50` |
| C51 | MUST | Change notifications | Refresh a server's skill list when it sends notifications/resources/list_changed. | implemented | `tests/integration.test.ts C51` |
| C52 | MAY | Change notifications | Also refresh when a server sends notifications/skills/list_changed, following the base list-method convention even though this extension does not name that notification. | implemented | `tests/integration.test.ts C52` |
| C53 | MUST | pi integration | Observe extension-registered servers with getMcpServers on session_start and with mcp_servers_change afterward, and drop skills for a server that disappears. | implemented | `tests/extension.test.ts C53` |
| C54 | MUST | pi integration | Send skills and resource requests through the MCP client pi already connected. Do not open a second client for the same server. | implemented | `tests/integration.test.ts C54` |
| C55 | MAY | Server instructions | Surface skill URIs mentioned in server instructions as references. They are not registry entries until skills/get confirms them. | implemented | `tests/unit.test.ts C55` |

### Readings and notes

- **C03.** pi-mcp 1.0.1 ClientCapabilities omits extensions, and the built-in MCP extension does not pass any. The attach hook adds the field on the existing McpClient before initialize.
- **C09.** The Final SEP left caching attributes on skills/get open and required them on skills/list only for protocol 2026-07-28+. The stable spec requires them on both results. Older negotiated protocols may omit them; this client accepts that omission and still caches until a list-changed notification or until `ttlMs` elapses.
- **C16.** Hosts MAY accept larger skills. This client stops at the published limits so every conforming server is loadable and anything beyond them is explained instead of failing on a later read.
- **C23.** Rules read from the Agent Skills specification (1–64 lowercase unicode letters or digits, hyphens not leading, trailing, or doubled). If that specification changes incompatibly, this client still accepts the previous naming rules.
- **C42.** pi 1.0.1 has no per-skill permission grant. This client never applies allowed-tools, so the field cannot widen access.
- **C50.** There is no on-disk skill cache, so the disk-cache integrity and durable-origin rules are met by not writing one. Restarting pi drops the cache and the remembered approvals.
- **C51.** The Final SEP and the stable spec do not define notifications/skills/list_changed. The working group previously pointed at resources/list_changed, and that is what pi's client already delivers. This client refreshes on that notification.
- **C54.** ExtensionAPI has no request or notification method. The workaround patches `McpServerConnection.connectOnce`, `getClient`, and `McpClient.connect` on the unbundled runtime and on the bundled `runtime-*.js` re-export.

- The stable spec mentions `server/discover` as the long-term way to negotiate extensions. pi 1.0.1 speaks `initialize` and stops at protocol `2025-11-25`, so this client reads the extension from the initialize capabilities and does not call `server/discover`.
- pi's negotiated protocol is older than 2026-07-28, so a live server may omit `resultType`, `ttlMs`, and `cacheScope`. Those fields are required only when the negotiated version is 2026-07-28 or later. When they are present they are still checked.
- `nextCursor` of `null` or `""` ends a page, matching pi's own client.
- An approval fingerprint includes size as well as URI and digest, which is the resources set the spec binds the approval to.
- Hosts may accept skills larger than 512 resources or 16 MiB. This client declines them and explains why.
- There is no on-disk skill cache, so the rules for a durable cache are met by not writing one.
- pi has no per-skill permission grant, so `allowed-tools` cannot be applied.

## Development

```bash
npm test
npm run typecheck
```

Tests run on Node's built-in runner. Integration tests spawn `tests/fixture-server.ts`, a stdio server built with `@modelcontextprotocol/sdk`, through `McpServerConnection`.

## License

MIT. Copyright (c) 2026 Richard Anaya.
